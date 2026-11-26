'use strict';
/**
 * touch.js — Controles táctiles para celular: dos joysticks virtuales y botones de habilidades.
 * Se activa solo en dispositivos táctiles o pantallas pequeñas.
 */
class TouchControls {
  constructor() {
    this.moveX = 0; // -1..1 (turn)
    this.moveY = 0; // -1..1 (throttle, -1 = adelante)
    this.aimX = 0;
    this.aimY = 0;
    this.fireHeld = false;
    this.specialQueued = false;
    this.actions = { pd: 0, pu: 0, aq: 0, aj: 0, af: 0, vn: 0, va: 0, vt: 0 };
    this.ph = 0; // pride hold charge
    this.ab = 0; // pride boost held
    this.cazBoost = 0;
    this.ameBoost = 0;
    this.voidBoost = 0;
    this.enabled = false;
    this._moveTouchId = null;
    this._aimTouchId = null;
    this._moveBase = null;
    this._moveKnob = null;
    this._aimBase = null;
    this._aimKnob = null;
    this._buttonsEl = null;
    this._currentModelId = null;
    this._initUI();
  }

  _initUI() {
    // Detectar si es dispositivo táctil
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isSmall = window.innerWidth < 900;
    this.enabled = isTouch || isSmall;
    if (!this.enabled) return;

    const container = document.createElement('div');
    container.id = 'touch-controls';
    container.innerHTML = `
      <div id="touch-move" class="touch-joystick touch-move">
        <div class="touch-base"></div>
        <div class="touch-knob"></div>
      </div>
      <div id="touch-aim" class="touch-joystick touch-aim">
        <div class="touch-base"></div>
        <div class="touch-knob"></div>
      </div>
      <div id="touch-buttons" class="touch-buttons"></div>
      <button id="touch-fire-btn" class="touch-fire-btn">FUEGO</button>
    `;
    document.body.appendChild(container);

    this._moveBase = container.querySelector('#touch-move .touch-base');
    this._moveKnob = container.querySelector('#touch-move .touch-knob');
    this._aimBase = container.querySelector('#touch-aim .touch-base');
    this._aimKnob = container.querySelector('#touch-aim .touch-knob');
    this._buttonsEl = container.querySelector('#touch-buttons');

    this._setupJoystick('touch-move', 'move');
    this._setupJoystick('touch-aim', 'aim');

    // Botón de fuego explícito
    const fireBtn = container.querySelector('#touch-fire-btn');
    fireBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.fireHeld = true; }, { passive: false });
    fireBtn.addEventListener('touchend', (e) => { e.preventDefault(); this.fireHeld = false; }, { passive: false });
    fireBtn.addEventListener('touchcancel', () => { this.fireHeld = false; });

    // Mostrar/ocultar según tamaño de pantalla
    window.addEventListener('resize', () => {
      const show = ('ontouchstart' in window || navigator.maxTouchPoints > 0) || window.innerWidth < 900;
      container.style.display = show ? 'flex' : 'none';
      this.enabled = show;
    });
  }

  _setupJoystick(id, type) {
    const el = document.getElementById(id);
    if (!el) return;
    const knob = el.querySelector('.touch-knob');
    const radius = 45; // radio máximo de desplazamiento del knob en px

    const onStart = (e) => {
      e.preventDefault();
      const touch = e.changedTouches[0];
      if (type === 'move') {
        if (this._moveTouchId !== null) return;
        this._moveTouchId = touch.identifier;
      } else {
        if (this._aimTouchId !== null) return;
        this._aimTouchId = touch.identifier;
      }
      this._updateJoystick(e, el, knob, type, radius);
    };

    const onMove = (e) => {
      e.preventDefault();
      for (const touch of e.changedTouches) {
        if (type === 'move' && touch.identifier === this._moveTouchId) {
          this._updateJoystick(e, el, knob, type, radius, touch);
        } else if (type === 'aim' && touch.identifier === this._aimTouchId) {
          this._updateJoystick(e, el, knob, type, radius, touch);
        }
      }
    };

    const onEnd = (e) => {
      for (const touch of e.changedTouches) {
        if (type === 'move' && touch.identifier === this._moveTouchId) {
          this._moveTouchId = null;
          this.moveX = 0; this.moveY = 0;
          knob.style.transform = 'translate(-50%, -50%)';
        } else if (type === 'aim' && touch.identifier === this._aimTouchId) {
          this._aimTouchId = null;
          this.aimX = 0; this.aimY = 0;
          knob.style.transform = 'translate(-50%, -50%)';
          if (!this._fireBtnHeld) this.fireHeld = false;
        }
      }
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
  }

  _updateJoystick(e, el, knob, type, radius, touchObj) {
    const touch = touchObj || e.changedTouches[0];
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const nx = dx / radius;
    const ny = dy / radius;
    if (type === 'move') {
      this.moveX = nx;
      this.moveY = ny;
    } else {
      this.aimX = nx;
      this.aimY = ny;
      // Si el joystick de mira se empuja lo suficiente, dispara automáticamente
      const mag = Math.hypot(nx, ny);
      if (mag > 0.35) this.fireHeld = true;
      else if (!this._fireBtnHeld) this.fireHeld = false;
    }
  }

  /** Actualiza los botones de habilidades según el modelo del tanque local. */
  updateButtons(modelId) {
    if (!this.enabled || !this._buttonsEl) return;
    if (this._currentModelId === modelId) return;
    this._currentModelId = modelId;
    this._buttonsEl.innerHTML = '';

    const model = (window.TankModels && window.TankModels.get(modelId)) || null;
    if (!model) return;

    const addBtn = (label, onPress, onRelease) => {
      const btn = document.createElement('button');
      btn.className = 'touch-ability-btn';
      btn.textContent = label;
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); onPress && onPress(); }, { passive: false });
      if (onRelease) {
        btn.addEventListener('touchend', (e) => { e.preventDefault(); onRelease(); }, { passive: false });
        btn.addEventListener('touchcancel', () => onRelease());
      }
      this._buttonsEl.appendChild(btn);
    };

    // Botón especial genérico (CERO ABSOLUTO, Descarga, Explosión, Nuclear)
    if (model.custom === 'cryo' || model.custom === 'cruzazul' || model.custom === 'america' || model.custom === 'void01') {
      const label = model.custom === 'cryo' ? 'CERO' : model.custom === 'cruzazul' ? 'DESCARGA' : model.custom === 'america' ? 'FÉNIX' : 'NUCLEAR';
      addBtn(label, () => { this.specialQueued = true; this.actions.af++; if (model.custom === 'void01') this.actions.vn++; });
    }

    // PRIDE OVERLORD
    if (model.custom === 'pride') {
      addBtn('ONDA', () => { this.actions.aq++; });
      addBtn('ESCUDO', () => { this.actions.aj++; });
      addBtn('ZONA', () => { this.actions.af++; this.specialQueued = true; });
      addBtn('TURBO', () => { this.ab = 1; }, () => { this.ab = 0; });
      addBtn('CARGAR', () => { this.ph = 1; this.actions.pd++; }, () => { this.ph = 0; this.actions.pu++; });
    }

    // CRUZ AZUL Turbo
    if (model.custom === 'cruzazul') {
      addBtn('TURBO', () => { this.cazBoost = 1; }, () => { this.cazBoost = 0; });
    }

    // AMÉRICA Turbo
    if (model.custom === 'america') {
      addBtn('TURBO', () => { this.ameBoost = 1; }, () => { this.ameBoost = 0; });
    }

    // VOID-01 habilidades extra
    if (model.custom === 'void01') {
      addBtn('AIMBOT', () => { this.actions.va++; });
      addBtn('TELEPORT', () => { this.actions.vt++; });
      addBtn('TURBO', () => { this.voidBoost = 1; }, () => { this.voidBoost = 0; });
    }
  }

  /** Devuelve el InputPayload para el tanque local (formato compatible con GameState). */
  getInput(state, tankId) {
    const tank = state.tanks.get(tankId);
    // Movimiento: joystick izquierdo. Y invertido: arriba = adelante (throttle 1)
    const throttle = this.moveY < -0.25 ? 1 : (this.moveY > 0.25 ? -1 : 0);
    const turn = this.moveX < -0.25 ? -1 : (this.moveX > 0.25 ? 1 : 0);
    // Mira: joystick derecho. Si no se está usando, usa la última dirección o ángulo del tanque.
    let aimAngle = tank ? tank.turretAngle : 0;
    const aimMag = Math.hypot(this.aimX, this.aimY);
    if (aimMag > 0.2) {
      aimAngle = Math.atan2(this.aimY, this.aimX);
    }
    const base = {
      seq: (this._seq = (this._seq || 0) + 1),
      throttle,
      turn,
      aimAngle: MathUtil.round(aimAngle, 3),
      fire: this.fireHeld,
      special: this.specialQueued,
    };
    // Consumir el especial para que no se repita
    this.specialQueued = false;

    if (tank && tank.mods && tank.mods.pride) {
      base.special = false;
      base.ph = this.ph;
      base.pd = this.actions.pd;
      base.pu = this.actions.pu;
      base.aq = this.actions.aq;
      base.aj = this.actions.aj;
      base.af = this.actions.af;
      base.ab = this.ab;
      base.nx = tank ? MathUtil.round(tank.x + Math.cos(aimAngle) * 100) : 0;
      base.ny = tank ? MathUtil.round(tank.y + Math.sin(aimAngle) * 100) : 0;
    }
    if (tank && tank.mods && tank.mods.cruzazul) {
      base.cazBoost = this.cazBoost;
    }
    if (tank && tank.mods && tank.mods.america) {
      base.ameBoost = this.ameBoost;
    }
    if (tank && tank.mods && tank.mods.void01) {
      base.voidBoost = this.voidBoost;
      base.voidNuke = this.actions.vn;
      base.voidAimbotToggle = this.actions.va;
      base.voidTeleport = this.actions.vt;
      // Aimbot táctil: si está activo, apunta al enemigo más cercano
      if (tank.voidAimbot) {
        let best = null, bestD2 = Infinity;
        for (const t of state.tanks.values()) {
          if (!t.isAlive || t.id === tank.id) continue;
          const d2 = MathUtil.dist2(tank.x, tank.y, t.x, t.y);
          if (d2 < bestD2) { bestD2 = d2; best = t; }
        }
        if (best) {
          const desired = Math.atan2(best.y - tank.y, best.x - tank.x);
          base.aimAngle = MathUtil.round(desired, 3);
          if (state.map.hasLineOfSight(tank.x, tank.y, best.x, best.y)) base.fire = true;
        }
      }
    }
    return base;
  }
}

window.TouchControls = TouchControls;
