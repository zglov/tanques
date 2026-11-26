'use strict';
/**
 * ============================================================================
 *  map.js — Mapa de celdas (tilemap) y consultas de colisión.
 * ============================================================================
 *  El mapa se guarda en un Uint8Array plano (rápido y compacto). Cualquier
 *  modificación incrementa `revision`, lo que permite:
 *    - al Renderer: saber cuándo re-generar su capa estática cacheada;
 *    - a la capa de red: saber cuándo debe reenviar el mapa a los clientes.
 * ============================================================================
 */
const TILE = Object.freeze({ EMPTY: 0, WALL: 1, BREAKABLE: 2 });

const TILE_CHARS = Object.freeze({ '.': TILE.EMPTY, '#': TILE.WALL, 'x': TILE.BREAKABLE });
const TILE_TO_CHAR = ['.', '#', 'x'];

class TileMap {
  /** @param {string[]} layout filas de caracteres ('#', 'x', '.') */
  constructor(layout) {
    this.tileSize = CONFIG.TILE_SIZE;
    this.revision = 0;
    this.initialLayout = layout.slice();
    this.load(layout);
  }

  /** Carga un layout (array de strings). */
  load(layout) {
    this.rows = layout.length;
    this.cols = layout[0].length;
    this.width = this.cols * this.tileSize;
    this.height = this.rows * this.tileSize;
    this.tiles = new Uint8Array(this.cols * this.rows);
    for (let ty = 0; ty < this.rows; ty++) {
      const row = layout[ty];
      for (let tx = 0; tx < this.cols; tx++) {
        const t = TILE_CHARS[row[tx]];
        this.tiles[ty * this.cols + tx] = t === undefined ? TILE.EMPTY : t;
      }
    }
    this.revision++;
  }

  /** Restaura el mapa original (al comenzar una ronda nueva). */
  reset() {
    this.load(this.initialLayout);
  }

  /** Tipo de celda; fuera de los límites se considera muro (mapa cerrado). */
  get(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return TILE.WALL;
    return this.tiles[ty * this.cols + tx];
  }

  set(tx, ty, type) {
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return;
    this.tiles[ty * this.cols + tx] = type;
    this.revision++;
  }

  isSolid(tx, ty) {
    return this.get(tx, ty) !== TILE.EMPTY;
  }

  isSolidAt(px, py) {
    return this.isSolid(Math.floor(px / this.tileSize), Math.floor(py / this.tileSize));
  }

  /** Destruye un bloque destructible. Devuelve true si se destruyó algo. */
  destroyTile(tx, ty) {
    if (this.get(tx, ty) !== TILE.BREAKABLE) return false;
    this.set(tx, ty, TILE.EMPTY);
    return true;
  }

  /**
   * Devuelve la primera celda sólida que se solapa con el círculo (cx, cy, r),
   * o null si no hay ninguna. Usado por la balística.
   * @returns {{tx:number, ty:number, type:number}|null}
   */
  queryCircle(cx, cy, r) {
    const ts = this.tileSize;
    const minTx = Math.floor((cx - r) / ts), maxTx = Math.floor((cx + r) / ts);
    const minTy = Math.floor((cy - r) / ts), maxTy = Math.floor((cy + r) / ts);
    const r2 = r * r;
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const type = this.get(tx, ty);
        if (type === TILE.EMPTY) continue;
        const bx = tx * ts, by = ty * ts;
        const qx = MathUtil.clamp(cx, bx, bx + ts);
        const qy = MathUtil.clamp(cy, by, by + ts);
        const dx = cx - qx, dy = cy - qy;
        if (dx * dx + dy * dy < r2) return { tx, ty, type };
      }
    }
    return null;
  }

  /**
   * Resuelve la colisión de un círculo contra los bloques empujándolo fuera
   * (círculo vs AABB). Permite "deslizarse" a lo largo de los muros.
   * @param {{x:number, y:number}} body objeto mutable con posición
   * @returns {boolean} true si hubo colisión
   */
  resolveCircle(body, r) {
    const ts = this.tileSize;
    let collided = false;
    for (let iter = 0; iter < 2; iter++) {
      const minTx = Math.floor((body.x - r) / ts), maxTx = Math.floor((body.x + r) / ts);
      const minTy = Math.floor((body.y - r) / ts), maxTy = Math.floor((body.y + r) / ts);
      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          if (!this.isSolid(tx, ty)) continue;
          const bx = tx * ts, by = ty * ts;
          const qx = MathUtil.clamp(body.x, bx, bx + ts);
          const qy = MathUtil.clamp(body.y, by, by + ts);
          const dx = body.x - qx, dy = body.y - qy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          collided = true;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            const push = r - d;
            body.x += (dx / d) * push;
            body.y += (dy / d) * push;
          } else {
            // Centro dentro del bloque: expulsar por el eje de menor penetración.
            const left = body.x - bx, right = bx + ts - body.x;
            const top = body.y - by, bottom = by + ts - body.y;
            const m = Math.min(left, right, top, bottom);
            if (m === left) body.x = bx - r;
            else if (m === right) body.x = bx + ts + r;
            else if (m === top) body.y = by - r;
            else body.y = by + ts + r;
          }
        }
      }
    }
    return collided;
  }

  /** Línea de visión libre entre dos puntos (muestreo cada `step` px). */
  hasLineOfSight(x1, y1, x2, y2, step = 6) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.isSolidAt(x1 + dx * t, y1 + dy * t)) return false;
    }
    return true;
  }

  /** Busca la celda libre más cercana (búsqueda en anillos). */
  findNearestFreeTile(tx, ty) {
    if (!this.isSolid(tx, ty)) return { tx, ty };
    for (let radius = 1; radius < Math.max(this.cols, this.rows); radius++) {
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          if (Math.abs(ox) !== radius && Math.abs(oy) !== radius) continue;
          if (!this.isSolid(tx + ox, ty + oy)) return { tx: tx + ox, ty: ty + oy };
        }
      }
    }
    return { tx: 1, ty: 1 };
  }

  /** Centro en px de una celda. */
  tileCenter(tx, ty) {
    return { x: (tx + 0.5) * this.tileSize, y: (ty + 0.5) * this.tileSize };
  }

  /** Serializa el mapa como array de strings (formato del layout). */
  serialize() {
    const out = new Array(this.rows);
    for (let ty = 0; ty < this.rows; ty++) {
      let row = '';
      for (let tx = 0; tx < this.cols; tx++) row += TILE_TO_CHAR[this.tiles[ty * this.cols + tx]];
      out[ty] = row;
    }
    return out;
  }

  /** Reemplaza el contenido del mapa con datos recibidos por red. */
  deserialize(rows) {
    this.load(rows);
  }
}

