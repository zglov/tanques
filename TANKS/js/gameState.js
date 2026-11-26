'use strict';
/**
 * ============================================================================
 *  gameState.js — Estado centralizado y simulación autoritativa.
 * ============================================================================
 *  GameState es la "fuente de verdad" del juego:
 *     tanks   : Map<id, Tank>
 *     bullets : Map<id, Bullet>
 *     map     : TileMap
 *     round   : estado de la ronda
 *
 *  Dos modos de funcionamiento:
 *   - isAuthority = true  (HOST / modo local): simula física, colisiones,
 *                         muertes y rondas a partir de los inputs recibidos.
 *   - isAuthority = false (CLIENTE): NO simula reglas; sólo refleja los
 *                         snapshots del host (applySnapshot) e interpola.
 *
 *  Nada aquí toca el DOM ni el canvas → se podría ejecutar tal cual en un
 *  servidor Node.js (opción WebSockets con servidor autoritativo).
 *
 *  Comunicación hacia fuera mediante EVENTOS (this.events): explosiones,
 *  disparos, rebotes... El Renderer y el audio los consumen para efectos, y
 *  la capa de red puede reenviarlos a los clientes (van en el snapshot).
 * ============================================================================
 */
class GameState {
  constructor({ isAuthority = true } = {}) {
    this.isAuthority = isAuthority;
    this.map = new TileMap(CONFIG.MAP_LAYOUT);

    /** @type {Map<string, Tank>} */
    this.tanks = new Map();
    /** @type {Map<number, Bullet>} */
    this.bullets = new Map();
    /** @type {Map<string, object>} último InputPayload recibido por tanque */
    this.inputs = new Map();

    this.tick = 0;
    this.time = 0;
    this.round = { number: 1, phase: 'playing', timer: 0, winnerId: null };

    /** Eventos para efectos locales (Renderer / audio). Se vacían cada frame. */
    this.events = [];
    /** Eventos pendientes de enviar por red (se vacían al serializar). */
    this.netEvents = [];

    this._nextBulletId = 1;

    /**
     * Estado criogénico (CRYO-01 FROST REAPER):
     *  - waves: ondas de CERO ABSOLUTO activas {ownerId, x, y, radius, maxRadius, hit:Set}
     *  - frozenTiles: Map<"tx,ty", segundos restantes> suelo congelado temporal.
     */
    this.waves = [];
    this.frozenTiles = new Map();

    /**
     * Estado de PRIDE OVERLORD:
     *  - prZones: zonas de Gemidos activas {id, ownerId, x, y, sx, sy, age, active, hit, pulseT}
     *  - _prZoneId: contador de zonas; _prideUid: uid único para eventos pride.
     */
    this.prZones = [];
    this._prZoneId = 0;
    this._prideUid = 0;

    // Callbacks que la bala usa para notificar sucesos (evita acoplarla a GameState).
    this._bulletHooks = {
      onBounce: (b) => this.emit('bounce', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) }),
      onExpire: (b) => {
        // El Rayo del Orgullo explota contra la pared en vez de destruirse en silencio.
        if (b.kind === 'pcharge' && typeof PrideRules !== 'undefined') {
          PrideRules.explodeCharged(this, b, null);
          return;
        }
        // Plasma VOID-01: explota contra la pared.
        if (b.kind === 'void') {
          this._voidExplode(b.x, b.y, b.ownerId, b);
          return;
        }
        this.emit('bulletDestroyed', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) });
      },
      onBlockDestroyed: (b, tx, ty) => this.emit('blockDestroyed', { tx, ty, x: MathUtil.round(b.x), y: MathUtil.round(b.y) }),
    };
  }

  // ==========================================================================
  //  GESTIÓN DE ENTIDADES
  // ==========================================================================

  /** Primer slot libre (0..9) o -1 si la partida está llena. */
  getFreeSlot() {
    const used = new Set();
    for (const t of this.tanks.values()) used.add(t.slot);
    for (let s = 0; s < CONFIG.MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return -1;
  }

  /**
   * Añade un tanque con un ID único. El slot asigna color y punto de spawn.
   * @param {string} [modelId] modelo predeterminado (ver models.js)
   * @returns {Tank|null} null si no hay hueco.
   */
  addTank({ id, name, isBot = false, slot, modelId }) {
    if (this.tanks.has(id)) return this.tanks.get(id);
    const s = slot !== undefined ? slot : this.getFreeSlot();
    if (s < 0) return null;
    const tank = new Tank({ id, name: name || CONFIG.COLORS[s].name, slot: s, isBot });
    if (modelId && window.TankModels) tank.applyModel(window.TankModels.get(modelId));
    this.tanks.set(id, tank);
    this._placeAtSpawn(tank);
    // Si se une a mitad de ronda, entra muerto y aparece en la siguiente.
    if (this.isAuthority && this.round.phase !== 'playing') tank.isAlive = false;
    this.emit('playerJoined', { id, slot: s });
    return tank;
  }

  removeTank(id) {
    if (!this.tanks.delete(id)) return;
    this.inputs.delete(id);
    for (const b of this.bullets.values()) if (b.ownerId === id) b.alive = false;
    this.emit('playerLeft', { id });
  }

  /** Registra el último input de un tanque (local, IA o recibido por red). */
  setInput(id, input) {
    this.inputs.set(id, input);
  }

  /** Coloca un tanque en su punto de aparición (rota cada ronda para variar). */
  _placeAtSpawn(tank) {
    const sp = CONFIG.SPAWN_POINTS;
    const [stx, sty] = sp[(tank.slot + this.round.number - 1) % sp.length];
    const free = this.map.findNearestFreeTile(stx, sty);
    const c = this.map.tileCenter(free.tx, free.ty);
    // Orientar el chasis hacia el centro del mapa.
    const angle = Math.atan2(this.map.height / 2 - c.y, this.map.width / 2 - c.x);
    tank.respawn(c.x, c.y, angle);
  }

  /** Registra un evento para efectos locales y para la red. */
  emit(type, data = {}) {
    const ev = Object.assign({ type }, data);
    this.events.push(ev);
    this.netEvents.push(ev);
    if (this.netEvents.length > 128) this.netEvents.shift(); // tope por si nadie los consume
  }

  /** Devuelve y vacía la cola de eventos locales. */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ==========================================================================
  //  BUCLE DE SIMULACIÓN (paso fijo)
  // ==========================================================================

  /** Avanza la simulación un paso fijo `dt`. */
  update(dt) {
    this.tick++;
    this.time += dt;

    for (const t of this.tanks.values()) t.savePrevious();
    for (const b of this.bullets.values()) b.savePrevious();

    if (!this.isAuthority) {
      this._updateReplica(dt);
      return;
    }

    this._updateTanks(dt);
    this._updateBullets(dt);
    this._updateCryo(dt);
    this._updatePride(dt);
    this._updateCruzAzul(dt);
    this._updateAmerica(dt);
    this._updateVoid01(dt);
    this._updateRound(dt);
  }

  /** Cliente: sin reglas, sólo suavizado hacia los snapshots y extrapolación. */
  _updateReplica(dt) {
    for (const t of this.tanks.values()) t.applyNetSmoothing(dt);
    for (const b of this.bullets.values()) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    if (this.round.phase === 'ending') this.round.timer = Math.max(0, this.round.timer - dt);
  }

  _updateTanks(dt) {
    const R = CONFIG.TANK.RADIUS;

    // 1) Movimiento + colisión con el mapa + disparo.
    for (const tank of this.tanks.values()) {
      if (!tank.isAlive) continue;
      const input = this.inputs.get(tank.id) || NEUTRAL_INPUT;
      const ox = tank.x, oy = tank.y;

      // Ralentización criogénica (pilas de congelación + suelo congelado).
      tank.slowFactor = this._computeSlowFactor(tank);

      // PRIDE OVERLORD: Q/E/F/Shift/clic derecho (carga). Otros tanques: se absorben.
      const isPride = !!(tank.mods && tank.mods.pride);
      if (typeof PrideRules !== 'undefined') {
        if (isPride) PrideRules.preUpdate(this, tank, input, dt);
        else PrideRules.absorb(tank, input);
      }

      tank.applyInput(input, dt);
      this.map.resolveCircle(tank, R);

      tank.lastMoveDistance = Math.hypot(tank.x - ox, tank.y - oy);

      if (input.fire) {
        this._tryFire(tank);
        // Consumir el disparo: si el siguiente input se retrasa (red), no se
        // repite el disparo con el input antiguo.
        input.fire = false;
      }
      if (input.special) {
        this._trySpecial(tank);
        input.special = false;
      }
      if (isPride && typeof PrideRules !== 'undefined') PrideRules.postUpdate(this, tank, dt);
    }

    // 2) Colisión tanque-tanque (separación de círculos). O(n²) con n ≤ 10: trivial.
    const list = Array.from(this.tanks.values()).filter((t) => t.isAlive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const minD = R * 2;
        if (d2 >= minD * minD || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        this.map.resolveCircle(a, R);
        this.map.resolveCircle(b, R);
      }
    }
  }

  _tryFire(tank) {
    if (tank.fireCooldown > 0) return false;
    if (tank.freezeTimer > 0) return false; // congelado: no puede disparar
    if (tank.stunTimer > 0) return false;   // aturdido: no puede disparar
    if (tank.prSilenceT > 0) return false;  // pulso de La Zona de Gemidos: disparo interrumpido
    // PRIDE OVERLORD: cañón de energía cromática (proyectil prism).
    if (tank.mods && tank.mods.pride && typeof PrideRules !== 'undefined') {
      return PrideRules.fireNormal(this, tank);
    }
    // VOID-01: disparo de plasma con explosión.
    if (tank.mods && tank.mods.void01) {
      return this._tryVoidFire(tank);
    }

    let active = 0;
    for (const b of this.bullets.values()) if (b.ownerId === tank.id && b.alive) active++;
    // Habilidad especial del modelo Destructor: disparo triple.
    const spread = !!(tank.mods && tank.mods.spread);
    const count = spread ? 3 : 1;
    if (active + count > CONFIG.TANK.MAX_ACTIVE_BULLETS) return false;

    const muzzle = tank.getMuzzlePosition();
    // Si la punta del cañón está dentro de un muro, no se dispara (evita atravesarlo).
    if (this.map.queryCircle(muzzle.x, muzzle.y, CONFIG.BULLET.RADIUS)) return false;
    if (!this.map.hasLineOfSight(tank.x, tank.y, muzzle.x, muzzle.y, 3)) return false;

    const bulletSpeed = (tank.mods && tank.mods.bulletSpeed) || 1;
    const isCryo = !!(tank.mods && tank.mods.cryo);
    const offsets = spread ? [-3.4, 0, 3.4] : [0];
    const spreadAngles = spread ? [-0.16, 0, 0.16] : [0];
    const px = -Math.sin(tank.turretAngle), py = Math.cos(tank.turretAngle);
    for (let i = 0; i < count; i++) {
      const bullet = new Bullet({
        id: this._nextBulletId++,
        ownerId: tank.id,
        x: muzzle.x + px * offsets[i],
        y: muzzle.y + py * offsets[i],
        angle: tank.turretAngle + spreadAngles[i],
        bounces: tank.maxBounces,
        // El Cryo Cannon dispara cristales de hielo; los demás, formas aleatorias.
        shape: isCryo ? null : randomMissileShape(),
        grace: spread ? 0.25 : 0,
        kind: isCryo ? 'cryo' : 'normal',
      });
      if (bulletSpeed !== 1) { bullet.vx *= bulletSpeed; bullet.vy *= bulletSpeed; }
      this.bullets.set(bullet.id, bullet);
    }
    tank.fireCooldown = CONFIG.TANK.FIRE_COOLDOWN / ((tank.mods && tank.mods.fireRate) || 1);
    this.emit('shot', {
      ownerId: tank.id,
      x: MathUtil.round(muzzle.x),
      y: MathUtil.round(muzzle.y),
      angle: MathUtil.round(tank.turretAngle, 3),
    });
    return true;
  }

  _updateBullets(dt) {
    const tankR = CONFIG.TANK.RADIUS;

    for (const b of this.bullets.values()) {
      if (!b.alive) continue;

      // 1) Movimiento + rebotes contra el mapa.
      b.update(dt, this.map, this._bulletHooks);
      if (!b.alive) continue;

      // 2) Impacto contra tanques (un solo impacto destruye el tanque).
      for (const t of this.tanks.values()) {
        if (!t.isAlive) continue;
        const hitDist = tankR + b.radius;
        const d2 = MathUtil.dist2(b.x, b.y, t.x, t.y);

        if (t.id === b.ownerId && b.ownerSafe) {
          // La bala "se arma" cuando sale del cuerpo de su dueño.
          if (d2 > hitDist * hitDist) b.ownerSafe = false;
          continue;
        }
        if (d2 < hitDist * hitDist) {
          if (b.kind === 'void') {
            // Plasma VOID-01: explota y mata en radio (respeta escudos vía _destroyTank).
            b.alive = false;
            this._voidExplode(b.x, b.y, b.ownerId, b);
          } else if (t.mods && t.mods.america && t.ameInvulnT > 0) {
            // Invulnerabilidad post-renacimiento: la bala se destruye sin matar.
            this.emit('ameInvulnHit', { x: MathUtil.round(b.x), y: MathUtil.round(b.y), victimId: t.id });
            b.alive = false;
          } else if (b.kind === 'pcharge' && typeof PrideRules !== 'undefined') {
            // Rayo del Orgullo: explota (mata en el radio; la víctima directa también).
            b.alive = false;
            PrideRules.explodeCharged(this, b, t);
          } else if (t.mods && t.mods.pride && typeof PrideRules !== 'undefined' && PrideRules.absorbHit(this, t)) {
            // Escudo Arcoíris: absorbe el impacto (la bala se destruye).
            b.alive = false;
          } else if (t.mods && t.mods.void01 && t.voidShieldHits > 0) {
            // Escudo VOID-01 x3: absorbe y consume un golpe.
            t.voidShieldHits--;
            this.emit('voidShieldHit', { x: MathUtil.round(b.x), y: MathUtil.round(b.y), victimId: t.id, hitsLeft: t.voidShieldHits });
            b.alive = false;
          } else if (t.hasShield) {
            // Habilidad del modelo Blindado: el escudo absorbe un impacto por ronda.
            t.hasShield = false;
            this.emit('shieldHit', { x: MathUtil.round(b.x), y: MathUtil.round(b.y), victimId: t.id });
            b.alive = false;
          } else if (b.kind === 'cryo') {
            this._cryoHit(t, b);
            b.alive = false;
          } else {
            // Si el tanque estaba congelado, el impacto lo hace añicos.
            if (t.freezeTimer > 0) {
              this.emit('shatter', { x: MathUtil.round(b.x), y: MathUtil.round(b.y), victimId: t.id, killerId: b.ownerId });
            }
            this._destroyTank(t, b.ownerId);
            b.alive = false;
          }
          break;
        }
      }
    }

    // 3) Bala contra bala: ambas se anulan (como en Wii Tanks).
    const list = Array.from(this.bullets.values());
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const c = list[j];
        if (!c.alive) continue;
        // Balas recién nacidas (disparo triple) no se aniquilan entre sí.
        if (a.grace > 0 || c.grace > 0) continue;
        const r = a.radius + c.radius;
        if (MathUtil.dist2(a.x, a.y, c.x, c.y) < r * r) {
          a.alive = c.alive = false;
          this.emit('bulletClash', { x: MathUtil.round((a.x + c.x) / 2), y: MathUtil.round((a.y + c.y) / 2) });
          // El Rayo del Orgullo explota al chocar con otra bala.
          if (typeof PrideRules !== 'undefined') {
            for (const z of [a, c]) if (z.kind === 'pcharge') PrideRules.explodeCharged(this, z, null);
          }
          break;
        }
      }
    }

    // 4) Limpieza.
    for (const [id, b] of this.bullets) if (!b.alive) this.bullets.delete(id);
  }

  _destroyTank(victim, killerId) {
    // VOID-01: escudo x3 absorbe golpes antes de morir.
    if (victim.mods && victim.mods.void01 && victim.voidShieldHits > 0) {
      victim.voidShieldHits--;
      this.emit('voidShieldHit', {
        x: MathUtil.round(victim.x), y: MathUtil.round(victim.y),
        victimId: victim.id, hitsLeft: victim.voidShieldHits,
      });
      return;
    }
    // ÁGUILAS DEL AMÉRICA: invulnerabilidad post-renacimiento y Renacimiento Fénix.
    if (victim.mods && victim.mods.america) {
      if (victim.ameInvulnT > 0) {
        this.emit('ameInvulnHit', { x: MathUtil.round(victim.x), y: MathUtil.round(victim.y), victimId: victim.id });
        return;
      }
      if (!victim.ameReviveUsed) {
        const oldX = victim.x, oldY = victim.y;
        victim.ameReviveUsed = true;
        this._placeAtSpawn(victim);
        victim.ameReviveUsed = true;
        victim.ameInvulnT = CONFIG.AMERICA.revive.invulnDuration;
        victim.freezeStacks = 0;
        victim.freezeTimer = 0;
        victim.freezeDecayTimer = 0;
        victim.slowFactor = 0;
        victim.stunTimer = 0;
        victim.amePulseCd = 0;
        victim.ameBoostCd = 0;
        victim.ameBoosting = false;
        victim.ameBoostT = 0;
        this.emit('ameRevive', {
          x: MathUtil.round(oldX), y: MathUtil.round(oldY),
          newX: MathUtil.round(victim.x), newY: MathUtil.round(victim.y),
          victimId: victim.id, killerId,
        });
        return;
      }
    }
    victim.isAlive = false;
    victim.speed = 0;
    // PRIDE destruido: carga y turbo se cancelan, escudo se apaga.
    if (victim.mods && victim.mods.pride && typeof PrideRules !== 'undefined') {
      PrideRules.interrupt(this, victim);
      victim.prShieldT = 0;
      victim.prShieldHits = 0;
      victim._prShieldWas = false;
    }
    const killer = this.tanks.get(killerId);
    if (killer && killer !== victim) killer.score++;
    this.emit('tankDestroyed', {
      victimId: victim.id,
      killerId,
      x: MathUtil.round(victim.x),
      y: MathUtil.round(victim.y),
      colorIndex: victim.colorIndex,
    });
  }

  // ==========================================================================
  //  SISTEMA CRIÓGÉNICO (CRYO-01 FROST REAPER)
  // ==========================================================================

  /**
   * Impacto de un proyectil criogénico sobre un tanque.
   *  - El FROST REAPER es inmune a su PROPIO efecto criogénico.
   *  - Un impacto sobre un tanque ya congelado lo destruye (se hace añicos).
   *  - En caso contrario suma una pila; al llegar al umbral congela 2.5 s.
   *    Umbral: 3 impactos (tanque normal) o 4 (FROST REAPER, resistencia 130%).
   */
  _cryoHit(t, b) {
    const C = CONFIG.CRYO;
    const hx = MathUtil.round(b.x), hy = MathUtil.round(b.y);
    const isCryoTank = !!(t.mods && t.mods.cryo);
    if (isCryoTank && b.ownerId === t.id) {
      this.emit('cryoHit', { x: hx, y: hy, victimId: t.id, immune: true });
      return;
    }
    if (t.freezeTimer > 0) {
      this.emit('shatter', { x: hx, y: hy, victimId: t.id, killerId: b.ownerId });
      this._destroyTank(t, b.ownerId);
      return;
    }
    t.freezeStacks++;
    t.freezeDecayTimer = C.FREEZE_DECAY;
    this.emit('cryoHit', { x: hx, y: hy, victimId: t.id, stacks: t.freezeStacks });
    const threshold = isCryoTank ? C.FREEZE_HITS_CRYO : C.FREEZE_HITS;
    if (t.freezeStacks >= threshold) {
      t.freezeStacks = 0;
      t.freezeTimer = C.FREEZE_DURATION;
      this.emit('frozen', { x: hx, y: hy, victimId: t.id });
    }
  }

  /** Ralentización actual de un tanque (0..1) por pilas de congelación y suelo. */
  _computeSlowFactor(tank) {
    const C = CONFIG.CRYO;
    if (tank.freezeTimer > 0) return 1;
    let slow = 0;
    if (tank.freezeStacks >= 2) slow = C.SLOW_2_STACKS;
    else if (tank.freezeStacks >= 1) slow = C.SLOW_1_STACK;
    // Suelo congelado: ralentiza a quien lo pise (el FROST REAPER es inmune).
    if (!(tank.mods && tank.mods.cryo) && this.frozenTiles.size > 0) {
      const tx = Math.floor(tank.x / this.map.tileSize);
      const ty = Math.floor(tank.y / this.map.tileSize);
      if (this.frozenTiles.has(tx + ',' + ty)) slow = Math.max(slow, C.GROUND_SLOW);
    }
    return slow;
  }

  /**
   * Activa CERO ABSOLUTO (botón derecho). Sólo el FROST REAPER, con recarga
   * lista y sin estar congelado. Genera una onda expansiva que congela
   * progresivamente todo lo que alcanza.
   */
  _trySpecial(tank) {
    // CRUZ AZUL - LA MÁQUINA: Descarga Celeste (clic derecho / F).
    if (tank.mods && tank.mods.cruzazul) return this._tryCruzPulse(tank);
    // ÁGUILAS DEL AMÉRICA: Explosión Fénix (clic derecho / F).
    if (tank.mods && tank.mods.america) return this._tryAmePulse(tank);
    // VOID-01: bomba nuclear también por clic derecho / F (además de N).
    if (tank.mods && tank.mods.void01) return this._tryVoidNuke(tank);
    const C = CONFIG.CRYO;
    if (!(tank.mods && tank.mods.cryo)) return false;
    if (!tank.isAlive || tank.freezeTimer > 0) return false;
    if (tank.specialCooldown > 0) return false;
    tank.specialCooldown = C.SPECIAL_COOLDOWN;
    this.waves.push({
      ownerId: tank.id,
      x: tank.x,
      y: tank.y,
      radius: 0,
      maxRadius: C.SPECIAL_RADIUS_TILES * this.map.tileSize,
      hit: new Set(),
    });
    this.emit('absoluteZero', { x: MathUtil.round(tank.x), y: MathUtil.round(tank.y), ownerId: tank.id });
    return true;
  }

  /**
   * Descarga Celeste de CRUZ AZUL: pulso eléctrico instantáneo.
   * Destruye balas enemigas en el radio, aturde a los enemigos
   * alcanzados y otorga impulso de velocidad al propio tanque.
   * Adaptado al juego de un solo impacto: control, sin daño directo.
   */
  _tryCruzPulse(tank) {
    const C = CONFIG.CRUZAZUL.special;
    if (!tank.isAlive || tank.freezeTimer > 0 || tank.stunTimer > 0) return false;
    if (tank.cazPulseCd > 0) return false;
    tank.cazPulseCd = C.cooldown;
    tank.cazBoostT = C.boostDuration;
    const r2 = C.radius * C.radius;
    const hit = [];
    // Limpiar balas enemigas dentro del radio.
    for (const b of this.bullets.values()) {
      if (!b.alive || b.ownerId === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, b.x, b.y) <= r2) {
        b.alive = false;
        this.emit('bulletDestroyed', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) });
      }
    }
    // Aturdir enemigos dentro del radio.
    for (const t of this.tanks.values()) {
      if (!t.isAlive || t.id === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, t.x, t.y) <= r2) {
        t.stunTimer = Math.max(t.stunTimer || 0, C.stunDuration);
        hit.push(t.id);
      }
    }
    this.emit('cazPulse', {
      x: MathUtil.round(tank.x), y: MathUtil.round(tank.y),
      ownerId: tank.id, radius: C.radius, hit,
    });
    return true;
  }

  /** Actualización de CRUZ AZUL por tick: recargas, impulso y Turbo Azul. */
  _updateCruzAzul(dt) {
    for (const t of this.tanks.values()) {
      if (!t.isAlive) continue;
      if (t.cazPulseCd > 0) t.cazPulseCd = Math.max(0, t.cazPulseCd - dt);
      if (t.cazBoostCd > 0) t.cazBoostCd = Math.max(0, t.cazBoostCd - dt);
      if (t.cazBoostT > 0) t.cazBoostT = Math.max(0, t.cazBoostT - dt);
      if (!(t.mods && t.mods.cruzazul)) continue;
      // Turbo Azul: Shift mantenido (input.cazBoost). Al soltar, recarga.
      const input = this.inputs.get(t.id);
      const wantsBoost = !!(input && input.cazBoost);
      const wasBoosting = !!t.cazBoosting;
      const canBoost = t.cazBoostCd <= 0 && t.freezeTimer <= 0 && t.stunTimer <= 0;
      t.cazBoosting = wantsBoost && canBoost;
      if (t.cazBoosting && !wasBoosting) {
        this.emit('cazBoostStart', { x: MathUtil.round(t.x), y: MathUtil.round(t.y), ownerId: t.id });
      } else if (!t.cazBoosting && wasBoosting) {
        t.cazBoostCd = CONFIG.CRUZAZUL.boost.cooldown;
        this.emit('cazBoostEnd', { x: MathUtil.round(t.x), y: MathUtil.round(t.y), ownerId: t.id });
      }
    }
  }

  /**
   * Explosión Fénix de ÁGUILAS DEL AMÉRICA: pulso de fuego instantáneo.
   * Destruye balas enemigas en el radio, aturde a los enemigos
   * alcanzados y otorga impulso de velocidad al propio tanque.
   * Adaptado al juego de un solo impacto: control, sin daño directo.
   */
  _tryAmePulse(tank) {
    const C = CONFIG.AMERICA.special;
    if (!tank.isAlive || tank.freezeTimer > 0 || tank.stunTimer > 0) return false;
    if (tank.amePulseCd > 0) return false;
    tank.amePulseCd = C.cooldown;
    tank.ameBoostT = C.boostDuration;
    const r2 = C.radius * C.radius;
    const hit = [];
    for (const b of this.bullets.values()) {
      if (!b.alive || b.ownerId === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, b.x, b.y) <= r2) {
        b.alive = false;
        this.emit('bulletDestroyed', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) });
      }
    }
    for (const t of this.tanks.values()) {
      if (!t.isAlive || t.id === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, t.x, t.y) <= r2) {
        t.stunTimer = Math.max(t.stunTimer || 0, C.stunDuration);
        hit.push(t.id);
      }
    }
    this.emit('amePulse', {
      x: MathUtil.round(tank.x), y: MathUtil.round(tank.y),
      ownerId: tank.id, radius: C.radius, hit,
    });
    return true;
  }

  /** Actualización de AMÉRICA por tick: recargas, impulso, invulnerabilidad y Turbo Águila. */
  _updateAmerica(dt) {
    for (const t of this.tanks.values()) {
      if (!t.isAlive) continue;
      if (t.amePulseCd > 0) t.amePulseCd = Math.max(0, t.amePulseCd - dt);
      if (t.ameBoostCd > 0) t.ameBoostCd = Math.max(0, t.ameBoostCd - dt);
      if (t.ameBoostT > 0) t.ameBoostT = Math.max(0, t.ameBoostT - dt);
      if (t.ameInvulnT > 0) t.ameInvulnT = Math.max(0, t.ameInvulnT - dt);
      if (!(t.mods && t.mods.america)) continue;
      // Turbo Águila: Shift mantenido (input.ameBoost). Al soltar, recarga.
      const input = this.inputs.get(t.id);
      const wantsBoost = !!(input && input.ameBoost);
      const wasBoosting = !!t.ameBoosting;
      const canBoost = t.ameBoostCd <= 0 && t.freezeTimer <= 0 && t.stunTimer <= 0;
      t.ameBoosting = wantsBoost && canBoost;
      if (t.ameBoosting && !wasBoosting) {
        this.emit('ameBoostStart', { x: MathUtil.round(t.x), y: MathUtil.round(t.y), ownerId: t.id });
      } else if (!t.ameBoosting && wasBoosting) {
        t.ameBoostCd = CONFIG.AMERICA.boost.cooldown;
        this.emit('ameBoostEnd', { x: MathUtil.round(t.x), y: MathUtil.round(t.y), ownerId: t.id });
      }
    }
  }

  /** Disparo de plasma VOID-01: bala rápida con explosión al impactar. */
  _tryVoidFire(tank) {
    const V = CONFIG.VOID01.shot;
    let active = 0;
    for (const b of this.bullets.values()) if (b.ownerId === tank.id && b.alive) active++;
    if (active >= CONFIG.TANK.MAX_ACTIVE_BULLETS * 2) return false;
    const muzzle = tank.getMuzzlePosition();
    if (this.map.queryCircle(muzzle.x, muzzle.y, CONFIG.BULLET.RADIUS)) return false;
    if (!this.map.hasLineOfSight(tank.x, tank.y, muzzle.x, muzzle.y, 3)) return false;
    const bullet = new Bullet({
      id: this._nextBulletId++,
      ownerId: tank.id,
      x: muzzle.x,
      y: muzzle.y,
      angle: tank.turretAngle,
      bounces: tank.maxBounces,
      shape: null,
      grace: 0,
      kind: 'void',
      speed: V.speed,
      radius: V.radius,
    });
    this.bullets.set(bullet.id, bullet);
    tank.fireCooldown = V.cooldown / ((tank.mods && tank.mods.fireRate) || 1);
    this.emit('shot', {
      ownerId: tank.id,
      x: MathUtil.round(muzzle.x),
      y: MathUtil.round(muzzle.y),
      angle: MathUtil.round(tank.turretAngle, 3),
    });
    return true;
  }

  /** Explosión de plasma VOID-01: mata a todos en el radio (respeta escudos). */
  _voidExplode(x, y, ownerId, bullet) {
    const V = CONFIG.VOID01.shot;
    const r2 = V.explosionRadius * V.explosionRadius;
    this.emit('voidExplode', {
      x: MathUtil.round(x), y: MathUtil.round(y),
      ownerId, radius: V.explosionRadius,
    });
    const victims = [];
    for (const t of this.tanks.values()) {
      if (!t.isAlive) continue;
      if (MathUtil.dist2(x, y, t.x, t.y) <= r2) victims.push(t);
    }
    for (const t of victims) {
      // No matar al dueño si la bala era suya y aún está en su cuerpo (ownerSafe ya se maneja fuera).
      this._destroyTank(t, ownerId);
    }
    if (bullet) bullet.alive = false;
  }

  /** Bomba nuclear VOID-01: explosión gigante que mata a todos y rompe bloques. */
  _tryVoidNuke(tank) {
    const C = CONFIG.VOID01.nuke;
    if (!tank.isAlive || tank.freezeTimer > 0 || tank.stunTimer > 0) return false;
    if (tank.voidNukeCd > 0) return false;
    tank.voidNukeCd = C.cooldown;
    const r2 = C.radius * C.radius;
    this.emit('voidNuke', {
      x: MathUtil.round(tank.x), y: MathUtil.round(tank.y),
      ownerId: tank.id, radius: C.radius,
    });
    // Romper bloques destructibles en el radio.
    if (C.destroyBlocks) {
      const ts = this.map.tileSize;
      const minTx = Math.max(0, Math.floor((tank.x - C.radius) / ts));
      const maxTx = Math.min(this.map.cols - 1, Math.floor((tank.x + C.radius) / ts));
      const minTy = Math.max(0, Math.floor((tank.y - C.radius) / ts));
      const maxTy = Math.min(this.map.rows - 1, Math.floor((tank.y + C.radius) / ts));
      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const c = this.map.tileCenter(tx, ty);
          if (MathUtil.dist2(tank.x, tank.y, c.x, c.y) <= r2) {
            if (this.map.get(tx, ty) === TILE.BREAKABLE) {
              this.map.destroyTile(tx, ty);
              this.emit('blockDestroyed', { tx, ty, x: MathUtil.round(c.x), y: MathUtil.round(c.y) });
            }
          }
        }
      }
    }
    // Matar enemigos en el radio (el propio tanque sobrevive).
    const victims = [];
    for (const t of this.tanks.values()) {
      if (!t.isAlive || t.id === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, t.x, t.y) <= r2) victims.push(t);
    }
    for (const t of victims) this._destroyTank(t, tank.id);
    return true;
  }

  /** Teletransporte VOID-01: salto corto hacia adelante. */
  _tryVoidTeleport(tank) {
    const C = CONFIG.VOID01.teleport;
    if (!tank.isAlive || tank.freezeTimer > 0 || tank.stunTimer > 0) return false;
    if (tank.voidTeleportCd > 0) return false;
    const angle = tank.chassisAngle;
    const nx = tank.x + Math.cos(angle) * C.distance;
    const ny = tank.y + Math.sin(angle) * C.distance;
    // No teletransportar dentro de un muro.
    if (this.map.queryCircle(nx, ny, CONFIG.TANK.RADIUS)) return false;
    const oldX = tank.x, oldY = tank.y;
    tank.x = tank.prevX = nx;
    tank.y = tank.prevY = ny;
    tank.voidTeleportCd = C.cooldown;
    this.emit('voidTeleport', {
      x: MathUtil.round(oldX), y: MathUtil.round(oldY),
      newX: MathUtil.round(nx), newY: MathUtil.round(ny),
      ownerId: tank.id,
    });
    return true;
  }

  /** Actualización de VOID-01 por tick: recargas, turbo infinito, aimbot, escudo. */
  _updateVoid01(dt) {
    for (const t of this.tanks.values()) {
      if (!t.isAlive) continue;
      if (t.voidNukeCd > 0) t.voidNukeCd = Math.max(0, t.voidNukeCd - dt);
      if (t.voidTeleportCd > 0) t.voidTeleportCd = Math.max(0, t.voidTeleportCd - dt);
      if (!(t.mods && t.mods.void01)) continue;
      const input = this.inputs.get(t.id);
      // Turbo infinito: Shift mantenido, sin recarga.
      const wantsBoost = !!(input && input.voidBoost);
      const canBoost = t.freezeTimer <= 0 && t.stunTimer <= 0;
      t.voidBoosting = wantsBoost && canBoost;
      // Aimbot toggle (contador monotónico).
      if (input && typeof input.voidAimbotToggle === 'number') {
        const last = t._voidAimbotSeen || 0;
        if (input.voidAimbotToggle > last) {
          t._voidAimbotSeen = input.voidAimbotToggle;
          t.voidAimbot = !t.voidAimbot;
          this.emit('voidAimbotToggle', { ownerId: t.id, on: t.voidAimbot });
        }
      }
      // Bomba nuclear (contador).
      if (input && typeof input.voidNuke === 'number') {
        const last = t._voidNukeSeen || 0;
        if (input.voidNuke > last) {
          t._voidNukeSeen = input.voidNuke;
          this._tryVoidNuke(t);
        }
      }
      // Teletransporte (contador).
      if (input && typeof input.voidTeleport === 'number') {
        const last = t._voidTeleportSeen || 0;
        if (input.voidTeleport > last) {
          t._voidTeleportSeen = input.voidTeleport;
          this._tryVoidTeleport(t);
        }
      }
      // Aimbot servidor (para bots y para validar): apunta al enemigo más cercano.
      if (t.voidAimbot) {
        let best = null, bestD2 = Infinity;
        for (const o of this.tanks.values()) {
          if (!o.isAlive || o.id === t.id) continue;
          const d2 = MathUtil.dist2(t.x, t.y, o.x, o.y);
          if (d2 < bestD2) { bestD2 = d2; best = o; }
        }
        if (best) {
          const targetAngle = Math.atan2(best.y - t.y, best.x - t.x);
          t.turretAngle = MathUtil.wrapAngle(targetAngle);
        }
      }
    }
  }

  /** Actualización criogénica por tick (sólo autoridad): decaimiento, ondas y suelo. */
  _updateCryo(dt) {
    const C = CONFIG.CRYO;

    // 1) Decaimiento de pilas y congelación; recarga de la habilidad.
    for (const t of this.tanks.values()) {
      if (!t.isAlive) continue;
      if (t.freezeTimer > 0) {
        t.freezeTimer -= dt;
        if (t.freezeTimer <= 0) {
          t.freezeTimer = 0;
          this.emit('thawed', { x: MathUtil.round(t.x), y: MathUtil.round(t.y), victimId: t.id });
        }
      } else if (t.freezeStacks > 0) {
        t.freezeDecayTimer -= dt;
        if (t.freezeDecayTimer <= 0) {
          t.freezeStacks--;
          t.freezeDecayTimer = t.freezeStacks > 0 ? C.FREEZE_DECAY : 0;
        }
      }
      if (t.specialCooldown > 0) t.specialCooldown = Math.max(0, t.specialCooldown - dt);
    }

    // 2) Ondas de CERO ABSOLUTO: se expanden y congelan lo que alcanzan.
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.radius += C.SPECIAL_WAVE_SPEED * dt;

      // Congelar el suelo dentro del radio (escarcha temporal).
      const ts = this.map.tileSize;
      const minTx = Math.max(0, Math.floor((w.x - w.radius) / ts));
      const maxTx = Math.min(this.map.cols - 1, Math.floor((w.x + w.radius) / ts));
      const minTy = Math.max(0, Math.floor((w.y - w.radius) / ts));
      const maxTy = Math.min(this.map.rows - 1, Math.floor((w.y + w.radius) / ts));
      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const c = this.map.tileCenter(tx, ty);
          if (MathUtil.dist2(w.x, w.y, c.x, c.y) <= w.radius * w.radius) {
            const key = tx + ',' + ty;
            const prev = this.frozenTiles.get(key) || 0;
            if (prev < C.GROUND_FROST_TIME) this.frozenTiles.set(key, C.GROUND_FROST_TIME);
          }
        }
      }

      // Congelar enemigos alcanzados por el frente de la onda.
      for (const t of this.tanks.values()) {
        if (!t.isAlive || t.id === w.ownerId || w.hit.has(t.id)) continue;
        if (MathUtil.dist2(w.x, w.y, t.x, t.y) <= w.radius * w.radius) {
          w.hit.add(t.id);
          if (t.freezeTimer > 0) continue; // ya estaba congelado: no renovar
          t.freezeStacks = 0;
          t.freezeTimer = C.SPECIAL_FREEZE;
          this.emit('absoluteZeroHit', { x: MathUtil.round(t.x), y: MathUtil.round(t.y), victimId: t.id });
        }
      }

      if (w.radius >= w.maxRadius) this.waves.splice(i, 1);
    }

    // 3) Suelo congelado: se descongela progresivamente.
    for (const [key, remaining] of this.frozenTiles) {
      const left = remaining - dt;
      if (left <= 0) this.frozenTiles.delete(key);
      else this.frozenTiles.set(key, left);
    }
  }

  /**
   * Actualización de PRIDE OVERLORD por tick (sólo autoridad): aturdimiento,
   * temporizadores de energía/recargas/escudo y las zonas de Gemidos.
   */
  _updatePride(dt) {
    if (typeof PrideRules === 'undefined') return;
    for (const t of this.tanks.values()) {
      if (!t.isAlive) continue;
      if (t.stunTimer > 0) t.stunTimer = Math.max(0, t.stunTimer - dt);
      if (t.mods && t.mods.pride) PrideRules.tick(this, t, dt);
    }
    PrideRules.updateZones(this, dt);
  }

  _updateRound(dt) {
    const r = this.round;
    if (r.phase === 'playing') {
      let alive = 0, last = null;
      for (const t of this.tanks.values()) if (t.isAlive) { alive++; last = t; }
      const total = this.tanks.size;
      const over = total >= 2 ? alive <= 1 : total === 1 && alive === 0;
      if (over) {
        r.phase = 'ending';
        r.timer = CONFIG.ROUND.RESTART_DELAY;
        r.winnerId = total >= 2 && last ? last.id : null;
        if (r.winnerId) last.wins++;
        // Celebración AMO A SAMARIEMM si gana un PRIDE OVERLORD.
        if (r.winnerId && typeof PrideRules !== 'undefined') PrideRules.onRoundEnd(this, last);
        // Celebración AMO EL CRUZ AZUL si gana LA MÁQUINA.
        if (r.winnerId && last.mods && last.mods.cruzazul) {
          this.emit('cruzazulWin', { id: last.id, round: this.round.number });
        }
        // Celebración ARRIBA LAS ÁGUILAS DEL AMÉRICA si gana AMÉRICA.
        if (r.winnerId && last.mods && last.mods.america) {
          this.emit('americaWin', { id: last.id, round: this.round.number });
        }
        // Celebración VOID-01 si gana la SOMBRA NEGRA.
        if (r.winnerId && last.mods && last.mods.void01) {
          this.emit('void01Win', { id: last.id, round: this.round.number });
        }
        this.emit('roundEnd', { winnerId: r.winnerId });
      }
    } else if (r.phase === 'ending') {
      r.timer -= dt;
      if (r.timer <= 0) this.resetRound(true);
    }
  }

  /** Reinicia la ronda: mapa original, sin balas, todos reaparecen. */
  resetRound(advance = true) {
    if (advance) this.round.number++;
    this.round.phase = 'playing';
    this.round.timer = 0;
    this.round.winnerId = null;
    this.map.reset();
    this.bullets.clear();
    // El estado criogénico se reinicia con la ronda (ondas, suelo y tanques vía respawn).
    this.waves = [];
    this.frozenTiles.clear();
    // La Zona de Gemidos también se reinicia con la ronda.
    this.prZones = [];
    for (const t of this.tanks.values()) this._placeAtSpawn(t);
    this.emit('roundStart', { round: this.round.number });
  }

  // ==========================================================================
  //  SERIALIZACIÓN DEL ESTADO COMPLETO (snapshot de red)
  // ==========================================================================

  /**
   * Genera un snapshot serializable a JSON.
   * @param {object} [opts]
   * @param {boolean} [opts.includeMap=false] incluir el mapa completo (sólo
   *        cuando cambió o para un peer recién llegado).
   * @param {boolean} [opts.flushEvents=true] adjuntar y vaciar los eventos de red.
   */
  serialize({ includeMap = false, flushEvents = true } = {}) {
    const snap = {
      v: 1,
      tick: this.tick,
      time: MathUtil.round(this.time, 3),
      round: {
        number: this.round.number,
        phase: this.round.phase,
        timer: MathUtil.round(this.round.timer, 2),
        winnerId: this.round.winnerId,
      },
      mapRevision: this.map.revision,
      meta: [],
      tanks: [],
      bullets: [],
      events: [],
    };
    for (const t of this.tanks.values()) {
      snap.meta.push(t.serializeMeta());
      snap.tanks.push(t.serialize());
    }
    for (const b of this.bullets.values()) snap.bullets.push(b.serialize());
    // Estado criogénico visible para los clientes (ondas y suelo congelado).
    snap.waves = this.waves.map((w) => ({
      ownerId: w.ownerId,
      x: MathUtil.round(w.x, 1),
      y: MathUtil.round(w.y, 1),
      radius: MathUtil.round(w.radius, 1),
    }));
    if (this.frozenTiles.size > 0) {
      snap.frozenTiles = [];
      for (const [key, remaining] of this.frozenTiles) {
        const parts = key.split(',');
        snap.frozenTiles.push([Number(parts[0]), Number(parts[1]), MathUtil.round(remaining, 2)]);
      }
    }
    // Zonas de Gemidos de PRIDE OVERLORD (sólo cuando hay alguna).
    if (this.prZones.length) {
      snap.pz = this.prZones.map((z) => [z.id, z.ownerId, MathUtil.round(z.x), MathUtil.round(z.y), z.active ? 1 : 0, MathUtil.round(z.age, 2), MathUtil.round(z.sx), MathUtil.round(z.sy)]);
    }
    if (includeMap) snap.map = this.map.serialize();
    if (flushEvents) {
      snap.events = this.netEvents;
      this.netEvents = [];
    }
    return snap;
  }

  /**
   * Aplica un snapshot recibido del host (lado CLIENTE).
   * Crea/actualiza/elimina tanques y balas para reflejar el estado remoto.
   */
  applySnapshot(snap) {
    this.tick = snap.tick;
    this.time = snap.time;

    // Ronda
    const prevRound = this.round.number;
    this.round.number = snap.round.number;
    this.round.phase = snap.round.phase;
    this.round.timer = snap.round.timer;
    this.round.winnerId = snap.round.winnerId;

    // Mapa (sólo viene cuando cambió)
    if (snap.map) this.map.deserialize(snap.map);

    // Tanques: metadatos primero (crea los que no existan).
    const seen = new Set();
    for (const meta of snap.meta) {
      let t = this.tanks.get(meta.id);
      if (!t) {
        t = new Tank({ id: meta.id, name: meta.name, slot: meta.slot, isBot: meta.isBot });
        this.tanks.set(meta.id, t);
        t._fresh = true;
      }
      t.deserializeMeta(meta);
      seen.add(meta.id);
    }
    for (const data of snap.tanks) {
      const t = this.tanks.get(data.id);
      if (!t) continue;
      const snapNow = t._fresh || prevRound !== snap.round.number;
      t.deserialize(data, !snapNow);
      t._fresh = false;
    }
    for (const id of Array.from(this.tanks.keys())) if (!seen.has(id)) this.tanks.delete(id);

    // Balas: reemplazo con reutilización de instancias.
    const seenBullets = new Set();
    for (const bd of snap.bullets) {
      const b = this.bullets.get(bd.id);
      if (b) b.deserialize(bd);
      else this.bullets.set(bd.id, Bullet.fromSnapshot(bd));
      seenBullets.add(bd.id);
    }
    for (const id of Array.from(this.bullets.keys())) if (!seenBullets.has(id)) this.bullets.delete(id);

    // Ondas de CERO ABSOLUTO (sólo visual para el cliente; la autoridad la manda).
    this.waves = (snap.waves || []).map((w) => ({
      ownerId: w.ownerId,
      x: w.x,
      y: w.y,
      radius: w.radius,
      maxRadius: CONFIG.CRYO.SPECIAL_RADIUS_TILES * this.map.tileSize,
      hit: new Set(),
    }));
    // Suelo congelado.
    this.frozenTiles.clear();
    if (snap.frozenTiles) {
      for (const [tx, ty, remaining] of snap.frozenTiles) {
        this.frozenTiles.set(tx + ',' + ty, remaining);
      }
    }
    // Zonas de Gemidos (sólo visual para el cliente; la autoridad las manda).
    this.prZones = (snap.pz || []).map((z) => ({
      id: z[0], ownerId: z[1], x: z[2], y: z[3], active: !!z[4], age: z[5], sx: z[6], sy: z[7],
      hit: new Set(), pulseT: 0,
    }));

    // Eventos remotos → efectos locales.
    if (snap.events) for (const ev of snap.events) this.events.push(ev);
  }
}

