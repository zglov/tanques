'use strict';
/**
 * pride.js — PRIDE OVERLORD sin foto, texto de victoria genérico.
 * Implementación simplificada compatible con el sistema one-hit-kill.
 */
const PrideRules = {
  preUpdate(state, tank, input, dt) {
    // Regenerar energía
    tank.prEnergy = Math.min(CONFIG.PRIDE.energy.max, tank.prEnergy + CONFIG.PRIDE.energy.regeneration * dt);
    // Decaer cooldowns básicos
    if (tank.prChargeCd > 0) tank.prChargeCd -= dt;
    if (tank.prWaveCd > 0) tank.prWaveCd -= dt;
    if (tank.prShieldCd > 0) tank.prShieldCd -= dt;
    if (tank.prZoneCd > 0) tank.prZoneCd -= dt;
    if (tank.prShieldT > 0) {
      tank.prShieldT -= dt;
      if (tank.prShieldT <= 0) tank.prShieldHits = 0;
    }
    if (tank.prSlowT > 0) tank.prSlowT -= dt;
    if (tank.prSilenceT > 0) tank.prSilenceT -= dt;

    // Turbo (Shift)
    const wantsBoost = !!(input && input.ab);
    if (wantsBoost && !tank.prBoosting && tank.prEnergy >= CONFIG.PRIDE.rainbowBoost.minEnergyToStart) {
      tank.prBoosting = true;
      state.emit('prBoostStart', { id: tank.id, x: tank.x, y: tank.y });
    } else if (!wantsBoost && tank.prBoosting) {
      tank.prBoosting = false;
      state.emit('prBoostEnd', { id: tank.id, x: tank.x, y: tank.y });
    }
    if (tank.prBoosting) {
      tank.prEnergy = Math.max(0, tank.prEnergy - CONFIG.PRIDE.rainbowBoost.energyDrainPerSecond * dt);
      if (tank.prEnergy <= 0) {
        tank.prBoosting = false;
        state.emit('prBoostEnd', { id: tank.id, x: tank.x, y: tank.y });
      }
    }

    // Carga del rayo (mantener clic derecho)
    const holding = !!(input && input.ph);
    if (holding && !tank.prCharging && tank.prChargeCd <= 0 && tank.prEnergy >= CONFIG.PRIDE.chargedShot.energyCost * CONFIG.PRIDE.chargedShot.minEnergyFraction) {
      tank.prCharging = true;
      tank.prCharge = 0;
      state.emit('prChargeStart', { id: tank.id });
    } else if (!holding && tank.prCharging) {
      // Soltar: disparar si carga suficiente, si no cancelar
      if (tank.prCharge >= 0.25) {
        this.fireCharged(state, tank, tank.prCharge);
      } else {
        state.emit('prChargeCancel', { id: tank.id });
      }
      tank.prCharging = false;
      tank.prCharge = 0;
    }
    if (tank.prCharging) {
      tank.prCharge = Math.min(1, tank.prCharge + dt / CONFIG.PRIDE.chargedShot.maxChargeTime);
      if (tank.prCharge >= 1) {
        this.fireCharged(state, tank, 1);
        tank.prCharging = false;
        tank.prCharge = 0;
      }
    }

    // Acciones instantáneas por contadores (Q, E, F)
    if (input && typeof input.aq === 'number') {
      const seen = tank._prAqSeen || 0;
      if (input.aq > seen) {
        tank._prAqSeen = input.aq;
        this.wave(state, tank);
      }
    }
    if (input && typeof input.aj === 'number') {
      const seen = tank._prAjSeen || 0;
      if (input.aj > seen) {
        tank._prAjSeen = input.aj;
        this.shield(state, tank);
      }
    }
    if (input && typeof input.af === 'number') {
      const seen = tank._prAfSeen || 0;
      if (input.af > seen) {
        tank._prAfSeen = input.af;
        const tx = (input.nx !== undefined) ? input.nx : tank.x + Math.cos(tank.turretAngle) * 150;
        const ty = (input.ny !== undefined) ? input.ny : tank.y + Math.sin(tank.turretAngle) * 150;
        this.zone(state, tank, tx, ty);
      }
    }
  },

  postUpdate(state, tank, dt) {},

  absorb(tank, input) {},

  fireNormal(state, tank) {
    const C = CONFIG.PRIDE.primaryWeapon;
    if (tank.fireCooldown > 0) return false;
    const muzzle = tank.getMuzzlePosition();
    const ang = tank.turretAngle;
    const b = new Bullet({
      id: state._nextBulletId(),
      ownerId: tank.id,
      x: muzzle.x, y: muzzle.y,
      vx: Math.cos(ang) * C.speed,
      vy: Math.sin(ang) * C.speed,
      radius: C.radius,
      bouncesLeft: CONFIG.BULLET.DEFAULT_BOUNCES,
      shape: 'normal',
    });
    b.kind = 'prism';
    state.bullets.set(b.id, b);
    tank.fireCooldown = C.cooldown;
    state.emit('shot', { id: tank.id, x: tank.x, y: tank.y, kind: 'prism' });
    return true;
  },

  fireCharged(state, tank, frac) {
    const C = CONFIG.PRIDE.chargedShot;
    const cost = Math.round(C.energyCost * (0.2 + 0.8 * frac));
    if (tank.prEnergy < cost) return false;
    tank.prEnergy -= cost;
    tank.prChargeCd = C.cooldown;
    const muzzle = tank.getMuzzlePosition();
    const ang = tank.turretAngle;
    const radius = C.minRadius + (C.maxRadius - C.minRadius) * frac;
    const b = new Bullet({
      id: state._nextBulletId(),
      ownerId: tank.id,
      x: muzzle.x, y: muzzle.y,
      vx: Math.cos(ang) * C.speed,
      vy: Math.sin(ang) * C.speed,
      radius: radius,
      bouncesLeft: 0,
      shape: 'normal',
    });
    b.kind = 'pcharge';
    b.prFrac = frac;
    state.bullets.set(b.id, b);
    state.emit('prShotCharged', { id: tank.id, x: tank.x, y: tank.y, frac });
    return true;
  },

  explodeCharged(state, bullet, victim) {
    const C = CONFIG.PRIDE.chargedShot;
    const frac = bullet.prFrac || 0;
    const radius = C.blastRadius * (0.5 + 0.5 * frac);
    const r2 = radius * radius;
    state.emit('prBlast', { x: MathUtil.round(bullet.x), y: MathUtil.round(bullet.y), radius, ownerId: bullet.ownerId, frac });
    // Matar tanques en radio
    const victims = [];
    for (const t of state.tanks.values()) {
      if (!t.isAlive || t.id === bullet.ownerId) continue;
      if (MathUtil.dist2(bullet.x, bullet.y, t.x, t.y) <= r2) victims.push(t);
    }
    for (const t of victims) state._destroyTank(t, bullet.ownerId);
    // Romper bloques si carga completa
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
    if (!tank.isAlive || tank.prWaveCd > 0 || tank.prEnergy < C.energyCost) return false;
    tank.prEnergy -= C.energyCost;
    tank.prWaveCd = C.cooldown;
    const r2 = C.radius * C.radius;
    let hit = false;
    for (const t of state.tanks.values()) {
      if (!t.isAlive || t.id === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, t.x, t.y) <= r2) {
        hit = true;
        t.stunTimer = Math.max(t.stunTimer, C.interruptDuration);
        // Empuje simple
        const ang = Math.atan2(t.y - tank.y, t.x - tank.x);
        t.x += Math.cos(ang) * C.push;
        t.y += Math.sin(ang) * C.push;
        state.map.resolveCircle(t, CONFIG.TANK.RADIUS);
      }
    }
    // Destruir balas enemigas en radio
    for (const b of state.bullets.values()) {
      if (!b.alive || b.ownerId === tank.id) continue;
      if (MathUtil.dist2(tank.x, tank.y, b.x, b.y) <= r2) {
        b.alive = false;
        state.emit('bulletDestroyed', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) });
      }
    }
    state.emit('prWave', { x: MathUtil.round(tank.x), y: MathUtil.round(tank.y), ownerId: tank.id, radius: C.radius, hit });
    return true;
  },

  shield(state, tank) {
    const C = CONFIG.PRIDE.rainbowShield;
    if (!tank.isAlive || tank.prShieldCd > 0 || tank.prEnergy < C.energyCost) return false;
    tank.prEnergy -= C.energyCost;
    tank.prShieldCd = C.cooldown;
    tank.prShieldT = C.duration;
    tank.prShieldHits = C.maxHits;
    state.emit('prShieldOn', { id: tank.id, x: tank.x, y: tank.y });
    return true;
  },

  absorbHit(state, tank) {
    if (tank.prShieldT > 0 && tank.prShieldHits > 0) {
      tank.prShieldHits--;
      state.emit('prShieldHit', { id: tank.id, x: tank.x, y: tank.y, left: tank.prShieldHits });
      if (tank.prShieldHits <= 0) {
        tank.prShieldT = 0;
        state.emit('prShieldBreak', { id: tank.id, x: tank.x, y: tank.y });
      }
      return true;
    }
    return false;
  },

  zone(state, tank, x, y) {
    const C = CONFIG.PRIDE.sonicZone;
    if (!tank.isAlive || tank.prZoneCd > 0 || tank.prEnergy < C.energyCost) return false;
    // Clampear a rango
    const dx = x - tank.x, dy = y - tank.y;
    const d = Math.hypot(dx, dy);
    if (d > C.range) {
      x = tank.x + (dx / d) * C.range;
      y = tank.y + (dy / d) * C.range;
    }
    tank.prEnergy -= C.energyCost;
    tank.prZoneCd = C.cooldown;
    const id = ++state._prZoneId;
    state.prZones.push({ id, ownerId: tank.id, x, y, radius: C.radius, t: 0, warning: C.warningTime, duration: C.duration, stunned: new Set() });
    state.emit('prZoneCast', { id, ownerId: tank.id, x: MathUtil.round(x), y: MathUtil.round(y), radius: C.radius, warning: C.warningTime, duration: C.duration });
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
        state.emit('prZoneEnd', { id: z.id });
        continue;
      }
      // Aplicar efectos a tanques dentro
      const r2 = z.radius * z.radius;
      for (const t of state.tanks.values()) {
        if (!t.isAlive) continue;
        if (MathUtil.dist2(z.x, z.y, t.x, t.y) <= r2) {
          t.prSlowT = Math.max(t.prSlowT, 0.2);
          t.prSilenceT = Math.max(t.prSilenceT, 0.2);
          if (!z.stunned.has(t.id)) {
            z.stunned.add(t.id);
            t.stunTimer = Math.max(t.stunTimer, C.stunDuration);
            state.emit('prZoneStun', { id: t.id, x: MathUtil.round(t.x), y: MathUtil.round(t.y) });
          }
        }
      }
    }
  },

  tick(state, tank, dt) {
    // Decaer aturdimiento y lentitud ya se maneja en gameState, aquí solo energía pasiva
  },

  interrupt(state, victim) {
    if (victim && victim.mods && victim.mods.pride) {
      victim.prCharging = false;
      victim.prBoosting = false;
    }
  },

  onRoundEnd(state, winner) {
    if (winner && winner.mods && winner.mods.pride) {
      state.emit('samariemm', { id: winner.id, round: state.round.number });
    }
  },
};

const PrideAI = {
  decide(ctrl, state, me, target, dist, out, dt) {
    ctrl._t = (ctrl._t || 0) + dt;
    if (ctrl._t < 0.2) return;
    ctrl._t = 0;
    if (!target) return;
    // Zona si hay 2+ enemigos cerca del punto medio
    if (me.prZoneCd <= 0 && me.prEnergy >= CONFIG.PRIDE.sonicZone.energyCost) {
      const mx = (me.x + target.x) / 2, my = (me.y + target.y) / 2;
      out.nx = mx; out.ny = my;
      out.af = (out.af || 0) + 1;
      return;
    }
    // Escudo si está amenazado
    if (me.prShieldCd <= 0 && me.prShieldT <= 0 && me.prEnergy >= CONFIG.PRIDE.rainbowShield.energyCost && dist < 200) {
      out.aj = (out.aj || 0) + 1;
      return;
    }
    // Onda si está rodeado
    if (me.prWaveCd <= 0 && me.prEnergy >= CONFIG.PRIDE.prideWave.energyCost && dist < 120) {
      out.aq = (out.aq || 0) + 1;
      return;
    }
    // Rayo cargado si alineado y distancia media
    if (me.prChargeCd <= 0 && me.prEnergy >= 30 && dist > 120 && dist < 480 && state.map.hasLineOfSight(me.x, me.y, target.x, target.y)) {
      out.ph = 1;
      out.pd = (out.pd || 0) + 1;
      return;
    }
    // Turbo para perseguir o escapar
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
