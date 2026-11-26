'use strict';
/**
 * ============================================================================
 *  network.js — Capa de red WebSocket (host autoritativo en estrella).
 * ============================================================================
 *
 *  ARQUITECTURA: HOST AUTORITATIVO EN ESTRELLA + SERVIDOR RELAY
 *  -------------------------------------------------------------
 *
 *        Cliente A ──INPUT──►┐                 ┌──STATE──► Cliente A
 *        Cliente B ──INPUT──►│  HOST (simula)  │──STATE──► Cliente B
 *          ...       ...     │   GameState     │   ...
 *        Cliente I ──INPUT──►┘ isAuthority=true└──STATE──► Cliente I
 *                              ▲
 *                              │ WebSocket relay (server.js)
 *                              │ agrupa por sala y reenvía
 *
 *   - Sólo el HOST ejecuta GameState.update() con reglas (isAuthority = true).
 *   - Los CLIENTES envían su InputPayload cada tick (sendInput) y reciben
 *     snapshots (~20 Hz) que aplican con GameState.applySnapshot().
 *   - El servidor (server.js en Node o worker.js en Cloudflare) NO simula:
 *     sólo agrupa conexiones por sala, verifica que haya un único host por
 *     sala y reenvía mensajes. El mismo protocolo funciona en ambos.
 *
 *  PROTOCOLO (sobres JSON). Cada mensaje tiene la forma:
 *      { type: NET_MSG.*, from: peerId, data: ... }
 *
 *   JOIN       (cliente → host)  data = { name }  (se envía al conectar)
 *   INPUT      (cliente → host)  data = InputPayload {seq, throttle, turn, aimAngle, fire}
 *   STATE      (host → clientes) data = GameState.serialize() (snapshot)
 *   LEAVE      (cualquiera)      data = {}        (aviso de salida)
 *   HOST_LEFT  (servidor → clientes) data = {}    (el host se desconectó)
 *   ROOM_FULL  (host → cliente)  data = {}        (sala llena, sin bots que reemplazar)
 *   ERROR      (servidor → peer) data = { code, message } (sin host, host duplicado, etc.)
 *
 *  IDENTIDAD: el ID del tanque de un jugador remoto ES su peerId.
 *  El host crea el tanque al recibir JOIN/INPUT y le asigna el primer slot libre.
 *  El cliente localiza "su" tanque buscando su propio localPeerId en el snapshot.
 * ============================================================================
 */

/** Tipos de mensaje del protocolo. */
const NET_MSG = Object.freeze({
  JOIN: 'join',
  INPUT: 'input',
  STATE: 'state',
  LEAVE: 'leave',
  HOST_LEFT: 'host-left',
  ROOM_FULL: 'room-full',
  ERROR: 'error',
  WELCOME: 'welcome',
  SKIN: 'skin',
});

class NetworkAdapter {
  constructor() {
    this.roomId = null;
    this.isHost = true;
    this.localPeerId = null;
    this.connected = false;
    this.socket = null;
    this.playerName = 'Jugador';
    /** @type {Array<(message:object, fromPeerId:string) => void>} */
    this._listeners = [];
    this.stats = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, lastPacketBytes: 0 };
  }

  _wsUrl(roomId, isHost) {
    const params = new URLSearchParams(location.search);
    // Permite forzar servidor con ?server=192.168.1.10:8000 o ?server=mi-worker.workers.dev
    let hostPort = params.get('server');
    if (!hostPort) {
      const host = location.hostname || 'localhost';
      // En Cloudflare (https) y en producción el puerto viene vacío: no agregar :8000.
      // Solo en desarrollo local (http con puerto explícito) se usa ese puerto.
      const port = location.port;
      const isDefaultPort = !port || port === '80' || port === '443';
      if (!host) {
        hostPort = 'localhost:8000';
      } else if (isDefaultPort) {
        hostPort = host;
      } else {
        hostPort = host + ':' + port;
      }
      // Si se abrió con file:// (sin host), forzar localhost:8000 para el servidor Node.
      if (location.protocol === 'file:') hostPort = 'localhost:8000';
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const role = isHost ? 'host' : 'client';
    return proto + '://' + hostPort + '/ws?room=' + encodeURIComponent(roomId) +
      '&role=' + role + '&peerId=' + encodeURIComponent(this.localPeerId) +
      '&name=' + encodeURIComponent(this.playerName) +
      '&model=' + encodeURIComponent(this.modelId || '');
  }

  /**
   * Inicializa la conexión a una sala.
   * @param {string} roomId  identificador de la sala (lo comparten todos los jugadores)
   * @param {boolean} isHost true si este peer simula la partida (autoridad)
   * @param {string} [playerName] nombre visible (para JOIN)
   * @param {string} [modelId] modelo de tanque elegido (para JOIN)
   * @returns {Promise<string>} el peerId local (será el ID de nuestro tanque)
   */
  async init(roomId, isHost, playerName = 'Jugador', modelId = null) {
    this.roomId = roomId;
    this.isHost = isHost;
    this.playerName = playerName || 'Jugador';
    this.modelId = modelId || null;
    this.localPeerId = isHost ? 'host' : 'peer-' + Math.random().toString(36).slice(2, 8);

    const url = this._wsUrl(roomId, isHost);
    console.info('[NetworkAdapter] conectando a ' + url);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { if (this.socket) this.socket.close(); } catch (_) {}
        if (isHost) {
          console.warn('[NetworkAdapter] sin servidor WebSocket: modo local (sin multijugador).');
          this.connected = false;
          resolve(this.localPeerId);
        } else {
          reject(new Error('No se pudo conectar al servidor. Revisa que el servidor esté corriendo y que la sala exista.'));
        }
      }, 3000);

      try {
        this.socket = new WebSocket(url);
      } catch (e) {
        clearTimeout(timeout);
        if (isHost) {
          console.warn('[NetworkAdapter] WebSocket no disponible: modo local.', e);
          this.connected = false;
          resolve(this.localPeerId);
          return;
        }
        reject(e);
        return;
      }

      this.socket.onopen = () => {
        this.connected = true;
        console.info('[NetworkAdapter] conectado como ' + this.localPeerId + ' (host=' + isHost + ')');
        if (!isHost) {
          // Enviar JOIN inmediatamente con el nombre y el modelo para que el host lo registre.
          this.sendJoin(this.playerName, this.modelId);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(this.localPeerId);
        }
      };

      this.socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        // El servidor puede enviar welcome/error; los reenviamos al juego.
        if (msg.type === NET_MSG.WELCOME) {
          if (msg.data && msg.data.peerId) this.localPeerId = msg.data.peerId;
          return;
        }
        if (msg.type === NET_MSG.ERROR) {
          console.warn('[NetworkAdapter] error del servidor:', msg.data);
          this._emit(msg, msg.from || 'server');
          if (!settled && !isHost) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error((msg.data && msg.data.message) || 'Error de conexión'));
          }
          return;
        }
        // Mensajes de juego: el servidor ya puso el 'from' correcto.
        this._emit(msg, msg.from);
      };

      this.socket.onerror = () => {
        // onclose se disparará después; no rechazamos aquí para evitar doble.
      };

      this.socket.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (isHost) {
            console.warn('[NetworkAdapter] conexión cerrada: modo local.');
            resolve(this.localPeerId);
          } else {
            reject(new Error('Conexión cerrada por el servidor.'));
          }
          return;
        }
        // Si era cliente y el host se fue, el servidor ya envió HOST_LEFT.
        // Si la conexión se cayó sin aviso, avisamos al juego.
        if (!isHost && wasConnected) {
          this._emit({ type: NET_MSG.HOST_LEFT, from: 'host', data: {} }, 'host');
        }
      };
    });
  }

  _sendRaw(obj) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const json = JSON.stringify(obj);
    this.stats.packetsSent++;
    this.stats.bytesSent += json.length;
    this.stats.lastPacketBytes = json.length;
    this.socket.send(json);
    return true;
  }

  sendJoin(name, modelId) {
    return this._sendRaw({
      type: NET_MSG.JOIN,
      from: this.localPeerId,
      data: { name: name || this.playerName, modelId: modelId || this.modelId || null },
    });
  }

  /**
   * CLIENTE → HOST: envía el input del tick actual (~60 veces/seg).
   * @param {object} payload InputPayload
   */
  sendInput(payload) {
    this._sendRaw({ type: NET_MSG.INPUT, from: this.localPeerId, data: payload });
  }

  /**
   * HOST → TODOS: difunde un snapshot del GameState (~20 veces/seg).
   * @param {object} state resultado de GameState.serialize()
   */
  broadcastState(state) {
    this._sendRaw({ type: NET_MSG.STATE, from: this.localPeerId, data: state });
  }

  /**
   * CLIENTE → HOST: envía las imágenes personalizadas (data URLs ya reducidas)
   * para que el host las incluya en los snapshots y todos las vean.
   * @param {object} payload { tank: string|null, missile: string|null }
   */
  sendSkin(payload) {
    return this._sendRaw({ type: NET_MSG.SKIN, from: this.localPeerId, data: payload });
  }

  /** HOST → un peer específico (p. ej. sala llena). */
  sendToPeer(peerId, type, data) {
    return this._sendRaw({ type, to: peerId, from: this.localPeerId, data: data || {} });
  }

  /**
   * Registra un callback para TODO mensaje entrante.
   * @param {(message:object, fromPeerId:string) => void} callback
   * @returns {() => void} función para cancelar la suscripción
   */
  onPeerMessage(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== callback);
    };
  }

  /**
   * Entrega un mensaje recibido a los suscriptores.
   */
  _emit(message, fromPeerId) {
    this.stats.packetsReceived++;
    for (const l of this._listeners) l(message, fromPeerId);
  }

  /** Cierra todas las conexiones. */
  disconnect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try { this._sendRaw({ type: NET_MSG.LEAVE, from: this.localPeerId, data: {} }); } catch (_) {}
    }
    try { if (this.socket) this.socket.close(); } catch (_) {}
    this.socket = null;
    this.connected = false;
  }
}

/**
 * ============================================================================
 *  LoopbackAdapter — "red falsa" para depurar SIN implementar transporte.
 * ============================================================================
 *  Reenvía los snapshots a sí mismo pasando por JSON.stringify/parse (como un
 *  cable real) con latencia, jitter y pérdida simulados. Game lo usa para el
 *  modo "fantasma" (tecla G): una réplica no autoritativa del GameState que
 *  se dibuja superpuesta, demostrando que serialize()/deserialize() bastan
 *  para reconstruir la partida en otro equipo.
 * ============================================================================
 */
class LoopbackAdapter extends NetworkAdapter {
  constructor({ latencyMs = 120, jitterMs = 30, packetLoss = 0.05 } = {}) {
    super();
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.packetLoss = packetLoss;
    this._timers = new Set();
  }

  async init(roomId, isHost) {
    this.roomId = roomId;
    this.isHost = isHost;
    this.localPeerId = 'loopback';
    this.connected = true;
    return this.localPeerId;
  }

  _deliver(json) {
    this.stats.packetsSent++;
    this.stats.bytesSent += json.length;
    this.stats.lastPacketBytes = json.length;
    if (Math.random() < this.packetLoss) return; // paquete perdido
    const delay = Math.max(0, this.latencyMs + MathUtil.randRange(-this.jitterMs, this.jitterMs));
    const id = setTimeout(() => {
      this._timers.delete(id);
      const msg = JSON.parse(json);
      this._emit(msg, msg.from);
    }, delay);
    this._timers.add(id);
  }

  sendInput(payload) {
    this._deliver(JSON.stringify({ type: NET_MSG.INPUT, from: this.localPeerId, data: payload }));
  }

  broadcastState(state) {
    this._deliver(JSON.stringify({ type: NET_MSG.STATE, from: this.localPeerId, data: state }));
  }

  disconnect() {
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this.connected = false;
  }
}
