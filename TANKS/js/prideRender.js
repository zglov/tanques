'use strict';
/**
 * ============================================================================
 *  prideRender.js — PRIDE OVERLORD en el Renderer (efectos locales).
 * ============================================================================
 *  Extiende Renderer.prototype: reutiliza partículas, anillos, luces,
 *  sacudida y textos flotantes. Todo se genera a partir de EVENTOS con uid;
 *  la fotografía nunca viaja por la red (se carga una vez con PrideArt.load).
 *  Adaptado al juego de un solo impacto (el escudo absorbe impactos).
 * ============================================================================
 */
(function () {
  if (typeof Renderer === 'undefined' || typeof PrideArt === 'undefined') return;
  const TAU = Math.PI * 2;
  const R = Renderer.prototype;
  const H = PrideArt.hue;
  const NEON = ['#ff4fd8', '#4fd8ff', '#9dff4f', '#ffe14f', '#b04fff', '#ff8a4f'];
  const rnd = (a) => a[(Math.random() * a.length) | 0];

  R._prFx = function (id) {
    const fx = this._fxFor(id);
    if (!fx.pr) fx.pr = { recoil: 0, muzzle: 0, vib: 0, shieldK: 0, hitFx: 0, trailT: 0, full: 0 };
    return fx.pr;
  };

  R._prSpark = function (x, y, n, speed, life = 0.5, size = 1.4) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = speed * MathUtil.randRange(0.4, 1);
      this._particle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * MathUtil.randRange(0.6, 1), size, rnd(NEON), 2, 3);
    }
  };

  R._prFloat = function (x, y, text, color, age = 0.5) {
    let dy = 0;
    for (const f of this.floatTexts) if (Math.abs(f.x - x) < 60 && Math.abs(f.y - y - dy) < 12 && f.age < 1.6) dy -= 14;
    this.floatTexts.push({ x, y: y + dy, text, age, color });
  };

  R._prideObserve = function (ev) {
    if (ev.type === 'roundStart') { this.prBanner = null; }
  };

  R._drawPride = function (ctx, t, x, y, ca, ta, dt, view) {
    this._localId = view.localTankId;
    const z = this._prFx(t.id), fx = this._fxFor(t.id), C = CONFIG.PRIDE;
    z.recoil = Math.max(0, z.recoil - dt * 5);
    z.muzzle = Math.max(0, z.muzzle - dt * 6);
    z.vib = Math.max(0, z.vib - dt * 2.5);
    z.hitFx = Math.max(0, z.hitFx - dt * 3);
    z.full = Math.max(0, z.full - dt * 3);
    z.shieldK += ((t.prShieldT > 0 ? 1 : 0) - z.shieldK) * Math.min(1, dt * 10);
    const charge = t.prCharging ? MathUtil.clamp(t.prCharge / C.chargedShot.maxChargeTime, 0, 1) : 0;
    const reduced = this.settings.reducedFx, q = this.settings.quality;
    PrideArt.drawTank(ctx, {
      x, y, chassis: ca, turret: ta, color: t.color.body, phase: fx.phase || 0, time: this.time,
      recoil: z.recoil, muzzle: Math.max(z.muzzle, z.full), charge, boost: t.prBoosting ? 1 : 0, speakerVib: z.vib,
      shieldK: z.shieldK, shieldFrac: C.rainbowShield.maxHits > 0 ? t.prShieldHits / C.rainbowShield.maxHits : 1, hitFx: z.hitFx, effects: !reduced,
    });
    if (!dt || reduced) return;
    // partículas concentrándose en la boca del cañón mientras carga
    if (charge > 0 && Math.random() < dt * (10 + 30 * charge)) {
      const mx = x + Math.cos(ta) * 27, my = y + Math.sin(ta) * 27, a = Math.random() * TAU, r = 14 + Math.random() * 10;
      this._particle(mx + Math.cos(a) * r, my + Math.sin(a) * r, -Math.cos(a) * r * 3, -Math.sin(a) * r * 3, 0.3, 1.2, rnd(NEON), 2, 1);
    }
    // turbo: estela arcoíris, corazones y huellas multicolor
    if (t.prBoosting) {
      z.trailT -= dt * (q === 'baja' ? 0.4 : 1) * C.particles.boostPerSecond;
      while (z.trailT <= 0) {
        z.trailT += 1;
        const c = Math.cos(ca), s = Math.sin(ca), off = MathUtil.randRange(-12, 12);
        this._particle(x - c * 24 - s * off, y - s * 24 + c * off, -c * 70 + MathUtil.randRange(-20, 20), -s * 70 + MathUtil.randRange(-20, 20), 0.6, 2.2, PrideArt.FLAG[(Math.random() * 6) | 0], 2, 1.5, 3);
      }
      if (Math.random() < dt * 4) this.floatTexts.push({ x: x + MathUtil.randRange(-10, 10), y: y - 10, text: '♥', age: 0.9, color: H(320 + Math.random() * 40, 100, 70) });
    } else if (Math.random() < dt * 3) {
      // escapes con partículas multicolor (suave)
      const c = Math.cos(ca), s = Math.sin(ca);
      this._particle(x - c * 23, y - s * 23, -c * 25, -s * 25, 0.5, 1.4, rnd(NEON), 1, 2, 2);
    }
  };

  /** La Zona de Gemidos (advertencia y campo activo), bajo los tanques. */
  R._drawPrideGround = function (ctx, dt) {
    const st = this.state;
    if (!st.prZones || !st.prZones.length) return;
    const Z = CONFIG.PRIDE.sonicZone;
    for (const z of st.prZones) {
      if (!z.active) PrideArt.drawZoneWarning(ctx, z, this.time, MathUtil.clamp(z.age / Z.warningTime, 0, 1));
      else {
        const age = z.age - Z.warningTime;
        PrideArt.drawZone(ctx, z, this.time, age, Z.duration, this.settings.reducedFx);
        if (dt && !this.settings.reducedFx && Math.random() < dt * CONFIG.PRIDE.particles.zonePerSecond * (this.settings.quality === 'baja' ? 0.4 : 1)) {
          const a = Math.random() * TAU, r = Math.random() * Z.radius;
          this._particle(z.x + Math.cos(a) * r, z.y + Math.sin(a) * r, 0, -25, 0.8, 1.6, rnd(['#ff6ec7', '#b56bff', '#5aa8ff']), 2, 1);
        }
      }
    }
  };

  /** Anuncio "¡LA ZONA DE GEMIDOS!" y celebración AMO A SAMARIEMM (pantalla). */
  R._drawPrideOverlay = function (ctx, dt) {
    const W = this.canvas.width, Hh = this.canvas.height;
    if (this.prBanner) {
      const b = this.prBanner; b.age += dt;
      const dur = 1.6;
      if (b.age > dur) this.prBanner = null;
      else {
        const k = Math.min(1, b.age / 0.2) * Math.min(1, (dur - b.age) / 0.4);
        ctx.save(); ctx.globalAlpha = k; ctx.translate(W / 2, 52);
        const sc = 1 + 0.15 * Math.max(0, 1 - b.age / 0.25); ctx.scale(sc, sc);
        ctx.font = '900 30px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(b.text).width;
        const g = ctx.createLinearGradient(-tw / 2, 0, tw / 2, 0);
        PrideArt.FLAG.forEach((c, i) => g.addColorStop(i / 5, c));
        ctx.lineJoin = 'round'; ctx.lineWidth = 6; ctx.strokeStyle = '#1a0624'; ctx.strokeText(b.text, 0, 0);
        ctx.fillStyle = g; ctx.fillText(b.text, 0, 0);
        PrideArt.heart(ctx, -tw / 2 - 18, 0, 8, '#ff4fa8'); PrideArt.heart(ctx, tw / 2 + 18, 0, 8, '#b04fff');
        ctx.restore();
      }
    }
    if (this.samAge >= 0) {
      this.samAge += dt;
      const C = CONFIG.PRIDE.victoryCelebration;
      if (!PrideArt.drawCelebration(ctx, W, Hh, this.samAge, C.duration, this.settings.reducedFx, C.text)) this.samAge = -1;
    }
  };

  R._handlePrideEvent = function (ev) {
    const reduced = this.settings.reducedFx, st = this.state;
    switch (ev.type) {
      case 'prShot': {
        const z = this._prFx(ev.ownerId); z.recoil = 0.7; z.muzzle = 0.8;
        this._light(ev.x, ev.y, 34, 0.08, '255,120,230');
        this._prSpark(ev.x, ev.y, reduced ? 2 : 5, 70, 0.3);
        return true;
      }
      case 'prChargeStart': case 'prChargeCancel': return true;
      case 'prChargeFull': {
        const t = st.tanks.get(ev.id);
        if (t) {
          this._prFx(ev.id).full = 1; // destello blanco con los colores del arcoíris
          const mx = t.x + Math.cos(t.turretAngle) * 27, my = t.y + Math.sin(t.turretAngle) * 27;
          this.rings.push({ x: mx, y: my, life: 0.3, max: 0.3, maxR: 18, color: '255,255,255', width: 3 });
          this._prSpark(mx, my, reduced ? 4 : 10, 90, 0.35);
        }
        return true;
      }
      case 'prChargedShot': {
        const z = this._prFx(ev.ownerId); z.recoil = 1; z.muzzle = 1;
        this.rings.push({ x: ev.x, y: ev.y, life: 0.3, max: 0.3, maxR: 20 + 20 * ev.frac, color: '255,180,250', width: 4 }); // onda al disparar
        this._light(ev.x, ev.y, 70, 0.2, '255,140,240');
        this._prSpark(ev.x, ev.y, reduced ? 4 : 12, 140, 0.4, 1.8);
        this.shake = Math.max(this.shake, reduced ? 0.3 : 1 + 2 * ev.frac);
        return true;
      }
      case 'prBlast': {
        const r = CONFIG.PRIDE.chargedShot.blastRadius * (0.5 + 0.5 * ev.frac);
        this._light(ev.x, ev.y, 90 + 60 * ev.frac, 0.3, '255,160,240');
        for (let i = 0; i < 3; i++) this.rings.push({ x: ev.x, y: ev.y, life: 0.3 + i * 0.1, max: 0.3 + i * 0.1, maxR: r * (0.7 + i * 0.25), color: ['255,80,200', '80,200,255', '200,255,80'][i], width: 4 - i });
        this._prSpark(ev.x, ev.y, reduced ? 8 : 22, 170, 0.6, 2.2);
        for (const [tx, ty] of ev.blocks || []) this.handleEvent({ type: 'blockDestroyed', tx, ty, x: tx * CONFIG.TILE_SIZE + 20, y: ty * CONFIG.TILE_SIZE + 20 });
        this.shake = Math.max(this.shake, reduced ? 0.5 : 2 + 2 * ev.frac);
        return true;
      }
      case 'prWave': {
        const t = st.tanks.get(ev.id);
        if (t) this._prFx(ev.id).vib = 1;
        const Rw = CONFIG.PRIDE.prideWave.radius;
        for (let i = 0; i < 4; i++) this.rings.push({ x: ev.x, y: ev.y, life: 0.35 + i * 0.08, max: 0.35 + i * 0.08, maxR: Rw * (0.6 + i * 0.15), color: ['255,79,216', '79,216,255', '157,255,79', '255,225,79'][i], width: 3 });
        for (let i = 0; i < (reduced ? 3 : 8); i++) {
          const a = i * TAU / 8;
          this.floatTexts.push({ x: ev.x + Math.cos(a) * 30, y: ev.y + Math.sin(a) * 30, text: i % 2 ? '♥' : '♪', age: 0.8, color: H(i * 45, 100, 70) });
        }
        this._prSpark(ev.x, ev.y, reduced ? 6 : 16, 160, 0.5);
        return true;
      }
      case 'prShieldOn': {
        this.rings.push({ x: ev.x, y: ev.y, life: 0.35, max: 0.35, maxR: 30, color: '255,170,250', width: 3 });
        return true;
      }
      case 'prShieldHit': this._prFx(ev.id).hitFx = 1; return true;
      case 'prShieldBreak': case 'prShieldEnd': {
        this._prSpark(ev.x, ev.y, reduced ? 8 : 24, 150, 0.6, 2);
        this.rings.push({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, maxR: 36, color: '255,255,255', width: 3 });
        if (ev.type === 'prShieldBreak') { const t = st.tanks.get(ev.id); if (t) this._prFloat(t.x, t.y - 32, 'ESCUDO ROTO', '#ff9ad8', 0.4); }
        return true;
      }
      case 'prBoostStart': case 'prBoostEnd': return true;
      case 'prNoEnergy': {
        const t = st.tanks.get(ev.id);
        if (t && ev.id === this._localId) this._prFloat(t.x, t.y - 32, 'SIN ENERGÍA', '#ff9ad8', 0.6);
        return true;
      }
      case 'prZoneCast': return true;
      case 'prZoneOn': {
        this.prBanner = { text: '¡LA ZONA DE GEMIDOS!', age: 0 };
        this.rings.push({ x: ev.x, y: ev.y, life: 0.5, max: 0.5, maxR: CONFIG.PRIDE.sonicZone.radius, color: '255,120,230', width: 5 });
        this._prSpark(ev.x, ev.y, reduced ? 8 : 26, 180, 0.7, 2);
        return true;
      }
      case 'prZonePulse': {
        if (!reduced) this.rings.push({ x: ev.x, y: ev.y, life: 0.45, max: 0.45, maxR: CONFIG.PRIDE.sonicZone.radius * 0.95, color: '200,120,255', width: 2 });
        for (const id of ev.hit || []) {
          const t = st.tanks.get(id);
          if (t) this.floatTexts.push({ x: t.x + MathUtil.randRange(-8, 8), y: t.y - 22, text: '♪', age: 0.7, color: H(280 + Math.random() * 60, 100, 75) });
        }
        return true;
      }
      case 'prZoneOff': this._prSpark(ev.x, ev.y, reduced ? 4 : 12, 120, 0.5); return true;
      case 'samariemm': {
        // AMO A SAMARIEMM: evita duplicados por red (<1s), pero permite repetir
        // en partidas nuevas aunque la ronda vuelva a 1.
        if (this._samLastWinTime == null) this._samLastWinTime = -99;
        if ((this.time - this._samLastWinTime) < 1.0) return true;
        this._samLastWinTime = this.time;
        this.samAge = 0;
        return true;
      }
      default: return false;
    }
  };
})();
