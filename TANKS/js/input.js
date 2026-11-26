'use strict';
/**
 * ============================================================================
 *  input.js — Captura de teclado y ratón (sólo lado local, depende del DOM).
 * ============================================================================
 *  InputManager únicamente registra el estado crudo de los dispositivos.
 *  La traducción a un InputPayload (formato de red) la hace
 *  KeyboardMouseController en controllers.js.
 * ============================================================================
 */
class InputManager {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this._pressed = new Set();       // teclas pulsadas desde la última consulta (flanco)
    this.mouse = { x: canvas.width / 2, y: canvas.height / 2, inside: false };
    this._fireQueued = false;
    this._specialQueued = false;
    this.mouseHeld = false;
    // PRIDE OVERLORD: clic derecho mantenido (carga) y contadores de pulsaciones.
    // Los contadores son monótonos: el anfitrión detecta la pulsación comparando
    // con el último valor visto (sobrevive a paquetes perdidos o duplicados).
    this.rmbHeld = false;
    this.actions = { pd: 0, pu: 0, aq: 0, aj: 0, af: 0 };

    window.addEventListener('keydown', (e) => {
      // No capturar teclas mientras se escribe en un formulario (menú).
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (this._isGameKey(e.code)) e.preventDefault();
      if (!e.repeat) this._pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' && !e.repeat) this._fireQueued = true;
      // F también activa la habilidad especial (alternativa al clic derecho).
      if (e.code === 'KeyF' && !e.repeat) { this._specialQueued = true; this.actions.af++; }
      // PRIDE OVERLORD: Q = Onda del Orgullo, E = Escudo Arcoíris.
      if (e.code === 'KeyQ' && !e.repeat) this.actions.aq++;
      if (e.code === 'KeyE' && !e.repeat) this.actions.aj++;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear(); this.mouseHeld = false;
      if (this.rmbHeld) { this.rmbHeld = false; this.actions.pu++; }
    });

    window.addEventListener('mousemove', (e) => this._updateMouse(e));
    canvas.addEventListener('mousedown', (e) => {
      this._updateMouse(e);
      if (e.button === 0) {
        this._fireQueued = true;
        this.mouseHeld = true;
      }
      // Botón derecho: habilidad especial (CERO ABSOLUTO) y carga del Rayo (PRIDE).
      if (e.button === 2) {
        this._specialQueued = true;
        this.rmbHeld = true;
        this.actions.pd++;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseHeld = false;
      if (e.button === 2 && this.rmbHeld) { this.rmbHeld = false; this.actions.pu++; }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mouseenter', () => { this.mouse.inside = true; });
    canvas.addEventListener('mouseleave', () => { this.mouse.inside = false; });
  }

  _isGameKey(code) {
    return code === 'Space' || code.startsWith('Arrow');
  }

  /** Convierte coordenadas de pantalla a coordenadas del mundo (canvas escalado por CSS). */
  _updateMouse(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.mouse.x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    this.mouse.y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
  }

  isDown(code) {
    return this.keys.has(code);
  }

  /** true una sola vez por pulsación (para toggles como pausa o debug). */
  consumePressed(code) {
    if (!this._pressed.has(code)) return false;
    this._pressed.delete(code);
    return true;
  }

  /** Devuelve true si hubo un clic de disparo pendiente y lo consume. */
  consumeFire() {
    const f = this._fireQueued;
    this._fireQueued = false;
    return f;
  }

  /** Devuelve true si hubo una activación de habilidad especial pendiente y la consume. */
  consumeSpecial() {
    const s = this._specialQueued;
    this._specialQueued = false;
    return s;
  }

  /** Descarta pulsaciones de flanco no consumidas (se llama al final del frame). */
  endFrame() {
    this._pressed.clear();
  }
}
