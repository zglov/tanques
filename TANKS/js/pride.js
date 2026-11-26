'use strict';
/**
 * ============================================================================
 *  pride.js — PRIDE OVERLORD 🌈 — EL REY DEL ORGULLO (adaptado).
 * ============================================================================
 *  Tanque de control de área y guerra sónica: cañón prism, Rayo del Orgullo
 *  cargable (explota), Onda del Orgullo, Escudo Arcoíris, Turbo multicolor y
 *  La Zona de Gemidos. Adaptado al juego de UN SOLO IMPACTO (sin HP):
 *    - el blindaje 115 % se traduce en que PRIDE absorbe un impacto por ronda
 *      (escudo pasivo, como el Blindado, vía mods.shield);
 *    - la onda empuja, aturde 0.5 s y desvía balas (sin daño);
 *    - la zona aturde 1 s, ralentiza 35 % y sus pulsos silencian el disparo;
 *    - la explosión del Rayo mata a los tanques dentro de su radio;
 *    - el Escudo Arcoíris absorbe impactos (se rompe tras absorber maxHits).
 *  Depende de: CONFIG, MathUtil, Bullet, TILE (map.js), TAU (utils.js).
 * ============================================================================
 */
const PRIDE_CONFIG = (typeof CONFIG !== 'undefined' && CONFIG.PRIDE) || null;

/** ¿Es este tanque un PRIDE OVERLORD? */
function _isPrideTank(tank) {
  return !!(tank && tank.mods && tank.mods.pride);
}

const PrideRules = {
  isPride: _isPrideTank,

  _now(state) { return state.time; },

  _emit(state, type, data) {
    data = data || {};
    if (!state._prideUid) state._prideUid = 0;
    data.uid = ++state._prideUid;
    state.emit(type, data);
  },

  /** ¿Puede actuar? (vivo, sin congelación ni aturdimiento) */
  _canAct(tank) {
    return tank.isAlive && tank.freezeTimer <= 0 && tank.stunTimer <= 0;
  },

  /** Aturdimiento propio (no acumulable): la onda y la zona lo usan. */
  _applyStun(state, v, duration) {
    if (!v.isAlive || v.stunTimer > 0 || v.freezeTimer > 0) return false;
    v.stunTimer = duration;
    v.speed = 0;
    v.angularVelocity = 0;
    if (this.isPride(v)) this.interrupt(state, v);
    return true;
  },

  /** ¿Está libre el punto (x,y) para empujar un tanque hasta ahí? */
  _spotFree(state, tank, x, y) {
    if (state.map.isSolidAt(x, y)) return false;
    const R = CONFIG.TANK.RADIUS;
    for (const o of state.tanks.values()) {
      if (o === tank || !o.isAlive) continue;
      if (MathUtil.dist2(x, y, o.x, o.y) < (2 * R) * (2 * R)) return false;
    }
    return true;
  },

  /** Cancela carga y turbo (al morir, aturdirse o congelarse). */
  interrupt(state, tank) {
    if (tank.prCharging) {
      tank.prCharging = false;
      tank.prCharge = 0;
      this._emit(state, 'prChargeCancel', { id: tank.id });
    }
    tank.prBoosting = false;
  },

  initTank(tank) {
    tank.prEnergy = CONFIG.PRIDE.energy.max;
    tank.prCharging = false;
    tank.prCharge = 0;
    tank.prChargeCd = 0;
    tank.prWaveCd = 0;
    tank.prShieldCd = 0;
    tank.prZoneCd = 0;
    tank.prShieldT = 0;
    tank.prShieldHits = 0;
    tank.prBoosting = false;
    tank.prSlowT = 0;
    tank.prSilenceT = 0;
    tank._pack = { aj: 0, aq: 0, af: 0, pd: 0, pu: 0 };
    tank._prBoostLock = false;
    tank._prShieldWas = false;
  },

  resetTank(tank) {
    tank.prCharging = false;
    tank.prCharge = 0;
    tank.prBoosting = false;
    tank.prShieldT = 0;
    tank.prShieldHits = 0;
    tank.prSlowT = 0;
    tank.prSilenceT = 0;
    tank._prBoostLock = false;
    tank._prShieldWas = false;
  },

  /** Temporizadores, energía y escudo (se llama cada tick para tanques PRIDE). */
  tick(state, tank, dt) {
    const P = CONFIG.PRIDE;
    if (tank.prChargeCd > 0) tank.prChargeCd = Math.max(0, tank.prChargeCd - dt);
    if (tank.prWaveCd > 0) tank.prWaveCd = Math.max(0, tank.prWaveCd - dt);
    if (tank.prShieldCd > 0) tank.prShieldCd = Math.max(0, tank.prShieldCd - dt);
    if (tank.prZoneCd > 0) tank.prZoneCd = Math.max(0, tank.prZoneCd - dt);
    if (tank.prSlowT > 0) tank.prSlowT = Math.max(0, tank.prSlowT - dt);
    if (tank.prSilenceT > 0) tank.prSilenceT = Math.max(0, tank.prSilenceT - dt);
    if (!tank.prBoosting) {
      tank.prEnergy = Math.min(P.energy.max, tank.prEnergy + P.energy.regeneration * dt);
    }
    if (tank.prShieldT > 0) {
      tank.prShieldT = Math.max(0, tank.prShieldT - dt);
      if (tank.prShieldT <= 0 && tank.prShieldHits > 0) {
        // El escudo termina por tiempo con impactos restantes.
        this._emit(state, 'prShieldEnd', { id: tank.id, x: MathUtil.round(tank.x), y: MathUtil.round(tank.y) });
      }
      if (tank.prShieldT <= 0) tank.prShieldHits = 0;
    }
    tank._prShieldWas = tank.prShieldT > 0;
  },

  /** Los tanques que no son PRIDE también "consumen" sus contadores. */
  absorb(tank, input) {
    if (!input) return;
    const c = tank._pack || (tank._pack = { aj: 0, aq: 0, af: 0, pd: 0, pu: 0 });
    c.aj = input.aj | 0; c.aq = input.aq | 0; c.af = input.af | 0;
    c.pd = input.pd | 0; c.pu = input.pu | 0;
  },

  /** Lógica de entrada de PRIDE (antes de mover el tanque). */
  preUpdate(state, tank, input, dt) {
    const P = CONFIG.PRIDE;
    const c = tank._pack || (tank._pack = { aj: 0, aq: 0, af: 0, pd: 0, pu: 0 });
    const pressed = (key) => {
      const v = input[key] | 0;
      const hit = v > (c[key] | 0);
      if (v > (c[key] | 0)) c[key] = v;
      return hit;
    };
    const qPress = pressed('aq'), ePress = pressed('aj'), fPress = pressed('af');
    const pdPress = pressed('pd'), puPress = pressed('pu');

    if (!this._canAct(tank)) {
      this.interrupt(state, tank);
      return;
    }

    // --- Turbo (Shift mantenido) ---
    const boostHeld = !!input.ab;
    if (tank.prBoosting) {
      if (!boostHeld) {
        tank.prBoosting = false;
        this._emit(state, 'prBoostEnd', { id: tank.id });
      } else {
        tank.prEnergy -= P.rainbowBoost.energyDrainPerSecond * dt;
        if (tank.prEnergy <= 0) {
          tank.prEnergy = 0;
          tank.prBoosting = false;
          tank._prBoostLock = true; // no se reactiva hasta soltar Shift
          this._emit(state, 'prBoostEnd', { id: tank.id });
        }
      }
    } else if (boostHeld && !tank._prBoostLock && tank.prEnergy >= P.rainbowBoost.minEnergyToStart) {
      tank.prBoosting = true;
      this._emit(state, 'prBoostStart', { id: tank.id });
    }
    if (!boostHeld) tank._prBoostLock = false;

    // --- Onda del Orgullo (Q) ---
    if (qPress && tank.prWaveCd <= 0 && tank.prEnergy >= P.prideWave.energyCost) {
      this.wave(state, tank);
    }
    // --- Escudo Arcoíris (E) ---
    if (ePress && tank.prShieldCd <= 0 && tank.prEnergy >= P.rainbowShield.energyCost) {
      this.shield(state, tank);
    }
    // --- La Zona de Gemidos (F) ---
    if (fPress && tank.prZoneCd <= 0) {
      if (tank.prEnergy >= P.sonicZone.energyCost) {
        this.zone(state, tank, input.nx, input.ny);
      } else {
        this._emit(state, 'prNoEnergy', { id: tank.id });
      }
    }

    // --- Rayo del Orgullo (clic derecho mantenido / soltado) ---
    const C = P.chargedShot;
    if (pdPress && !tank.prCharging && tank.prChargeCd <= 0) {
      const need = C.energyCost * C.minEnergyFraction;
      if (tank.prEnergy >= need) {
        tank.prCharging = true;
        tank.prCharge = 0;
        this._emit(state, 'prChargeStart', { id: tank.id });
      } else {
        this._emit(state, 'prNoEnergy', { id: tank.id });
      }
    }
    if (tank.prCharging) {
      if (input.ph) {
        const was = tank.prCharge;
        tank.prCharge = Math.min(C.maxChargeTime, tank.prCharge + dt);
        if (was < C.maxChargeTime && tank.prCharge >= C.maxChargeTime) {
          this._emit(state, 'prChargeFull', { id: tank.id });
        }
      } else if (puPress || !input.ph) {
        // Soltar (o dejar de mantener) dispara.
        this.fireCharged(state, tank);
      }
    }
  },

  postUpdate(state, tank, dt) {
    // El fin del escudo se emite en tick(); aquí no hay nada extra.
  },

  /** Cañón de energía cromática: proyectil prism que rebota como bala normal. */
  fireNormal(state, tank) {
    const P = CONFIG.PRIDE;
    if (tank.fireCooldown > 0) return false;
    if (tank.prSilenceT > 0) return false;
    const muzzle = tank.getMuzzlePosition();
    if (state.map.isSolidAt(muzzle.x, muzzle.y)) return false;
    const b = new Bullet({
      id: state._nextBulletId++,
      ownerId: tank.id,
      x: muzzle.x, y: muzzle.y,
      angle: tank.turretAngle,
      bounces: tank.maxBounces,
      kind: 'prism',
      speed: P.primaryWeapon.speed,
      radius: P.primaryWeapon.radius,
    });
    state.bullets.set(b.id, b);
    tank.fireCooldown = P.primaryWeapon.cooldown;
    this._emit(state, 'prShot', { ownerId: tank.id, x: muzzle.x, y: muzzle.y, angle: tank.turretAngle });
    return true;
  },

  /** Dispara el Rayo del Orgullo cargado (proyectil pcharge que explota). */
  fireCharged(state, tank) {
    const P = CONFIG.PRIDE, C = P.chargedShot;
    if (!tank.prCharging) return false;
    const frac = MathUtil.clamp(tank.prCharge / C.maxChargeTime, 0, 1);
    const cost = Math.min(tank.prEnergy, C.energyCost * Math.max(C.minEnergyFraction, frac));
    tank.prEnergy -= cost;
    tank.prCharging = false;
    tank.prCharge = 0;
    tank.prChargeCd = C.cooldown;
    const muzzle = tank.getMuzzlePosition();
    const r = MathUtil.lerp(C.minRadius, C.maxRadius, frac);
    const b = new Bullet({
      id: state._nextBulletId++,
      ownerId: tank.id,
      x: muzzle.x, y: muzzle.y,
      angle: tank.turretAngle,
      bounces: 0,
      kind: 'pcharge',
      prFrac: frac,
      speed: C.speed,
      radius: r,
    });
    state.bullets.set(b.id, b);
    this._emit(state, 'prChargedShot', { ownerId: tank.id, x: muzzle.x, y: muzzle.y, angle: tank.turretAngle, frac });
    return true;
  },

  /**
   * Explosión del Rayo del Orgullo (un solo impacto: mata a los tanques en el
   * radio; a carga completa rompe bloques destructibles).
   */
  explodeCharged(state, b, directVictim) {
    if (!b || b._prExploded) return;
    b._prExploded = true;
    const P = CONFIG.PRIDE, C = P.chargedShot;
    const frac = b.prFrac || 0;
    const R = C.blastRadius * (0.5 + 0.5 * frac);
    const blocks = [];
    // Bloques destructibles a carga completa.
    if (C.breakableBlast && frac >= 0.95) {
      const ts = CONFIG.TILE_SIZE;
      const tx0 = Math.floor((b.x - R) / ts), tx1 = Math.floor((b.x + R) / ts);
      const ty0 = Math.floor((b.y - R) / ts), ty1 = Math.floor((b.y + R) / ts);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const c = state.map.get(tx, ty);
          if (c === TILE.BREAKABLE) {
            const cx = tx * ts + ts / 2, cy = ty * ts + ts / 2;
            if (MathUtil.dist2(b.x, b.y, cx, cy) <= R * R) {
              state.map.destroyTile(tx, ty);
              blocks.push([tx, ty]);
            }
          }
        }
      }
    }
    this._emit(state, 'prBlast', { x: MathUtil.round(b.x), y: MathUtil.round(b.y), frac, blocks, ownerId: b.ownerId });
    // El impacto directo mata a la víctima (si la hay).
    if (directVictim && directVictim.isAlive) {
      state._destroyTank(directVictim, b.ownerId);
    }
    // La explosión mata a los tanques en el radio (sin línea de visión = no).
    for (const v of state.tanks.values()) {
      if (!v.isAlive || v.id === b.ownerId) continue;
      if (MathUtil.dist2(b.x, b.y, v.x, v.y) > R * R) continue;
      if (!state.map.hasLineOfSight(b.x, b.y, v.x, v.y)) continue;
      state._destroyTank(v, b.ownerId);
    }
  },

  /** Onda del Orgullo (Q): empuja, aturde 0.5 s y desvía proyectiles. */
  wave(state, tank) {
    const W = CONFIG.PRIDE.prideWave;
    tank.prEnergy -= W.energyCost;
    tank.prWaveCd = W.cooldown;
    const hits = [];
    // Empuje + aturdimiento (sin daño: juego de un solo impacto).
    for (const v of state.tanks.values()) {
      if (!v.isAlive || v === tank) continue;
      const dx = v.x - tank.x, dy = v.y - tank.y;
      const d = Math.hypot(dx, dy);
      if (d > W.radius + CONFIG.TANK.RADIUS) continue;
      if (!state.map.hasLineOfSight(tank.x, tank.y, v.x, v.y)) continue;
      hits.push(v.id);
      // Empuje en 8 pasos (con comprobación de hueco libre).
      const ux = d > 0.01 ? dx / d : 1, uy = d > 0.01 ? dy / d : 0;
      const step = W.push / 8;
      for (let i = 0; i < 8; i++) {
        const nx = v.x + ux * step, ny = v.y + uy * step;
        if (!this._spotFree(state, v, nx, ny)) break;
        v.x = nx; v.y = ny;
      }
      state.map.resolveCircle(v, CONFIG.TANK.RADIUS);
      this._applyStun(state, v, W.interruptDuration);
    }
    // Desvía proyectiles enemigos (todos menos el propio Rayo).
    for (const b of state.bullets.values()) {
      if (!b.alive || b.ownerId === tank.id || b.kind === 'pcharge') continue;
      const dx = b.x - tank.x, dy = b.y - tank.y;
      const d = Math.hypot(dx, dy);
      if (d > W.radius + b.radius) continue;
      if (!state.map.hasLineOfSight(tank.x, tank.y, b.x, b.y)) continue;
      const ux = d > 0.01 ? dx / d : 1, uy = d > 0.01 ? dy / d : 0;
      const sp = Math.max(60, Math.hypot(b.vx, b.vy));
      b.vx = ux * sp; b.vy = uy * sp;
      b.ownerId = tank.id;
      b.bouncesLeft = tank.maxBounces;
      b.ownerSafe = true;
    }
    this._emit(state, 'prWave', { id: tank.id, x: MathUtil.round(tank.x), y: MathUtil.round(tank.y), hits });
  },

  /** Escudo Arcoíris (E): absorbe impactos durante 4 s. */
  shield(state, tank) {
    const S = CONFIG.PRIDE.rainbowShield;
    tank.prEnergy -= S.energyCost;
    tank.prShieldCd = S.cooldown;
    tank.prShieldT = S.duration;
    tank.prShieldHits = S.maxHits;
    tank._prShieldWas = true;
    this._emit(state, 'prShieldOn', { id: tank.id, x: MathUtil.round(tank.x), y: MathUtil.round(tank.y) });
  },

  /**
   * El Escudo Arcoíris absorbe un impacto (la bala se destruye).
   * Devuelve true si absorbió. Se rompe tras absorber maxHits impactos.
   */
  absorbHit(state, tank) {
    if (tank.prShieldT <= 0 || tank.prShieldHits <= 0) return false;
    tank.prShieldHits--;
    if (tank.prShieldHits <= 0) {
      tank.prShieldT = 0;
      tank.prShieldHits = 0;
      tank._prShieldWas = false;
      this._emit(state, 'prShieldBreak', { id: tank.id, x: MathUtil.round(tank.x), y: MathUtil.round(tank.y) });
    } else {
      this._emit(state, 'prShieldHit', { id: tank.id, x: MathUtil.round(tank.x), y: MathUtil.round(tank.y) });
    }
    return true;
  },

  /** Valida el punto de la zona (alcance, dentro del mapa, fuera de muros). */
  zoneSpot(state, tank, nx, ny) {
    const Z = CONFIG.PRIDE.sonicZone;
    const map = state.map;
    let x = nx, y = ny;
    if (!isFinite(x) || !isFinite(y)) { x = tank.x; y = tank.y; }
    const dx = x - tank.x, dy = y - tank.y;
    const d = Math.hypot(dx, dy);
    if (d > Z.range) {
      const k = Z.range / d;
      x = tank.x + dx * k; y = tank.y + dy * k;
    }
    x = MathUtil.clamp(x, 20, map.width - 20);
    y = MathUtil.clamp(y, 20, map.height - 20);
    if (map.isSolidAt(x, y)) {
      const tx = Math.floor(x / map.tileSize), ty = Math.floor(y / map.tileSize);
      const free = map.findNearestFreeTile(tx, ty);
      const c = map.tileCenter(free.tx, free.ty);
      x = c.x; y = c.y;
    }
    return { x, y };
  },

  /** Lanza La Zona de Gemidos (F). */
  zone(state, tank, nx, ny) {
    const Z = CONFIG.PRIDE.sonicZone;
    tank.prEnergy -= Z.energyCost;
    tank.prZoneCd = Z.cooldown;
    const spot = this.zoneSpot(state, tank, nx, ny);
    if (!state.prZones) { state.prZones = []; state._prZoneId = 0; }
    const z = {
      id: ++state._prZoneId, ownerId: tank.id,
      x: spot.x, y: spot.y, sx: spot.x, sy: spot.y,
      age: 0, active: false, hit: new Set(), pulseT: 0,
    };
    state.prZones.push(z);
    this._emit(state, 'prZoneCast', { id: tank.id, x: MathUtil.round(z.x), y: MathUtil.round(z.y), zoneId: z.id });
    return z;
  },

  /** Actualiza las zonas activas (advertencia, pulsos de silencio, fin). */
  updateZones(state, dt) {
    if (!state.prZones || !state.prZones.length) return;
    const Z = CONFIG.PRIDE.sonicZone;
    for (let i = state.prZones.length - 1; i >= 0; i--) {
      const z = state.prZones[i];
      z.age += dt;
      if (!z.active) {
        if (z.age >= Z.warningTime) {
          z.active = true;
          z.pulseT = 0;
          // Aturdimiento inicial (una vez por activación).
          for (const v of state.tanks.values()) {
            if (!v.isAlive || v.id === z.ownerId) continue;
            if (MathUtil.dist2(z.x, z.y, v.x, v.y) <= Z.radius * Z.radius) {
              this._applyStun(state, v, Z.stunDuration);
            }
          }
          this._emit(state, 'prZoneOn', { x: MathUtil.round(z.x), y: MathUtil.round(z.y), zoneId: z.id });
        }
        continue;
      }
      // Pulsos: ralentización + silencio (sin daño: un solo impacto).
      z.pulseT -= dt;
      if (z.pulseT <= 0) {
        z.pulseT += Z.pulseInterval;
        const affected = [];
        for (const v of state.tanks.values()) {
          if (!v.isAlive || v.id === z.ownerId) continue;
          if (MathUtil.dist2(z.x, z.y, v.x, v.y) > Z.radius * Z.radius) continue;
          v.prSlowT = Math.max(v.prSlowT || 0, 0.12);
          v.prSilenceT = Math.max(v.prSilenceT || 0, Z.fireInterrupt);
          affected.push(v.id);
        }
        if (affected.length) {
          this._emit(state, 'prZonePulse', { x: MathUtil.round(z.x), y: MathUtil.round(z.y), zoneId: z.id, hit: affected });
        }
      }
      if (z.age >= Z.warningTime + Z.duration) {
        state.prZones.splice(i, 1);
        this._emit(state, 'prZoneOff', { x: MathUtil.round(z.x), y: MathUtil.round(z.y), zoneId: z.id });
      }
    }
  },

  /** Celebración AMO A SAMARIEMM si gana PRIDE. */
  onRoundEnd(state, winner) {
    if (!winner || !this.isPride(winner)) return;
    this._emit(state, 'samariemm', { id: winner.id, round: state.round.number });
  },
};

/**
 * ============================================================================
 *  PrideAI — bots que usan PRIDE OVERLORD (adaptado a Angel's AIController).
 * ============================================================================
 *  decide(state, me, out, dt): rellena los campos pride del input del bot
 *  (contadores aq/aj/af/pd/pu, ph, ab, nx, ny). El host los procesa igual
 *  que los de un jugador humano.
 * ============================================================================
 */
const PrideAI = {
  /**
   * decide(ai, state, me, target, dist, out, dt): rellena los campos pride
   * del input del bot. Los contadores viven en el CONTROLADOR (ai.pr), no en
   * el tanque: el anfitrión los compara con tank._pack para detectar pulsaciones.
   */
  decide(ai, state, me, target, dist, out, dt) {
    const P = CONFIG.PRIDE, Z = P.sonicZone, R = CONFIG.TANK.RADIUS;
    const c = ai.pr = ai.pr || { aj: 0, aq: 0, af: 0, pd: 0, pu: 0, hold: 0, boostT: 0, think: 0 };
    const E = me.prEnergy;
    const enemies = [...state.tanks.values()].filter((o) => o.isAlive && o.id !== me.id);
    // Amenazas: proyectiles que vienen hacia mí.
    let threat = 0;
    for (const b of state.bullets.values()) {
      if (b.ownerId === me.id) continue;
      const dx = me.x - b.x, dy = me.y - b.y, d = Math.hypot(dx, dy);
      if (d < 150 && b.vx * dx + b.vy * dy > 0) threat++;
    }
    c.think -= dt;
    const decideNow = c.think <= 0;
    if (decideNow) c.think = 0.2;
    // La Zona de Gemidos: el punto que afecte a más enemigos.
    const zoneReady = me.prZoneCd <= 0;
    if (zoneReady && decideNow && E >= Z.energyCost) {
      let best = null, bn = 0;
      for (const o of enemies) {
        if (Math.hypot(o.x - me.x, o.y - me.y) > Z.range + Z.radius * 0.5) continue;
        const n = enemies.filter((q) => Math.hypot(q.x - o.x, q.y - o.y) < Z.radius).length;
        if (n > bn) { bn = n; best = o; }
      }
      if (best && (bn >= 2 || Math.random() < 0.25)) { c.af++; out.nx = Math.round(best.x); out.ny = Math.round(best.y); }
    }
    const reserve = zoneReady ? Z.energyCost : 0;
    // Escudo ante amenazas.
    if (decideNow && me.prShieldCd <= 0 && me.prShieldT <= 0 && E - P.rainbowShield.energyCost >= reserve * 0.5 && threat >= 1) c.aj++;
    // Onda si está rodeado o un enemigo está encima.
    const near = enemies.filter((o) => Math.hypot(o.x - me.x, o.y - me.y) < P.prideWave.radius + R).length;
    if (decideNow && me.prWaveCd <= 0 && E - P.prideWave.energyCost >= reserve * 0.5 && (near >= 2 || (near >= 1 && Math.random() < 0.5) || threat >= 2)) c.aq++;
    // Disparo cargado cuando hay oportunidad (alineado, con visión y a media distancia).
    if (c.hold > 0) {
      c.hold -= dt;
      out.ph = 1;
      if (c.hold <= 0 || !target) { out.ph = 0; c.pu++; c.hold = 0; }
    } else if (decideNow && target && out.aligned && me.prChargeCd <= 0 && !me.prCharging && dist > 120 && dist < 480 &&
      E - P.chargedShot.energyCost >= reserve * 0.5 && state.map.hasLineOfSight(me.x, me.y, target.x, target.y)) {
      c.pd++; c.hold = MathUtil.randRange(0.7, P.chargedShot.maxChargeTime); out.ph = 1;
    } else out.ph = 0;
    // Turbo: escapar bajo amenaza o perseguir de lejos.
    if (c.boostT > 0) c.boostT -= dt;
    else if (decideNow && E > 45 && ((threat >= 1 && target && dist < 220) || (target && dist > 360))) c.boostT = MathUtil.randRange(0.6, 1.2);
    out.ab = c.boostT > 0 && E > 8 && Math.abs(out.throttle) > 0.2 ? 1 : 0;
    out.aj = c.aj; out.aq = c.aq; out.af = c.af; out.pd = c.pd; out.pu = c.pu;
    if (!Number.isFinite(out.nx)) { out.nx = Math.round(target ? target.x : me.x); out.ny = Math.round(target ? target.y : me.y); }
    return out;
  },
};
/**
 * ============================================================================
 *  PrideArt — dibujo del tanque, proyectiles, zona y celebración.
 * ============================================================================
 *  Todo en Canvas 2D (sin imágenes externas salvo la foto de la celebración,
 *  que se carga una sola vez desde CONFIG.PRIDE.portrait).
 * ============================================================================
 */
const PrideArt = {
  FLAG: ['#e40303', '#ff8c00', '#ffed00', '#008026', '#24408e', '#732982'],

  hue(h, s, l) {
    return `hsl(${((h % 360) + 360) % 360},${s}%,${l}%)`;
  },

  _photo: null,
  _photoReady: false,
  _photoCrop: null,

  load(base) {
    const src = (base || '') + ((typeof CONFIG !== 'undefined' && CONFIG.PRIDE) ? CONFIG.PRIDE.portrait : 'assets/tanks/pride/samariemm.webp');
    try {
      const img = new Image();
      img.onload = () => { this._photo = img; this._photoReady = true; };
      img.onerror = () => { this._photoReady = false; };
      img.src = src;
    } catch (e) { /* sin foto: la celebración sigue sin retrato */ }
  },

  _cropPhoto() {
    if (!this._photo || !this._photoReady) return null;
    if (this._photoCrop) return this._photoCrop;
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');
    const s = Math.min(this._photo.width, this._photo.height);
    const sx = (this._photo.width - s) / 2, sy = (this._photo.height - s) / 2;
    g.save();
    g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.clip();
    g.drawImage(this._photo, sx, sy, s, s, 0, 0, S, S);
    g.restore();
    this._photoCrop = cv;
    return cv;
  },

  heart(ctx, x, y, s, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s / 16, s / 16);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 5);
    ctx.bezierCurveTo(-9, -3, -6, -11, 0, -6);
    ctx.bezierCurveTo(6, -11, 9, -3, 0, 5);
    ctx.fill();
    ctx.restore();
  },

  _hullSprite: null,

  _getHullSprite() {
    if (this._hullSprite) return this._hullSprite;
    const S = 4, W = 58 * S, H = 50 * S;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.scale(S, S);
    g.translate(29, 25);
    // Casco negro brillante con franjas arcoíris.
    const grad = g.createLinearGradient(-16, -13, 16, 13);
    grad.addColorStop(0, '#3a3a44');
    grad.addColorStop(0.5, '#14141c');
    grad.addColorStop(1, '#2c2c38');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-16, -11); g.lineTo(12, -11); g.lineTo(17, -6); g.lineTo(17, 6); g.lineTo(12, 11); g.lineTo(-16, 11); g.lineTo(-18, 0);
    g.closePath(); g.fill();
    // Franjas arcoíris.
    for (let i = 0; i < 6; i++) {
      g.fillStyle = this.FLAG[i];
      g.globalAlpha = 0.85;
      g.fillRect(-15 + i * 5.2, -10.4, 2.2, 20.8);
    }
    g.globalAlpha = 1;
    // Placas iridiscentes.
    g.strokeStyle = 'rgba(200,220,255,0.5)';
    g.lineWidth = 0.8;
    g.strokeRect(-13, -8, 10, 6);
    g.strokeRect(4, 2, 10, 6);
    this._hullSprite = cv;
    return cv;
  },

  drawShadow(ctx, x, y) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x + 3, y + 5, 26, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  drawTracks(ctx, x, y, chassis, phase, time) {
    const T = CONFIG.TANK;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(chassis);
    const off = ((phase % 8) + 8) % 8;
    for (const side of [-1, 1]) {
      const ty = side * (T.BODY_WIDTH / 2 + 3);
      // Oruga negra.
      ctx.fillStyle = '#101016';
      ctx.beginPath();
      ctx.roundRect(-18, ty - 5, 36, 10, 4);
      ctx.fill();
      // Eslabones animados.
      ctx.fillStyle = '#2c2c38';
      for (let i = -2; i < 3; i++) {
        const px = i * 8 - off;
        ctx.fillRect(px - 2.5, ty - 4, 5, 8);
      }
      // Borde RGB.
      ctx.strokeStyle = this.hue(time * 120 + side * 60, 100, 60);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-18, ty - 5, 36, 10, 4);
      ctx.stroke();
      // Ruedas con aro RGB.
      for (const wx of [-12, 0, 12]) {
        ctx.fillStyle = '#1a1a22';
        ctx.beginPath(); ctx.arc(wx, ty, 3.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = this.hue(time * 120 + wx * 10, 100, 65);
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(wx, ty, 3.4, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  },

  drawBody(ctx, x, y, chassis, time) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(chassis);
    // Borde RGB del casco.
    ctx.strokeStyle = this.hue(time * 90, 100, 62);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-16, -11); ctx.lineTo(12, -11); ctx.lineTo(17, -6); ctx.lineTo(17, 6); ctx.lineTo(12, 11); ctx.lineTo(-16, 11); ctx.lineTo(-18, 0);
    ctx.closePath(); ctx.stroke();
    // Franja del jugador.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-14, -1.2, 26, 2.4);
    ctx.restore();
  },

  drawSpeakers(ctx, x, y, chassis, vib, time) {
    const T = CONFIG.TANK;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(chassis);
    const amp = 1 + vib * 0.35;
    for (const [sx, sy] of [[-14, -14], [14, -14], [-14, 14], [14, 14]]) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(amp, amp);
      ctx.fillStyle = '#14141c';
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = this.hue(time * 150 + sx * 7 + sy * 11, 100, 62);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#2c2c38';
      ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  },

  drawTurret(ctx, x, y, turret, opts) {
    const o = opts || {};
    const recoil = o.recoil || 0, muzzle = o.muzzle || 0, charge = o.charge || 0;
    const time = o.time || 0, speakerVib = o.speakerVib || 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turret);
    // Cañón con anillos de carga.
    const barrelLen = 22 - recoil * 4;
    ctx.fillStyle = '#1a1a22';
    ctx.fillRect(4, -3.4, barrelLen, 6.8);
    ctx.strokeStyle = '#d8dde6';
    ctx.lineWidth = 1;
    ctx.strokeRect(4, -3.4, barrelLen, 6.8);
    // Anillos de energía (se encienden con la carga).
    for (let i = 0; i < 3; i++) {
      const ax = 8 + i * 6;
      const on = charge > (i + 0.5) / 3;
      ctx.strokeStyle = on ? this.hue(time * 200 + i * 40, 100, 65) : 'rgba(120,130,150,0.5)';
      ctx.lineWidth = on ? 2.2 : 1.2;
      ctx.beginPath(); ctx.arc(ax, 0, 4.6, 0, Math.PI * 2); ctx.stroke();
    }
    // Boca del cañón con brillo al disparar.
    if (muzzle > 0) {
      const g = ctx.createRadialGradient(4 + barrelLen, 0, 0, 4 + barrelLen, 0, 10 * muzzle + 4);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * muzzle})`);
      g.addColorStop(0.4, `rgba(255,120,230,${0.7 * muzzle})`);
      g.addColorStop(1, 'rgba(255,120,230,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(4 + barrelLen, 0, 10 * muzzle + 4, 0, Math.PI * 2); ctx.fill();
    }
    // Bocinas sónicas a los lados de la torreta.
    const vibAmp = 1 + speakerVib * 0.3;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(2, side * 9);
      ctx.scale(vibAmp, vibAmp);
      ctx.fillStyle = '#14141c';
      ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = this.hue(time * 160 + side * 90, 100, 62);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#2c2c38';
      ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // Torreta facetada cromada.
    const tg = ctx.createLinearGradient(-8, -8, 8, 8);
    tg.addColorStop(0, '#e8ecf4');
    tg.addColorStop(0.5, '#9aa3b5');
    tg.addColorStop(1, '#5a6274');
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.moveTo(8, 0); ctx.lineTo(3, -7); ctx.lineTo(-7, -7); ctx.lineTo(-9, 0); ctx.lineTo(-7, 7); ctx.lineTo(3, 7);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(20,22,30,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Bobinas de energía.
    for (const bx of [-4, 0, 4]) {
      ctx.strokeStyle = this.hue(time * 130 + bx * 30, 100, 60);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(bx, -6.5); ctx.lineTo(bx + 2, -3); ctx.lineTo(bx - 1, 0); ctx.lineTo(bx + 2, 3); ctx.lineTo(bx, 6.5);
      ctx.stroke();
    }
    // Núcleo de corazón brillante.
    const pulse = 0.75 + 0.25 * Math.sin(time * 6);
    ctx.save();
    ctx.shadowColor = '#ff4fa8';
    ctx.shadowBlur = 10 * pulse;
    this.heart(ctx, 0, 0, 9 * pulse, '#ff4fa8');
    ctx.restore();
    // Antenas con luces RGB.
    for (const side of [-1, 1]) {
      ctx.strokeStyle = '#8a93a6';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-6, side * 5);
      ctx.lineTo(-11, side * 11);
      ctx.stroke();
      ctx.fillStyle = this.hue(time * 180 + side * 120, 100, 65);
      ctx.beginPath(); ctx.arc(-11, side * 11, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },

  drawPhoto(ctx, x, y, r, time) {
    const crop = this._cropPhoto();
    if (!crop) return;
    ctx.save();
    ctx.translate(x, y);
    // Marco arcoíris giratorio.
    ctx.strokeStyle = this.hue(time * 120, 100, 62);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, r + 2, 0, Math.PI * 2); ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(crop, -r, -r, r * 2, r * 2);
    ctx.restore();
    ctx.restore();
  },

  drawShield(ctx, x, y, k, frac, time) {
    if (k <= 0.01) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.55 * k;
    // Burbuja hexagonal translúcida.
    ctx.strokeStyle = this.hue(time * 140, 100, 68);
    ctx.lineWidth = 2.4 * k + 0.6;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + time * 0.6;
      const px = Math.cos(a) * 26, py = Math.sin(a) * 26;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.stroke();
    // Grietas cuando el escudo está débil.
    if (frac < 0.35) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(10, -14); ctx.lineTo(16, -6); ctx.lineTo(12, 2); ctx.lineTo(18, 10);
      ctx.moveTo(-14, 8); ctx.lineTo(-8, 14); ctx.lineTo(-14, 20);
      ctx.stroke();
    }
    // Anillos de impacto.
    ctx.restore();
  },

  drawChargeRing(ctx, x, y, charge, time) {
    if (charge <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    const R = 30;
    for (let i = 0; i < 18; i++) {
      const a0 = (i / 18) * Math.PI * 2;
      const a1 = ((i + 0.7) / 18) * Math.PI * 2;
      const on = (i / 18) <= charge;
      ctx.strokeStyle = on ? this.hue(time * 200 + i * 20, 100, 62) : 'rgba(120,130,150,0.35)';
      ctx.lineWidth = on ? 3 : 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, R, a0, a1);
      ctx.stroke();
    }
    ctx.restore();
  },

  /** Dibuja el tanque completo (capas 1–12 del diseño). */
  drawTank(ctx, o) {
    const x = o.x, y = o.y, chassis = o.chassis, turret = o.turret;
    const time = o.time || 0, phase = o.phase || 0;
    const charge = o.charge || 0, boost = o.boost || 0;
    const shieldK = o.shieldK || 0, shieldFrac = o.shieldFrac != null ? o.shieldFrac : 1;
    const hitFx = o.hitFx || 0;
    this.drawShadow(ctx, x, y);
    this.drawTracks(ctx, x, y, chassis, phase, time);
    // Casco (sprite cacheado).
    const spr = this._getHullSprite();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(chassis);
    ctx.drawImage(spr, -29, -25, 58, 50);
    ctx.restore();
    this.drawBody(ctx, x, y, chassis, time);
    this.drawSpeakers(ctx, x, y, chassis, o.speakerVib || 0, time);
    this.drawTurret(ctx, x, y, turret, {
      recoil: o.recoil || 0, muzzle: o.muzzle || 0, charge, time,
      speakerVib: o.speakerVib || 0,
    });
    // Marco holográfico con la foto sobre la torreta.
    this.drawPhoto(ctx, x, y, 9, time);
    // Escudo arcoíris.
    if (shieldK > 0.01) this.drawShield(ctx, x, y, shieldK, shieldFrac, time);
    // Anillo de carga.
    if (charge > 0) this.drawChargeRing(ctx, x, y, charge, time);
    // Destello de impacto.
    if (hitFx > 0) {
      ctx.save();
      ctx.globalAlpha = hitFx * 0.7;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 20 + (1 - hitFx) * 8, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    void boost;
  },

  /** Proyectil prism (energía cromática). */
  drawPrism(ctx, x, y, angle, time, id) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const seed = ((id || 0) * 37) % 360;
    // Estela arcoíris.
    ctx.strokeStyle = this.hue(time * 300 + seed, 100, 60);
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(0, 0); ctx.stroke();
    ctx.globalAlpha = 1;
    // Núcleo brillante.
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 6);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, this.hue(time * 300 + seed, 100, 65));
    g.addColorStop(1, 'rgba(255,120,230,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },

  /** Proyectil pcharge (Rayo del Orgullo). */
  drawPlasma(ctx, x, y, angle, time, radius, frac) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const r = radius || 6;
    // Estela de plasma.
    ctx.strokeStyle = this.hue(time * 240, 100, 62);
    ctx.lineWidth = r * 0.9;
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(-r * 2.2, 0); ctx.lineTo(0, 0); ctx.stroke();
    ctx.globalAlpha = 1;
    // Núcleo.
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, this.hue(time * 240, 100, 66));
    g.addColorStop(1, 'rgba(255,120,230,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    // Anillo de carga.
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(0, 0, r + 2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  },

  /** Advertencia de la zona (círculo punteado + dispositivo volador). */
  drawZoneWarning(ctx, z, time, k) {
    ctx.save();
    ctx.translate(z.x, z.y);
    ctx.strokeStyle = this.hue(time * 160, 100, 62);
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.arc(0, 0, CONFIG.PRIDE.sonicZone.radius * (0.6 + 0.4 * k), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // Dispositivo volador que desciende.
    const dy = -40 + 30 * k;
    ctx.fillStyle = '#1a1a22';
    ctx.beginPath(); ctx.arc(0, dy, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#d8dde6';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, dy, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = this.hue(time * 200, 100, 65);
    ctx.beginPath(); ctx.arc(0, dy, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },

  /** Zona activa (pista de baile holográfica). */
  drawZone(ctx, z, time, age, duration, reducedFx) {
    const Z = CONFIG.PRIDE.sonicZone;
    const R = Z.radius;
    ctx.save();
    ctx.translate(z.x, z.y);
    // Suelo translúcido.
    ctx.fillStyle = 'rgba(120,40,160,0.18)';
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    // Rejilla de pista de baile.
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    const step = 22;
    for (let gx = -R; gx <= R; gx += step) {
      ctx.beginPath();
      ctx.moveTo(gx, -Math.sqrt(Math.max(0, R * R - gx * gx)));
      ctx.lineTo(gx, Math.sqrt(Math.max(0, R * R - gx * gx)));
      ctx.stroke();
    }
    for (let gy = -R; gy <= R; gy += step) {
      ctx.beginPath();
      ctx.moveTo(-Math.sqrt(Math.max(0, R * R - gy * gy)), gy);
      ctx.lineTo(Math.sqrt(Math.max(0, R * R - gy * gy)), gy);
      ctx.stroke();
    }
    // Anillos de sonido.
    const pulses = 3;
    for (let i = 0; i < pulses; i++) {
      const k = ((time * 1.2 + i / pulses) % 1);
      ctx.strokeStyle = this.hue(time * 140 + i * 60, 100, 62);
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, 0, R * k, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Ecualizadores en el perímetro.
    if (!reducedFx) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + time * 0.4;
        const h = 4 + 8 * Math.abs(Math.sin(time * 6 + i * 1.7));
        const px = Math.cos(a) * (R - 4), py = Math.sin(a) * (R - 4);
        ctx.fillStyle = this.hue(time * 200 + i * 30, 100, 62);
        ctx.fillRect(px - 2, py - h / 2, 4, h);
      }
    }
    // Bocinas perimetrales.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const px = Math.cos(a) * (R - 8), py = Math.sin(a) * (R - 8);
      ctx.fillStyle = '#14141c';
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = this.hue(time * 170 + i * 90, 100, 62);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke();
    }
    // Corazones, notas y estrellas flotantes.
    if (!reducedFx) {
      for (let i = 0; i < 10; i++) {
        const seed = i * 1.37;
        const fx = Math.cos(seed + time * 0.7) * (R * 0.6);
        const fy = Math.sin(seed * 1.3 + time * 0.5) * (R * 0.6) - 10 * Math.sin(time * 1.5 + seed);
        const kind = i % 3;
        if (kind === 0) this.heart(ctx, fx, fy, 7, this.hue(time * 120 + i * 40, 100, 68));
        else if (kind === 1) {
          ctx.fillStyle = this.hue(time * 150 + i * 50, 100, 70);
          ctx.font = '10px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText('♪', fx, fy);
        } else {
          ctx.fillStyle = this.hue(time * 180 + i * 60, 100, 72);
          ctx.beginPath();
          ctx.arc(fx, fy, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // Borde exterior.
    ctx.strokeStyle = this.hue(time * 120, 100, 60);
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  },

  /** Celebración AMO A SAMARIEMM (confeti, foto, texto arcoíris, banderas). */
  drawCelebration(ctx, W, Hh, age, duration, reducedFx, text) {
    const k = age / duration;
    if (k >= 1) return false;
    ctx.save();
    // Fondo oscuro.
    ctx.fillStyle = `rgba(10,4,20,${0.55 * Math.min(1, k * 4)})`;
    ctx.fillRect(0, 0, W, Hh);
    // Confeti.
    if (!reducedFx) {
      for (let i = 0; i < 60; i++) {
        const seed = i * 2.39;
        const fx = ((seed * 97) % W + age * 30 * (i % 3 - 1)) % W;
        const fy = ((seed * 53) % (Hh + 40) + age * 90 * (0.5 + (i % 5) / 10)) % (Hh + 40) - 20;
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(seed + age * (1 + (i % 3) * 0.5));
        ctx.fillStyle = this.FLAG[i % 6];
        ctx.fillRect(-3, -2, 6, 4);
        ctx.restore();
      }
    }
    // Foto central.
    const crop = this._cropPhoto();
    const cx = W / 2, cy = Hh / 2 - 30;
    const r = 70 * Math.min(1, k * 3);
    if (crop && r > 4) {
      ctx.save();
      ctx.strokeStyle = this.hue(age * 160, 100, 62);
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(crop, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      ctx.restore();
    }
    // Texto arcoíris.
    const label = text || 'AMO A SAMARIEMM';
    ctx.save();
    ctx.translate(cx, cy + r + 46);
    const sc = 1 + 0.08 * Math.sin(age * 6);
    ctx.scale(sc, sc);
    ctx.font = '900 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const g = ctx.createLinearGradient(-tw / 2, 0, tw / 2, 0);
    this.FLAG.forEach((c, i) => g.addColorStop(i / 5, c));
    ctx.lineJoin = 'round';
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#1a0624';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = g;
    ctx.fillText(label, 0, 0);
    this.heart(ctx, -tw / 2 - 22, 0, 10, '#ff4fa8');
    this.heart(ctx, tw / 2 + 22, 0, 10, '#b04fff');
    ctx.restore();
    // Banderas en las esquinas.
    for (const [bx, by, flip] of [[30, 30, 1], [W - 30, 30, -1], [30, Hh - 30, 1], [W - 30, Hh - 30, -1]]) {
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(flip, 1);
      ctx.fillStyle = '#d8dde6';
      ctx.fillRect(-1, -14, 2, 28);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = this.FLAG[i];
        ctx.fillRect(1, -14 + i * 4.6, 16, 4.6);
      }
      ctx.restore();
    }
    ctx.restore();
    return true;
  },

  drawPortrait(ctx, w, h, time) {
    const crop = this._cropPhoto();
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) / 2 - 4;
    ctx.save();
    ctx.strokeStyle = this.hue((time || 0) * 120, 100, 62);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (crop) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r - 2, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(crop, cx - r + 2, cy - r + 2, (r - 2) * 2, (r - 2) * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = '#2a0f36';
      ctx.beginPath(); ctx.arc(cx, cy, r - 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff9ad8';
      ctx.font = '900 14px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🌈', cx, cy);
    }
    ctx.restore();
  },
};

if (typeof window !== 'undefined') {
  window.PrideRules = PrideRules;
  window.PrideAI = PrideAI;
  window.PrideArt = PrideArt;
  window.PRIDE_CONFIG = PRIDE_CONFIG;
}
