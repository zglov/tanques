'use strict';
/**
 * pride.js — PRIDE OVERLORD 🌈 (sin foto, texto de victoria genérico)
 * Adaptado al sistema one-hit-kill de TANKS.
 */
const PrideRules = {
  emit(state, type, data = {}) {
    data.uid = ++state._prideUid;
    state.emit(type, data);
  },

  resetTank(t) {
    const P = CONFIG.PRIDE;
    t.prEnergy = P.energy.max;
    t.prCharging = false; t.prCharge = 0;
    t.prChargeCd = 0; t.prWaveCd = 0; t.prShieldCd = 0; t.prZoneCd = 0;
    t.prShieldT = 0; t.prShieldHits = 0;
    t.prBoosting = false; t._prBoostLock = false;
    t.prSlowT = 0; t.prSilenceT = 0;
    t._pack = { aj: 0, aq: 0, af: 0, pd: 0, pu: 0 };
    t._prAqSeen = 0; t._prAjSeen = 0; t._prAfSeen = 0;
  },

  tick(state, tank, dt) {
    if (tank.prChargeCd > 0) tank.prChargeCd = Math.max(0, tank.prChargeCd - dt);
    if (tank.prWaveCd > 0) tank.prWaveCd = Math.max(0, tank.prWaveCd - dt);
    if (tank.prShieldCd > 0) tank.prShieldCd = Math.max(0, tank.prShieldCd - dt);
    if (tank.prZoneCd > 0) tank.prZoneCd = Math.max(0, tank.prZoneCd - dt);
    if (tank.prShieldT > 0) {
      tank.prShieldT = Math.max(0, tank.prShieldT - dt);
      if (tank.prShieldT <= 0) tank.prShieldHits = 0;
    }
    if (tank.prSlowT > 0) tank.prSlowT = Math.max(0, tank.prSlowT - dt);
    if (tank.prSilenceT > 0) tank.prSilenceT = Math.max(0, tank.prSilenceT - dt);
    // Regenerar energía
    tank.prEnergy = Math.min(CONFIG.PRIDE.energy.max, tank.prEnergy + CONFIG.PRIDE.energy.regeneration * dt);
  },

  _counts(input) {
    const c = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
    return { aj: c(input.aj), aq: c(input.aq), af: c(input.af), pd: c(input.pd), pu: c(input.pu) };
  },

  absorb(t, input) {
    if (!input) return;
    const c = this._counts(input);
    const k = t._pack || { aj: 0, aq: 0, af: 0, pd: 0, pu: 0 };
    t._pack = { aj: Math.max(k.aj, c.aj), aq: Math.max(k.aq, c.aq), af: Math.max(k.af, c.af), pd: Math.max(k.pd, c.pd), pu: Math.max(k.pu, c.pu) };
    t._prAqSeen = t._pack.aq;
    t._prAjSeen = t._pack.aj;
    t._prAfSeen = t._pack.af;
  },

  interrupt(state, t) {
    if (t.prCharging) { t.prCharging = false; t.prCharge = 0; this.emit(state, 'prChargeCancel', { id: t.id }); }
    if (t.prBoosting) { t.prBoosting = false; this.emit(state, 'prBoostEnd', { id: t.id }); }
  },

  _spend(state, t, cost) {
    if (t.prEnergy + 1e-6 < cost) { this.emit(state, 'prNoEnergy', { id: t.id }); return false; }
    t.prEnergy = Math.max(0, t.prEnergy - cost);
    return true;
  },

  preUpdate(state, t, input, dt) {
    const P = CONFIG.PRIDE;
    if (!t._pack) t._pack = { aj: 0, aq: 0, af: 0, pd: 0, pu: 0 };
    const c = this._counts(input || {});
    const k = t._pack;
    const press = (n) => c[n] > k[n];
    const doWave = press('aq'), doShield = press('aj'), doZone = press('af'), down = press('pd'), up = press('pu');
    t._pack = { aj: Math.max(k.aj, c.aj), aq: Math.max(k.aq, c.aq), af: Math.max(k.af, c.af), pd: Math.max(k.pd, c.pd), pu: Math.max(k.pu, c.pu) };
    t._prAqSeen = t._pack.aq; t._prAjSeen = t._pack.aj; t._prAfSeen = t._pack.af;
    const held = !!(input && input.ph);
    if (t.freezeTimer > 0 || t.stunTimer > 0 || !t.isAlive) {
      this.interrupt(state, t);
      if (!input.ab) t._prBoostLock = false;
      return;
    }
    // Turbo
    const wantBoost = !!(input && input.ab);
    if (!wantBoost) t._prBoostLock = false;
    if (t.prBoosting) {
      t.prEnergy -= P.rainbowBoost.energyDrainPerSecond * dt;
      if (t.prEnergy <= 0 || !wantBoost) {
        t.prEnergy = Math.max(0, t.prEnergy);
        t.prBoosting = false;
        this.emit(state, 'prBoostEnd', { id: t.id });
      }
    } else if (wantBoost && !t._prBoostLock && t.prEnergy >= P.rainbowBoost.minEnergyToStart) {
      t.prBoosting = true;
      this.emit(state, 'prBoostStart', { id: t.id });
    }
    // Carga del rayo
    if (down && !t.prCharging && t.prChargeCd <= 0 && t.prEnergy >= P.chargedShot.energyCost * P.chargedShot.minEnergyFraction) {
      t.prCharging = true;
      t.prCharge = 0;
      this.emit(state, 'prChargeStart', { id: t.id });
    }
    if (t.prCharging) {
      if (held) {
        t.prCharge = Math.min(P.chargedShot.maxChargeTime, t.prCharge + dt);
        this.emit(state, 'prChargeTick', { id: t.id, frac: t.prCharge / P.chargedShot.maxChargeTime });
        if (t.prCharge >= P.chargedShot.maxChargeTime) {
          this.fireCharged(state, t, 1);
          t.prCharging = false;
          t.prCharge = 0;
        }
      }
      if (up) {
        if (t.prCharge >= P.chargedShot.maxChargeTime * P.chargedShot.minEnergyFraction) {
          this.fireCharged(state, t, t.prCharge / P.chargedShot.maxChargeTime);
        } else {
          this.emit(state, 'prChargeCancel', { id: t.id });
        }
        t.prCharging = false;
        t.prCharge = 0;
      }
    }
    // Acciones instantáneas
    if (doWave) this.wave(state, t);
    if (doShield) this.shield(state, t);
    if (doZone) {
      const tx = (input.nx !== undefined) ? input.nx : t.x + Math.cos(t.turretAngle) * 150;
      const ty = (input.ny !== undefined) ? input.ny : t.y + Math.sin(t.turretAngle) * 150;
      this.zone(state, t, tx, ty);
    }
  },

  postUpdate(state, t, dt) {},

  fireNormal(state, tank) {
    const C = CONFIG.PRIDE.primaryWeapon;
    if (tank.fireCooldown > 0) return false;
    if (tank.prSilenceT > 0) return false;
    const muzzle = tank.getMuzzlePosition();
    const b = new Bullet({
      id: state._nextBulletId(),
      ownerId: tank.id,
      x: muzzle.x, y: muzzle.y,
      angle: tank.turretAngle,
      bounces: CONFIG.BULLET.DEFAULT_BOUNCES,
      kind: 'prism',
      speed: C.speed,
      radius: C.radius,
    });
    state.bullets.set(b.id, b);
    tank.fireCooldown = C.cooldown;
    state.emit('shot', { id: tank.id, x: tank.x, y: tank.y, kind: 'prism' });
    return true;
  },

  fireCharged(state, tank, frac) {
    const C = CONFIG.PRIDE.chargedShot;
    const cost = Math.round(C.energyCost * (0.2 + 0.8 * frac));
    if (!this._spend(state, tank, cost)) return false;
    tank.prChargeCd = C.cooldown;
    const muzzle = tank.getMuzzlePosition();
    const radius = C.minRadius + (C.maxRadius - C.minRadius) * frac;
    const b = new Bullet({
      id: state._nextBulletId(),
      ownerId: tank.id,
      x: muzzle.x, y: muzzle.y,
      angle: tank.turretAngle,
      bounces: 0,
      kind: 'pcharge',
      prFrac: frac,
      speed: C.speed,
      radius: radius,
    });
    state.bullets.set(b.id, b);
    this.emit(state, 'prShotCharged', { id: tank.id, x: tank.x, y: tank.y, frac });
    return true;
  },

  explodeCharged(state, bullet, victim) {
    const C = CONFIG.PRIDE.chargedShot;
    const frac = bullet.prFrac || 0;
    const radius = C.blastRadius * (0.5 + 0.5 * frac);
    const r2 = radius * radius;
    this.emit(state, 'prBlast', { x: MathUtil.round(bullet.x), y: MathUtil.round(bullet.y), radius, ownerId: bullet.ownerId, frac });
    const victims = [];
    for (const t of state.tanks.values()) {
      if (!t.isAlive || t.id === bullet.ownerId) continue;
      if (MathUtil.dist2(bullet.x, bullet.y, t.x, t.y) <= r2) victims.push(t);
    }
    for (const t of victims) state._destroyTank(t, bullet.ownerId);
    if (frac >= 0.95 && C.breakableBlast) {
      const ts = state.map.tileSize;
      const minTx = Math.max(0, Math.floor((bullet.x - radius) / ts));
      const maxTx = Math.min(state.map.cols - 1, Math.floor((bullet.x + radius) / ts));
      const minTy = Math.max(0, Math.floor((bullet.y - radius) / ts));
      const maxTy = Math.min(state.map.rows - 1, Math.floor((bullet.y + radius) / ts));
      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const c = state.map.tileCenter(tx, ty);
          if (MathUtil.dist2(bullet.x, bullet.y, c.x, c.y) <= r2) {
            if (state.map.get(tx, ty) === TILE.BREAKABLE) {
              state.map.destroyTile(tx, ty);
              state.emit('blockDestroyed', { tx, ty, x: MathUtil.round(c.x), y: MathUtil.round(c.y) });
            }
          }
        }
      }
    }
    if (bullet) bullet.alive = false;
  },

  wave(state, tank) {
    const C = CONFIG.PRIDE.prideWave;
    if (!tank.isAlive || tank.prWaveCd > 0) return false;
    if (!this._spend(state, tank, C.energyCost)) return false;
    tank.prWaveCd = C.cooldown;
    const r2 = C.radius * C.radius;
    let hit = false;
    for (const t of state.tanks.values()) {
      if (!t.isAlive || t.id === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, t.x, t.y) <= r2) {
        hit = true;
        t.stunTimer = Math.max(t.stunTimer, C.interruptDuration);
        const ang = Math.atan2(t.y - tank.y, t.x - tank.x);
        t.x += Math.cos(ang) * C.push;
        t.y += Math.sin(ang) * C.push;
        state.map.resolveCircle(t, CONFIG.TANK.RADIUS);
      }
    }
    for (const b of state.bullets.values()) {
      if (!b.alive || b.ownerId === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, b.x, b.y) <= r2) {
        b.alive = false;
        state.emit('bulletDestroyed', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) });
      }
    }
    this.emit(state, 'prWave', { x: MathUtil.round(tank.x), y: MathUtil.round(tank.y), ownerId: tank.id, radius: C.radius, hit });
    return true;
  },

  shield(state, tank) {
    const C = CONFIG.PRIDE.rainbowShield;
    if (!tank.isAlive || tank.prShieldCd > 0) return false;
    if (!this._spend(state, tank, C.energyCost)) return false;
    tank.prShieldCd = C.cooldown;
    tank.prShieldT = C.duration;
    tank.prShieldHits = C.maxHits;
    this.emit(state, 'prShieldOn', { id: tank.id, x: tank.x, y: tank.y });
    return true;
  },

  absorbHit(state, tank) {
    if (tank.prShieldT > 0 && tank.prShieldHits > 0) {
      tank.prShieldHits--;
      this.emit(state, 'prShieldHit', { id: tank.id, x: tank.x, y: tank.y, left: tank.prShieldHits });
      if (tank.prShieldHits <= 0) {
        tank.prShieldT = 0;
        this.emit(state, 'prShieldBreak', { id: tank.id, x: tank.x, y: tank.y });
      }
      return true;
    }
    return false;
  },

  zone(state, tank, x, y) {
    const C = CONFIG.PRIDE.sonicZone;
    if (!tank.isAlive || tank.prZoneCd > 0) return false;
    if (!this._spend(state, tank, C.energyCost)) return false;
    const dx = x - tank.x, dy = y - tank.y;
    const d = Math.hypot(dx, dy);
    if (d > C.range) {
      x = tank.x + (dx / d) * C.range;
      y = tank.y + (dy / d) * C.range;
    }
    tank.prZoneCd = C.cooldown;
    const id = ++state._prZoneId;
    state.prZones.push({ id, ownerId: tank.id, x, y, radius: C.radius, t: 0, warning: C.warningTime, duration: C.duration, stunned: new Set() });
    this.emit(state, 'prZoneCast', { id, ownerId: tank.id, x: MathUtil.round(x), y: MathUtil.round(y), radius: C.radius, warning: C.warningTime, duration: C.duration });
    return true;
  },

  updateZones(state, dt) {
    if (!state.prZones || state.prZones.length === 0) return;
    const C = CONFIG.PRIDE.sonicZone;
    for (let i = state.prZones.length - 1; i >= 0; i--) {
      const z = state.prZones[i];
      z.t += dt;
      if (z.t < z.warning) continue;
      const activeT = z.t - z.warning;
      if (activeT > z.duration) {
        state.prZones.splice(i, 1);
        this.emit(state, 'prZoneEnd', { id: z.id });
        continue;
      }
      const r2 = z.radius * z.radius;
      for (const t of state.tanks.values()) {
        if (!t.isAlive) continue;
        if (MathUtil.dist2(z.x, z.y, t.x, t.y) <= r2) {
          t.prSlowT = Math.max(t.prSlowT, 0.2);
          t.prSilenceT = Math.max(t.prSilenceT, 0.2);
          if (!z.stunned.has(t.id)) {
            z.stunned.add(t.id);
            t.stunTimer = Math.max(t.stunTimer, C.stunDuration);
            this.emit(state, 'prZoneStun', { id: t.id, x: MathUtil.round(t.x), y: MathUtil.round(t.y) });
          }
        }
      }
    }
  },

  onRoundEnd(state, winner) {
    if (winner && winner.mods && winner.mods.pride) {
      this.emit(state, 'samariemm', { id: winner.id, round: state.round.number });
    }
  },
};

const PrideAI = {
  decide(ctrl, state, me, target, dist, out, dt) {
    ctrl._t = (ctrl._t || 0) + dt;
    if (ctrl._t < 0.2) return;
    ctrl._t = 0;
    if (!target) return;
    if (me.prZoneCd <= 0 && me.prEnergy >= CONFIG.PRIDE.sonicZone.energyCost && dist < 300) {
      out.nx = MathUtil.round((me.x + target.x) / 2);
      out.ny = MathUtil.round((me.y + target.y) / 2);
      out.af = (out.af || 0) + 1;
      return;
    }
    if (me.prShieldCd <= 0 && me.prShieldT <= 0 && me.prEnergy >= CONFIG.PRIDE.rainbowShield.energyCost && dist < 200) {
      out.aj = (out.aj || 0) + 1;
      return;
    }
    if (me.prWaveCd <= 0 && me.prEnergy >= CONFIG.PRIDE.prideWave.energyCost && dist < 120) {
      out.aq = (out.aq || 0) + 1;
      return;
    }
    if (me.prChargeCd <= 0 && me.prEnergy >= 30 && dist > 120 && dist < 480 && state.map.hasLineOfSight(me.x, me.y, target.x, target.y)) {
      out.ph = 1;
      out.pd = (out.pd || 0) + 1;
      return;
    }
    if (me.prEnergy > 20) {
      if (dist > 320) out.ab = 1;
      else if (dist < 180 && Math.random() < 0.3) out.ab = 1;
    }
  },
};

const PrideArt = {
  load() {},
  drawPrism(ctx, x, y, angle, time, id) {
    const hue = (time * 360 + (id || 0) * 40) % 360;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = `hsl(${hue},100%,60%)`;
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
  drawPlasma(ctx, x, y, angle, time, radius, frac) {
    ctx.save();
    ctx.translate(x, y);
    const hue = (time * 200) % 360;
    ctx.fillStyle = `hsla(${hue},100%,65%,0.9)`;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
};

if (typeof window !== 'undefined') {
  window.PrideRules = PrideRules;
  window.PrideAI = PrideAI;
  window.PrideArt = PrideArt;
}
