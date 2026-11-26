'use strict';
/**
 * ============================================================================
 *  utils.js — Utilidades matemáticas puras (sin estado, sin DOM).
 * ============================================================================
 *  Al ser funciones puras, pueden usarse indistintamente en el host, en los
 *  clientes o incluso en un servidor Node.js si los alumnos deciden mover la
 *  simulación autoritativa a un backend con WebSockets.
 * ============================================================================
 */
const TAU = Math.PI * 2;

const MathUtil = Object.freeze({
  clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  },

  lerp(a, b, t) {
    return a + (b - a) * t;
  },

  /** Normaliza un ángulo al rango (-PI, PI]. */
  wrapAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  },

  /** Diferencia angular más corta para ir de `a` a `b`. */
  angleDiff(a, b) {
    return MathUtil.wrapAngle(b - a);
  },

  /** Interpolación angular por el camino más corto. */
  lerpAngle(a, b, t) {
    return a + MathUtil.angleDiff(a, b) * t;
  },

  /** Gira `current` hacia `target` como máximo `maxStep` radianes. */
  rotateTowards(current, target, maxStep) {
    const d = MathUtil.angleDiff(current, target);
    if (Math.abs(d) <= maxStep) return target;
    return current + Math.sign(d) * maxStep;
  },

  /** Acerca `value` a `target` como máximo `delta` unidades. */
  approach(value, target, delta) {
    if (value < target) return Math.min(value + delta, target);
    return Math.max(value - delta, target);
  },

  /** Redondea a N decimales (reduce el tamaño de los paquetes JSON). */
  round(v, decimals = 1) {
    const f = 10 ** decimals;
    return Math.round(v * f) / f;
  },

  dist2(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    return dx * dx + dy * dy;
  },

  randRange(min, max) {
    return min + Math.random() * (max - min);
  },

  /**
   * Reflexión especular de un vector v sobre una superficie con normal n
   * (n debe ser unitario):   r = v - 2 (v · n) n
   * Garantiza ángulo de incidencia = ángulo de reflexión.
   */
  reflect(vx, vy, nx, ny) {
    const dot = vx * nx + vy * ny;
    return { x: vx - 2 * dot * nx, y: vy - 2 * dot * ny };
  },

  /** Ruido determinista 0..1 a partir de dos enteros (para texturas estables). */
  hashNoise(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  },
});

