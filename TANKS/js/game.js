'use strict';
/**
 * ============================================================================
 *  game.js — Orquestador: bucle principal, controladores, red y HUD.
 * ============================================================================
 *
 *  BUCLE DE JUEGO (paso fijo + render interpolado)
 *  ------------------------------------------------
 *   requestAnimationFrame ─► acumulador += dt real
 *                            while (acumulador >= FIXED_DT):   ← LÓGICA (60 Hz exactos)
 *                                 _fixedUpdate(FIXED_DT)
 *                            alpha = acumulador / FIXED_DT
 *                            renderer.render(alpha)            ← RENDER (tasa del monitor)
 *
 *  La lógica es determinista respecto al tiempo (siempre pasos de 1/60 s),
 *  independiente de los FPS reales: requisito básico para sincronizar varios
 *  equipos por red.
 *
 *  FLUJO DE DATOS DE RED
 *  ---------------------
 *   HOST:    inputs (local + bots + RemoteControllers) → GameState.update()
 *            → cada 1/NET_SEND_RATE s: network.broadcastState(state.serialize())
 *   CLIENTE: input local → network.sendInput(input)
 *            snapshots entrantes → state.applySnapshot() → interpolación
 * ============================================================================
 */
class Game {
  /**
   * @param {object} dom
   * @param {HTMLCanvasElement} dom.canvas
   * @param {HTMLElement} dom.stage contenedor del canvas (para escalar)
   */
  constructor({ canvas, stage }) {
    this.canvas = canvas;
    this.stage = stage;
    this.input = new InputManager(canvas);
    this.renderer = new Renderer(canvas);
    this.audio = new SoundFX();
    this.hud = new HUD(this);

    this.network = new NetworkAdapter();
    this._unsubscribeNet = null;

    // PRIDE OVERLORD: la foto de la celebración se carga UNA vez (nunca viaja por la red).
    if (typeof PrideArt !== 'undefined') PrideArt.load('');

    /** @type {GameState|null} */
    this.state = null;
    /** @type {Map<string, {getInput: Function}>} id de tanque → controlador */
    this.controllers = new Map();
    this.localTankId = null;
    this.localController = null;
    this.isHost = true;
    this.options = null;

    this.running = false;
    this.paused = false;
    this.accumulator = 0;
    this.lastTime = 0;

    this._netAccumulator = 0;
    this._lastSentMapRevision = -1;
    this._snapshotsSinceMap = 0;
    this.lastSnapshotBytes = 0;
    this.receivedFirstSnapshot = false;
    this._lastAcceptedTick = -1;      // descarta snapshots viejos fuera de orden
    this._peerNames = new Map();      // peerId -> nombre (para JOIN + INPUT implícito)
    this._peerModels = new Map();     // peerId -> modelId (para JOIN + INPUT implícito)
    this._netReady = false;           // estado y receptor listos antes de procesar red
    this._matchId = 0;                // partida actual del host (cambia al reiniciar)
    this._lastMatchId = null;         // último matchId aceptado del host (cliente)

    /** Imágenes personalizadas compartidas por la red. */
    this._remoteSkinData = new Map();   // host: peerId -> {tank, missile} dataURLs recibidas
    this._remoteSkinImages = new Map(); // tankId -> {tank: Image, missile: Image, tankUrl, missileUrl}
    this._skinsDirty = false;           // hay skins nuevas por difundir en el snapshot

    // Cuando el jugador sube/quita una imagen: difundirla (host) o enviarla al host (cliente).
    window.addEventListener('tankskinchange', () => {
      this._skinsDirty = true;
      if (!this.isHost && this.network.connected) this._sendMySkins();
    });

    /** Réplica de depuración alimentada por LoopbackAdapter (tecla G). */
    this.mirror = null;

    this.fps = 0;
    this._fpsFrames = 0;
    this._fpsTime = 0;

    this._frame = this._frame.bind(this);
    window.addEventListener('resize', () => this._fitCanvas());
  }

  /**
   * Inicia (o reinicia) una partida.
   * @param {object} opts
   * @param {string}  [opts.roomId]
   * @param {boolean} [opts.isHost]     true = este navegador simula (modo local / host)
   * @param {number}  [opts.botCount]   bots locales (sólo host)
   * @param {string}  [opts.playerName]
   */
  async start({ roomId = 'sala-local', isHost = true, botCount = 3, playerName = 'Jugador' } = {}) {
    this.options = { roomId, isHost, botCount, playerName };
    this.audio.unlock();
    this._disableMirror();

    // --- Estado primero: así ningún mensaje de red llega sin estado listo ---
    this.isHost = isHost;
    this._netReady = false;
    this._lastAcceptedTick = -1;
    this._peerNames.clear();
    this._peerModels.clear();
    this.state = new GameState({ isAuthority: isHost });
    this._matchId++; // partida nueva: los clientes aceptan sus snapshots aunque el tick vuelva a 0
    this._remoteSkinData.clear();
    this._remoteSkinImages.clear();
    this.renderer.remoteSkins.clear();
    this._skinsDirty = false;
    this.renderer.setState(this.state);
    this.controllers.clear();
    this.receivedFirstSnapshot = false;
    this._netAccumulator = 0;
    this._lastSentMapRevision = -1;
    this._snapshotsSinceMap = 0;
    this.paused = false;

    // peerId provisional hasta que el transporte confirme (host='host', cliente aleatorio)
    const provisionalId = isHost ? 'host' : 'peer-' + Math.random().toString(36).slice(2, 8);
    this.localTankId = provisionalId;
    this.localController = new KeyboardMouseController(this.input, this.localTankId);
    // Modelo de tanque elegido en el menú (persiste en localStorage).
    const modelId = (window.TankModels && window.TankModels.selectedId()) || null;

    if (isHost) {
      this.state.addTank({ id: this.localTankId, name: playerName, modelId });
      this.controllers.set(this.localTankId, this.localController);
      this._spawnBots(botCount);
    }
    // En modo cliente NO se crea nada: todo llega en los snapshots del host.

    // --- Red (después de crear estado y receptor) ---
    if (this._unsubscribeNet) this._unsubscribeNet();
    this.network.disconnect();
    this._unsubscribeNet = this.network.onPeerMessage((msg, from) => this._handleNetMessage(msg, from));
    this._netReady = true;
    try {
      const peerId = await this.network.init(roomId, isHost, playerName, modelId);
      // Si el servidor asignó otro ID (welcome), actualizamos el tanque local del host.
      if (peerId !== this.localTankId && isHost) {
        // El host siempre es 'host'; este caso es sólo por seguridad.
        this.localTankId = peerId;
      }
      // Para el cliente, localPeerId ya viene del servidor (welcome) o del provisional.
      // Sincronizamos localTankId con el ID real del transporte.
      if (!isHost && this.network.localPeerId) {
        this.localTankId = this.network.localPeerId;
        this.localController = new KeyboardMouseController(this.input, this.localTankId);
      }
      if (!isHost && this.network.connected) {
        // Reenviar JOIN por si el onopen del transporte no lo envió con el nombre correcto.
        this.network.sendJoin(playerName, modelId);
        // Si ya tenía imágenes personalizadas, compartirlas con el host.
        this._sendMySkins();
      }
    } catch (err) {
      console.error('[Game] error de conexión:', err);
      this._netReady = false;
      alert('No se pudo conectar: ' + err.message + '\nRevisa que el servidor esté corriendo (npm start) y que la sala exista.');
      this._showMenu();
      return;
    }

    this._fitCanvas();
    if (!this.running) {
      this.running = true;
      this.lastTime = performance.now();
      requestAnimationFrame(this._frame);
    }
  }

  _showMenu() {
    this.paused = true;
    const menu = document.getElementById('menu');
    if (menu) menu.classList.remove('hidden');
  }

  restart() {
    if (!this.options) return;
    if (!this.isHost) {
      // El cliente no es la autoridad: reiniciar la simulación local no tiene
      // sentido y antes sacaba al jugador de la sala. Sólo el host reinicia.
      console.info('[Game] sólo el host puede reiniciar la partida.');
      return;
    }
    this._resetMatch();
  }

  /**
   * Reinicia la partida SIN tocar la red: la conexión WebSocket sigue viva,
   * así los clientes unidos no se desconectan. Se crea un GameState nuevo y
   * se vuelven a añadir el tanque local, los remotos (conservan id, slot y
   * controlador) y los bots.
   */
  _resetMatch() {
    this._disableMirror();

    // Guardar los peers remotos conectados antes de tirar el estado.
    const remotePeers = [];
    for (const [id, ctrl] of this.controllers) {
      if (ctrl instanceof RemoteController) {
        const tank = this.state.tanks.get(id);
        remotePeers.push({
          id,
          name: tank ? tank.name : (this._peerNames.get(id) || id),
          slot: tank ? tank.slot : undefined,
          ctrl,
          modelId: tank ? tank.modelId : null,
        });
      }
    }

    // Estado nuevo (misma autoridad, sin reconectar la red).
    this.state = new GameState({ isAuthority: true });
    this.renderer.setState(this.state);
    this.controllers.clear();
    this._netAccumulator = 0;
    this._lastSentMapRevision = -1; // forzar el mapa en el próximo snapshot
    this._snapshotsSinceMap = 0;
    this.paused = false;
    this._matchId++; // los clientes detectan la partida nueva aunque el tick vuelva a 0
    this._skinsDirty = true; // los peers siguen conectados: redifundir sus skins

    // Tanques: local, remotos y bots.
    const localModelId = (window.TankModels && window.TankModels.selectedId()) || null;
    this.state.addTank({ id: this.localTankId, name: this.options.playerName, modelId: localModelId });
    this.controllers.set(this.localTankId, this.localController);
    for (const p of remotePeers) {
      const tank = this.state.addTank({ id: p.id, name: p.name, slot: p.slot, modelId: p.modelId });
      if (tank) {
        p.ctrl.lastReceivedAt = performance.now() / 1000; // evitar expulsión inmediata por timeout
        this.controllers.set(p.id, p.ctrl);
      }
    }
    this._spawnBots(this.options.botCount);
  }

  _spawnBots(count) {
    const list = (window.TankModels && window.TankModels.list) || [];
    for (let i = 0; i < count; i++) {
      const slot = this.state.getFreeSlot();
      if (slot < 0) break;
      const id = `bot-${slot}`;
      // Cada bot recibe un modelo predeterminado aleatorio (colores, efectos y habilidades).
      const modelId = list.length ? list[Math.floor(Math.random() * list.length)].id : null;
      const tank = this.state.addTank({ id, name: `Bot ${CONFIG.COLORS[slot].name}`, isBot: true, slot, modelId });
      // La mitad de los bots dispara balas con un rebote extra (sobre su modelo).
      if (i % 2 === 1) tank.maxBounces = Math.min(CONFIG.BULLET.MAX_BOUNCES, tank.maxBounces + 1);
      this.controllers.set(id, new AIController(id, { aimSpeed: MathUtil.randRange(1.8, 2.8) }));
    }
  }

  // ==========================================================================
  //  BUCLE PRINCIPAL
  // ==========================================================================
  _frame(now) {
    requestAnimationFrame(this._frame);

    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!(dt > 0)) dt = 0;
    if (dt > CONFIG.MAX_FRAME_DT) dt = CONFIG.MAX_FRAME_DT;

    this._handleHotkeys();

    // ---- LÓGICA: pasos fijos ----
    if (!this.paused) {
      this.accumulator += dt;
      while (this.accumulator >= CONFIG.FIXED_DT) {
        this._fixedUpdate(CONFIG.FIXED_DT);
        this.accumulator -= CONFIG.FIXED_DT;
      }
    }

    // ---- Eventos → efectos y sonido ----
    for (const ev of this.state.drainEvents()) {
      this.renderer.handleEvent(ev);
      this._playEventSound(ev);
    }
    if (this.mirror) this.mirror.state.drainEvents(); // la réplica no genera efectos

    // ---- RENDER: interpolado ----
    const alpha = this.paused ? 1 : this.accumulator / CONFIG.FIXED_DT;
    this.renderer.render(alpha, dt, {
      localTankId: this.localTankId,
      mouse: this.input.mouse,
      mirrorState: this.mirror ? this.mirror.state : null,
      paused: this.paused,
      waitingForHost: !this.isHost && !this.receivedFirstSnapshot,
    });

    this.input.endFrame();
    this._updateFps(dt);
    this.hud.update(dt);
  }

  /** Un paso de simulación de duración fija. */
  _fixedUpdate(dt) {
    const state = this.state;

    if (this.isHost) {
      // 1) Recoger el input de TODOS los controladores (local, IA y remotos).
      for (const [id, ctrl] of this.controllers) state.setInput(id, ctrl.getInput(state, dt));

      // 2) Simular (autoridad).
      state.update(dt);

      // 3) Expulsar peers que dejaron de enviar inputs.
      this._checkPeerTimeouts();

      // 4) Difundir el estado a frecuencia de red.
      this._netAccumulator += dt;
      const interval = 1 / CONFIG.NET_SEND_RATE;
      if (this._netAccumulator >= interval) {
        this._netAccumulator -= interval;
        this._broadcastSnapshot();
      }
    } else {
      // CLIENTE: enviar nuestro input al host.
      const input = this.localController.getInput(state, dt);
      this.network.sendInput(input);
      // RETO ALUMNOS (avanzado): PREDICCIÓN DEL LADO DEL CLIENTE.
      //   Aplicar `input` a nuestro tanque inmediatamente (tank.applyInput +
      //   map.resolveCircle), guardar el input en un buffer indexado por `seq`
      //   y, al llegar un snapshot que confirme hasta cierto `seq`, corregir la
      //   posición y re-simular los inputs pendientes (reconciliación).
      //   Para ello el host debería incluir en el snapshot el último `seq`
      //   procesado de cada jugador (RemoteController.lastSeq).
      state.update(dt);
    }

    if (this.mirror) this.mirror.state.update(dt);
  }

  /** Envía mis imágenes personalizadas al host (sólo cliente). */
  _sendMySkins() {
    const s = window.TankSkins || {};
    this.network.sendSkin({ tank: s.tankDataUrl || null, missile: s.missileDataUrl || null });
  }

  /** Reúne las skins conocidas (propia + remotas) para incluirlas en un snapshot. */
  _collectSkins() {
    const out = {};
    const local = window.TankSkins || {};
    const mine = { tank: local.tankDataUrl || null, missile: local.missileDataUrl || null };
    if (mine.tank || mine.missile) out[this.localTankId] = mine;
    for (const [peerId, s] of this._remoteSkinData) {
      if (s.tank || s.missile) out[peerId] = s;
    }
    return out;
  }

  /** Aplica las skins recibidas en un snapshot: carga las imágenes nuevas. */
  _applyRemoteSkins(skins) {
    for (const [tankId, s] of Object.entries(skins)) {
      let entry = this._remoteSkinImages.get(tankId);
      if (!entry) {
        entry = { tank: null, missile: null, tankUrl: null, missileUrl: null };
        this._remoteSkinImages.set(tankId, entry);
      }
      for (const kind of ['tank', 'missile']) {
        const url = s[kind];
        if (!url || entry[kind + 'Url'] === url) continue;
        entry[kind + 'Url'] = url;
        const img = new Image();
        img.onload = () => { entry[kind] = img; };
        img.onerror = () => { entry[kind] = null; };
        img.src = url;
      }
    }
    // Limpiar skins de tanques que ya no existen.
    for (const id of Array.from(this._remoteSkinImages.keys())) {
      if (!this.state.tanks.has(id)) this._remoteSkinImages.delete(id);
    }
    this.renderer.remoteSkins = this._remoteSkinImages;
  }

  _broadcastSnapshot() {
    const state = this.state;
    // El mapa sólo viaja cuando cambia, más un "keyframe" cada ~2 s por si se
    // perdió un paquete en un canal no fiable.
    const includeMap = state.map.revision !== this._lastSentMapRevision ||
      this._snapshotsSinceMap >= CONFIG.NET_SEND_RATE * 2;
    if (includeMap) {
      this._lastSentMapRevision = state.map.revision;
      this._snapshotsSinceMap = 0;
    } else {
      this._snapshotsSinceMap++;
    }

    const snapshot = state.serialize({ includeMap });
    snapshot.matchId = this._matchId; // si el host reinicia, el cliente acepta la partida nueva
    // Skins: se envían cuando cambian y en el keyframe periódico (como el mapa).
    const includeSkins = this._skinsDirty || this._snapshotsSinceMap >= CONFIG.NET_SEND_RATE * 2;
    if (includeSkins) {
      snapshot.skins = this._collectSkins();
      this._skinsDirty = false;
    }
    this.network.broadcastState(snapshot);
    if (this.mirror) this.mirror.adapter.broadcastState(snapshot);
    this.lastSnapshotBytes = this.network.stats.lastPacketBytes;
  }

  // ==========================================================================
  //  RED: mensajes entrantes (lógica de juego ya cableada)
  // ==========================================================================
  /**
   * Punto único de entrada de los paquetes de red.
   * RETO ALUMNOS: en cuanto vuestro NetworkAdapter llame a _emit(), este
   * método ya conecta los paquetes con el GameState.
   */
  _handleNetMessage(msg, from) {
    if (!msg || !this.state || !this._netReady) return;
    const now = performance.now() / 1000;

    switch (msg.type) {
      case NET_MSG.JOIN:
        if (this.isHost) {
          if (msg.data && msg.data.name) this._peerNames.set(from, msg.data.name);
          if (msg.data && msg.data.modelId) this._peerModels.set(from, msg.data.modelId);
          this._admitRemotePeer(from, msg.data && msg.data.name, msg.data && msg.data.modelId);
        }
        break;

      case NET_MSG.INPUT: {
        if (!this.isHost) return;
        let ctrl = this.controllers.get(from);
        if (!ctrl) {
          // Unión implícita: usar el nombre guardado del JOIN si existe.
          const savedName = this._peerNames.get(from);
          if (!this._admitRemotePeer(from, savedName, this._peerModels.get(from))) return;
          ctrl = this.controllers.get(from);
        }
        if (ctrl instanceof RemoteController) ctrl.pushInput(msg.data, now);
        break;
      }

      case NET_MSG.SKIN:
        if (!this.isHost) return;
        if (msg.data) {
          this._remoteSkinData.set(from, { tank: msg.data.tank || null, missile: msg.data.missile || null });
          this._skinsDirty = true; // difundir en el próximo snapshot
        }
        break;

      case NET_MSG.STATE:
        if (this.isHost) return; // el host es la autoridad: ignora estados ajenos
        if (from !== 'host') return; // sólo aceptar snapshots del host identificado
        // Si el host reinició la partida, el tick vuelve a 0: aceptar la nueva
        // partida en lugar de descartar sus snapshots por "viejos".
        if (msg.data && msg.data.matchId !== undefined && msg.data.matchId !== this._lastMatchId) {
          this._lastMatchId = msg.data.matchId;
          this._lastAcceptedTick = -1;
        }
        // Descartar snapshots viejos fuera de orden (si el transporte no garantiza orden).
        if (msg.data && typeof msg.data.tick === 'number' && msg.data.tick < this._lastAcceptedTick) return;
        if (msg.data && typeof msg.data.tick === 'number') this._lastAcceptedTick = msg.data.tick;
        this.state.applySnapshot(msg.data);
        if (msg.data && msg.data.skins) this._applyRemoteSkins(msg.data.skins);
        this.receivedFirstSnapshot = true;
        break;

      case NET_MSG.LEAVE:
        if (this.isHost) this._removePeer(from);
        break;

      case NET_MSG.HOST_LEFT:
        if (!this.isHost) {
          alert('El anfitrión se desconectó. Volviendo al menú.');
          this.network.disconnect();
          this._showMenu();
        }
        break;

      case NET_MSG.ROOM_FULL:
        if (!this.isHost) {
          alert('La sala está llena (10 tanques). No se pudo unir.');
          this.network.disconnect();
          this._showMenu();
        }
        break;

      case NET_MSG.ERROR:
        if (!this.isHost) {
          const code = msg.data && msg.data.code;
          if (code === 'host-exists') {
            alert('Ya hay un anfitrión en esa sala. Elige otra sala.');
            this._showMenu();
          } else if (code === 'no-host') {
            alert('No hay anfitrión en esa sala. Primero crea la sala como Local / Host.');
            this._showMenu();
          } else {
            alert('Error de conexión: ' + ((msg.data && msg.data.message) || 'desconocido'));
            this._showMenu();
          }
        }
        break;

      default:
        console.warn('[Game] mensaje de red desconocido', msg);
    }
  }

  /**
   * Crea el tanque de un jugador remoto. Si la sala está llena (10), reemplaza
   * a un bot; si sólo hay humanos, rechaza la conexión.
   */
  _admitRemotePeer(peerId, name, modelId) {
    const state = this.state;
    if (state.tanks.has(peerId)) return true;
    if (state.getFreeSlot() < 0) {
      const bot = Array.from(state.tanks.values()).find((t) => t.isBot);
      if (!bot) {
        // Sala llena sin bots: avisar al cliente y rechazar.
        this.network.sendToPeer(peerId, NET_MSG.ROOM_FULL, {});
        return false;
      }
      state.removeTank(bot.id);
      this.controllers.delete(bot.id);
    }
    const slot = state.getFreeSlot();
    const tank = state.addTank({ id: peerId, name: name || `Jugador ${slot + 1}`, modelId });
    if (!tank) return false;
    const ctrl = new RemoteController(peerId);
    ctrl.lastReceivedAt = performance.now() / 1000;
    this.controllers.set(peerId, ctrl);
    this._skinsDirty = true; // el recién llegado debe recibir las skins pronto
    // Forzar envío del mapa actual en el próximo snapshot (jugador que entra a mitad de partida).
    this._lastSentMapRevision = -1;
    this._snapshotsSinceMap = 0;
    console.info(`[Game] peer ${peerId} → slot ${tank.slot} (${tank.color.name})`);
    return true;
  }

  _removePeer(peerId) {
    if (!(this.controllers.get(peerId) instanceof RemoteController)) return;
    this.controllers.delete(peerId);
    this.state.removeTank(peerId);
    this._peerNames.delete(peerId);
    this._peerModels.delete(peerId);
    this._remoteSkinData.delete(peerId);
    this._skinsDirty = true;
    console.info(`[Game] peer ${peerId} desconectado`);
  }

  _checkPeerTimeouts() {
    const now = performance.now() / 1000;
    for (const [id, ctrl] of this.controllers) {
      if (ctrl instanceof RemoteController && now - ctrl.lastReceivedAt > CONFIG.NET_PEER_TIMEOUT) {
        this._removePeer(id);
      }
    }
  }

  // ==========================================================================
  //  DEPURACIÓN: réplica por red simulada (tecla G)
  // ==========================================================================
  toggleMirror() {
    if (this.mirror) {
      this._disableMirror();
      return;
    }
    if (!this.isHost) return;
    const adapter = new LoopbackAdapter({ latencyMs: 120, jitterMs: 30, packetLoss: 0.05 });
    adapter.init('mirror', false);
    const replica = new GameState({ isAuthority: false });
    adapter.onPeerMessage((msg) => {
      if (msg.type === NET_MSG.STATE) replica.applySnapshot(msg.data);
    });
    this.mirror = { adapter, state: replica };
    this._lastSentMapRevision = -1; // forzar envío del mapa a la réplica
  }

  _disableMirror() {
    if (!this.mirror) return;
    this.mirror.adapter.disconnect();
    this.mirror = null;
  }

  // ==========================================================================
  //  ENTRADA GLOBAL, SONIDO, VARIOS
  // ==========================================================================
  _handleHotkeys() {
    const k = this.input;
    if (k.consumePressed('KeyP') || k.consumePressed('Escape')) {
      // En red, pausar al cliente detendría sus envíos y el host lo expulsaría por timeout.
      // Por eso el cliente en línea no pausa; sólo el host/local puede pausar.
      if (!this.isHost && this.network.connected) return;
      this.paused = !this.paused;
      this.accumulator = 0;
    }
    if (k.consumePressed('KeyR')) this.restart();
    if (k.consumePressed('KeyG')) this.toggleMirror();
    if (k.consumePressed('KeyM')) this.audio.toggleMute();
    if (k.consumePressed('KeyB') && this.isHost) {
      const me = this.state.tanks.get(this.localTankId);
      if (me) me.maxBounces = me.maxBounces === 1 ? 2 : 1;
    }
  }

  _playEventSound(ev) {
    switch (ev.type) {
      case 'shot': {
        const owner = this.state.tanks.get(ev.ownerId);
        const m = owner && window.TankModels ? window.TankModels.get(owner.modelId) : null;
        if (m && m.custom === 'cryo') this.audio.play('cryoShot');
        else if (m && m.custom === 'cruzazul') this.audio.play('cazShot');
        else if (m && m.custom === 'america') this.audio.play('ameShot');
        else if (m && m.custom === 'void01') this.audio.play('voidShot');
        else this.audio.play('shot');
        break;
      }
      case 'bounce': this.audio.play('bounce'); break;
      case 'blockDestroyed': this.audio.play('block'); break;
      case 'bulletClash': this.audio.play('clash'); break;
      case 'tankDestroyed': this.audio.play('explosion'); break;
      case 'roundStart': this.audio.play('round'); break;
      // --- Criogénicos ---
      case 'cryoHit': this.audio.play('cryoHit'); break;
      case 'frozen': this.audio.play('frozen'); break;
      case 'shatter': this.audio.play('shatter'); break;
      case 'absoluteZero': this.audio.play('absoluteZero'); break;
      case 'absoluteZeroHit': this.audio.play('frozen'); break;
      case 'thawed': this.audio.play('thaw'); break;
      // --- PRIDE OVERLORD ---
      case 'prShot': this.audio.play('prShot'); break;
      case 'prChargeStart': this.audio.prCharge(ev.id, true); break;
      case 'prChargeCancel': this.audio.prCharge(ev.id, false); break;
      case 'prChargeFull': this.audio.play('prFull'); break;
      case 'prChargedShot': this.audio.prCharge(ev.ownerId, false); this.audio.play('prBig'); break;
      case 'prBlast': this.audio.play('prBlast'); break;
      case 'prWave': this.audio.play('prWave'); break;
      case 'prShieldOn': this.audio.play('prShield'); break;
      case 'prShieldHit': this.audio.play('prShieldHit'); break;
      case 'prShieldBreak': this.audio.play('prShieldBreak'); break;
      case 'prBoostStart': this.audio.play('prBoost'); break;
      case 'prZoneCast': this.audio.play('prCast'); break;
      case 'prZoneOn': this.audio.play('prZoneOn'); break;
      case 'prZonePulse': this.audio.play('prPulse'); break;
      case 'prNoEnergy': if (ev.id === this.localTankId) this.audio.play('prNoEnergy'); break;
      case 'samariemm': {
        const now = performance.now() / 1000;
        if (!this._samSoundTime || (now - this._samSoundTime) > 1.0) {
          this._samSoundTime = now;
          this.audio.play('prCelebrate');
        }
        break;
      }
      // --- CRUZ AZUL ---
      case 'cazPulse': this.audio.play('cazPulse'); break;
      case 'cazBoostStart': this.audio.play('cazBoost'); break;
      case 'cruzazulWin': {
        const now = performance.now() / 1000;
        if (!this._cazSoundTime || (now - this._cazSoundTime) > 1.0) {
          this._cazSoundTime = now;
          this.audio.play('cazWin');
        }
        break;
      }
      // --- AMÉRICA ---
      case 'amePulse': this.audio.play('amePulse'); break;
      case 'ameBoostStart': this.audio.play('ameBoost'); break;
      case 'ameRevive': this.audio.play('ameRevive'); break;
      case 'americaWin': {
        const now = performance.now() / 1000;
        if (!this._ameSoundTime || (now - this._ameSoundTime) > 1.0) {
          this._ameSoundTime = now;
          this.audio.play('ameWin');
        }
        break;
      }
      // --- VOID-01 ---
      case 'voidExplode': this.audio.play('voidExplode'); break;
      case 'voidNuke': this.audio.play('voidNuke'); break;
      case 'voidTeleport': this.audio.play('voidTeleport'); break;
      case 'voidShieldHit': this.audio.play('voidShieldHit'); break;
      case 'voidAimbotToggle': if (ev.ownerId === this.localTankId) this.audio.play('voidAimbot'); break;
      case 'void01Win': {
        const now = performance.now() / 1000;
        if (!this._voidSoundTime || (now - this._voidSoundTime) > 1.0) {
          this._voidSoundTime = now;
          this.audio.play('voidWin');
        }
        break;
      }
      default: break;
    }
  }

  _updateFps(dt) {
    this._fpsFrames++;
    this._fpsTime += dt;
    if (this._fpsTime >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsTime);
      this._fpsFrames = 0;
      this._fpsTime = 0;
    }
  }

  /** Escala el canvas por CSS manteniendo la proporción (la resolución interna no cambia). */
  _fitCanvas() {
    const w = this.canvas.width, h = this.canvas.height;
    const availW = this.stage.clientWidth;
    const availH = this.stage.clientHeight;
    if (!availW || !availH) return;
    const scale = Math.min(availW / w, availH / h);
    this.canvas.style.width = `${Math.floor(w * scale)}px`;
    this.canvas.style.height = `${Math.floor(h * scale)}px`;
  }
}

/**
 * ============================================================================
 *  HUD — Panel lateral en el DOM (se actualiza 4 veces/seg, no cada frame).
 * ============================================================================
 */
class HUD {
  constructor(game) {
    this.game = game;
    this.el = {
      scoreboard: document.getElementById('scoreboard'),
      netStats: document.getElementById('net-stats'),
      fps: document.getElementById('fps'),
      bounces: document.getElementById('bounce-mode'),
      cryoHud: document.getElementById('cryo-hud'),
      cryoTemp: document.getElementById('cryo-temp'),
      cryoTempText: document.getElementById('cryo-temp-text'),
      cryoSpecial: document.getElementById('cryo-special'),
      cryoSpecialText: document.getElementById('cryo-special-text'),
      prideHud: document.getElementById('pride-hud'),
      prideEnergy: document.getElementById('pride-energy'),
      prideEnergyText: document.getElementById('pride-energy-text'),
      prideCharge: document.getElementById('pride-charge'),
      prideChargeText: document.getElementById('pride-charge-text'),
      prideWave: document.getElementById('pride-wave'),
      prideWaveText: document.getElementById('pride-wave-text'),
      prideShield: document.getElementById('pride-shield'),
      prideShieldText: document.getElementById('pride-shield-text'),
      prideZone: document.getElementById('pride-zone'),
      prideZoneText: document.getElementById('pride-zone-text'),
      cazHud: document.getElementById('cruzazul-hud'),
      cazPulse: document.getElementById('caz-pulse'),
      cazPulseText: document.getElementById('caz-pulse-text'),
      cazBoost: document.getElementById('caz-boost'),
      cazBoostText: document.getElementById('caz-boost-text'),
      cazShield: document.getElementById('caz-shield'),
      cazShieldText: document.getElementById('caz-shield-text'),
      ameHud: document.getElementById('america-hud'),
      amePulse: document.getElementById('ame-pulse'),
      amePulseText: document.getElementById('ame-pulse-text'),
      ameBoost: document.getElementById('ame-boost'),
      ameBoostText: document.getElementById('ame-boost-text'),
      ameRevive: document.getElementById('ame-revive'),
      ameReviveText: document.getElementById('ame-revive-text'),
      voidHud: document.getElementById('void01-hud'),
      voidNuke: document.getElementById('void-nuke'),
      voidNukeText: document.getElementById('void-nuke-text'),
      voidAimbot: document.getElementById('void-aimbot'),
      voidAimbotText: document.getElementById('void-aimbot-text'),
      voidTeleport: document.getElementById('void-teleport'),
      voidTeleportText: document.getElementById('void-teleport-text'),
      voidShield: document.getElementById('void-shield'),
      voidShieldText: document.getElementById('void-shield-text'),
    };
    this._timer = 0;
    this._cache = {};
  }

  _set(key, html) {
    const el = this.el[key];
    if (!el || this._cache[key] === html) return;
    this._cache[key] = html;
    el.innerHTML = html;
  }

  /** Actualiza el ancho de una barra de progreso (0..1) sin tocar el DOM si no cambió. */
  _setBar(key, fraction) {
    const el = this.el[key];
    if (!el) return;
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    const style = `width:${pct}%`;
    if (this._cache[key] === style) return;
    this._cache[key] = style;
    el.style.width = pct + '%';
  }

  update(dt) {
    this._timer -= dt;
    if (this._timer > 0) return;
    this._timer = 0.25;

    const g = this.game;
    const s = g.state;
    if (!s) return;

    // Marcador
    const tanks = Array.from(s.tanks.values()).sort((a, b) => a.slot - b.slot);
    let rows = '';
    for (const t of tanks) {
      const me = t.id === g.localTankId;
      rows += `<li class="${t.isAlive ? '' : 'dead'} ${me ? 'me' : ''}">
        <span class="swatch" style="background:${t.color.body};border-color:${t.color.dark}"></span>
        <span class="name">${escapeHtml(t.name)}${me ? ' <em>(tú)</em>' : ''}${t.isBot ? ' <small>BOT</small>' : ''}</span>
        <span class="stat" title="Bajas">${t.score}</span>
        <span class="stat wins" title="Rondas ganadas">${t.wins}</span>
      </li>`;
    }
    this._set('scoreboard', rows || '<li class="empty">Sin jugadores</li>');

    // Rebotes del jugador
    const me = s.tanks.get(g.localTankId);
    this._set('bounces', me ? `${me.maxBounces} rebote${me.maxBounces > 1 ? 's' : ''}` : '—');

    // Panel criogénico: visible sólo si tu tanque es el FROST REAPER.
    const isCryo = !!(me && window.TankModels && window.TankModels.get(me.modelId).custom === 'cryo');
    if (this.el.cryoHud) {
      this.el.cryoHud.classList.toggle('hidden', !isCryo);
      if (isCryo && me) {
        const charge = 1 - Math.max(0, Math.min(1, me.specialCooldown / CONFIG.CRYO.SPECIAL_COOLDOWN));
        const tempC = Math.round(-20 - 176 * charge); // −20 °C vacío → −196 °C (cero absoluto) listo
        this._setBar('cryoTemp', charge);
        this._set('cryoTempText', tempC + ' °C');
        this._setBar('cryoSpecial', charge);
        this._set('cryoSpecialText', charge >= 1 ? 'LISTO' : Math.ceil(me.specialCooldown) + ' s');
      }
    }

    // Panel de PRIDE OVERLORD: visible sólo si tu tanque es PRIDE.
    const isPride = !!(me && me.mods && me.mods.pride);
    if (this.el.prideHud) {
      this.el.prideHud.classList.toggle('hidden', !isPride);
      if (isPride && me) {
        const P = CONFIG.PRIDE;
        this._setBar('prideEnergy', me.prEnergy / P.energy.max);
        this._set('prideEnergyText', Math.floor(me.prEnergy) + (me.prBoosting ? ' · TURBO' : ''));
        if (me.prCharging) {
          const c = MathUtil.clamp(me.prCharge / P.chargedShot.maxChargeTime, 0, 1);
          this._setBar('prideCharge', c);
          this._set('prideChargeText', Math.round(c * 100) + ' %');
        } else {
          this._setBar('prideCharge', 1 - Math.max(0, Math.min(1, me.prChargeCd / P.chargedShot.cooldown)));
          this._set('prideChargeText', me.prChargeCd > 0 ? Math.ceil(me.prChargeCd) + ' s' : 'LISTO');
        }
        this._setBar('prideWave', 1 - Math.max(0, Math.min(1, me.prWaveCd / P.prideWave.cooldown)));
        this._set('prideWaveText', me.prWaveCd > 0 ? Math.ceil(me.prWaveCd) + ' s' : 'LISTO');
        if (me.prShieldT > 0) {
          this._setBar('prideShield', me.prShieldT / P.rainbowShield.duration);
          this._set('prideShieldText', me.prShieldT.toFixed(1) + ' s');
        } else {
          this._setBar('prideShield', 1 - Math.max(0, Math.min(1, me.prShieldCd / P.rainbowShield.cooldown)));
          this._set('prideShieldText', me.prShieldCd > 0 ? Math.ceil(me.prShieldCd) + ' s' : 'LISTO');
        }
        this._setBar('prideZone', 1 - Math.max(0, Math.min(1, me.prZoneCd / P.sonicZone.cooldown)));
        this._set('prideZoneText', me.prZoneCd > 0 ? Math.ceil(me.prZoneCd) + ' s' : 'LISTO');
      }
    }

    // Panel de CRUZ AZUL: visible sólo si tu tanque es LA MÁQUINA.
    const isCaz = !!(me && me.mods && me.mods.cruzazul);
    if (this.el.cazHud) {
      this.el.cazHud.classList.toggle('hidden', !isCaz);
      if (isCaz && me) {
        const C = CONFIG.CRUZAZUL;
        this._setBar('cazPulse', 1 - Math.max(0, Math.min(1, (me.cazPulseCd || 0) / C.special.cooldown)));
        this._set('cazPulseText', (me.cazPulseCd || 0) > 0 ? Math.ceil(me.cazPulseCd) + ' s' : 'LISTO');
        if (me.cazBoosting) {
          this._setBar('cazBoost', 1);
          this._set('cazBoostText', 'TURBO');
        } else {
          this._setBar('cazBoost', 1 - Math.max(0, Math.min(1, (me.cazBoostCd || 0) / C.boost.cooldown)));
          this._set('cazBoostText', (me.cazBoostCd || 0) > 0 ? Math.ceil(me.cazBoostCd) + ' s' : 'LISTO');
        }
        this._setBar('cazShield', me.hasShield ? 1 : 0);
        this._set('cazShieldText', me.hasShield ? 'ACTIVO' : 'ROTO');
      }
    }

    // Panel de AMÉRICA: visible sólo si tu tanque es ÁGUILAS DEL AMÉRICA.
    const isAme = !!(me && me.mods && me.mods.america);
    if (this.el.ameHud) {
      this.el.ameHud.classList.toggle('hidden', !isAme);
      if (isAme && me) {
        const C = CONFIG.AMERICA;
        this._setBar('amePulse', 1 - Math.max(0, Math.min(1, (me.amePulseCd || 0) / C.special.cooldown)));
        this._set('amePulseText', (me.amePulseCd || 0) > 0 ? Math.ceil(me.amePulseCd) + ' s' : 'LISTO');
        if (me.ameBoosting) {
          this._setBar('ameBoost', 1);
          this._set('ameBoostText', 'TURBO');
        } else {
          this._setBar('ameBoost', 1 - Math.max(0, Math.min(1, (me.ameBoostCd || 0) / C.boost.cooldown)));
          this._set('ameBoostText', (me.ameBoostCd || 0) > 0 ? Math.ceil(me.ameBoostCd) + ' s' : 'LISTO');
        }
        this._setBar('ameRevive', me.ameReviveUsed ? 0 : 1);
        this._set('ameReviveText', me.ameReviveUsed ? 'USADO' : 'LISTO');
      }
    }

    // Panel de VOID-01: visible sólo si tu tanque es la SOMBRA NEGRA.
    const isVoid = !!(me && me.mods && me.mods.void01);
    if (this.el.voidHud) {
      this.el.voidHud.classList.toggle('hidden', !isVoid);
      if (isVoid && me) {
        const C = CONFIG.VOID01;
        this._setBar('voidNuke', 1 - Math.max(0, Math.min(1, (me.voidNukeCd || 0) / C.nuke.cooldown)));
        this._set('voidNukeText', (me.voidNukeCd || 0) > 0 ? Math.ceil(me.voidNukeCd) + ' s' : 'LISTO');
        this._setBar('voidAimbot', me.voidAimbot ? 1 : 0);
        this._set('voidAimbotText', me.voidAimbot ? 'ON' : 'OFF');
        this._setBar('voidTeleport', 1 - Math.max(0, Math.min(1, (me.voidTeleportCd || 0) / C.teleport.cooldown)));
        this._set('voidTeleportText', (me.voidTeleportCd || 0) > 0 ? Math.ceil(me.voidTeleportCd) + ' s' : 'LISTO');
        const hits = me.voidShieldHits || 0;
        this._setBar('voidShield', hits / C.shield.maxHits);
        this._set('voidShieldText', hits + ' / ' + C.shield.maxHits);
      }
    }

    // Red
    const bytes = g.lastSnapshotBytes;
    const uploadKBs = (bytes * CONFIG.NET_SEND_RATE * (CONFIG.MAX_PLAYERS - 1)) / 1024;
    const mode = g.isHost ? 'Host (autoridad)' : 'Cliente';
    this._set('netStats', `
      <dt>Modo</dt><dd>${mode}</dd>
      <dt>Sala / peerId</dt><dd>${escapeHtml(g.options ? g.options.roomId : '-')} / ${escapeHtml(g.localTankId || '-')}</dd>
      <dt>Tick</dt><dd>${s.tick}</dd>
      <dt>Tanques</dt><dd>${s.tanks.size} / ${CONFIG.MAX_PLAYERS}</dd>
      <dt>Balas</dt><dd>${s.bullets.size}</dd>
      <dt>Snapshot</dt><dd>${bytes} B @ ${CONFIG.NET_SEND_RATE} Hz</dd>
      <dt>Subida host (9 peers)</dt><dd>≈ ${uploadKBs.toFixed(1)} KB/s</dd>
      <dt>Réplica (G)</dt><dd>${g.mirror ? 'ON · 120 ms ±30 · 5% pérdida' : 'OFF'}</dd>
    `);

    this._set('fps', `${g.fps} FPS`);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================================
//  ARRANQUE
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  const game = new Game({
    canvas: document.getElementById('game'),
    stage: document.getElementById('stage'),
  });
  window.game = game; // accesible desde la consola para depurar

  const menu = document.getElementById('menu');
  const form = document.getElementById('menu-form');
  const params = new URLSearchParams(location.search);
  if (params.get('room')) form.room.value = params.get('room');
  if (params.get('mode') === 'client') form.mode.value = 'client';

  const syncModeUI = () => {
    form.bots.disabled = form.mode.value === 'client';
  };
  form.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', syncModeUI));
  syncModeUI();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const isHost = form.mode.value !== 'client';
    const rawName = form.playerName.value.trim();
    // Código secreto VOID-01: si el nombre es el código, desbloquea el modelo oculto.
    if (window.TankModels && window.TankModels.unlockSecret) {
      const secret = (typeof CONFIG !== 'undefined' && CONFIG.VOID01) ? CONFIG.VOID01.SECRET_CODE : '';
      if (secret && rawName.toLowerCase() === secret.toLowerCase()) {
        window.TankModels.unlockSecret();
        // Cambiar el nombre visible para no mostrar el código en partida.
        form.playerName.value = 'VOID-01';
      }
    }
    menu.classList.add('hidden');
    document.activeElement && document.activeElement.blur();
    game.start({
      roomId: form.room.value.trim() || 'sala-local',
      isHost,
      botCount: parseInt(form.bots.value, 10) || 0,
      playerName: form.playerName.value.trim().slice(0, 14) || 'Jugador',
    });
  });

  // Los botones pierden el foco tras el clic para que Espacio no los "pulse".
  const onClick = (id, fn) => document.getElementById(id).addEventListener('click', (e) => {
    e.currentTarget.blur();
    fn();
  });
  onClick('btn-menu', () => {
    game.paused = true;
    try { game.network.disconnect(); } catch (_) {}
    menu.classList.remove('hidden');
  });
  onClick('btn-restart', () => game.restart());
  onClick('btn-mirror', () => game.toggleMirror());
});
