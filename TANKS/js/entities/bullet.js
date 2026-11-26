'use strict';
/**
 * ============================================================================
 *  entities/bullet.js — Proyectil con rebote especular.
 * ============================================================================
 *  - Velocidad CONSTANTE en módulo (sólo cambia la dirección al rebotar).
 *  - Rebota exactamente `bouncesLeft` veces (1 o 2) contra muros
 *    indestructibles; al siguiente impacto se destruye.
 *  - Al tocar un bloque destructible, lo rompe y la bala desaparece.
 *  - Integración con sub-pasos para evitar "tunneling" a través de muros.
 *
 *  Física del rebote (separación por ejes):
 *    Las paredes del mapa están alineadas a los ejes, así que la normal de la
 *    superficie impactada es (±1, 0) o (0, ±1). Se avanza primero en X y luego
 *    en Y; si el avance en un eje produce solapamiento, ESE eje es el que
 *    colisionó y se aplica r = v - 2(v·n)n con la normal correspondiente.
 *    Resultado: ángulo incidente = ángulo reflejado.
 * ============================================================================
 */
/**
 * Formas de misil dibujadas (ver renderer._drawMissileShape).
 * Cada disparo sale con una forma aleatoria de la lista.
 * Si el jugador subió una imagen de misil personalizada, esa tiene prioridad.
 */
const MISSILE_SHAPES = [
  'dildo', 'negrito', 'banana', 'berenjena', 'hotdog', 'taco',
  'dona', 'durazno', 'croissant', 'zanahoria', 'mierda',
];

/** Devuelve una forma de misil aleatoria. */
function randomMissileShape() {
  return MISSILE_SHAPES[Math.floor(Math.random() * MISSILE_SHAPES.length)];
}

class Bullet {
  /**
   * @param {object} o
   * @param {number} o.id
   * @param {string} o.ownerId
   * @param {number} o.x
   * @param {number} o.y
   * @param {number} o.angle     dirección inicial (rad)
   * @param {number} [o.bounces] rebotes permitidos (1 o 2)
   * @param {string} [o.shape]   forma de misil dibujada (ver MISSILE_SHAPES)
   * @param {number} [o.grace]   segundos sin colisión bala-bala (disparo triple)
   * @param {string} [o.kind]    'normal' | 'cryo' | 'prism' | 'pcharge' | 'void'
   * @param {number} [o.prFrac]  fracción de carga del Rayo del Orgullo (0..1)
   * @param {number} [o.speed]   velocidad inicial (por defecto CONFIG.BULLET.SPEED)
   * @param {number} [o.radius]  radio de la bala (por defecto CONFIG.BULLET.RADIUS)
   */
  constructor({ id, ownerId, x, y, angle, bounces = CONFIG.BULLET.DEFAULT_BOUNCES, shape = null, grace = 0, kind = 'normal', prFrac = 0, speed = null, radius = null }) {
    this.id = id;
    this.ownerId = ownerId;
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    const spd = speed != null ? speed : CONFIG.BULLET.SPEED;
    this.vx = Math.cos(angle) * spd;
    this.vy = Math.sin(angle) * spd;
    this.radius = radius != null ? radius : CONFIG.BULLET.RADIUS;
    this.bouncesLeft = MathUtil.clamp(bounces, 0, CONFIG.BULLET.MAX_BOUNCES);
    this.age = 0;
    this.alive = true;
    /** Mientras la bala no salga del cuerpo de su dueño, no puede dañarlo. */
    this.ownerSafe = true;
    /** Forma de misil dibujada (null = misil clásico). */
    this.shape = shape;
    /** Segundos restantes sin colisión bala-bala (para el disparo triple). */
    this.grace = grace;
    /** 'cryo' = proyectil de hielo; 'prism' = energía cromática; 'pcharge' = Rayo del Orgullo; 'void' = plasma VOID-01. */
    this.kind = ['cryo', 'prism', 'pcharge', 'void'].includes(kind) ? kind : 'normal';
    /** Fracción de carga del Rayo del Orgullo (0..1): tamaño y explosión. */
    this.prFrac = MathUtil.clamp(prFrac || 0, 0, 1);
  }

  savePrevious() {
    this.prevX = this.x;
    this.prevY = this.y;
  }

  /**
   * Avanza la bala `dt` segundos contra el mapa.
   * @param {number} dt
   * @param {TileMap} map
   * @param {object} hooks callbacks de GameState para emitir eventos:
   *        onBounce(bullet), onBlockDestroyed(bullet, tx, ty), onExpire(bullet)
   */
  update(dt, map, hooks) {
    this.age += dt;
    if (this.grace > 0) this.grace -= dt;
    if (this.age > CONFIG.BULLET.MAX_LIFETIME) {
      this.alive = false;
      hooks.onExpire(this);
      return;
    }

    const distance = Math.hypot(this.vx, this.vy) * dt;
    const steps = Math.max(1, Math.ceil(distance / CONFIG.BULLET.SUBSTEP_PX));
    const h = dt / steps;

    for (let i = 0; i < steps && this.alive; i++) {
      // Un impacto en esquina (X e Y en el mismo sub-paso) cuenta como 1 rebote.
      let bouncedThisStep = false;

      // ---- Eje X ----
      const nx = this.x + this.vx * h;
      const hitX = map.queryCircle(nx, this.y, this.radius);
      if (hitX) {
        if (!this._onWallHit(hitX, -Math.sign(this.vx), 0, bouncedThisStep, map, hooks)) return;
        bouncedThisStep = true;
      } else {
        this.x = nx;
      }

      // ---- Eje Y ----
      const ny = this.y + this.vy * h;
      const hitY = map.queryCircle(this.x, ny, this.radius);
      if (hitY) {
        if (!this._onWallHit(hitY, 0, -Math.sign(this.vy), bouncedThisStep, map, hooks)) return;
      } else {
        this.y = ny;
      }
    }
  }

  /**
   * Gestiona el impacto contra una celda sólida.
   * @returns {boolean} true si la bala sigue viva (rebotó), false si murió.
   */
  _onWallHit(hit, normalX, normalY, alreadyBounced, map, hooks) {
    // Rayo del Orgullo: explota contra cualquier pared (sin rebotar).
    if (this.kind === 'pcharge') {
      this.alive = false;
      hooks.onExpire(this);
      return false;
    }
    // Bloque destructible: se rompe y la bala se consume.
    if (hit.type === TILE.BREAKABLE) {
      map.destroyTile(hit.tx, hit.ty);
      this.alive = false;
      hooks.onBlockDestroyed(this, hit.tx, hit.ty);
      return false;
    }

    // Muro indestructible: rebotar si quedan rebotes, si no destruirse.
    if (!alreadyBounced) {
      if (this.bouncesLeft <= 0) {
        this.alive = false;
        hooks.onExpire(this);
        return false;
      }
      this.bouncesLeft--;
      this.ownerSafe = false; // tras rebotar, la bala puede herir a su propio dueño
      hooks.onBounce(this);
    }

    // Reflexión especular: r = v - 2(v·n)n
    const r = MathUtil.reflect(this.vx, this.vy, normalX, normalY);
    this.vx = r.x;
    this.vy = r.y;
    return true;
  }

  get angle() {
    return Math.atan2(this.vy, this.vx);
  }

  // ==========================================================================
  //  SERIALIZACIÓN
  // ==========================================================================
  serialize() {
    const out = {
      id: this.id,
      ownerId: this.ownerId,
      x: MathUtil.round(this.x, 1),
      y: MathUtil.round(this.y, 1),
      vx: MathUtil.round(this.vx, 1),
      vy: MathUtil.round(this.vy, 1),
      bouncesLeft: this.bouncesLeft,
      shape: this.shape,
      kind: this.kind,
    };
    if (this.kind === 'pcharge') {
      out.pf = MathUtil.round(this.prFrac || 0, 2); // tamaño del Rayo del Orgullo
      out.r = MathUtil.round(this.radius, 1);
    }
    if (this.kind === 'void') {
      out.r = MathUtil.round(this.radius, 1);
    }
    return out;
  }

  deserialize(data) {
    this.x = data.x;
    this.y = data.y;
    this.vx = data.vx;
    this.vy = data.vy;
    this.bouncesLeft = data.bouncesLeft;
    this.shape = data.shape || null;
    this.kind = ['cryo', 'prism', 'pcharge', 'void'].includes(data.kind) ? data.kind : 'normal';
    this.prFrac = data.pf || 0;
    if (data.r) this.radius = data.r;
  }

  static fromSnapshot(data) {
    const b = new Bullet({
      id: data.id,
      ownerId: data.ownerId,
      x: data.x,
      y: data.y,
      angle: Math.atan2(data.vy, data.vx),
      bounces: data.bouncesLeft,
      shape: data.shape || null,
      kind: ['cryo', 'prism', 'pcharge', 'void'].includes(data.kind) ? data.kind : 'normal',
      prFrac: data.pf || 0,
      radius: data.r || null,
    });
    b.vx = data.vx;
    b.vy = data.vy;
    return b;
  }
}

