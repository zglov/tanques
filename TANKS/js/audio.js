'use strict';
/**
 * ============================================================================
 *  audio.js — Efectos de sonido sintetizados con WebAudio (sin archivos).
 * ============================================================================
 *  Los navegadores exigen un gesto del usuario para iniciar el audio: Game
 *  llama a unlock() al pulsar "Jugar".
 * ============================================================================
 */
class SoundFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._noise = null;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.25;
      this.master.connect(this.ctx.destination);
      // Buffer de ruido blanco reutilizable (explosiones).
      const len = this.ctx.sampleRate * 0.6;
      this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  _tone(type, f0, f1, duration, gain = 0.5) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + duration);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  _burst(duration, freq, gain = 0.8) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq, t);
    filter.frequency.exponentialRampToValueAtTime(80, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration);
  }

  // ------------------------------------------------------------------ PRIDE OVERLORD
  /** Tope de volumen de los sonidos de PRIDE (nunca excesivo). */
  _prG(g) { return Math.min(g, (typeof CONFIG !== 'undefined' && CONFIG.PRIDE) ? CONFIG.PRIDE.audio.maxGain : 0.22); }

  /** Onda sónica instrumental. */
  _synthWave(f0, f1, dur, gain, delay = 0) {
    const t = this.ctx.currentTime + delay;
    for (const [k, type] of [[1, 'sine'], [1.5, 'triangle'], [2, 'sine']]) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0 * k, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * k), t + dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }

  /** Sonido de carga ascendente: empieza al cargar y se corta al disparar o cancelar. */
  prCharge(id, on) {
    if (!this._prCh) this._prCh = new Map();
    const cur = this._prCh.get(id);
    if (cur) { try { cur.g.gain.cancelScheduledValues(0); cur.g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.03); cur.o.stop(this.ctx.currentTime + 0.12); } catch (e) { /* ya parado */ } this._prCh.delete(id); }
    if (!on || !this.ctx || this.muted || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime, d = CONFIG.PRIDE.chargedShot.maxChargeTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(1100, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(CONFIG.PRIDE.audio.chargeGain, t + d);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + d + 3);
    this._prCh.set(id, { o, g });
  }

  play(name) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    switch (name) {
      case 'shot': this._tone('square', 520, 140, 0.09, 0.25); break;
      case 'bounce': this._tone('triangle', 1100, 700, 0.05, 0.25); break;
      case 'block': this._burst(0.18, 2500, 0.5); break;
      case 'clash': this._tone('sine', 1500, 300, 0.08, 0.3); break;
      case 'explosion': this._burst(0.55, 1200, 1.0); this._tone('sine', 120, 40, 0.4, 0.6); break;
      case 'round': this._tone('square', 440, 880, 0.25, 0.2); break;
      // --- Criogénicos (CRYO-01 FROST REAPER) ---
      case 'cryoShot': this._tone('sine', 1400, 350, 0.12, 0.22); this._burst(0.09, 4200, 0.3); break;
      case 'cryoHit': this._tone('sine', 900, 220, 0.1, 0.25); this._burst(0.08, 3800, 0.25); break;
      case 'frozen': this._burst(0.3, 3000, 0.6); this._tone('sine', 600, 120, 0.3, 0.3); break;
      case 'shatter': this._burst(0.28, 5200, 0.8); this._tone('sine', 1800, 400, 0.15, 0.3); break;
      case 'absoluteZero': this._tone('sine', 90, 35, 1.4, 0.9); this._burst(1.1, 1800, 0.7); break;
      case 'thaw': this._burst(0.2, 2400, 0.4); break;
      // --- PRIDE OVERLORD (sintetizado y original; volumen con tope) ---
      case 'prShot': this._tone('sine', 900, 1500, 0.08, this._prG(0.12)); this._tone('triangle', 1800, 2600, 0.06, this._prG(0.05)); break;
      case 'prFull': [1047, 1319, 1568].forEach((f, i) => this._tone('sine', f, f, 0.18, this._prG(0.06 + i * 0.01))); break;
      case 'prBig': this._tone('sawtooth', 300, 1200, 0.25, this._prG(0.1)); this._burst(0.25, 3000, this._prG(0.25)); break;
      case 'prBlast': this._tone('sine', 160, 40, 0.4, this._prG(0.22)); this._burst(0.4, 2600, this._prG(0.5)); [784, 988, 1175].forEach((f, i) => this._tone('sine', f, f * 1.5, 0.25, this._prG(0.05))); break;
      case 'prWave': this._synthWave(110, 55, 0.5, this._prG(0.16)); this._burst(0.3, 900, this._prG(0.3)); break;
      case 'prShield': [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this._tone('sine', f, f, 0.25, this._prG(0.06)), i * 50)); break;
      case 'prShieldHit': this._tone('sine', 1400, 900, 0.12, this._prG(0.08)); break;
      case 'prShieldBreak': this._burst(0.35, 7000, this._prG(0.35)); [1568, 1175, 784].forEach((f, i) => setTimeout(() => this._tone('triangle', f, f * 0.7, 0.2, this._prG(0.08)), i * 60)); break;
      case 'prBoost': this._tone('sawtooth', 150, 600, 0.35, this._prG(0.07)); this._burst(0.3, 1800, this._prG(0.2)); break;
      case 'prCast': this._tone('sine', 400, 1600, 0.6, this._prG(0.08)); break;
      case 'prZoneOn': [262, 330, 392, 523].forEach((f, i) => setTimeout(() => this._tone('square', f, f, 0.16, this._prG(0.04)), i * 80)); break;
      case 'prPulse': this._tone('sine', 700, 500, 0.12, this._prG(0.05)); break;
      case 'prCelebrate': [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => this._tone('triangle', f, f, 0.3, this._prG(0.1)), i * 120)); break;
      case 'prNoEnergy': this._tone('square', 220, 180, 0.12, this._prG(0.06)); break;
      // --- CRUZ AZUL - LA MÁQUINA ---
      case 'cazShot': this._tone('sawtooth', 1200, 300, 0.09, 0.18); this._burst(0.07, 6000, 0.22); break;
      case 'cazPulse': this._burst(0.45, 5000, 0.7); this._tone('sine', 180, 60, 0.5, 0.5); this._tone('sawtooth', 900, 200, 0.25, 0.25); break;
      case 'cazBoost': this._tone('sawtooth', 180, 700, 0.35, 0.12); this._burst(0.25, 2200, 0.18); break;
      case 'cazWin': [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => setTimeout(() => this._tone('triangle', f, f, 0.28, 0.12), i * 110)); break;
      default: break;
    }
  }
}

