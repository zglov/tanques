'use strict';
/**
 * ============================================================================
 *  entities/tank.js — Entidad Tanque.
 * ============================================================================
 *  Contiene SOLO estado y física local del tanque. No sabe dibujarse (eso es
 *  responsabilidad del Renderer) ni sabe de dónde vienen sus inputs (teclado,
 *  IA o red: ver controllers.js). Esta separación es la que permite que el
 *  mismo objeto funcione en el host (simulado) y en un cliente (replicado).
 *
 *  Formato de input que consume (InputPayload):
 *    {
 *      seq:      number,  // nº de secuencia incremental (útil para reconciliación)
 *      throttle: -1|0|1,  // W = +1 (avanzar), S = -1 (retroceder)
 *      turn:     -1|0|1,  // D = +1 (horario), A = -1 (antihorario)
 *      aimAngle: number,  // ángulo absoluto de la torreta en radianes
 *      fire:     boolean, // disparo (flanco: true sólo un tick)
 *      special:  boolean  // habilidad especial (flanco: true sólo un tick)
 *    }
 * ============================================================================
 */

/** Input neutro (tanque quieto) — se usa cuando no hay input disponible. */
const NEUTRAL_INPUT = Object.freeze({ seq: 0, throttle: 0, turn: 0, aimAngle: 0, fire: false, special: false });

class Tank {
  /**
   * @param {object} opts
   * @param {string} opts.id         identificador único (p. ej. el peerId de red)
   * @param {string} opts.name       nombre visible
   * @param {number} opts.slot       0..9: define color y punto de aparición
   * @param {boolean} [opts.isBot]
   */
  constructor({ id, name, slot, isBot = false }) {
    this.id = id;
    this.name = name;
    this.slot = slot;
    this.colorIndex = slot % CONFIG.COLORS.length;
    this.isBot = isBot;

    // --- Estado replicado por red (ver serialize) ---
    this.x = 0;
    this.y = 0;
    this.chassisAngle = 0;
    this.turretAngle = 0;
    this.isAlive = true;

    // --- Estado de simulación (sólo lo necesita quien simula: el host) ---
    this.speed = 0;            // px/s a lo largo de chassisAngle (negativa = marcha atrás)
    this.angularVelocity = 0;  // rad/s
    this.fireCooldown = 0;
    this.maxBounces = CONFIG.BULLET.DEFAULT_BOUNCES;
    this.lastMoveDistance = 0; // px recorridos en el último tick (útil para la IA)

    // --- Puntuación / metadatos ---
    this.score = 0;  // bajas
    this.wins = 0;   // rondas ganadas

    // --- Modelo predeterminado (ver models.js) ---
    this.modelId = null;
    this.mods = { speed: 1, turn: 1, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: false, spread: false, cryo: false, pride: false, cruzazul: false, america: false, void01: false };
    this.hasShield = false; // escudo activo (absorbe un impacto; se restaura cada ronda)

    // --- Estado criogénico (CRYO-01 FROST REAPER, ver config.js CRYO) ---
    this.freezeStacks = 0;     // pilas de congelación acumuladas (0..umbral)
    this.freezeTimer = 0;      // s restantes de congelación completa
    this.freezeDecayTimer = 0; // s hasta perder una pila (descongelación progresiva)
    this.specialCooldown = 0;  // s restantes de recarga de CERO ABSOLUTO
    this.slowFactor = 0;       // ralentización actual 0..1 (lo calcula GameState)

    // --- Estado de PRIDE OVERLORD (ver js/pride.js y config.js PRIDE) ---
    this.stunTimer = 0;        // s de aturdimiento restante (onda / zona)
    this.prEnergy = 100;       // energía cromática 0..100
    this.prCharging = false;   // está cargando el Rayo del Orgullo
    this.prCharge = 0;         // s de carga acumulada
    this.prChargeCd = 0;       // recarga del Rayo
    this.prWaveCd = 0;         // recarga de la Onda del Orgullo
    this.prShieldCd = 0;       // recarga del Escudo Arcoíris
    this.prZoneCd = 0;         // recarga de La Zona de Gemidos
    this.prShieldT = 0;        // s restantes del Escudo Arcoíris
    this.prShieldHits = 0;     // impactos que aún absorbe el escudo
    this.prBoosting = false;   // turbo activo
    this.prSlowT = 0;          // s de ralentización de la zona
    this.prSilenceT = 0;       // s sin poder disparar (pulsos de la zona)
    this._pack = { aj: 0, aq: 0, af: 0, pd: 0, pu: 0 }; // últimos contadores de entrada vistos
    this._prBoostLock = false; // turbo bloqueado hasta soltar Shift
    this._prShieldWas = false; // había escudo en el tick anterior (para eventos)

    // --- Estado de CRUZ AZUL - LA MÁQUINA (ver config.js CRUZAZUL) ---
    this.cazPulseCd = 0;       // s restantes de recarga de Descarga Celeste
    this.cazBoostCd = 0;       // s restantes de recarga del Turbo Azul
    this.cazBoosting = false;  // Turbo Azul activo (Shift mantenido)
    this.cazBoostT = 0;        // s restantes de impulso tras Descarga Celeste

    // --- Estado de ÁGUILAS DEL AMÉRICA (tema fénix, ver config.js AMERICA) ---
    this.amePulseCd = 0;       // s restantes de recarga de Explosión Fénix
    this.ameBoostCd = 0;       // s restantes de recarga del Turbo Águila
    this.ameBoosting = false;  // Turbo Águila activo (Shift mantenido)
    this.ameBoostT = 0;        // s restantes de impulso tras Explosión Fénix
    this.ameReviveUsed = false; // Renacimiento ya usado esta ronda
    this.ameInvulnT = 0;       // s de invulnerabilidad tras renacer

    // --- Estado de VOID-01 // SOMBRA NEGRA (secreto, ver config.js VOID01) ---
    this.voidNukeCd = 0;       // s restantes de recarga de bomba nuclear
    this.voidAimbot = false;   // aimbot activado (T)
    this.voidBoosting = false; // turbo infinito activo (Shift)
    this.voidShieldHits = 0;   // impactos que aún absorbe el escudo x3
    this.voidTeleportCd = 0;   // s restantes de recarga de teletransporte

    // --- Interpolación de render (entre dos ticks fijos) ---
    this.prevX = 0;
    this.prevY = 0;
    this.prevChassisAngle = 0;
    this.prevTurretAngle = 0;

    // --- Objetivo de red (en clientes, ver deserialize/applyNetSmoothing) ---
    this.netTarget = null;
  }

  get color() {
    return CONFIG.COLORS[this.colorIndex];
  }

  /**
   * Aplica un modelo predeterminado (ver models.js). Con null vuelve al
   * Clásico: modificadores en 1 y sin escudo.
   */
  applyModel(model) {
    if (!model) {
      this.modelId = null;
      this.mods = { speed: 1, turn: 1, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: false, spread: false, cryo: false, pride: false, cruzazul: false, america: false, void01: false };
      this.hasShield = false;
      return;
    }
    this.modelId = model.id;
    const d = model.mods || {};
    this.mods = {
      speed: d.speed != null ? d.speed : 1,
      turn: d.turn != null ? d.turn : 1,
      fireRate: d.fireRate != null ? d.fireRate : 1,
      bulletSpeed: d.bulletSpeed != null ? d.bulletSpeed : 1,
      bounces: d.bounces || 0,
      shield: !!d.shield,
      spread: !!d.spread,
      cryo: !!d.cryo,
      pride: !!d.pride,
      cruzazul: !!d.cruzazul,
      america: !!d.america,
      void01: !!d.void01,
    };
    this.maxBounces = Math.min(CONFIG.BULLET.MAX_BOUNCES, CONFIG.BULLET.DEFAULT_BOUNCES + this.mods.bounces);
    this.hasShield = this.mods.shield;
    if (this.mods.void01) this.voidShieldHits = CONFIG.VOID01.shield.maxHits;
  }

  /** Coloca el tanque en una posición y lo revive. */
  respawn(x, y, angle) {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.chassisAngle = this.prevChassisAngle = angle;
    this.turretAngle = this.prevTurretAngle = angle;
    this.speed = 0;
    this.angularVelocity = 0;
    this.fireCooldown = 0.5;
    this.isAlive = true;
    this.hasShield = !!(this.mods && this.mods.shield); // el escudo se restaura cada ronda
    this.netTarget = null;
    // El estado criogénico se reinicia al reaparecer (ronda nueva).
    this.freezeStacks = 0;
    this.freezeTimer = 0;
    this.freezeDecayTimer = 0;
    this.specialCooldown = 0;
    this.slowFactor = 0;
    // El estado de PRIDE OVERLORD también se reinicia (energía llena).
    this.stunTimer = 0;
    this.prEnergy = CONFIG.PRIDE.energy.max;
    this.prCharging = false;
    this.prCharge = 0;
    this.prChargeCd = 0;
    this.prWaveCd = 0;
    this.prShieldCd = 0;
    this.prZoneCd = 0;
    this.prShieldT = 0;
    this.prShieldHits = 0;
    this.prBoosting = false;
    this.prSlowT = 0;
    this.prSilenceT = 0;
    this._prBoostLock = false;
    this._prShieldWas = false;
    // CRUZ AZUL también se reinicia (recargas listas, sin impulso).
    this.cazPulseCd = 0;
    this.cazBoostCd = 0;
    this.cazBoosting = false;
    this.cazBoostT = 0;
    // AMÉRICA también se reinicia (renacimiento disponible, recargas listas).
    this.amePulseCd = 0;
    this.ameBoostCd = 0;
    this.ameBoosting = false;
    this.ameBoostT = 0;
    this.ameReviveUsed = false;
    this.ameInvulnT = 0;
    // VOID-01 también se reinicia (escudo x3, recargas listas).
    this.voidNukeCd = 0;
    this.voidAimbot = false;
    this.voidBoosting = false;
    this.voidShieldHits = (this.mods && this.mods.void01) ? CONFIG.VOID01.shield.maxHits : 0;
    this.voidTeleportCd = 0;
  }

  /** Guarda el estado anterior para interpolar el render entre ticks. */
  savePrevious() {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevChassisAngle = this.chassisAngle;
    this.prevTurretAngle = this.turretAngle;
  }

  /**
   * Integra la física de movimiento (sin colisiones: las resuelve GameState).
   * Movimiento tipo "tanque": W/S avanzan/retroceden en la dirección del
   * chasis y A/D rotan el chasis, con aceleración y fricción suaves.
   */
  applyInput(input, dt) {
    const T = CONFIG.TANK;
    // Congelado completo o aturdido: no puede moverse, girar ni disparar (la
    // torreta sigue apuntando, pero GameState no deja disparar en esos estados).
    const frozen = this.freezeTimer > 0 || this.stunTimer > 0;
    const slow = MathUtil.clamp(this.slowFactor || 0, 0, 1);
    const moveScale = 1 - slow;
    // PRIDE OVERLORD: turbo (170 %) y ralentización de La Zona de Gemidos (−35 %).
    let speedMod = (this.mods && this.mods.speed) || 1;
    if (this.mods && this.mods.pride) {
      if (this.prBoosting) speedMod = CONFIG.PRIDE.rainbowBoost.speedMultiplier;
      if (this.prSlowT > 0) speedMod *= CONFIG.PRIDE.sonicZone.slowMultiplier;
    }
    // CRUZ AZUL: Turbo Azul (Shift) e impulso tras Descarga Celeste.
    if (this.mods && this.mods.cruzazul) {
      if (this.cazBoosting) speedMod = CONFIG.CRUZAZUL.boost.speedMultiplier;
      if (this.cazBoostT > 0) speedMod *= CONFIG.CRUZAZUL.special.boostSpeedMultiplier;
    }
    // AMÉRICA: Turbo Águila (Shift) e impulso tras Explosión Fénix.
    if (this.mods && this.mods.america) {
      if (this.ameBoosting) speedMod = CONFIG.AMERICA.boost.speedMultiplier;
      if (this.ameBoostT > 0) speedMod *= CONFIG.AMERICA.special.boostSpeedMultiplier;
    }
    // VOID-01: Turbo infinito (Shift) x2 sin recarga.
    if (this.mods && this.mods.void01) {
      if (this.voidBoosting) speedMod = CONFIG.VOID01.boost.speedMultiplier;
    }

    // 1) Rotación del chasis: la velocidad angular persigue a la deseada.
    // CORREGIDO: TURN_RESPONSE faltaba en config.js y producía NaN en el primer tick.
    const turnIn = frozen ? 0 : MathUtil.clamp(input.turn, -1, 1);
    const targetAngVel = turnIn * T.MAX_TURN_SPEED * ((this.mods && this.mods.turn) || 1) * moveScale;
    const turnResponse = (typeof T.TURN_RESPONSE === 'number' && isFinite(T.TURN_RESPONSE)) ? T.TURN_RESPONSE : 12;
    this.angularVelocity += (targetAngVel - this.angularVelocity) * Math.min(1, turnResponse * dt);
    this.chassisAngle = MathUtil.wrapAngle(this.chassisAngle + this.angularVelocity * dt);

    // 2) Velocidad lineal con aceleración / frenado / fricción.
    const throttle = frozen ? 0 : MathUtil.clamp(input.throttle, -1, 1);
    if (throttle !== 0) {
      const maxSpeed = (throttle > 0 ? T.MAX_SPEED : T.MAX_SPEED * T.REVERSE_FACTOR) * speedMod * moveScale;
      const target = throttle * maxSpeed;
      const braking = Math.sign(target) !== Math.sign(this.speed) && this.speed !== 0;
      this.speed = MathUtil.approach(this.speed, target, (braking ? T.BRAKE : T.ACCELERATION) * dt);
    } else {
      this.speed *= Math.exp(-T.FRICTION * dt);
      if (Math.abs(this.speed) < 1) this.speed = 0;
    }

    // 3) Integración de posición.
    this.x += Math.cos(this.chassisAngle) * this.speed * dt;
    this.y += Math.sin(this.chassisAngle) * this.speed * dt;

    // 4) Torreta: independiente del chasis, apunta al ángulo solicitado.
    this.turretAngle = MathUtil.wrapAngle(input.aimAngle);

    // 5) Enfriamiento del arma.
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
  }

  /** Punto de salida del proyectil (punta del cañón). */
  getMuzzlePosition() {
    const d = CONFIG.TANK.BARREL_LENGTH + CONFIG.BULLET.RADIUS;
    return {
      x: this.x + Math.cos(this.turretAngle) * d,
      y: this.y + Math.sin(this.turretAngle) * d,
    };
  }

  // ==========================================================================
  //  SERIALIZACIÓN (orientada a red)
  // ==========================================================================

  /**
   * Estado dinámico mínimo para replicar por red (se envía ~20 veces/seg).
   * Los números se redondean para reducir el tamaño del paquete.
   */
  serialize() {
    return {
      id: this.id,
      x: MathUtil.round(this.x, 1),
      y: MathUtil.round(this.y, 1),
      chassisAngle: MathUtil.round(this.chassisAngle, 3),
      turretAngle: MathUtil.round(this.turretAngle, 3),
      isAlive: this.isAlive,
      shield: this.hasShield,
      // Estado criogénico (FROST REAPER): pilas, congelación, recarga y ralentización.
      freezeStacks: this.freezeStacks | 0,
      freezeTimer: MathUtil.round(this.freezeTimer, 2),
      specialCooldown: MathUtil.round(this.specialCooldown, 1),
      slowFactor: MathUtil.round(this.slowFactor || 0, 2),
      // Estado de PRIDE OVERLORD (aturdimiento, energía, carga, escudo, turbo y recargas).
      stunTimer: MathUtil.round(this.stunTimer || 0, 2),
      prEnergy: MathUtil.round(this.prEnergy || 0, 1),
      prCharging: !!this.prCharging,
      prCharge: MathUtil.round(this.prCharge || 0, 2),
      prShieldT: MathUtil.round(this.prShieldT || 0, 2),
      prShieldHits: this.prShieldHits | 0,
      prBoosting: !!this.prBoosting,
      prChargeCd: MathUtil.round(this.prChargeCd || 0, 1),
      prWaveCd: MathUtil.round(this.prWaveCd || 0, 1),
      prShieldCd: MathUtil.round(this.prShieldCd || 0, 1),
      prZoneCd: MathUtil.round(this.prZoneCd || 0, 1),
      prSlowT: MathUtil.round(this.prSlowT || 0, 2),
      prSilenceT: MathUtil.round(this.prSilenceT || 0, 2),
      // Estado de CRUZ AZUL (recargas e impulso).
      cazPulseCd: MathUtil.round(this.cazPulseCd || 0, 1),
      cazBoostCd: MathUtil.round(this.cazBoostCd || 0, 1),
      cazBoosting: !!this.cazBoosting,
      cazBoostT: MathUtil.round(this.cazBoostT || 0, 2),
      // Estado de AMÉRICA (recargas, impulso, renacimiento e invulnerabilidad).
      amePulseCd: MathUtil.round(this.amePulseCd || 0, 1),
      ameBoostCd: MathUtil.round(this.ameBoostCd || 0, 1),
      ameBoosting: !!this.ameBoosting,
      ameBoostT: MathUtil.round(this.ameBoostT || 0, 2),
      ameReviveUsed: !!this.ameReviveUsed,
      ameInvulnT: MathUtil.round(this.ameInvulnT || 0, 2),
      // Estado de VOID-01 (nuclear, aimbot, turbo, escudo, teletransporte).
      voidNukeCd: MathUtil.round(this.voidNukeCd || 0, 1),
      voidAimbot: !!this.voidAimbot,
      voidBoosting: !!this.voidBoosting,
      voidShieldHits: this.voidShieldHits | 0,
      voidTeleportCd: MathUtil.round(this.voidTeleportCd || 0, 1),
    };
  }

  /** Metadatos que cambian poco (nombre, color, marcador, modelo). */
  serializeMeta() {
    return {
      id: this.id,
      name: this.name,
      slot: this.slot,
      isBot: this.isBot,
      score: this.score,
      wins: this.wins,
      maxBounces: this.maxBounces,
      modelId: this.modelId,
    };
  }

  /**
   * Aplica un estado recibido desde el exterior (red).
   * @param {object} data      resultado de serialize() de otro peer
   * @param {boolean} interpolate
   *    true  → se guarda como objetivo y applyNetSmoothing() se acerca a él
   *            suavemente en cada tick (oculta la baja frecuencia de snapshots).
   *    false → "snap": se refleja el estado inmediatamente.
   */
  deserialize(data, interpolate = true) {
    const wasAlive = this.isAlive;
    this.isAlive = data.isAlive;
    this.hasShield = !!data.shield;
    // Estado criogénico: se refleja directamente (sin interpolar).
    this.freezeStacks = data.freezeStacks | 0;
    this.freezeTimer = data.freezeTimer || 0;
    this.specialCooldown = data.specialCooldown || 0;
    this.slowFactor = data.slowFactor || 0;
    // Estado de PRIDE OVERLORD: se refleja directamente (sin interpolar).
    this.stunTimer = data.stunTimer || 0;
    this.prEnergy = data.prEnergy || 0;
    this.prCharging = !!data.prCharging;
    this.prCharge = data.prCharge || 0;
    this.prShieldT = data.prShieldT || 0;
    this.prShieldHits = data.prShieldHits | 0;
    this.prBoosting = !!data.prBoosting;
    this.prChargeCd = data.prChargeCd || 0;
    this.prWaveCd = data.prWaveCd || 0;
    this.prShieldCd = data.prShieldCd || 0;
    this.prZoneCd = data.prZoneCd || 0;
    this.prSlowT = data.prSlowT || 0;
    this.prSilenceT = data.prSilenceT || 0;
    // Estado de CRUZ AZUL: se refleja directamente (sin interpolar).
    this.cazPulseCd = data.cazPulseCd || 0;
    this.cazBoostCd = data.cazBoostCd || 0;
    this.cazBoosting = !!data.cazBoosting;
    this.cazBoostT = data.cazBoostT || 0;
    // Estado de AMÉRICA: se refleja directamente (sin interpolar).
    this.amePulseCd = data.amePulseCd || 0;
    this.ameBoostCd = data.ameBoostCd || 0;
    this.ameBoosting = !!data.ameBoosting;
    this.ameBoostT = data.ameBoostT || 0;
    this.ameReviveUsed = !!data.ameReviveUsed;
    this.ameInvulnT = data.ameInvulnT || 0;
    // Estado de VOID-01: se refleja directamente (sin interpolar).
    this.voidNukeCd = data.voidNukeCd || 0;
    this.voidAimbot = !!data.voidAimbot;
    this.voidBoosting = !!data.voidBoosting;
    this.voidShieldHits = data.voidShieldHits | 0;
    this.voidTeleportCd = data.voidTeleportCd || 0;

    // Teletransporte (respawn) o primer paquete → no interpolar.
    const farAway = MathUtil.dist2(this.x, this.y, data.x, data.y) > 80 * 80;
    if (!interpolate || farAway || (!wasAlive && data.isAlive)) {
      this.x = this.prevX = data.x;
      this.y = this.prevY = data.y;
      this.chassisAngle = this.prevChassisAngle = data.chassisAngle;
      this.turretAngle = this.prevTurretAngle = data.turretAngle;
      this.netTarget = null;
      return;
    }
    this.netTarget = {
      x: data.x,
      y: data.y,
      chassisAngle: data.chassisAngle,
      turretAngle: data.turretAngle,
    };
  }

  /** Aplica metadatos recibidos por red. */
  deserializeMeta(meta) {
    this.name = meta.name;
    this.slot = meta.slot;
    this.colorIndex = meta.slot % CONFIG.COLORS.length;
    this.isBot = meta.isBot;
    this.score = meta.score;
    this.wins = meta.wins;
    // Modelo predeterminado: restaura colores/efectos (y mods, por si acaso).
    if (meta.modelId && window.TankModels) {
      this.applyModel(window.TankModels.get(meta.modelId));
    } else {
      this.applyModel(null);
    }
    // maxBounces viaja en meta (incluye ajustes de bots); tiene la última palabra.
    this.maxBounces = meta.maxBounces;
  }

  /**
   * Interpolación exponencial hacia el último estado recibido por red.
   * Independiente del framerate gracias a 1 - e^(-k·dt).
   *
   * RETO ALUMNOS (avanzado): sustituir por "entity interpolation" con buffer
   * de snapshots y renderizar ~100 ms en el pasado (técnica de Valve/Source),
   * y para el tanque propio aplicar predicción + reconciliación usando `seq`.
   */
  applyNetSmoothing(dt) {
    if (!this.netTarget) return;
    const t = 1 - Math.exp(-15 * dt);
    this.x = MathUtil.lerp(this.x, this.netTarget.x, t);
    this.y = MathUtil.lerp(this.y, this.netTarget.y, t);
    this.chassisAngle = MathUtil.wrapAngle(MathUtil.lerpAngle(this.chassisAngle, this.netTarget.chassisAngle, t));
    // La torreta se refleja casi directamente para que el apuntado se sienta preciso.
    this.turretAngle = MathUtil.wrapAngle(MathUtil.lerpAngle(this.turretAngle, this.netTarget.turretAngle, Math.min(1, t * 2)));
  }
}

