'use strict';
/**
 * prideRender.js — Efectos visuales de PRIDE sin foto, texto genérico.
 */
(function() {
  if (typeof Renderer === 'undefined') return;

  Renderer.prototype._prideObserve = function(ev) {
    if (ev.type === 'samariemm') {
      // Dedup por tiempo para evitar doble celebración por red
      const now = performance.now() / 1000;
      if (this._samLastWinTime && (now - this._samLastWinTime) < 1) return;
      this._samLastWinTime = now;
      this.samAge = 0;
      this._samRounds = this._samRounds || new Set();
      this._samRounds.add(ev.round);
    }
    if (ev.type === 'roundStart' && ev.round === 1) {
      this._samLastWinTime = -99;
      this.samAge = -1;
    }
  };

  Renderer.prototype._handlePrideEvent = function(ev) {
    switch (ev.type) {
      case 'prWave':
        for (let i = 0; i < 3; i++) {
          this.rings.push({ x: ev.x, y: ev.y, r: 10 + i * 20, maxR: ev.radius, color: `hsl(${(this.time * 360 + i * 60) % 360},100%,60%)`, width: 3, age: 0, life: 0.5 });
        }
        this.shake = Math.max(this.shake, 5);
        break;
      case 'prBlast':
        for (let i = 0; i < 3; i++) {
          this.rings.push({ x: ev.x, y: ev.y, r: 5, maxR: ev.radius, color: '#ff6ec7', width: 4, age: 0, life: 0.4 });
        }
        for (let i = 0; i < 20; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 50 + Math.random() * 150;
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, `hsl(${Math.random() * 360},100%,60%)`, 0.5, 2);
        }
        this.shake = Math.max(this.shake, 8);
        break;
      case 'prShieldOn':
      case 'prShieldHit':
      case 'prShieldBreak':
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * Math.PI * 2;
          this._particle(ev.x, ev.y, Math.cos(a) * 80, Math.sin(a) * 80, '#ff6ec7', 0.4, 2);
        }
        break;
      case 'prZoneCast':
        this.rings.push({ x: ev.x, y: ev.y, r: 5, maxR: ev.radius, color: '#ff6ec7', width: 2, age: 0, life: ev.warning });
        break;
      case 'prZoneStun':
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2;
          this._particle(ev.x, ev.y, Math.cos(a) * 60, Math.sin(a) * 60, '#ffd700', 0.4, 2);
        }
        break;
    }
  };

  const origHandle = Renderer.prototype.handleEvent;
  Renderer.prototype.handleEvent = function(ev) {
    if (this._prideObserve) this._prideObserve(ev);
    if (this._handlePrideEvent) this._handlePrideEvent(ev);
    return origHandle.call(this, ev);
  };

  Renderer.prototype._drawPride = function(ctx, tank, x, y, ca, ta, dt, view) {
    ctx.save();
    ctx.translate(x, y);
    // Chasis con franjas arcoíris
    ctx.save();
    ctx.rotate(ca);
    const colors = ['#ff0000','#ff7f00','#ffff00','#00ff00','#0000ff','#8b00ff'];
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = colors[i];
      ctx.fillRect(-16 + i * 5.3, -13, 5, 26);
    }
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.strokeRect(-16, -13, 32, 26);
    ctx.restore();
    // Torreta
    ctx.save();
    ctx.rotate(ta);
    const hue = (this.time * 180) % 360;
    ctx.fillStyle = `hsl(${hue},70%,50%)`;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(9, -2, 14, 4);
    ctx.restore();
    // Anillo de carga
    if (tank.prCharging) {
      ctx.strokeStyle = `hsl(${(this.time * 360) % 360},100%,60%)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 16 + tank.prCharge * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Escudo arcoíris
    if (tank.prShieldT > 0) {
      ctx.strokeStyle = `hsla(${(this.time * 360) % 360},100%,65%,0.8)`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  };

  Renderer.prototype._drawPrideGround = function(ctx, dt) {
    if (!this.state || !this.state.prZones || this.state.prZones.length === 0) return;
    for (const z of this.state.prZones) {
      ctx.save();
      ctx.translate(z.x, z.y);
      if (z.t < z.warning) {
        ctx.strokeStyle = 'rgba(255,110,199,0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.arc(0, 0, z.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = 'rgba(255,110,199,0.12)';
        ctx.beginPath();
        ctx.arc(0, 0, z.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,110,199,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, z.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  Renderer.prototype._drawPrideOverlay = function(ctx, dt) {
    if (this.samAge === undefined || this.samAge < 0) return;
    this.samAge += dt || 0;
    const dur = CONFIG.PRIDE.victoryCelebration.duration;
    if (this.samAge > dur) { this.samAge = -1; return; }
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);
    // Confeti arcoíris
    for (let i = 0; i < 40; i++) {
      const hue = (i * 37 + this.time * 200) % 360;
      const cx = (i * 53 % w);
      const cy = ((i * 97 + this.time * 80) % h);
      ctx.fillStyle = `hsl(${hue},100%,60%)`;
      ctx.fillRect(cx, cy, 6, 10);
    }
    ctx.font = '900 36px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const grad = ctx.createLinearGradient(0, h/2 - 20, 0, h/2 + 20);
    grad.addColorStop(0, '#ff0000');
    grad.addColorStop(0.2, '#ff7f00');
    grad.addColorStop(0.4, '#ffff00');
    grad.addColorStop(0.6, '#00ff00');
    grad.addColorStop(0.8, '#0000ff');
    grad.addColorStop(1, '#8b00ff');
    ctx.fillStyle = grad;
    ctx.fillText(CONFIG.PRIDE.victoryCelebration.text, w/2, h/2);
    ctx.restore();
  };
})();
