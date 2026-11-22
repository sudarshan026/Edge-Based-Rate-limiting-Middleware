/* ═══════════════════════════════════════════════════════════════════════════
   bucket.js — Token Bucket Liquid Vessel Visualization
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

(function() {
  const S = window.Store;
  let canvas, ctx;
  let W = 120, H = 200;
  let phase = 0;
  let frameId;
  let currentLevel = 0;    // animated 0..1
  let targetLevel = 1;
  let globalLevel = -1;    // -1 = unknown
  let capacity = 20;
  let droplets = [];        // falling token droplets
  let refillDrops = [];     // incoming refill drops

  function init() {
    canvas = document.getElementById('bucket-liquid');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    frameId = requestAnimationFrame(render);

    // Auto-select first client on load
    S.on('reset', () => {
      currentLevel = 1;
      targetLevel = 1;
      droplets = [];
      refillDrops = [];
    });
  }

  function render(time) {
    frameId = requestAnimationFrame(render);
    if (!ctx) return;

    ctx.clearRect(0, 0, W, H);
    phase += 0.04;

    // Animate level toward target
    currentLevel += (targetLevel - currentLevel) * 0.08;

    // ── Vessel outline ──
    const vesselX = 15;
    const vesselY = 15;
    const vesselW = W - 30;
    const vesselH = H - 40;
    const vesselBottom = vesselY + vesselH;

    // Vessel background
    ctx.fillStyle = 'rgba(5,7,15,0.6)';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    roundRect(ctx, vesselX, vesselY, vesselW, vesselH, 8);
    ctx.fill();
    ctx.stroke();

    // ── Liquid fill with sine wave surface ──
    const fillH = vesselH * Math.max(0, Math.min(1, currentLevel));
    const liquidTop = vesselBottom - fillH;

    if (fillH > 2) {
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, vesselX + 1, vesselY + 1, vesselW - 2, vesselH - 2, 7);
      ctx.clip();

      // Gradient fill
      const grad = ctx.createLinearGradient(0, liquidTop, 0, vesselBottom);
      const hue = currentLevel > 0.5 ? 157 : currentLevel > 0.2 ? 40 : 350;
      grad.addColorStop(0, `hsla(${hue}, 100%, 60%, 0.5)`);
      grad.addColorStop(1, `hsla(${hue}, 100%, 40%, 0.8)`);
      ctx.fillStyle = grad;

      // Sine wave surface
      ctx.beginPath();
      ctx.moveTo(vesselX, vesselBottom);
      ctx.lineTo(vesselX, liquidTop);
      for (let x = 0; x <= vesselW; x += 2) {
        const waveY = liquidTop + Math.sin(phase + x * 0.08) * 3 + Math.sin(phase * 1.3 + x * 0.12) * 1.5;
        ctx.lineTo(vesselX + x, waveY);
      }
      ctx.lineTo(vesselX + vesselW, vesselBottom);
      ctx.closePath();
      ctx.fill();

      // Surface highlight
      ctx.strokeStyle = `hsla(${hue}, 100%, 70%, 0.4)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= vesselW; x += 2) {
        const waveY = liquidTop + Math.sin(phase + x * 0.08) * 3 + Math.sin(phase * 1.3 + x * 0.12) * 1.5;
        if (x === 0) ctx.moveTo(vesselX + x, waveY);
        else ctx.lineTo(vesselX + x, waveY);
      }
      ctx.stroke();

      ctx.restore();
    }

    // ── Capacity tick mark ──
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(vesselX - 5, vesselY);
    ctx.lineTo(vesselX + vesselW + 5, vesselY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 8px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'right';
    ctx.fillText('CAP', vesselX - 2, vesselY + 4);

    // ── Global marker (amber line) ──
    if (globalLevel >= 0) {
      const globalY = vesselBottom - vesselH * Math.max(0, Math.min(1, globalLevel));
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(vesselX, globalY);
      ctx.lineTo(vesselX + vesselW, globalY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.font = '600 7px "JetBrains Mono", monospace';
      ctx.fillStyle = '#ffb020';
      ctx.textAlign = 'left';
      ctx.fillText('GLOBAL', vesselX + vesselW + 3, globalY + 3);
    }

    // ── Droplets (tokens being consumed — falling out) ──
    for (let i = droplets.length - 1; i >= 0; i--) {
      const d = droplets[i];
      d.y += d.vy;
      d.vy += 0.3;
      d.alpha -= 0.025;
      if (d.alpha <= 0 || d.y > H) {
        droplets.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(d.x, d.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,255,157,${d.alpha})`;
      ctx.fill();
    }

    // ── Refill drops (falling in from top) ──
    for (let i = refillDrops.length - 1; i >= 0; i--) {
      const d = refillDrops[i];
      d.y += d.vy;
      d.vy += 0.15;
      if (d.y >= liquidTop) {
        refillDrops.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(d.x, d.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100,200,255,${0.6})`;
      ctx.fill();
    }

    // ── Token count label at bottom ──
    const tokens = Math.round(currentLevel * capacity);
    ctx.font = '700 12px "JetBrains Mono", monospace';
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'center';
    ctx.fillText(`${tokens} / ${capacity}`, W / 2, H - 8);
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
    c.closePath();
  }

  // ── Public API ──
  window.Bucket = {
    init,

    setLevel(localTokens, cap) {
      capacity = cap || 20;
      targetLevel = Math.max(0, Math.min(1, localTokens / capacity));
    },

    setGlobalLevel(globalTokens, cap) {
      capacity = cap || 20;
      globalLevel = globalTokens >= 0 ? Math.max(0, Math.min(1, globalTokens / capacity)) : -1;
    },

    /** Animate a token being consumed (droplet falls out) */
    consumeToken() {
      droplets.push({
        x: 30 + Math.random() * 60,
        y: H - 50,
        vy: -2 - Math.random() * 2,
        alpha: 1
      });
    },

    /** Animate a refill drop falling in */
    addRefillDrop() {
      refillDrops.push({
        x: 30 + Math.random() * 60,
        y: 5,
        vy: 0.5
      });
    },

    /** Update the caption text */
    updateCaption(text) {
      const el = document.getElementById('bucket-caption');
      if (el) el.textContent = text;
    },

    destroy() {
      cancelAnimationFrame(frameId);
    }
  };
})();
