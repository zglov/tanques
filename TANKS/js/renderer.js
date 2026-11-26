'use strict';
/**
 * ============================================================================
 *  renderer.js — Dibujo del GameState en un <canvas> 2D.
 * ============================================================================
 *  El Renderer es de SOLO LECTURA respecto al GameState: nunca modifica la
 *  simulación. Todo lo que mantiene (partículas, huellas de orugas, sacudida
 *  de cámara) es puramente cosmético y local a cada máquina.
 *
 *  Optimización para 60 FPS:
 *   - Capa estática (suelo + bloques) pre-renderizada en un canvas offscreen;
 *     sólo se regenera cuando cambia map.revision (al romperse un bloque).
 *   - Capa de "decals" (huellas) persistente: dibujar una huella cuesta O(1).
 *   - Interpolación (alpha) entre el estado anterior y actual de cada tick
 *     fijo → movimiento suave también en monitores de 120/144 Hz.
 * ============================================================================
 */
class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.state = null;

    this.staticLayer = document.createElement('canvas');
    this.staticCtx = this.staticLayer.getContext('2d');
    this.decalLayer = document.createElement('canvas');
    this.decalCtx = this.decalLayer.getContext('2d');

    this._mapRevision = -1;
    this._roundNumber = -1;
    this._roundBanner = 0;
    this._decalFade = 0;
    this.shake = 0;
    this.time = 0;

    /** Partículas cosméticas. layer 0 = bajo los tanques, 1 = encima. */
    this.particles = [];
    this.rings = [];
    /** Estado cosmético por tanque (fase de orugas, última huella). */
    this.tankFx = new Map();
    /** Imágenes personalizadas de otros jugadores: tankId -> {tank, missile}. */
    this.remoteSkins = new Map();
    this._localTankId = null;
    // PRIDE OVERLORD: ajustes gráficos, textos flotantes, luces, banner y celebración.
    this.settings = { reducedFx: false, quality: 'alta' };
    this.floatTexts = [];
    this.lights = [];
    this.prBanner = null;
    this.samAge = -1;
    this._samRounds = new Set();
    // CRUZ AZUL: sprites, destello de boca y celebración AMO EL CRUZ AZUL.
    this._cazChasisImg = new Image();
    this._cazChasisImg.src = (typeof CONFIG !== 'undefined' && CONFIG.CRUZAZUL) ? CONFIG.CRUZAZUL.sprites.chasis : 'assets/tanks/cruzazul/chasis.png';
    this._cazTorretaImg = new Image();
    this._cazTorretaImg.src = (typeof CONFIG !== 'undefined' && CONFIG.CRUZAZUL) ? CONFIG.CRUZAZUL.sprites.torreta : 'assets/tanks/cruzazul/torreta.png';
    this.cazAge = -1;
    this._cazRounds = new Set();
    this._cazLastWinTime = -99;
    this._cazFlash = new Map(); // tankId -> tiempo del último disparo
    // AMÉRICA: sprites, destello de boca y celebración ARRIBA LAS ÁGUILAS DEL AMÉRICA.
    this._ameChasisImg = new Image();
    this._ameChasisImg.src = (typeof CONFIG !== 'undefined' && CONFIG.AMERICA) ? CONFIG.AMERICA.sprites.chasis : 'assets/tanks/america/chasis.png';
    this._ameTorretaImg = new Image();
    this._ameTorretaImg.src = (typeof CONFIG !== 'undefined' && CONFIG.AMERICA) ? CONFIG.AMERICA.sprites.torreta : 'assets/tanks/america/torreta.png';
    this.ameAge = -1;
    this._ameLastWinTime = -99;
    this._ameFlash = new Map(); // tankId -> tiempo del último disparo
  }

  /** Asocia el GameState a dibujar. */
  setState(state) {
    this.state = state;
    this._mapRevision = -1;
    this._roundNumber = -1;
    this.particles.length = 0;
    this.rings.length = 0;
    this.tankFx.clear();
    this._ensureSize();
    this.decalCtx.clearRect(0, 0, this.decalLayer.width, this.decalLayer.height);
  }

  _ensureSize() {
    const { width, height } = this.state.map;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    for (const c of [this.staticLayer, this.decalLayer]) {
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
    }
  }

  // ==========================================================================
  //  EVENTOS DEL JUEGO → EFECTOS VISUALES
  // ==========================================================================

  /** Estado cosmético por tanque (lo crea si no existe). Lo usa PRIDE OVERLORD. */
  _fxFor(id) {
    let fx = this.tankFx.get(id);
    if (!fx) {
      fx = { lastX: 0, lastY: 0, markX: 0, markY: 0, phase: Math.random() * Math.PI * 2 };
      this.tankFx.set(id, fx);
    }
    return fx;
  }

  /** Destello radial (se dibuja en el siguiente render con desvanecimiento). */
  _light(x, y, r, alpha, rgb) {
    this.lights.push({ x, y, r, alpha, rgb, life: 0.25, max: 0.25 });
  }

  handleEvent(ev) {
    // PRIDE OVERLORD: observación y efectos propios (ver js/prideRender.js).
    if (this._prideObserve) this._prideObserve(ev);
    if (this._handlePrideEvent && this._handlePrideEvent(ev)) return;
    switch (ev.type) {
      case 'shot': {
        const c = Math.cos(ev.angle), s = Math.sin(ev.angle);
        const owner = this.state.tanks.get(ev.ownerId);
        const ownerModel = owner ? this._modelFor(owner) : null;
        if (ownerModel && ownerModel.custom === 'cryo') {
          // Destello criogénico en la boca del Cryo Cannon.
          for (let i = 0; i < 8; i++) {
            const a = ev.angle + MathUtil.randRange(-0.6, 0.6);
            const sp = MathUtil.randRange(30, 130);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.2, MathUtil.randRange(2, 4),
              i % 2 ? '#dff6ff' : '#7fe3ff', 1, 6);
          }
          for (let i = 0; i < 4; i++) {
            this._particle(ev.x + c * 4, ev.y + s * 4, c * 25 + MathUtil.randRange(-12, 12), s * 25 + MathUtil.randRange(-12, 12),
              MathUtil.randRange(0.5, 0.9), 4.5, 'rgba(190,235,255,1)', 1, 2, 8);
          }
          break;
        }
        if (ownerModel && ownerModel.custom === 'cruzazul') {
          // Destello eléctrico en las bocas (brillo, SIN rayo proyectado).
          this._cazFlash.set(ev.ownerId, this.time);
          for (let i = 0; i < 10; i++) {
            const a = ev.angle + MathUtil.randRange(-0.7, 0.7);
            const sp = MathUtil.randRange(40, 160);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.18, MathUtil.randRange(2, 3.5),
              i % 2 ? '#9fdcff' : '#38b6ff', 1, 6);
          }
          for (let i = 0; i < 4; i++) {
            this._particle(ev.x + c * 4, ev.y + s * 4, c * 25 + MathUtil.randRange(-12, 12), s * 25 + MathUtil.randRange(-12, 12),
              MathUtil.randRange(0.4, 0.7), 4.5, 'rgba(180,225,255,1)', 1, 2, 8);
          }
          this._light(ev.x, ev.y, 26, 0.25, '56,182,255');
          break;
        }
        if (ownerModel && ownerModel.custom === 'america') {
          // Destello fénix en las bocas (fuego naranja/rojo).
          this._ameFlash.set(ev.ownerId, this.time);
          for (let i = 0; i < 10; i++) {
            const a = ev.angle + MathUtil.randRange(-0.7, 0.7);
            const sp = MathUtil.randRange(40, 170);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.2, MathUtil.randRange(2, 3.5),
              i % 2 ? '#ff8c1a' : '#ff5a1a', 1, 6);
          }
          for (let i = 0; i < 4; i++) {
            this._particle(ev.x + c * 4, ev.y + s * 4, c * 25 + MathUtil.randRange(-12, 12), s * 25 + MathUtil.randRange(-12, 12),
              MathUtil.randRange(0.4, 0.7), 4.5, 'rgba(255,180,60,1)', 1, 2, 8);
          }
          this._light(ev.x, ev.y, 28, 0.28, '255,140,26');
          break;
        }
        const flash = owner ? this._effectFor(owner) : '#ffd75e';
        for (let i = 0; i < 6; i++) {
          const a = ev.angle + MathUtil.randRange(-0.5, 0.5);
          const sp = MathUtil.randRange(40, 140);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.15, MathUtil.randRange(2, 3.5), flash, 1, 8);
        }
        for (let i = 0; i < 3; i++) {
          this._particle(ev.x + c * 4, ev.y + s * 4, c * 20 + MathUtil.randRange(-10, 10), s * 20 + MathUtil.randRange(-10, 10),
            MathUtil.randRange(0.4, 0.7), 4, 'rgba(200,200,200,1)', 1, 3, 10);
        }
        break;
      }
      case 'bounce':
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(30, 90);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.2, 2, '#fff3b0', 1, 6);
        }
        break;
      case 'bulletDestroyed':
      case 'bulletClash':
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(20, 80);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.25, 0.5), 3,
            i % 2 ? '#ffffff' : '#bdbdbd', 1, 5, 4);
        }
        break;
      case 'blockDestroyed': {
        const ts = CONFIG.TILE_SIZE;
        const cx = (ev.tx + 0.5) * ts, cy = (ev.ty + 0.5) * ts;
        for (let i = 0; i < 22; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(40, 180);
          this._particle(cx + MathUtil.randRange(-12, 12), cy + MathUtil.randRange(-12, 12), Math.cos(a) * sp, Math.sin(a) * sp,
            MathUtil.randRange(0.4, 0.9), MathUtil.randRange(2, 5), i % 3 ? '#d9b97c' : '#9c7a45', 1, 4);
        }
        for (let i = 0; i < 6; i++) {
          this._particle(cx, cy, MathUtil.randRange(-30, 30), MathUtil.randRange(-30, 30), MathUtil.randRange(0.6, 1.1), 8,
            'rgba(190,170,140,1)', 1, 2, 14);
        }
        this.shake = Math.max(this.shake, 3);
        break;
      }
      case 'shieldHit': {
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(40, 140);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.3, 0.6), 3, '#7fd4ff', 1, 5);
        }
        this.rings.push({ x: ev.x, y: ev.y, life: 0.35, max: 0.35, maxR: 40 });
        break;
      }
      case 'tankDestroyed': {
        const color = CONFIG.COLORS[ev.colorIndex] || CONFIG.COLORS[0];
        const victim = this.state.tanks.get(ev.victimId);
        const victimModel = victim ? this._modelFor(victim) : null;
        const effectColor = victim ? this._effectFor(victim) : color.body;
        this.rings.push({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, maxR: 55 });
        if (victimModel && victimModel.custom === 'cryo') {
          // Explosión criogénica: fragmentos metálicos, cristales de hielo y vapor frío.
          for (let i = 0; i < 30; i++) {
            const a = Math.random() * TAU, sp = MathUtil.randRange(50, 230);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.3, 0.75),
              MathUtil.randRange(3, 7), i % 2 ? '#dff6ff' : '#7fe3ff', 1, 4, -4);
          }
          for (let i = 0; i < 14; i++) {
            const a = Math.random() * TAU, sp = MathUtil.randRange(10, 60);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.9, 1.6),
              MathUtil.randRange(6, 10), 'rgba(180,225,250,1)', 1, 1.5, 12);
          }
          for (let i = 0; i < 10; i++) {
            const a = Math.random() * TAU, sp = MathUtil.randRange(80, 200);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.5, 0.9), 3.5, effectColor, 1, 3);
          }
        } else {
          const fire = ['#fff2a8', '#ffc94a', '#ff8a2a', '#ff4d1f'];
          for (let i = 0; i < 28; i++) {
            const a = Math.random() * TAU, sp = MathUtil.randRange(50, 230);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.3, 0.75),
              MathUtil.randRange(3, 7), fire[i % fire.length], 1, 4, -4);
          }
          for (let i = 0; i < 12; i++) {
            const a = Math.random() * TAU, sp = MathUtil.randRange(10, 60);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.9, 1.6),
              MathUtil.randRange(6, 10), 'rgba(90,90,90,1)', 1, 1.5, 12);
          }
          for (let i = 0; i < 10; i++) {
            const a = Math.random() * TAU, sp = MathUtil.randRange(80, 200);
            this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.5, 0.9), 3.5, effectColor, 1, 3);
          }
        }
        this.shake = Math.max(this.shake, 9);
        break;
      }
      case 'cryoHit': {
        // Impacto criogénico: cristales y escarcha.
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(20, 110);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.25, 0.55),
            MathUtil.randRange(2, 4), i % 2 ? '#dff6ff' : '#7fe3ff', 1, 5);
        }
        if (ev.immune) {
          this.rings.push({ x: ev.x, y: ev.y, life: 0.3, max: 0.3, maxR: 30 });
        }
        break;
      }
      case 'frozen': {
        // Congelación completa: explosión de escarcha alrededor del tanque.
        for (let i = 0; i < 22; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(30, 150);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.4, 0.8),
            MathUtil.randRange(2.5, 5), i % 2 ? '#eaf9ff' : '#8fd8ff', 1, 4);
        }
        this.rings.push({ x: ev.x, y: ev.y, life: 0.45, max: 0.45, maxR: 46 });
        break;
      }
      case 'shatter': {
        // El tanque congelado se hace añicos: fragmentos de hielo.
        for (let i = 0; i < 34; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(40, 240);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.3, 0.8),
            MathUtil.randRange(2.5, 6), i % 3 ? '#dff6ff' : '#ffffff', 1, 3, -3);
        }
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(10, 50);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.8, 1.4),
            MathUtil.randRange(5, 9), 'rgba(170,220,250,1)', 1, 1.5, 10);
        }
        this.rings.push({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, maxR: 55 });
        this.shake = Math.max(this.shake, 6);
        break;
      }
      case 'thawed': {
        // Descongelación: vapor frío que se disipa.
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(10, 50);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.5, 1.0),
            4.5, 'rgba(200,235,255,1)', 1, 2, 8);
        }
        break;
      }
      case 'absoluteZero': {
        // Inicio de CERO ABSOLUTO: acumulación de energía y destello.
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * TAU, r = MathUtil.randRange(20, 60);
          const px = ev.x + Math.cos(a) * r, py = ev.y + Math.sin(a) * r;
          this._particle(px, py, -Math.cos(a) * 60, -Math.sin(a) * 60, MathUtil.randRange(0.3, 0.6),
            MathUtil.randRange(2, 4), i % 2 ? '#dff6ff' : '#7fe3ff', 1, 3);
        }
        this.rings.push({ x: ev.x, y: ev.y, life: 0.5, max: 0.5, maxR: 70 });
        this.shake = Math.max(this.shake, 12);
        break;
      }
      case 'absoluteZeroHit': {
        // Enemigo alcanzado por la onda: se congela por completo.
        for (let i = 0; i < 18; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(30, 130);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.35, 0.7),
            MathUtil.randRange(2.5, 5), i % 2 ? '#eaf9ff' : '#8fd8ff', 1, 4);
        }
        break;
      }
      case 'cazPulse': {
        // Descarga Celeste: anillos eléctricos + chispas + sacudida ligera.
        const R = ev.radius || CONFIG.CRUZAZUL.special.radius;
        for (let i = 0; i < 3; i++) {
          this.rings.push({ x: ev.x, y: ev.y, life: 0.35 + i * 0.09, max: 0.35 + i * 0.09, maxR: R * (0.55 + i * 0.2), color: ['56,182,255', '120,210,255', '200,235,255'][i], width: 3 });
        }
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(50, 220);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.25, 0.6),
            MathUtil.randRange(2, 4), i % 2 ? '#9fdcff' : '#38b6ff', 1, 5);
        }
        this._light(ev.x, ev.y, R * 0.6, 0.3, '56,182,255');
        this.shake = Math.max(this.shake, 6);
        break;
      }
      case 'cazBoostStart':
      case 'cazBoostEnd':
        break;
      case 'cruzazulWin': {
        // Evita duplicados por red (mismo evento repetido en <1s), pero permite
        // que se repita en rondas o partidas nuevas aunque el número de ronda
        // vuelva a 1 tras reiniciar con R.
        if (this._cazLastWinTime == null) this._cazLastWinTime = -99;
        if ((this.time - this._cazLastWinTime) < 1.0) break;
        this._cazLastWinTime = this.time;
        this.cazAge = 0;
        break;
      }
      case 'amePulse': {
        // Explosión Fénix: anillos de fuego + chispas + sacudida ligera.
        const R = ev.radius || CONFIG.AMERICA.special.radius;
        for (let i = 0; i < 3; i++) {
          this.rings.push({ x: ev.x, y: ev.y, life: 0.35 + i * 0.09, max: 0.35 + i * 0.09, maxR: R * (0.55 + i * 0.2), color: ['255,140,26', '255,90,26', '255,200,60'][i], width: 3 });
        }
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(50, 230);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.25, 0.6),
            MathUtil.randRange(2, 4), i % 2 ? '#ff8c1a' : '#ff5a1a', 1, 5);
        }
        this._light(ev.x, ev.y, R * 0.6, 0.32, '255,140,26');
        this.shake = Math.max(this.shake, 7);
        break;
      }
      case 'ameRevive': {
        // Renacimiento Fénix: explosión de fuego en muerte y renacimiento.
        for (let i = 0; i < 30; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(40, 220);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.3, 0.7),
            MathUtil.randRange(2.5, 5), i % 2 ? '#ff8c1a' : '#ffd75e', 1, 4);
        }
        for (let i = 0; i < 20; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(30, 150);
          this._particle(ev.newX, ev.newY, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.3, 0.6),
            MathUtil.randRange(2, 4), i % 2 ? '#ff8c1a' : '#ff5a1a', 1, 4);
        }
        this.rings.push({ x: ev.newX, y: ev.newY, life: 0.5, max: 0.5, maxR: 60, color: '255,140,26', width: 3 });
        this.rings.push({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, maxR: 50, color: '255,90,26', width: 3 });
        this._light(ev.newX, ev.newY, 60, 0.4, '255,140,26');
        this.shake = Math.max(this.shake, 8);
        break;
      }
      case 'ameInvulnHit': {
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(40, 140);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.25, 2.5, '#ffd75e', 1, 5);
        }
        break;
      }
      case 'ameBoostStart':
      case 'ameBoostEnd':
        break;
      case 'americaWin': {
        if (this._ameLastWinTime == null) this._ameLastWinTime = -99;
        if ((this.time - this._ameLastWinTime) < 1.0) break;
        this._ameLastWinTime = this.time;
        this.ameAge = 0;
        break;
      }
      case 'roundStart': {
        // Partida nueva: limpia el candado para que la celebración vuelva a salir.
        if (ev.round === 1) {
          this._cazLastWinTime = -99;
          if (this._cazRounds) this._cazRounds.clear();
          this.cazAge = -1;
          this._ameLastWinTime = -99;
          this.ameAge = -1;
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Crea una partícula.
   * @param {number} life  duración en s
   * @param {number} size  radio inicial
   * @param {number} drag  amortiguación de velocidad (1/s)
   * @param {number} grow  crecimiento del radio (px/s, puede ser negativo)
   */
  _particle(x, y, vx, vy, life, size, color, layer = 1, drag = 3, grow = 0) {
    if (this.particles.length > 900) return;
    this.particles.push({ x, y, vx, vy, life, max: life, size, color, layer, drag, grow });
  }

  _updateParticles(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size = Math.max(0.5, p.size + p.grow * dt);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt;
      if (this.rings[i].life <= 0) this.rings.splice(i, 1);
    }
    this.shake = Math.max(0, this.shake - dt * 30);
  }

  // ==========================================================================
  //  RENDER PRINCIPAL
  // ==========================================================================
  /**
   * @param {number} alpha   fracción [0,1) entre el tick anterior y el actual
   * @param {number} frameDt dt real del frame (para efectos cosméticos)
   * @param {object} view    { localTankId, mouse, mirrorState, paused, waitingForHost }
   */
  render(alpha, frameDt, view) {
    const ctx = this.ctx;
    const state = this.state;
    this.time += frameDt;
    this._ensureSize();

    if (state.map.revision !== this._mapRevision) this._buildStaticLayer();
    if (state.round.number !== this._roundNumber) {
      this._roundNumber = state.round.number;
      this._roundBanner = 1.8;
      this.tankFx.clear();
      this.decalCtx.clearRect(0, 0, this.decalLayer.width, this.decalLayer.height);
    }
    if (!view.paused) {
      this._updateParticles(frameDt);
      this._spawnBulletSmoke(frameDt, alpha);
      this._spawnCryoAmbient(frameDt, alpha);
      this._updateFloatTexts(frameDt);
      this._updateLights(frameDt);
    }
    this._roundBanner = Math.max(0, this._roundBanner - frameDt);
    this._updateDecals(alpha, frameDt);
    this._localTankId = view.localTankId;

    // --- Mundo (con sacudida de cámara) ---
    ctx.save();
    if (this.shake > 0) ctx.translate(MathUtil.randRange(-1, 1) * this.shake, MathUtil.randRange(-1, 1) * this.shake);
    ctx.drawImage(this.staticLayer, 0, 0);
    ctx.drawImage(this.decalLayer, 0, 0);
    this._drawFrozenGround(ctx);
    this._drawCryoWaves(ctx);
    // La Zona de Gemidos de PRIDE OVERLORD (translúcida, bajo los tanques).
    if (this._drawPrideGround) this._drawPrideGround(ctx, view.paused ? 0 : frameDt);

    for (const t of state.tanks.values()) if (!t.isAlive) this._drawWreck(ctx, t);
    this._drawParticles(ctx, 0);

    for (const t of state.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha);
      const ca = MathUtil.lerpAngle(t.prevChassisAngle, t.chassisAngle, alpha);
      const ta = MathUtil.lerpAngle(t.prevTurretAngle, t.turretAngle, alpha);
      const fx = this.tankFx.get(t.id);
      if (t.hasShield) this._drawShield(ctx, x, y, this._effectFor(t));
      const skin = this._skinFor(t.id, 'tank');
      const model = this._modelFor(t);
      if (model && model.custom === 'pride' && !skin && this._drawPride) {
        // PRIDE OVERLORD 🌈: diseño propio (ver js/prideRender.js).
        this._drawPride(ctx, t, x, y, ca, ta, view.paused ? 0 : frameDt, view);
      } else if (model && model.custom === 'cryo' && !skin) {
        // CRYO-01 FROST REAPER: diseño criogénico detallado en Canvas 2D.
        this._drawCryoTank(ctx, x, y, ca, ta, fx ? fx.phase : 0, this.time);
      } else if (model && model.custom === 'cruzazul' && !skin) {
        // CRUZ AZUL - LA MÁQUINA: sprites chasis/torreta con destello eléctrico.
        this._drawCruzAzulTank(ctx, t, x, y, ca, ta, view.paused ? 0 : frameDt);
      } else if (model && model.custom === 'america' && !skin) {
        // ÁGUILAS DEL AMÉRICA: sprites chasis/torreta con destello fénix.
        this._drawAmericaTank(ctx, t, x, y, ca, ta, view.paused ? 0 : frameDt);
      } else if (model && model.custom && !skin) {
        // Diseño personalizado del modelo (p. ej. el Destructor).
        this._drawCustomTank(ctx, x, y, ca, ta, this._colorsFor(t), fx ? fx.phase : 0, model.custom);
      } else {
        this._drawTank(ctx, x, y, ca, ta, this._colorsFor(t), fx ? fx.phase : 0, skin);
      }
      // Capa de hielo sobre tanques con pilas de congelación o congelados.
      if (t.freezeTimer > 0 || t.freezeStacks > 0) this._drawFrozenOverlay(ctx, x, y, ca, t);
      this._spawnModelTrail(t, x, y, ca, frameDt);
    }

    for (const b of state.bullets.values()) this._drawBullet(ctx, b, alpha, state, this._skinFor(b.ownerId, 'missile'));

    this._drawParticles(ctx, 1);
    this._drawRings(ctx);
    this._drawLights(ctx);
    this._drawFloatTexts(ctx);

    if (view.mirrorState) this._drawMirror(ctx, view.mirrorState, alpha);

    this._drawLabels(ctx, alpha, view.localTankId);
    ctx.restore();

    // --- Interfaz sobre el mundo (sin sacudida) ---
    this._drawAim(ctx, alpha, view);
    this._drawBanners(ctx, view);
    // PRIDE OVERLORD: anuncio de la zona y celebración AMO A SAMARIEMM.
    if (this._drawPrideOverlay) this._drawPrideOverlay(ctx, view.paused ? 0 : frameDt);
    // CRUZ AZUL: celebración AMO EL CRUZ AZUL.
    this._drawCruzAzulOverlay(ctx, view.paused ? 0 : frameDt);
    // AMÉRICA: celebración ARRIBA LAS ÁGUILAS DEL AMÉRICA.
    this._drawAmericaOverlay(ctx, view.paused ? 0 : frameDt);
  }

  // ==========================================================================
  //  CAPA ESTÁTICA: SUELO Y BLOQUES
  // ==========================================================================
  _buildStaticLayer() {
    const g = this.staticCtx;
    const map = this.state.map;
    const ts = map.tileSize;
    this._mapRevision = map.revision;

    // Suelo de madera clara
    g.fillStyle = '#ead6a9';
    g.fillRect(0, 0, map.width, map.height);
    for (let ty = 0; ty < map.rows; ty++) {
      for (let tx = 0; tx < map.cols; tx++) {
        const n = MathUtil.hashNoise(tx, ty);
        g.fillStyle = `rgba(150,110,50,${0.03 + n * 0.05})`;
        g.fillRect(tx * ts, ty * ts, ts, ts);
      }
    }
    g.strokeStyle = 'rgba(140,100,45,0.12)';
    g.lineWidth = 1;
    g.beginPath();
    for (let tx = 0; tx <= map.cols; tx++) { g.moveTo(tx * ts + 0.5, 0); g.lineTo(tx * ts + 0.5, map.height); }
    for (let ty = 0; ty <= map.rows; ty++) { g.moveTo(0, ty * ts + 0.5); g.lineTo(map.width, ty * ts + 0.5); }
    g.stroke();

    // Sombras proyectadas por los bloques
    g.fillStyle = 'rgba(70,45,20,0.28)';
    for (let ty = 0; ty < map.rows; ty++) {
      for (let tx = 0; tx < map.cols; tx++) {
        if (map.isSolid(tx, ty)) g.fillRect(tx * ts + 6, ty * ts + 7, ts, ts);
      }
    }

    // Bloques
    for (let ty = 0; ty < map.rows; ty++) {
      for (let tx = 0; tx < map.cols; tx++) {
        const type = map.get(tx, ty);
        if (type === TILE.WALL) this._drawWallTile(g, tx, ty, ts);
        else if (type === TILE.BREAKABLE) this._drawBreakableTile(g, tx, ty, ts);
      }
    }
  }

  _drawWallTile(g, tx, ty, ts) {
    const x = tx * ts, y = ty * ts;
    const side = 7;
    g.fillStyle = '#8c6236';           // cara frontal (pseudo-3D)
    g.fillRect(x, y, ts, ts);
    g.fillStyle = '#c4935a';           // cara superior
    g.fillRect(x, y, ts, ts - side);
    g.fillStyle = '#dcae74';           // bisel
    g.fillRect(x, y, ts, 3);
    // Vetas de madera
    g.strokeStyle = 'rgba(110,70,30,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i <= 3; i++) {
      const yy = y + i * ((ts - side) / 4) + (MathUtil.hashNoise(tx * 3 + i, ty) - 0.5) * 3;
      g.moveTo(x + 2, yy);
      g.lineTo(x + ts - 2, yy + (MathUtil.hashNoise(tx, ty * 5 + i) - 0.5) * 2);
    }
    g.stroke();
    g.strokeStyle = 'rgba(60,35,10,0.55)';
    g.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
  }

  _drawBreakableTile(g, tx, ty, ts) {
    const x = tx * ts, y = ty * ts;
    const side = 6;
    g.fillStyle = '#b08a52';
    g.fillRect(x + 1, y + 1, ts - 2, ts - 2);
    g.fillStyle = '#e2c487';
    g.fillRect(x + 1, y + 1, ts - 2, ts - 2 - side);
    // Textura de corcho (moteado determinista)
    for (let i = 0; i < 16; i++) {
      const px = x + 4 + MathUtil.hashNoise(tx * 31 + i, ty * 17) * (ts - 8);
      const py = y + 4 + MathUtil.hashNoise(tx * 13, ty * 29 + i) * (ts - side - 8);
      g.fillStyle = i % 2 ? 'rgba(140,100,50,0.55)' : 'rgba(255,240,200,0.6)';
      g.fillRect(px, py, 2, 2);
    }
    // Marco discontinuo = pista visual de "destructible"
    g.strokeStyle = 'rgba(110,75,30,0.7)';
    g.setLineDash([4, 3]);
    g.strokeRect(x + 4.5, y + 4.5, ts - 9, ts - 9 - side);
    g.setLineDash([]);
    g.strokeStyle = 'rgba(80,55,20,0.6)';
    g.strokeRect(x + 1.5, y + 1.5, ts - 3, ts - 3);
  }

  // ==========================================================================
  //  DECALS: huellas de orugas que se desvanecen
  // ==========================================================================
  _updateDecals(alpha, dt) {
    const g = this.decalCtx;
    this._decalFade += dt;
    if (this._decalFade > 0.5) {
      this._decalFade = 0;
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = 'rgba(0,0,0,0.08)';
      g.fillRect(0, 0, this.decalLayer.width, this.decalLayer.height);
      g.globalCompositeOperation = 'source-over';
    }

    const half = CONFIG.TANK.BODY_WIDTH / 2;
    g.fillStyle = 'rgba(105,75,35,0.22)';
    for (const t of this.state.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha);
      let fx = this.tankFx.get(t.id);
      if (!fx) {
        fx = { lastX: x, lastY: y, markX: x, markY: y, phase: 0 };
        this.tankFx.set(t.id, fx);
      }
      const dx = x - fx.lastX, dy = y - fx.lastY;
      const moved = Math.hypot(dx, dy);
      if (moved > 40) { // teletransporte (respawn / corrección de red)
        fx.markX = x; fx.markY = y;
      }
      const forward = dx * Math.cos(t.chassisAngle) + dy * Math.sin(t.chassisAngle) >= 0 ? 1 : -1;
      fx.phase += moved * forward;
      fx.lastX = x;
      fx.lastY = y;

      if (MathUtil.dist2(x, y, fx.markX, fx.markY) >= 36) {
        const c = Math.cos(t.chassisAngle), s = Math.sin(t.chassisAngle);
        const model = this._modelFor(t);
        if (model && model.custom === 'cryo') {
          // Huellas congeladas: escarcha azulada que queda tras el FROST REAPER.
          g.setTransform(c, s, -s, c, x, y);
          g.fillStyle = 'rgba(175,228,255,0.30)';
          g.beginPath();
          g.ellipse(0, 0, 9, 7, 0, 0, TAU);
          g.fill();
          g.fillStyle = 'rgba(255,255,255,0.35)';
          g.beginPath();
          g.ellipse(-1, -1, 5, 3.5, 0, 0, TAU);
          g.fill();
          g.setTransform(1, 0, 0, 1, 0, 0);
        } else {
          g.setTransform(c, s, -s, c, x, y);
          g.fillRect(-2, -half + 0.5, 4, 6);
          g.fillRect(-2, half - 6.5, 4, 6);
          g.setTransform(1, 0, 0, 1, 0, 0);
        }
        fx.markX = x;
        fx.markY = y;
      }
    }
  }

  // ==========================================================================
  //  ENTIDADES
  // ==========================================================================
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Imagen personalizada para un tanque/bala, o null si usa el dibujo clásico.
   * Primero la propia (TankSkins, local); si no, la compartida por la red.
   */
  _skinFor(tankId, kind) {
    if (tankId === this._localTankId) {
      const img = window.TankSkins && window.TankSkins[kind];
      if (img && img.complete && img.naturalWidth > 0) return img;
    }
    const entry = this.remoteSkins.get(tankId);
    const img = entry && entry[kind];
    if (img && img.complete && img.naturalWidth > 0) return img;
    return null;
  }

  /** Modelo predeterminado de un tanque, o null (Clásico / sin modelo). */
  _modelFor(tank) {
    return (window.TankModels && tank && tank.modelId) ? window.TankModels.get(tank.modelId) : null;
  }

  /** Colores a usar para dibujar el tanque (los del modelo o los de su slot). */
  _colorsFor(tank) {
    const m = this._modelFor(tank);
    return (m && m.colors) || tank.color;
  }

  /** Color de los efectos del modelo (destello, estela, explosión). */
  _effectFor(tank) {
    const m = this._modelFor(tank);
    return (m && m.effect) || '#ffd75e';
  }

  /** Anillo del escudo (habilidad del modelo Blindado). */
  _drawShield(ctx, x, y, color) {
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.15 * Math.sin(this.time * 6);
    ctx.beginPath();
    ctx.arc(x, y, 21, 0, TAU);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.08;
    ctx.fill();
    ctx.restore();
  }

  /** Estela de partículas detrás de los tanques con modelo (no Clásico). */
  _spawnModelTrail(t, x, y, ca, frameDt) {
    const m = this._modelFor(t);
    if (!m || m.id === 'clasico') return;
    if (Math.abs(t.speed) < 25) return;
    let fx = this.tankFx.get(t.id);
    if (!fx) {
      fx = { lastX: x, lastY: y, markX: x, markY: y, phase: 0, trailAcc: 0 };
      this.tankFx.set(t.id, fx);
    }
    fx.trailAcc = (fx.trailAcc || 0) + frameDt;
    if (fx.trailAcc < 0.06) return;
    fx.trailAcc = 0;
    const bx = x - Math.cos(ca) * 16, by = y - Math.sin(ca) * 16;
    this._particle(bx, by, MathUtil.randRange(-8, 8), MathUtil.randRange(-8, 8), 0.45, 3, m.effect, 0, 2, 4);
  }

  _drawTank(ctx, x, y, chassis, turret, color, treadPhase, skinImage) {
    const T = CONFIG.TANK;
    const L = T.BODY_LENGTH, W = T.BODY_WIDTH;
    const treadH = 7;

    // --- Skin personalizada: imagen subida por el usuario (propia o remota) ---
    const skin = skinImage;
    if (skin) {
      ctx.save();
      ctx.translate(x, y);
      // Sombra
      ctx.fillStyle = 'rgba(50,30,10,0.3)';
      ctx.beginPath();
      ctx.ellipse(3, 4, L / 2 + 2, W / 2 + 2, 0, 0, TAU);
      ctx.fill();
      // La imagen se gira hacia la torreta (hacia donde apuntas) y se ajusta
      // conservando su proporción dentro del tamaño del tanque.
      ctx.rotate(turret);
      const maxW = L + 10, maxH = W + 10;
      const s = Math.min(maxW / skin.naturalWidth, maxH / skin.naturalHeight);
      const dw = skin.naturalWidth * s, dh = skin.naturalHeight * s;
      ctx.drawImage(skin, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(x, y);

    // --- Chasis ---
    ctx.save();
    ctx.rotate(chassis);
    // Sombra
    ctx.fillStyle = 'rgba(50,30,10,0.3)';
    this._roundRect(ctx, -L / 2 + 3, -W / 2 + 4, L, W, 5);
    ctx.fill();
    // Orugas (con franjas animadas según la distancia recorrida)
    const off = ((treadPhase % 5) + 5) % 5;
    for (const ty of [-W / 2, W / 2 - treadH]) {
      ctx.fillStyle = '#2a2a2a';
      this._roundRect(ctx, -L / 2, ty, L, treadH, 2.5);
      ctx.fill();
      ctx.fillStyle = '#5a5a5a';
      for (let sx = -L / 2 + off; sx < L / 2 - 1; sx += 5) ctx.fillRect(sx, ty + 1, 1.6, treadH - 2);
    }
    // Carrocería
    ctx.fillStyle = color.body;
    this._roundRect(ctx, -L / 2 + 2, -W / 2 + 5, L - 4, W - 10, 3);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color.dark;
    ctx.stroke();
    ctx.fillStyle = color.light;
    ctx.fillRect(-L / 2 + 5, -W / 2 + 6.5, L - 12, 2);
    // Indicador frontal
    ctx.fillStyle = color.dark;
    ctx.fillRect(L / 2 - 6, -3, 3, 6);
    ctx.restore();

    // --- Torreta (rotación independiente) ---
    ctx.rotate(turret);
    ctx.fillStyle = color.dark;
    ctx.fillRect(0, -3.6, T.BARREL_LENGTH, 7.2);
    ctx.fillStyle = color.body;
    ctx.fillRect(2, -2.2, T.BARREL_LENGTH - 4, 4.4);
    ctx.fillStyle = color.dark;
    ctx.fillRect(T.BARREL_LENGTH - 4, -4.4, 5, 8.8);

    ctx.beginPath();
    ctx.arc(0, 0, 8.5, 0, TAU);
    ctx.fillStyle = color.body;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color.dark;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-2.2, -2.2, 3, 0, TAU);
    ctx.fillStyle = color.light;
    ctx.fill();

    ctx.restore();
  }

  /**
   * Diseño personalizado del modelo Destructor: chasis angular con núcleo
   * brillante y torreta giratoria con cañón triple (su habilidad especial).
   * Coordenadas locales: origen en el centro del tanque, +X = avance del chasis.
   */
  _drawCustomTank(ctx, x, y, chassis, turret, color, treadPhase, design) {
    ctx.save();
    ctx.translate(x, y);

    // ---------- Chasis ----------
    ctx.save();
    ctx.rotate(chassis);

    // Orugas angulares
    ctx.fillStyle = color.dark;
    this._roundRect(ctx, -15, -13, 30, 6, 3); ctx.fill();
    this._roundRect(ctx, -15, 7, 30, 6, 3); ctx.fill();

    // Cuerpo angular
    ctx.beginPath();
    ctx.moveTo(-13, -9);
    ctx.lineTo(9, -11);
    ctx.lineTo(16, -5);
    ctx.lineTo(16, 5);
    ctx.lineTo(9, 11);
    ctx.lineTo(-13, 9);
    ctx.closePath();
    ctx.fillStyle = color.body;
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = color.dark; ctx.stroke();

    // Placa frontal
    ctx.beginPath();
    ctx.moveTo(9, -8); ctx.lineTo(16, -5); ctx.lineTo(16, 5); ctx.lineTo(9, 8);
    ctx.closePath();
    ctx.fillStyle = color.light;
    ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;

    // Núcleo brillante
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 8);
    glow.addColorStop(0, 'rgba(255,255,255,0.95)');
    glow.addColorStop(0.35, color.light);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, TAU); ctx.fill();

    ctx.restore();

    // ---------- Torreta giratoria ----------
    ctx.save();
    ctx.rotate(turret);

    // Cañón triple
    ctx.fillStyle = color.dark;
    for (const off of [-3.4, 0, 3.4]) {
      this._roundRect(ctx, 3, off - 1.6, 19, 3.2, 1.6); ctx.fill();
    }
    // Base de la torreta
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU);
    ctx.fillStyle = color.body; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = color.dark; ctx.stroke();
    // Escotilla
    ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, TAU);
    ctx.fillStyle = color.light; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = color.dark; ctx.stroke();

    ctx.restore();
    ctx.restore();
  }

  /**
   * CRYO-01 FROST REAPER: tanque criogénico futurista dibujado con Canvas 2D.
   * Blindaje blanco/plateado/azul glaciar angular, orugas escarchadas,
   * cristales de hielo, núcleo criogénico brillante, conductos transparentes,
   * dos cañones criogénicos paralelos, LEDs cian, rejillas de vapor y escarcha.
   * Coordenadas locales: origen en el centro, +X = avance del chasis.
   */
  _drawCryoTank(ctx, x, y, chassis, turret, treadPhase, time) {
    const pulse = 0.85 + 0.15 * Math.sin(time * 4);
    ctx.save();
    ctx.translate(x, y);

    // ---------- Chasis ----------
    ctx.save();
    ctx.rotate(chassis);

    // Sombra
    ctx.fillStyle = 'rgba(50,30,10,0.3)';
    ctx.beginPath();
    ctx.ellipse(3, 4, 20, 16, 0, 0, TAU);
    ctx.fill();

    // Orugas negras con escarcha
    const off = ((treadPhase % 5) + 5) % 5;
    for (const ty of [-13.5, 7.5]) {
      ctx.fillStyle = '#1d2733';
      this._roundRect(ctx, -16, ty, 32, 6, 3); ctx.fill();
      ctx.fillStyle = '#5a6b7a';
      for (let sx = -16 + off; sx < 15; sx += 5) ctx.fillRect(sx, ty + 1, 1.6, 4);
      // Escarcha sobre la oruga
      ctx.fillStyle = 'rgba(220,245,255,0.55)';
      ctx.fillRect(-15 + ((off * 2) % 6), ty + 0.8, 5, 1.6);
      ctx.fillRect(5 - ((off * 2) % 5), ty + 3.4, 4, 1.4);
    }

    // Blindaje angular principal (degradado blanco → azul glaciar, con contraste)
    const hullGrad = ctx.createLinearGradient(0, -13, 0, 13);
    hullGrad.addColorStop(0, '#eaf6ff');
    hullGrad.addColorStop(0.45, '#bfe0f5');
    hullGrad.addColorStop(1, '#8fc8ec');
    ctx.beginPath();
    ctx.moveTo(-16, -11);
    ctx.lineTo(10, -13);
    ctx.lineTo(19, -7);
    ctx.lineTo(19, 7);
    ctx.lineTo(10, 13);
    ctx.lineTo(-16, 11);
    ctx.closePath();
    ctx.fillStyle = hullGrad;
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#4d82ad';
    ctx.stroke();

    // Placas angulares superpuestas
    ctx.beginPath();
    ctx.moveTo(-16, -11); ctx.lineTo(1, -12); ctx.lineTo(5, -3); ctx.lineTo(-1, 4); ctx.lineTo(-16, 7);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(10, -13); ctx.lineTo(19, -7); ctx.lineTo(19, 7); ctx.lineTo(10, 13); ctx.lineTo(5, 0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,180,225,0.5)';
    ctx.fill();

    // Acumulación de escarcha sobre el blindaje
    ctx.fillStyle = 'rgba(235,250,255,0.65)';
    ctx.beginPath(); ctx.ellipse(-8, -6, 5, 2.2, 0.3, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(11, 6, 4.5, 2, -0.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(15, -2, 3, 1.6, 0, 0, TAU); ctx.fill();

    // Cristales de hielo en los laterales
    ctx.fillStyle = 'rgba(170,225,250,0.75)';
    ctx.strokeStyle = '#5fb8e8';
    ctx.lineWidth = 1;
    for (const [cx, cy, s] of [[-12, -11.5, 4], [0, -13, 3.2], [-12, 11.5, 4], [0, 13, 3.2], [16.5, 0, 2.6]]) {
      ctx.beginPath();
      ctx.moveTo(cx - s, cy);
      ctx.lineTo(cx + s * 0.4, cy - s);
      ctx.lineTo(cx + s, cy);
      ctx.lineTo(cx + s * 0.4, cy + s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Conductos transparentes de energía congelante (core → cañones)
    ctx.lineCap = 'round';
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(2, sy * 3);
      ctx.quadraticCurveTo(9, sy * 5, 13, sy * 3.2);
      ctx.strokeStyle = 'rgba(127,227,255,0.35)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(230,250,255,0.9)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // Núcleo de energía criogénica (brillante, pulsante)
    const coreGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 8);
    coreGlow.addColorStop(0, 'rgba(255,255,255,0.95)');
    coreGlow.addColorStop(0.35, `rgba(127,227,255,${0.85 * pulse})`);
    coreGlow.addColorStop(1, 'rgba(127,227,255,0)');
    ctx.fillStyle = coreGlow;
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU);
    ctx.strokeStyle = 'rgba(127,227,255,0.9)';
    ctx.lineWidth = 1.4; ctx.stroke();

    // Rejillas de ventilación (expulsan vapor frío)
    ctx.fillStyle = '#3d4a57';
    for (const [vx, vy] of [[-9, -4], [-9, 4], [-12, 0]]) {
      this._roundRect(ctx, vx - 2.4, vy - 1, 4.8, 2, 1); ctx.fill();
    }
    ctx.fillStyle = 'rgba(220,245,255,0.8)';
    for (const [vx, vy] of [[-9, -4], [-9, 4], [-12, 0]]) ctx.fillRect(vx - 1.6, vy - 0.4, 3.2, 0.8);

    // LEDs cian
    ctx.fillStyle = '#37e0ff';
    for (const [lx, ly] of [[16, -4], [16, 4], [-14, -8.5], [-14, 8.5], [4, -10.5], [4, 10.5]]) {
      ctx.beginPath(); ctx.arc(lx, ly, 1.3, 0, TAU); ctx.fill();
    }

    ctx.restore();

    // ---------- Torreta giratoria con cañones criogénicos gemelos ----------
    ctx.save();
    ctx.rotate(turret);

    // Cañones criogénicos paralelos (largos: salen bien de la torreta)
    for (const offY of [-3.4, 3.4]) {
      const barrelGrad = ctx.createLinearGradient(0, offY - 2, 0, offY + 2);
      barrelGrad.addColorStop(0, '#ffffff');
      barrelGrad.addColorStop(0.5, '#cfe9f8');
      barrelGrad.addColorStop(1, '#7fb8dd');
      ctx.fillStyle = barrelGrad;
      this._roundRect(ctx, 3, offY - 1.7, 23, 3.4, 1.7); ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#4d82ad';
      ctx.stroke();
      // Línea de energía congelante a lo largo del cañón
      ctx.beginPath();
      ctx.moveTo(6, offY);
      ctx.lineTo(23, offY);
      ctx.strokeStyle = 'rgba(127,227,255,0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // Boca luminosa
      const tipGlow = ctx.createRadialGradient(27, offY, 0, 27, offY, 5);
      tipGlow.addColorStop(0, 'rgba(255,255,255,0.95)');
      tipGlow.addColorStop(1, 'rgba(127,227,255,0)');
      ctx.fillStyle = tipGlow;
      ctx.beginPath(); ctx.arc(27, offY, 5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#dff6ff';
      ctx.beginPath(); ctx.arc(26, offY, 1.6, 0, TAU); ctx.fill();
    }

    // Base de la torreta hexagonal (angular y agresiva)
    const baseGrad = ctx.createLinearGradient(0, -8, 0, 8);
    baseGrad.addColorStop(0, '#ffffff');
    baseGrad.addColorStop(0.55, '#cfe6f5');
    baseGrad.addColorStop(1, '#8fb8d8');
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU; // vértice frontal en +X
      const px = Math.cos(a) * 8, py = Math.sin(a) * 8;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = baseGrad; ctx.fill();
    ctx.lineWidth = 1.8; ctx.strokeStyle = '#4d82ad'; ctx.stroke();

    // Escarcha sobre la torreta
    ctx.fillStyle = 'rgba(240,252,255,0.7)';
    ctx.beginPath(); ctx.ellipse(-2.5, -3, 3, 1.4, 0.4, 0, TAU); ctx.fill();

    // Domo del núcleo en la torreta
    const domeGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 5);
    domeGlow.addColorStop(0, 'rgba(255,255,255,0.95)');
    domeGlow.addColorStop(0.4, `rgba(127,227,255,${0.8 * pulse})`);
    domeGlow.addColorStop(1, 'rgba(127,227,255,0)');
    ctx.fillStyle = domeGlow;
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, TAU);
    ctx.fillStyle = '#ffffff'; ctx.fill();

    ctx.restore();
    ctx.restore();
  }

  /**
   * Proyectil criogénico (Cryo Cannon): cristal de hielo afilado con núcleo
   * luminoso blanco-azul. Coordenadas locales: origen en el centro, +X = vuelo.
   */
  _drawCryoBullet(ctx) {
    // Halo luminoso
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 11);
    glow.addColorStop(0, 'rgba(200,240,255,0.85)');
    glow.addColorStop(0.45, 'rgba(127,227,255,0.45)');
    glow.addColorStop(1, 'rgba(127,227,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fill();

    // Cristal alargado (rombo afilado)
    const g = ctx.createLinearGradient(0, -4, 0, 4);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, '#bfe9ff');
    g.addColorStop(1, '#5fb8e8');
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(1.5, -3.4);
    ctx.lineTo(-7, 0);
    ctx.lineTo(1.5, 3.4);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#2f7fb8';
    ctx.stroke();
    // Facetas internas
    ctx.beginPath();
    ctx.moveTo(1.5, -3.4); ctx.lineTo(-2, 0); ctx.lineTo(1.5, 3.4);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Núcleo luminoso
    ctx.beginPath();
    ctx.ellipse(1, 0, 3.4, 1.7, 0, 0, TAU);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  /**
   * Capa de hielo sobre un tanque con pilas de congelación o congelado por
   * completo. La intensidad crece con las pilas; congelado = cascarón completo
   * con cristales y grietas.
   */
  _drawFrozenOverlay(ctx, x, y, chassis, t) {
    const frozen = t.freezeTimer > 0;
    const stacks = t.freezeStacks | 0;
    const alpha = frozen ? 0.6 : (stacks >= 2 ? 0.38 : 0.22);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(chassis);

    // Cascarón de hielo
    ctx.fillStyle = `rgba(190,235,255,${alpha})`;
    this._roundRect(ctx, -17, -14, 34, 28, 6);
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `rgba(255,255,255,${frozen ? 0.9 : 0.55})`;
    ctx.stroke();
    // Escarcha interna
    ctx.fillStyle = `rgba(255,255,255,${frozen ? 0.35 : 0.2})`;
    ctx.beginPath(); ctx.ellipse(-4, -4, 9, 5, 0.3, 0, TAU); ctx.fill();

    // Cristales alrededor de la carrocería
    const nCrystals = frozen ? 8 : (stacks >= 2 ? 5 : 3);
    ctx.fillStyle = 'rgba(200,240,255,0.85)';
    ctx.strokeStyle = '#5fb8e8';
    ctx.lineWidth = 1;
    for (let i = 0; i < nCrystals; i++) {
      const a = (i / nCrystals) * TAU + 0.4;
      const cx = Math.cos(a) * 18, cy = Math.sin(a) * 15;
      const s = frozen ? 3.6 : 2.6;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy);
      ctx.lineTo(cx + s * 0.4, cy - s);
      ctx.lineTo(cx + s, cy);
      ctx.lineTo(cx + s * 0.4, cy + s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Grietas cuando está completamente congelado
    if (frozen) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-10, -6); ctx.lineTo(-4, -2); ctx.lineTo(-7, 3); ctx.lineTo(-1, 7);
      ctx.moveTo(8, -7); ctx.lineTo(3, -3); ctx.lineTo(7, 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Suelo congelado por CERO ABSOLUTO: escarcha translúcida sobre las casillas. */
  _drawFrozenGround(ctx) {
    if (!this.state.frozenTiles || this.state.frozenTiles.size === 0) return;
    const ts = this.state.map.tileSize;
    const maxTime = CONFIG.CRYO.GROUND_FROST_TIME;
    ctx.save();
    for (const [key, remaining] of this.state.frozenTiles) {
      const parts = key.split(',');
      const tx = Number(parts[0]), ty = Number(parts[1]);
      const k = Math.max(0, Math.min(1, remaining / maxTime));
      const a = 0.12 + 0.33 * k;
      ctx.fillStyle = `rgba(185,232,255,${a})`;
      ctx.fillRect(tx * ts + 1, ty * ts + 1, ts - 2, ts - 2);
      // Brillo cristalino (determinista por casilla)
      const n = MathUtil.hashNoise(tx * 7 + 3, ty * 11 + 5);
      if (n > 0.35) {
        ctx.fillStyle = `rgba(255,255,255,${0.25 * k + 0.1})`;
        const sx = tx * ts + 6 + n * (ts - 14);
        const sy = ty * ts + 6 + MathUtil.hashNoise(tx, ty * 3 + 1) * (ts - 14);
        ctx.fillRect(sx, sy, 3, 1.6);
        ctx.fillRect(sx + 1, sy - 1.6, 1.2, 3);
      }
    }
    ctx.restore();
  }

  /** Onda expansiva de CERO ABSOLUTO: anillo de escarcha + niebla fría. */
  _drawCryoWaves(ctx) {
    if (!this.state.waves || this.state.waves.length === 0) return;
    ctx.save();
    for (const w of this.state.waves) {
      const r = w.radius;
      // Niebla fría interior
      ctx.fillStyle = 'rgba(160,220,255,0.10)';
      ctx.beginPath(); ctx.arc(w.x, w.y, r, 0, TAU); ctx.fill();
      // Anillo de escarcha (frente de la onda)
      ctx.lineWidth = 9;
      ctx.strokeStyle = 'rgba(190,240,255,0.55)';
      ctx.beginPath(); ctx.arc(w.x, w.y, r, 0, TAU); ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(245,253,255,0.9)';
      ctx.beginPath(); ctx.arc(w.x, w.y, r, 0, TAU); ctx.stroke();
      // Cristales sobre el frente de la onda
      ctx.fillStyle = 'rgba(210,245,255,0.9)';
      ctx.strokeStyle = '#5fb8e8';
      ctx.lineWidth = 1;
      const nCrystals = 10;
      for (let i = 0; i < nCrystals; i++) {
        const a = (i / nCrystals) * TAU + 0.31;
        const jitter = MathUtil.hashNoise(i * 3 + 1, Math.floor(this.time * 4)) * 6 - 3;
        const cx = w.x + Math.cos(a) * (r + jitter);
        const cy = w.y + Math.sin(a) * (r + jitter);
        const s = 3.4;
        ctx.beginPath();
        ctx.moveTo(cx - s, cy);
        ctx.lineTo(cx + s * 0.4, cy - s);
        ctx.lineTo(cx + s, cy);
        ctx.lineTo(cx + s * 0.4, cy + s);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Ambiente criogénico: nieve y vapor frío alrededor de cada FROST REAPER
   * vivo, y estela de partículas congeladas tras los proyectiles criogénicos.
   */
  _spawnCryoAmbient(dt, alpha) {
    for (const t of this.state.tanks.values()) {
      if (!t.isAlive) continue;
      const model = this._modelFor(t);
      if (!model || model.custom !== 'cryo') continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha);
      // Copos de nieve alrededor del vehículo
      if (Math.random() < dt * 10) {
        const a = Math.random() * TAU, r = MathUtil.randRange(10, 30);
        this._particle(x + Math.cos(a) * r, y + Math.sin(a) * r,
          MathUtil.randRange(-8, 8), MathUtil.randRange(4, 14),
          MathUtil.randRange(0.8, 1.6), MathUtil.randRange(1.2, 2.4), 'rgba(235,250,255,1)', 1, 0.5);
      }
      // Vapor frío de las rejillas
      if (Math.random() < dt * 14) {
        const a = Math.random() * TAU, r = MathUtil.randRange(6, 14);
        this._particle(x + Math.cos(a) * r, y + Math.sin(a) * r,
          MathUtil.randRange(-6, 6), MathUtil.randRange(-10, -2),
          MathUtil.randRange(0.5, 0.9), 3.2, 'rgba(200,235,255,1)', 0, 1.5, 7);
      }
    }
    // Estela congelada de los proyectiles criogénicos
    const chance = dt * 30;
    for (const b of this.state.bullets.values()) {
      if (b.kind !== 'cryo') continue;
      if (Math.random() > chance) continue;
      const x = MathUtil.lerp(b.prevX, b.x, alpha);
      const y = MathUtil.lerp(b.prevY, b.y, alpha);
      this._particle(x, y, MathUtil.randRange(-6, 6), MathUtil.randRange(-6, 6),
        0.45, 2.4, 'rgba(170,225,255,1)', 0, 1, 5);
    }
  }

  /**
   * CRUZ AZUL - LA MÁQUINA: sprites chasis + torreta con rotación independiente.
   * Los sprites apuntan hacia abajo en la imagen (cañones abajo), por eso se
   * rota con ángulo - PI/2 para alinearlos con el ángulo del juego.
   * Efecto eléctrico: brillo en las bocas al disparar, SIN rayo proyectado.
   */
  _drawCruzAzulTank(ctx, t, x, y, chassis, turret, dt) {
    const chasisImg = this._cazChasisImg;
    const torretaImg = this._cazTorretaImg;
    const chasisReady = chasisImg && chasisImg.complete && chasisImg.naturalWidth > 0;
    const torretaReady = torretaImg && torretaImg.complete && torretaImg.naturalWidth > 0;

    // Sombra
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x + 3, y + 5, 28, 22, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (!chasisReady || !torretaReady) {
      // Fallback mientras cargan los sprites: tanque azul clásico.
      this._drawTank(ctx, x, y, chassis, turret, this._colorsFor(t), 0, null);
      return;
    }

    const CHASIS_SIZE = 56;
    const TORRETA_SIZE = 40;

    // Chasis (gira con el movimiento)
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(chassis - Math.PI / 2);
    ctx.drawImage(chasisImg, -CHASIS_SIZE / 2, -CHASIS_SIZE / 2, CHASIS_SIZE, CHASIS_SIZE);
    ctx.restore();

    // Torreta (gira con la mira)
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turret - Math.PI / 2);
    ctx.drawImage(torretaImg, -TORRETA_SIZE / 2, -TORRETA_SIZE / 2, TORRETA_SIZE, TORRETA_SIZE);
    ctx.restore();

    // Brillo eléctrico en las bocas de los cañones (sin rayo).
    const lastShot = this._cazFlash.get(t.id);
    const flashAge = lastShot != null ? this.time - lastShot : 99;
    const flashK = flashAge < 0.18 ? 1 - flashAge / 0.18 : 0;
    const idlePulse = 0.35 + 0.15 * Math.sin(this.time * 5);
    const glowK = Math.max(idlePulse * 0.5, flashK);
    // Posición de las bocas: distancia ~20px, separación lateral ±6px.
    const muzzleDist = 20;
    const dx = Math.cos(turret), dy = Math.sin(turret);
    const px = -dy, py = dx;
    for (const side of [-1, 1]) {
      const mx = x + dx * muzzleDist + px * side * 6;
      const my = y + dy * muzzleDist + py * side * 6;
      const r = 7 + flashK * 6;
      const g = ctx.createRadialGradient(mx, my, 0, mx, my, r);
      g.addColorStop(0, `rgba(255,255,255,${0.85 * glowK + 0.1})`);
      g.addColorStop(0.4, `rgba(120,210,255,${0.6 * glowK})`);
      g.addColorStop(1, 'rgba(56,182,255,0)');
      ctx.save();
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Turbo Azul: estela eléctrica detrás del chasis.
    if (dt && (t.cazBoosting || (t.cazBoostT > 0))) {
      const bx = x - Math.cos(chassis) * 22, by = y - Math.sin(chassis) * 22;
      if (Math.random() < dt * 28) {
        this._particle(bx + MathUtil.randRange(-6, 6), by + MathUtil.randRange(-6, 6),
          -Math.cos(chassis) * 40 + MathUtil.randRange(-15, 15),
          -Math.sin(chassis) * 40 + MathUtil.randRange(-15, 15),
          0.4, 2.4, Math.random() < 0.5 ? '#9fdcff' : '#38b6ff', 0, 2, 3);
      }
    }

    // Aturdido: estrellitas sobre el tanque.
    if (t.stunTimer > 0 && dt) {
      if (Math.random() < dt * 6) {
        this._particle(x + MathUtil.randRange(-10, 10), y - 20, MathUtil.randRange(-8, 8), -18,
          0.6, 2.2, '#ffe14f', 1, 1, 2);
      }
    }
  }

  /** Celebración AMO EL CRUZ AZUL (azul/blanco/rojo, sin foto). */
  _drawCruzAzulOverlay(ctx, dt) {
    if (this.cazAge < 0) return;
    this.cazAge += dt;
    const C = CONFIG.CRUZAZUL.victoryCelebration;
    const k = this.cazAge / C.duration;
    if (k >= 1) { this.cazAge = -1; return; }
    const W = this.canvas.width, Hh = this.canvas.height;
    ctx.save();
    ctx.fillStyle = `rgba(4,18,48,${0.55 * Math.min(1, k * 4)})`;
    ctx.fillRect(0, 0, W, Hh);
    // Confeti azul, blanco y rojo.
    const COLORS = ['#0b3d91', '#ffffff', '#e01e2b', '#6ab0ff', '#38b6ff'];
    for (let i = 0; i < 60; i++) {
      const seed = i * 2.39;
      const fx = ((seed * 97) % W + this.cazAge * 30 * (i % 3 - 1)) % W;
      const fy = ((seed * 53) % (Hh + 40) + this.cazAge * 90 * (0.5 + (i % 5) / 10)) % (Hh + 40) - 20;
      ctx.save();
      ctx.translate(fx, fy);
      ctx.rotate(seed + this.cazAge * (1 + (i % 3) * 0.5));
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fillRect(-3, -2, 6, 4);
      ctx.restore();
    }
    // Texto principal.
    const label = C.text;
    const cx = W / 2, cy = Hh / 2;
    ctx.save();
    ctx.translate(cx, cy);
    const sc = 1 + 0.08 * Math.sin(this.cazAge * 6);
    ctx.scale(sc, sc);
    ctx.font = '900 36px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const g = ctx.createLinearGradient(-tw / 2, 0, tw / 2, 0);
    g.addColorStop(0, '#6ab0ff');
    g.addColorStop(0.5, '#ffffff');
    g.addColorStop(1, '#0b3d91');
    ctx.lineJoin = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#062a66';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = g;
    ctx.fillText(label, 0, 0);
    ctx.restore();
    // Banderas azules en las esquinas.
    for (const [bx, by, flip] of [[30, 30, 1], [W - 30, 30, -1], [30, Hh - 30, 1], [W - 30, Hh - 30, -1]]) {
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(flip, 1);
      ctx.fillStyle = '#d8dde6';
      ctx.fillRect(-1, -14, 2, 28);
      ctx.fillStyle = '#0b3d91';
      ctx.fillRect(1, -14, 16, 14);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(1, 0, 16, 14);
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * ÁGUILAS DEL AMÉRICA: sprites chasis + torreta con rotación independiente.
   * Los sprites apuntan hacia abajo en la imagen (cañones abajo), por eso se
   * rota con ángulo - PI/2 para alinearlos con el ángulo del juego.
   * Efecto fénix: brillo de fuego en las bocas al disparar.
   */
  _drawAmericaTank(ctx, t, x, y, chassis, turret, dt) {
    const chasisImg = this._ameChasisImg;
    const torretaImg = this._ameTorretaImg;
    const chasisReady = chasisImg && chasisImg.complete && chasisImg.naturalWidth > 0;
    const torretaReady = torretaImg && torretaImg.complete && torretaImg.naturalWidth > 0;

    // Sombra
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x + 3, y + 5, 28, 22, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (!chasisReady || !torretaReady) {
      this._drawTank(ctx, x, y, chassis, turret, this._colorsFor(t), 0, null);
      return;
    }

    const CHASIS_SIZE = 56;
    const TORRETA_SIZE = 40;

    // Chasis (gira con el movimiento)
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(chassis - Math.PI / 2);
    ctx.drawImage(chasisImg, -CHASIS_SIZE / 2, -CHASIS_SIZE / 2, CHASIS_SIZE, CHASIS_SIZE);
    ctx.restore();

    // Torreta (gira con la mira)
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turret - Math.PI / 2);
    ctx.drawImage(torretaImg, -TORRETA_SIZE / 2, -TORRETA_SIZE / 2, TORRETA_SIZE, TORRETA_SIZE);
    ctx.restore();

    // Brillo fénix en las bocas de los cañones.
    const lastShot = this._ameFlash.get(t.id);
    const flashAge = lastShot != null ? this.time - lastShot : 99;
    const flashK = flashAge < 0.18 ? 1 - flashAge / 0.18 : 0;
    const idlePulse = 0.35 + 0.15 * Math.sin(this.time * 5);
    const glowK = Math.max(idlePulse * 0.5, flashK);
    const muzzleDist = 19;
    const dx = Math.cos(turret), dy = Math.sin(turret);
    const px = -dy, py = dx;
    for (const side of [-1, 1]) {
      const mx = x + dx * muzzleDist + px * side * 4;
      const my = y + dy * muzzleDist + py * side * 4;
      const r = 7 + flashK * 6;
      const g = ctx.createRadialGradient(mx, my, 0, mx, my, r);
      g.addColorStop(0, `rgba(255,255,220,${0.85 * glowK + 0.1})`);
      g.addColorStop(0.4, `rgba(255,160,40,${0.6 * glowK})`);
      g.addColorStop(1, 'rgba(255,90,26,0)');
      ctx.save();
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Invulnerabilidad post-renacimiento: anillo dorado pulsante.
    if (t.ameInvulnT > 0) {
      const k = 0.6 + 0.4 * Math.sin(this.time * 10);
      ctx.save();
      ctx.strokeStyle = `rgba(255,215,94,${0.55 * k})`;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // Turbo Águila / impulso: estela de fuego detrás del chasis.
    if (dt && (t.ameBoosting || (t.ameBoostT > 0))) {
      const bx = x - Math.cos(chassis) * 22, by = y - Math.sin(chassis) * 22;
      if (Math.random() < dt * 30) {
        this._particle(bx + MathUtil.randRange(-6, 6), by + MathUtil.randRange(-6, 6),
          -Math.cos(chassis) * 40 + MathUtil.randRange(-15, 15),
          -Math.sin(chassis) * 40 + MathUtil.randRange(-15, 15),
          0.4, 2.4, Math.random() < 0.5 ? '#ff8c1a' : '#ff5a1a', 0, 2, 3);
      }
    }

    // Aturdido: estrellitas sobre el tanque.
    if (t.stunTimer > 0 && dt) {
      if (Math.random() < dt * 6) {
        this._particle(x + MathUtil.randRange(-10, 10), y - 20, MathUtil.randRange(-8, 8), -18,
          0.6, 2.2, '#ffe14f', 1, 1, 2);
      }
    }
  }

  /** Celebración ARRIBA LAS ÁGUILAS DEL AMÉRICA (amarillo/azul, sin foto). */
  _drawAmericaOverlay(ctx, dt) {
    if (this.ameAge < 0) return;
    this.ameAge += dt;
    const C = CONFIG.AMERICA.victoryCelebration;
    const k = this.ameAge / C.duration;
    if (k >= 1) { this.ameAge = -1; return; }
    const W = this.canvas.width, Hh = this.canvas.height;
    ctx.save();
    ctx.fillStyle = `rgba(8,10,40,${0.55 * Math.min(1, k * 4)})`;
    ctx.fillRect(0, 0, W, Hh);
    // Confeti amarillo, azul y rojo.
    const COLORS = ['#f9e700', '#0b3d91', '#e01e2b', '#ffe95c', '#ff8c1a'];
    for (let i = 0; i < 60; i++) {
      const seed = i * 2.39;
      const fx = ((seed * 97) % W + this.ameAge * 30 * (i % 3 - 1)) % W;
      const fy = ((seed * 53) % (Hh + 40) + this.ameAge * 90 * (0.5 + (i % 5) / 10)) % (Hh + 40) - 20;
      ctx.save();
      ctx.translate(fx, fy);
      ctx.rotate(seed + this.ameAge * (1 + (i % 3) * 0.5));
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fillRect(-3, -2, 6, 4);
      ctx.restore();
    }
    // Texto principal.
    const label = C.text;
    const cx = W / 2, cy = Hh / 2;
    ctx.save();
    ctx.translate(cx, cy);
    const sc = 1 + 0.08 * Math.sin(this.ameAge * 6);
    ctx.scale(sc, sc);
    ctx.font = '900 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const g = ctx.createLinearGradient(-tw / 2, 0, tw / 2, 0);
    g.addColorStop(0, '#f9e700');
    g.addColorStop(0.5, '#ffffff');
    g.addColorStop(1, '#0b3d91');
    ctx.lineJoin = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#062a66';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = g;
    ctx.fillText(label, 0, 0);
    ctx.restore();
    // Banderas amarillo/azul en las esquinas.
    for (const [bx, by, flip] of [[30, 30, 1], [W - 30, 30, -1], [30, Hh - 30, 1], [W - 30, Hh - 30, -1]]) {
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(flip, 1);
      ctx.fillStyle = '#d8dde6';
      ctx.fillRect(-1, -14, 2, 28);
      ctx.fillStyle = '#f9e700';
      ctx.fillRect(1, -14, 16, 14);
      ctx.fillStyle = '#0b3d91';
      ctx.fillRect(1, 0, 16, 14);
      ctx.restore();
    }
    ctx.restore();
  }

  _drawWreck(ctx, t) {
    const s = 11;
    const cols = this._colorsFor(t);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, TAU);
    ctx.fillStyle = 'rgba(40,25,10,0.18)';
    ctx.fill();
    ctx.lineCap = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = cols.dark;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(-s, -s); ctx.lineTo(s, s);
    ctx.moveTo(s, -s); ctx.lineTo(-s, s);
    ctx.stroke();
    ctx.restore();
  }

  _drawBullet(ctx, b, alpha, state, skinImage) {
    const x = MathUtil.lerp(b.prevX, b.x, alpha);
    const y = MathUtil.lerp(b.prevY, b.y, alpha);
    const a = Math.atan2(b.vy, b.vx);
    const owner = state.tanks.get(b.ownerId);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    // Estela
    const grad = ctx.createLinearGradient(-18, 0, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0.7)');
    ctx.fillStyle = grad;
    ctx.fillRect(-18, -2, 18, 4);
    // Proyectil criogénico: cristal de hielo con núcleo luminoso.
    if (b.kind === 'cryo') {
      this._drawCryoBullet(ctx);
      ctx.restore();
      return;
    }
    // PRIDE OVERLORD: energía cromática (prism) y Rayo del Orgullo (pcharge).
    if (b.kind === 'prism' && typeof PrideArt !== 'undefined') {
      PrideArt.drawPrism(ctx, 0, 0, 0, this.time, b.id);
      ctx.restore();
      return;
    }
    if (b.kind === 'pcharge' && typeof PrideArt !== 'undefined') {
      PrideArt.drawPlasma(ctx, 0, 0, 0, this.time, b.radius, b.prFrac || 0);
      ctx.restore();
      return;
    }
    // Skin personalizada: imagen subida por el usuario (propia o remota)
    const skin = skinImage;
    if (skin) {
      const maxW = 20, maxH = 12;
      const s = Math.min(maxW / skin.naturalWidth, maxH / skin.naturalHeight);
      const dw = skin.naturalWidth * s, dh = skin.naturalHeight * s;
      ctx.drawImage(skin, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      return;
    }
    // Forma de misil dibujada: cada bala vuela con una cosa distinta
    if (b.shape) {
      this._drawMissileShape(ctx, b.shape);
      ctx.restore();
      return;
    }
    // Cuerpo
    ctx.beginPath();
    ctx.ellipse(0, 0, 6, 3.6, 0, 0, TAU);
    ctx.fillStyle = '#3b3b3b';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = owner ? this._colorsFor(owner).body : '#000';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(-1, -2, 4, 1.3);
    // Las balas con 2 rebotes restantes muestran un punto extra
    if (b.bouncesLeft >= 2) {
      ctx.fillStyle = '#ffcf3f';
      ctx.beginPath();
      ctx.arc(-3, 0, 1.4, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // ==========================================================================
  //  FORMAS DE MISIL DIBUJADAS (cada bala sale con una forma aleatoria)
  //  Coordenadas locales: origen en el centro de la bala, +X = dirección de vuelo.
  // ==========================================================================

  _drawMissileShape(ctx, shapeId) {
    switch (shapeId) {
      case 'dildo': this._shapeDildo(ctx); break;
      case 'negrito': this._shapeNegrito(ctx); break;
      case 'banana': this._shapeBanana(ctx); break;
      case 'berenjena': this._shapeBerenjena(ctx); break;
      case 'hotdog': this._shapeHotdog(ctx); break;
      case 'taco': this._shapeTaco(ctx); break;
      case 'dona': this._shapeDona(ctx); break;
      case 'durazno': this._shapeDurazno(ctx); break;
      case 'croissant': this._shapeCroissant(ctx); break;
      case 'zanahoria': this._shapeZanahoria(ctx); break;
      case 'mierda': this._shapeMierda(ctx); break;
      default: break;
    }
  }

  _shapeDildo(ctx) {
    // Fuste
    ctx.beginPath();
    ctx.moveTo(3, -3.4);
    ctx.quadraticCurveTo(-3, -2.4, -7, -2);
    ctx.lineTo(-7, 2);
    ctx.quadraticCurveTo(-3, 2.4, 3, 3.4);
    ctx.closePath();
    ctx.fillStyle = '#e89b8c';
    ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#c47a6d'; ctx.stroke();
    // Cabeza redondeada
    ctx.beginPath();
    ctx.ellipse(7, 0, 4.6, 4, 0, 0, TAU);
    ctx.fillStyle = '#efa694';
    ctx.fill(); ctx.stroke();
    // Base
    this._roundRect(ctx, -11, -4.6, 5, 9.2, 2);
    ctx.fillStyle = '#d98a7c';
    ctx.fill(); ctx.stroke();
    // Brillo
    ctx.beginPath();
    ctx.ellipse(6.5, -1.8, 2, 1, -0.3, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
  }

  _shapeNegrito(ctx) {
    // Cuerpo de chocolate
    this._roundRect(ctx, -10, -4.5, 20, 9, 4);
    ctx.fillStyle = '#5a3a22'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#3d2716'; ctx.stroke();
    // Relleno de crema (línea clara al centro)
    ctx.beginPath();
    ctx.moveTo(-8, 0); ctx.lineTo(8, 0);
    ctx.strokeStyle = '#f5e6d3'; ctx.lineWidth = 2; ctx.stroke();
    // Remolino de crema arriba
    ctx.beginPath(); ctx.ellipse(0, -6, 6.5, 2.6, 0, 0, TAU);
    ctx.fillStyle = '#fff8ee'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#d9c7ae'; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -8.4, 2, 0, TAU);
    ctx.fillStyle = '#fff8ee'; ctx.fill(); ctx.stroke();
  }

  _shapeBanana(ctx) {
    ctx.beginPath();
    ctx.moveTo(-10, 3.5);
    ctx.quadraticCurveTo(-2, -8.5, 10, -4);
    ctx.quadraticCurveTo(2, -1.5, -6, 5.5);
    ctx.closePath();
    ctx.fillStyle = '#ffe135'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#c9a227'; ctx.stroke();
    // Punta
    ctx.beginPath(); ctx.arc(10, -4, 1.4, 0, TAU);
    ctx.fillStyle = '#8a6d1f'; ctx.fill();
  }

  _shapeBerenjena(ctx) {
    // Cuerpo
    ctx.beginPath();
    ctx.ellipse(0, 0.5, 9, 5, -0.06, 0, TAU);
    ctx.fillStyle = '#6a2a8a'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#4a1c63'; ctx.stroke();
    // Brillo
    ctx.beginPath();
    ctx.ellipse(-2, -1.6, 4, 1.6, -0.1, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
    // Tallo
    ctx.beginPath();
    ctx.ellipse(8.5, -3.4, 2.6, 1.6, 0.5, 0, TAU);
    ctx.fillStyle = '#3fa34d'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#2c7036'; ctx.stroke();
  }

  _shapeHotdog(ctx) {
    // Pan
    this._roundRect(ctx, -10, -4.5, 20, 9, 4.5);
    ctx.fillStyle = '#e0a55c'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#b87f3e'; ctx.stroke();
    // Salchicha (sale por el frente)
    ctx.beginPath();
    ctx.ellipse(8, 0, 4.6, 3.2, 0, 0, TAU);
    ctx.fillStyle = '#b0552f'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#8a3f20'; ctx.stroke();
    // Mostaza
    ctx.beginPath();
    ctx.moveTo(-7, -1.5);
    ctx.lineTo(-4, -2.6); ctx.lineTo(-1, -1.5); ctx.lineTo(2, -2.6); ctx.lineTo(5, -1.5);
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  _shapeTaco(ctx) {
    // Tortilla (media luna)
    ctx.beginPath();
    ctx.arc(0, 2, 8.5, Math.PI, 0);
    ctx.closePath();
    ctx.fillStyle = '#f2c14e'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#d9a03a'; ctx.stroke();
    // Relleno
    const fillings = [[-4.5, -5.4, '#7ac74f'], [0, -6.6, '#e74c3c'], [4.5, -5.4, '#ffd23f']];
    for (const [fx, fy, c] of fillings) {
      ctx.beginPath(); ctx.arc(fx, fy, 2.6, 0, TAU);
      ctx.fillStyle = c; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
    }
  }

  _shapeDona(ctx) {
    // Masa
    ctx.beginPath(); ctx.arc(0, 0, 8.5, 0, TAU);
    ctx.fillStyle = '#e8b06a'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#c98d4a'; ctx.stroke();
    // Glaseado (anillo con hueco)
    ctx.beginPath();
    ctx.arc(0, 0, 6.8, 0, TAU);
    ctx.arc(0, 0, 2.6, 0, TAU, true);
    ctx.fillStyle = '#f78fb3';
    ctx.fill('evenodd');
    // Chispas
    const sparks = [[-3.4, -2.6, '#5ec8e6'], [2.8, -3.4, '#ffe135'], [3.6, 2.2, '#7ac74f'], [-2.6, 3.6, '#b388ff']];
    ctx.lineWidth = 1.4;
    for (const [sx, sy, c] of sparks) {
      ctx.beginPath();
      ctx.moveTo(sx - 1, sy); ctx.lineTo(sx + 1, sy);
      ctx.strokeStyle = c; ctx.stroke();
    }
  }

  _shapeDurazno(ctx) {
    // Cuerpo
    ctx.beginPath(); ctx.arc(0, 0.5, 7.5, 0, TAU);
    ctx.fillStyle = '#f7a072'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#e07a5f'; ctx.stroke();
    // Luz
    ctx.beginPath(); ctx.arc(-2, -1.5, 4.4, 0, TAU);
    ctx.fillStyle = 'rgba(255,211,176,0.8)'; ctx.fill();
    // Hendidura
    ctx.beginPath();
    ctx.arc(0, 0.5, 5.5, Math.PI * 0.35, Math.PI * 0.85);
    ctx.strokeStyle = '#e07a5f'; ctx.lineWidth = 1.6; ctx.stroke();
    // Hoja
    ctx.beginPath(); ctx.ellipse(0.5, -7.4, 3.4, 1.7, -0.4, 0, TAU);
    ctx.fillStyle = '#3fa34d'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#2c7036'; ctx.stroke();
  }

  _shapeCroissant(ctx) {
    // Tres protuberancias doradas (croissant visto de frente)
    const parts = [[-5.5, 3.4], [0, 4.6], [5.5, 3.4]];
    for (const [px, pr] of parts) {
      ctx.beginPath(); ctx.arc(px, 0, pr, 0, TAU);
      ctx.fillStyle = '#d99a4e'; ctx.fill();
      ctx.lineWidth = 1.3; ctx.strokeStyle = '#b8732f'; ctx.stroke();
    }
  }

  _shapeZanahoria(ctx) {
    // Hojas
    ctx.lineWidth = 2.2; ctx.strokeStyle = '#3fa34d'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-4, 0); ctx.lineTo(-10, -4.5);
    ctx.moveTo(-4, 0); ctx.lineTo(-11, 0);
    ctx.moveTo(-4, 0); ctx.lineTo(-10, 4.5);
    ctx.stroke();
    // Cuerpo
    ctx.beginPath();
    ctx.moveTo(-4, -4.2);
    ctx.lineTo(-4, 4.2);
    ctx.lineTo(10.5, 0);
    ctx.closePath();
    ctx.fillStyle = '#ff8c42'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#e06a1f'; ctx.stroke();
    // Líneas
    ctx.beginPath();
    ctx.moveTo(-1, -2.6); ctx.lineTo(1.5, -1.4);
    ctx.moveTo(0.5, 2.2); ctx.lineTo(3, 1);
    ctx.lineWidth = 1.3; ctx.strokeStyle = '#e06a1f'; ctx.stroke();
  }

  _shapeMierda(ctx) {
    // Cuerpo largo con punta (mierda larga, dibujada)
    ctx.beginPath();
    ctx.moveTo(-11, 0);
    ctx.quadraticCurveTo(-11, -4.6, -5, -4.8);
    ctx.quadraticCurveTo(2, -5, 7, -2.8);
    ctx.quadraticCurveTo(10.5, -1.4, 11, 0.6);
    ctx.quadraticCurveTo(10.5, 2.6, 7, 3.6);
    ctx.quadraticCurveTo(1, 5, -5, 4.6);
    ctx.quadraticCurveTo(-11, 4.2, -11, 0);
    ctx.closePath();
    ctx.fillStyle = '#8b5a2b'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#6b4226'; ctx.stroke();
    // Segmentos
    ctx.beginPath();
    ctx.arc(-4, 0, 3.4, -1.2, 1.2);
    ctx.arc(2, 0, 2.8, -1.2, 1.2);
    ctx.strokeStyle = '#6b4226'; ctx.lineWidth = 1.3; ctx.stroke();
    // Brillo
    ctx.beginPath();
    ctx.ellipse(-3, -2.6, 3, 1, -0.1, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fill();
  }

  _spawnBulletSmoke(dt, alpha) {
    const chance = dt * 25;
    for (const b of this.state.bullets.values()) {
      if (Math.random() > chance) continue;
      const x = MathUtil.lerp(b.prevX, b.x, alpha);
      const y = MathUtil.lerp(b.prevY, b.y, alpha);
      this._particle(x, y, MathUtil.randRange(-6, 6), MathUtil.randRange(-6, 6), 0.5, 2.2, 'rgba(235,235,235,1)', 0, 1, 5);
    }
  }

  _drawParticles(ctx, layer) {
    for (const p of this.particles) {
      if (p.layer !== layer) continue;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawRings(ctx) {
    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = r.width ? r.width * (1 - k) + 1 : 4 * (1 - k) + 1;
      ctx.strokeStyle = r.color ? `rgba(${r.color},${1 - k})` : '#fff6d0';
      ctx.beginPath();
      ctx.arc(r.x, r.y, 6 + k * r.maxR, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Actualiza los textos flotantes (suben y se desvanecen). */
  _updateFloatTexts(dt) {
    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const f = this.floatTexts[i];
      f.age -= dt;
      f.y -= dt * 22;
      if (f.age <= 0) this.floatTexts.splice(i, 1);
    }
  }

  /** Dibuja los textos flotantes (corazones, notas, avisos). */
  _drawFloatTexts(ctx) {
    if (!this.floatTexts.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 12px system-ui, sans-serif';
    for (const f of this.floatTexts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, f.age));
      ctx.fillStyle = f.color || '#ffffff';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();
  }

  /** Actualiza los destellos radiales. */
  _updateLights(dt) {
    for (let i = this.lights.length - 1; i >= 0; i--) {
      this.lights[i].life -= dt;
      if (this.lights[i].life <= 0) this.lights.splice(i, 1);
    }
  }

  /** Dibuja los destellos radiales (brillo de disparos y explosiones). */
  _drawLights(ctx) {
    if (!this.lights.length) return;
    ctx.save();
    for (const l of this.lights) {
      const k = l.life / l.max;
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      g.addColorStop(0, `rgba(${l.rgb},${l.alpha * k})`);
      g.addColorStop(1, `rgba(${l.rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l.x, l.y, l.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Réplica recibida por la red simulada (modo fantasma, tecla G). */
  _drawMirror(ctx, mirror, alpha) {
    const T = CONFIG.TANK;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 2;
    for (const t of mirror.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha);
      ctx.strokeStyle = t.color.dark;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t.chassisAngle);
      ctx.strokeRect(-T.BODY_LENGTH / 2, -T.BODY_WIDTH / 2, T.BODY_LENGTH, T.BODY_WIDTH);
      ctx.rotate(t.turretAngle - t.chassisAngle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(T.BARREL_LENGTH + 4, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    for (const b of mirror.bullets.values()) {
      ctx.beginPath();
      ctx.arc(MathUtil.lerp(b.prevX, b.x, alpha), MathUtil.lerp(b.prevY, b.y, alpha), 6, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawLabels(ctx, alpha, localTankId) {
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    for (const t of this.state.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha) - 24;
      const isLocal = t.id === localTankId;
      const label = isLocal ? 'TÚ' : t.name;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(40,25,10,0.65)';
      ctx.strokeText(label, x, y);
      ctx.fillStyle = isLocal ? '#ffffff' : t.color.light;
      ctx.fillText(label, x, y);
      if (isLocal) {
        const bob = Math.sin(this.time * 6) * 2;
        ctx.fillStyle = t.color.body;
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 16 + bob);
        ctx.lineTo(x + 5, y - 16 + bob);
        ctx.lineTo(x, y - 10 + bob);
        ctx.closePath();
        ctx.fill();
      }
      // Indicadores criogénicos: pilas de congelación (puntos) y barra de congelado.
      const stacks = t.freezeStacks | 0;
      if (t.freezeTimer > 0) {
        const bw = 34, bh = 4;
        const bx = x - bw / 2, by = y - 13;
        ctx.fillStyle = 'rgba(40,25,10,0.55)';
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        const k = Math.max(0, Math.min(1, t.freezeTimer / CONFIG.CRYO.FREEZE_DURATION));
        ctx.fillStyle = '#8fd8ff';
        ctx.fillRect(bx, by, bw * k, bh);
      } else if (stacks > 0) {
        ctx.fillStyle = '#8fd8ff';
        for (let i = 0; i < stacks; i++) {
          const dx = (i - (stacks - 1) / 2) * 8;
          ctx.beginPath();
          ctx.arc(x + dx, y - 11, 2.6, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      // Barra de recarga de CERO ABSOLUTO bajo el FROST REAPER local.
      const model = this._modelFor(t);
      if (isLocal && model && model.custom === 'cryo') {
        const bw = 44, bh = 5;
        const bx = x - bw / 2, by = y + 30;
        const k = 1 - Math.max(0, Math.min(1, t.specialCooldown / CONFIG.CRYO.SPECIAL_COOLDOWN));
        ctx.fillStyle = 'rgba(40,25,10,0.55)';
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = k >= 1 ? '#37e0ff' : '#5d93bb';
        ctx.fillRect(bx, by, bw * k, bh);
        if (k >= 1) {
          ctx.fillStyle = '#dff6ff';
          ctx.font = '700 9px system-ui, sans-serif';
          ctx.fillText('CERO ABSOLUTO LISTO', x, by + 13);
        }
      }
      // Barra de recarga de Descarga Celeste bajo CRUZ AZUL local.
      if (isLocal && model && model.custom === 'cruzazul') {
        const bw = 44, bh = 5;
        const bx = x - bw / 2, by = y + 30;
        const k = 1 - Math.max(0, Math.min(1, (t.cazPulseCd || 0) / CONFIG.CRUZAZUL.special.cooldown));
        ctx.fillStyle = 'rgba(40,25,10,0.55)';
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = k >= 1 ? '#38b6ff' : '#5d93bb';
        ctx.fillRect(bx, by, bw * k, bh);
        if (k >= 1) {
          ctx.fillStyle = '#dff6ff';
          ctx.font = '700 9px system-ui, sans-serif';
          ctx.fillText('DESCARGA LISTA', x, by + 13);
        }
      }
      // Barra de recarga de Explosión Fénix bajo AMÉRICA local.
      if (isLocal && model && model.custom === 'america') {
        const bw = 44, bh = 5;
        const bx = x - bw / 2, by = y + 30;
        const k = 1 - Math.max(0, Math.min(1, (t.amePulseCd || 0) / CONFIG.AMERICA.special.cooldown));
        ctx.fillStyle = 'rgba(40,25,10,0.55)';
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = k >= 1 ? '#ff8c1a' : '#c98a4a';
        ctx.fillRect(bx, by, bw * k, bh);
        if (k >= 1) {
          ctx.fillStyle = '#ffe9c4';
          ctx.font = '700 9px system-ui, sans-serif';
          ctx.fillText('FÉNIX LISTO', x, by + 13);
        }
      }
    }
    ctx.restore();
  }

  /** Línea de puntería punteada + mira en el cursor (estilo Wii Tanks). */
  _drawAim(ctx, alpha, view) {
    if (!view.mouse || !view.mouse.inside) return;
    const local = this.state.tanks.get(view.localTankId);
    const color = local ? local.color : CONFIG.COLORS[0];
    const mx = view.mouse.x, my = view.mouse.y;

    if (local && local.isAlive && !view.paused) {
      const x = MathUtil.lerp(local.prevX, local.x, alpha);
      const y = MathUtil.lerp(local.prevY, local.y, alpha);
      const a = Math.atan2(my - y, mx - x);
      const d = CONFIG.TANK.BARREL_LENGTH + 6;
      ctx.save();
      ctx.setLineDash([3, 8]);
      ctx.lineDashOffset = -this.time * 20;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(70,45,20,0.35)';
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
      ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color.dark;
    ctx.beginPath();
    ctx.arc(mx, my, 9, 0, TAU);
    ctx.moveTo(mx - 14, my); ctx.lineTo(mx - 5, my);
    ctx.moveTo(mx + 5, my); ctx.lineTo(mx + 14, my);
    ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my - 5);
    ctx.moveTo(mx, my + 5); ctx.lineTo(mx, my + 14);
    ctx.stroke();
    ctx.fillStyle = color.body;
    ctx.beginPath();
    ctx.arc(mx, my, 2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawBanner(ctx, title, subtitle, alpha = 1) {
    const w = this.canvas.width, h = this.canvas.height;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(30,20,10,0.55)';
    ctx.fillRect(0, h / 2 - 50, w, subtitle ? 100 : 80);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = '800 42px system-ui, sans-serif';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(30,20,10,0.8)';
    ctx.strokeText(title, w / 2, h / 2 - (subtitle ? 12 : -10));
    ctx.fillStyle = '#fff8e6';
    ctx.fillText(title, w / 2, h / 2 - (subtitle ? 12 : -10));
    if (subtitle) {
      ctx.font = '500 17px system-ui, sans-serif';
      ctx.fillStyle = '#f3dfb5';
      ctx.fillText(subtitle, w / 2, h / 2 + 28);
    }
    ctx.restore();
  }

  _drawBanners(ctx, view) {
    const state = this.state;
    if (view.waitingForHost) {
      this._drawBanner(ctx, 'Esperando al host…', 'Conectado al servidor. Esperando la primera instantánea del host…');
      return;
    }
    if (view.paused) {
      this._drawBanner(ctx, 'PAUSA', 'Pulsa P o Esc para continuar');
      return;
    }
    if (state.round.phase === 'ending') {
      const w = state.tanks.get(state.round.winnerId);
      const title = w ? `¡${w.id === view.localTankId ? 'Ganaste' : w.name + ' gana'}!` : 'Ronda terminada';
      this._drawBanner(ctx, title, `Siguiente ronda en ${Math.ceil(state.round.timer)}…`);
    } else if (this._roundBanner > 0) {
      this._drawBanner(ctx, `Ronda ${state.round.number}`, null, Math.min(1, this._roundBanner / 0.4));
    }
  }
}
