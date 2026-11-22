/* ═══════════════════════════════════════════════════════════════════════════
   topology.js — Canvas-based Hero Topology with Particle System
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

(function() {
  const S = window.Store;
  let canvas, ctx;
  let W, H;
  let dpr = 1;
  let frameId;

  // ── Node definitions ──
  const NODES = {
    clients:    { x: 0.06, y: 0.42, w: 100, h: 55, label: 'Clients',      icon: '👤', color: '#22d3ee', zone: 'Internet' },
    cdn:        { x: 0.17, y: 0.42, w: 100, h: 55, label: 'CDN',          icon: '🌐', color: '#22d3ee', zone: 'Internet' },
    mumbai:     { x: 0.32, y: 0.14, w: 110, h: 55, label: 'Mumbai',       icon: '🏙', color: '#22d3ee', zone: 'Edge Network', isPop: true },
    delhi:      { x: 0.32, y: 0.42, w: 110, h: 55, label: 'Delhi',        icon: '🏛', color: '#22d3ee', zone: 'Edge Network', isPop: true },
    bengaluru:  { x: 0.32, y: 0.70, w: 110, h: 55, label: 'Bengaluru',    icon: '🌴', color: '#22d3ee', zone: 'Edge Network', isPop: true },
    shield:     { x: 0.52, y: 0.38, w: 110, h: 68, label: 'Shield',       icon: '🛡', color: '#00ff9d', zone: 'Origin Shield' },
    origin:     { x: 0.68, y: 0.42, w: 100, h: 55, label: 'Origin',       icon: '📦', color: '#e2e8f0', zone: 'Origin Shield' },
    redis:      { x: 0.52, y: 0.78, w: 100, h: 48, label: 'Redis',        icon: '🗄', color: '#ffb020', zone: 'Origin Shield' },
    cloudwatch: { x: 0.84, y: 0.14, w: 115, h: 48, label: 'CloudWatch',   icon: '☁',  color: '#a78bfa', zone: 'AWS' },
    sns:        { x: 0.84, y: 0.42, w: 115, h: 48, label: 'SNS',          icon: '📢', color: '#a78bfa', zone: 'AWS' },
    s3:         { x: 0.84, y: 0.70, w: 115, h: 48, label: 'S3',           icon: '📦', color: '#a78bfa', zone: 'AWS' },
  };

  // ── Link definitions ──
  const LINKS = [
    { from: 'clients',   to: 'cdn',        style: 'normal' },
    { from: 'cdn',       to: 'mumbai',     style: 'normal' },
    { from: 'cdn',       to: 'delhi',      style: 'normal' },
    { from: 'cdn',       to: 'bengaluru',  style: 'normal' },
    { from: 'mumbai',    to: 'shield',     style: 'normal' },
    { from: 'delhi',     to: 'shield',     style: 'normal' },
    { from: 'bengaluru', to: 'shield',     style: 'normal' },
    { from: 'shield',    to: 'origin',     style: 'normal' },
    { from: 'shield',    to: 'redis',      style: 'sync', color: '#ffb020' },
    { from: 'shield',    to: 'cloudwatch', style: 'aws', color: '#a78bfa' },
    { from: 'shield',    to: 'sns',        style: 'aws', color: '#a78bfa' },
    { from: 'shield',    to: 's3',         style: 'aws', color: '#a78bfa' },
  ];

  // ── Zone definitions ──
  const ZONES = [
    { label: 'Internet',       x1: 0.02, y1: 0.04, x2: 0.24, y2: 0.96, color: 'rgba(34,211,238,0.06)', border: 'rgba(34,211,238,0.15)' },
    { label: 'Edge Network',   x1: 0.26, y1: 0.04, x2: 0.46, y2: 0.96, color: 'rgba(34,211,238,0.04)', border: 'rgba(34,211,238,0.12)' },
    { label: 'Origin Shield',  x1: 0.48, y1: 0.04, x2: 0.76, y2: 0.96, color: 'rgba(0,255,157,0.04)',  border: 'rgba(0,255,157,0.12)' },
    { label: 'AWS Cloud',      x1: 0.78, y1: 0.04, x2: 0.98, y2: 0.96, color: 'rgba(167,139,250,0.04)',border: 'rgba(167,139,250,0.12)' },
  ];

  // ── Particle pool ──
  const particles = [];
  const MAX_PARTICLES = 300;
  const ambientParticles = [];
  const MAX_AMBIENT = 20;

  // ── Live counters per node ──
  const nodeCounters = {};
  const nodeSpark = {};  // mini sparkline data per node

  // ── Sync pulse state ──
  let syncPulseActive = false;
  let syncPulseProgress = 0;
  let syncPulseLabel = '';

  // ── Redis state ──
  let redisBreathPhase = 0;
  let redisDown = false;

  // ── Shield bucket gauge ──
  let shieldBucketLevel = 1.0;  // 0..1

  // ── Dash offset for flowing animation ──
  let dashOffset = 0;

  // ── Link glow states ──
  const linkGlows = {};
  let shieldRedPulse = 0; // Flash Shield node border red on 429
  let shieldShake = 0;

  function getNodeCenter(key) {
    const n = NODES[key];
    return {
      x: n.x * W + n.w / 2,
      y: n.y * H + n.h / 2
    };
  }

  function getNodeRect(key) {
    const n = NODES[key];
    return {
      x: n.x * W,
      y: n.y * H,
      w: n.w,
      h: n.h,
      cx: n.x * W + n.w / 2,
      cy: n.y * H + n.h / 2
    };
  }

  function init() {
    canvas = document.getElementById('topology-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);

    // Start ambient particles
    for (let i = 0; i < MAX_AMBIENT; i++) {
      spawnAmbientParticle();
    }

    // Start render loop
    frameId = requestAnimationFrame(render);
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = rect.width;
    H = rect.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Drawing functions ──

  function drawZones() {
    for (const z of ZONES) {
      const x = z.x1 * W;
      const y = z.y1 * H;
      const w = (z.x2 - z.x1) * W;
      const h = (z.y2 - z.y1) * H;

      ctx.fillStyle = z.color;
      ctx.strokeStyle = z.border;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);

      roundRect(x, y, w, h, 12);
      ctx.fill();
      ctx.stroke();

      // Zone label
      ctx.font = '600 10px Inter, sans-serif';
      ctx.fillStyle = z.border;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(z.label.toUpperCase(), x + 8, y + 6);
    }
  }

  function drawLinks(time) {
    dashOffset = (time / 40) % 20;

    for (const link of LINKS) {
      const from = getNodeCenter(link.from);
      const to = getNodeCenter(link.to);

      const glowKey = `${link.from}-${link.to}`;
      const glowObj = linkGlows[glowKey];
      const glow = typeof glowObj === 'object' ? glowObj.val : (glowObj || 0);
      const glowColor = typeof glowObj === 'object' ? glowObj.color : '#00ff9d';

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);

      // Bezier curve for organic links
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const cx1 = from.x + dx * 0.4;
      const cy1 = from.y;
      const cx2 = from.x + dx * 0.6;
      const cy2 = to.y;
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, to.x, to.y);

      if (link.style === 'sync') {
        ctx.strokeStyle = redisDown ? '#ff2e63' : (link.color || '#ffb020');
        ctx.lineWidth = 1.5 + glow * 2;
        ctx.setLineDash(redisDown ? [4, 4] : [6, 4]);
        ctx.lineDashOffset = redisDown ? dashOffset * 2 : -dashOffset;
      } else if (link.style === 'aws') {
        ctx.strokeStyle = link.color || '#a78bfa';
        ctx.lineWidth = 1 + glow;
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -dashOffset * 0.5;
      } else {
        if (glow > 0) {
          const rgb = hexToRgb(glowColor);
          ctx.strokeStyle = `rgba(${rgb},${0.4 + glow * 0.6})`;
          ctx.lineWidth = 2 + glow * 2.5;
        } else {
          ctx.strokeStyle = 'rgba(45,58,79,0.6)';
          ctx.lineWidth = 1.5;
        }
        ctx.setLineDash([8, 4]);
        ctx.lineDashOffset = -dashOffset;
      }

      // Glow effect
      if (glow > 0.1) {
        ctx.shadowColor = glowColor || link.color || '#00ff9d';
        ctx.shadowBlur = glow * 10;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);

      // Decay glow
      if (linkGlows[glowKey]) {
        if (typeof linkGlows[glowKey] === 'object') {
          linkGlows[glowKey].val = Math.max(0, linkGlows[glowKey].val - 0.025);
          if (linkGlows[glowKey].val <= 0) delete linkGlows[glowKey];
        } else {
          linkGlows[glowKey] = Math.max(0, linkGlows[glowKey] - 0.025);
        }
      }
    }
  }

  function drawNodes(time) {
    for (const [key, node] of Object.entries(NODES)) {
      const r = getNodeRect(key);

      // Breathing effect for Redis
      let breathScale = 1;
      let offsetX = 0, offsetY = 0;
      if (key === 'redis' && !redisDown) {
        redisBreathPhase += 0.02;
        breathScale = 1 + Math.sin(redisBreathPhase) * 0.015;
      }
      if (key === 'shield' && shieldShake > 0) {
        offsetX = (Math.random() - 0.5) * 6 * shieldShake;
        offsetY = (Math.random() - 0.5) * 6 * shieldShake;
        shieldShake = Math.max(0, shieldShake - 0.05);
      }

      ctx.save();
      if (breathScale !== 1) {
        ctx.translate(r.cx, r.cy);
        ctx.scale(breathScale, breathScale);
        ctx.translate(-r.cx, -r.cy);
      }
      if (offsetX !== 0 || offsetY !== 0) {
        ctx.translate(offsetX, offsetY);
      }

      // Node background — glassmorphism
      const isDown = key === 'redis' && redisDown;
      const isShieldFlash = key === 'shield' && shieldRedPulse > 0;
      const bgColor = isDown ? 'rgba(60,15,15,0.7)' : (isShieldFlash ? `rgba(70,12,24,${0.75 + shieldRedPulse * 0.2})` : 'rgba(10,15,30,0.75)');
      ctx.fillStyle = bgColor;
      if (isShieldFlash) {
        ctx.strokeStyle = `rgba(255,46,99,${0.5 + shieldRedPulse * 0.5})`;
        ctx.lineWidth = 2 + shieldRedPulse * 3;
        ctx.shadowColor = '#ff2e63';
        ctx.shadowBlur = shieldRedPulse * 15;
        shieldRedPulse = Math.max(0, shieldRedPulse - 0.03);
      } else {
        ctx.strokeStyle = isDown ? 'rgba(255,46,99,0.5)' : `rgba(${hexToRgb(node.color)},0.25)`;
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 0;
      }
      roundRect(r.x, r.y, r.w, r.h, 12);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Health ring (pulsing glow)
      if (!isDown) {
        const pulse = 0.5 + Math.sin(time / 1000 + hashCode(key)) * 0.3;
        ctx.strokeStyle = `rgba(${hexToRgb(node.color)},${pulse * 0.3})`;
        ctx.lineWidth = 2;
        roundRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4, 14);
        ctx.stroke();
      }

      // Icon + Label
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.icon, r.cx - 30, r.cy - 6);

      ctx.font = '700 12px Inter, sans-serif';
      ctx.fillStyle = isDown ? '#ff2e63' : '#e2e8f0';
      ctx.fillText(node.label, r.cx + 5, r.cy - 8);

      // Counter
      const counter = nodeCounters[key] || '';
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.fillStyle = isDown ? '#ff6b8a' : 'rgba(226,232,240,0.6)';
      ctx.fillText(counter, r.cx, r.cy + 12);

      // Shield: mini bucket gauge
      if (key === 'shield') {
        drawShieldGauge(r.cx - 20, r.cy + 22, 40, 8);
      }

      ctx.restore();
    }
  }

  function drawShieldGauge(x, y, w, h) {
    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundRect(x, y, w, h, 3);
    ctx.fill();

    // Fill
    const fillW = w * Math.max(0, Math.min(1, shieldBucketLevel));
    const hue = shieldBucketLevel > 0.5 ? '157' : shieldBucketLevel > 0.2 ? '40' : '350';
    ctx.fillStyle = `hsla(${hue}, 100%, 60%, 0.8)`;
    if (fillW > 0) {
      roundRect(x, y, fillW, h, 3);
      ctx.fill();
    }
  }

  function drawParticles(time) {
    // Active particles (request traffic)
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.progress += p.speed;

      if (p.progress >= 1) {
        // Move to next segment
        p.segIdx++;
        if (p.segIdx >= p.segments.length) {
          // Particle finished
          particles.splice(i, 1);
          S.activeParticles--;

          // 429 shockwave effect
          if (!p.allowed && !S.lowFx) {
            spawnShockwave(p.x, p.y);
          }
          continue;
        }
        p.progress = 0;
      }

      const seg = p.segments[p.segIdx];
      const t = easeOutCubic(p.progress);
      p.x = seg.from.x + (seg.to.x - seg.from.x) * t;
      p.y = seg.from.y + (seg.to.y - seg.from.y) * t;

      // Draw comet trail
      if (!S.lowFx) {
        const trailLen = p.allowed ? 4 : 7;
        for (let j = 1; j <= trailLen; j++) {
          const tt = Math.max(0, p.progress - j * (p.allowed ? 0.08 : 0.06));
          const tx = seg.from.x + (seg.to.x - seg.from.x) * easeOutCubic(tt);
          const ty = seg.from.y + (seg.to.y - seg.from.y) * easeOutCubic(tt);
          ctx.beginPath();
          ctx.arc(tx, ty, p.size * (1 - j / (trailLen + 1)), 0, Math.PI * 2);
          const trailAlpha = (p.allowed ? 0.35 : 0.65) * (1 - j / trailLen);
          ctx.fillStyle = `rgba(${hexToRgb(p.color)},${trailAlpha})`;
          ctx.fill();
        }
      }

      // Draw particle
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      if (!S.lowFx) {
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.allowed ? 8 : 16;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Ambient particles (slow drifting along links)
    for (const ap of ambientParticles) {
      ap.progress += ap.speed;
      if (ap.progress >= 1) {
        ap.progress = 0;
        ap.linkIdx = Math.floor(Math.random() * LINKS.length);
      }
      const link = LINKS[ap.linkIdx % LINKS.length];
      const from = getNodeCenter(link.from);
      const to = getNodeCenter(link.to);
      ap.x = from.x + (to.x - from.x) * ap.progress;
      ap.y = from.y + (to.y - from.y) * ap.progress;

      ctx.beginPath();
      ctx.arc(ap.x, ap.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100,120,160,${0.15 + Math.sin(time / 500 + ap.phase) * 0.1})`;
      ctx.fill();
    }
  }

  // ── Shockwave effects & Red Shards ──
  const shockwaves = [];
  const shards = [];

  function spawnShockwave(x, y) {
    shockwaves.push({ x, y, radius: 10, maxRadius: 65, alpha: 1 });
    shieldRedPulse = 1.0;
    shieldShake = 1.0;

    // Red shard burst flying out from shield impact
    for (let i = 0; i < 10; i++) {
      const angle = (Math.PI * 2 * i) / 10 + (Math.random() - 0.5) * 0.5;
      const spd = 2 + Math.random() * 3.5;
      shards.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        alpha: 1,
        size: 2.5 + Math.random() * 1.5,
        life: 25 + Math.random() * 15
      });
    }

    // Floating "429" text - placed higher above shield, bold, bright neon red with drop shadow
    floatingTexts.push({ x: x, y: y - 20, text: '429', color: '#ff2e63', alpha: 1, vy: -1.4, life: 70 });
  }

  const floatingTexts = [];

  function drawEffects(time) {
    // Shockwaves
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const sw = shockwaves[i];
      sw.radius += 2.0;
      sw.alpha -= 0.025;
      if (sw.alpha <= 0) { shockwaves.splice(i, 1); continue; }

      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,46,99,${sw.alpha})`;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#ff2e63';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Red shards
    for (let i = shards.length - 1; i >= 0; i--) {
      const sh = shards[i];
      sh.x += sh.vx;
      sh.y += sh.vy;
      sh.vx *= 0.94;
      sh.vy *= 0.94;
      sh.life--;
      sh.alpha = sh.life / 35;
      if (sh.life <= 0) { shards.splice(i, 1); continue; }

      ctx.beginPath();
      ctx.arc(sh.x, sh.y, sh.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,46,99,${sh.alpha})`;
      ctx.shadowColor = '#ff2e63';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Floating texts
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
      const ft = floatingTexts[i];
      ft.y += ft.vy;
      ft.life--;
      ft.alpha = ft.life / 70;
      if (ft.life <= 0) { floatingTexts.splice(i, 1); continue; }

      ctx.font = '900 18px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(${hexToRgb(ft.color)},${ft.alpha})`;
      if (!S.lowFx) {
        ctx.shadowColor = ft.color;
        ctx.shadowBlur = 12;
      }
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.shadowBlur = 0;
    }

    // Sync pulse
    if (syncPulseActive) {
      syncPulseProgress += 0.015;
      if (syncPulseProgress >= 1) {
        syncPulseActive = false;
        syncPulseProgress = 0;
      } else {
        const shieldC = getNodeCenter('shield');
        const redisC = getNodeCenter('redis');
        const t = easeOutCubic(syncPulseProgress);
        const px = shieldC.x + (redisC.x - shieldC.x) * t;
        const py = shieldC.y + (redisC.y - shieldC.y) * t;

        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb020';
        ctx.shadowColor = '#ffb020';
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Label
        if (syncPulseLabel) {
          ctx.font = '600 9px "JetBrains Mono", monospace';
          ctx.fillStyle = 'rgba(255,176,32,0.8)';
          ctx.textAlign = 'center';
          ctx.fillText(syncPulseLabel, px, py - 12);
        }
      }
    }
  }

  // ── Redis down banner ──
  function drawRedisDownBanner(time) {
    if (!redisDown) return;

    const pulse = 0.5 + Math.sin(time / 300) * 0.2;
    // Red vignette at edges
    const gradient = ctx.createRadialGradient(W / 2, H / 2, W * 0.3, W / 2, H / 2, W * 0.7);
    gradient.addColorStop(0, 'rgba(255,0,0,0)');
    gradient.addColorStop(1, `rgba(255,0,0,${0.05 * pulse})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);

    // Banner
    ctx.fillStyle = `rgba(60,10,10,${0.85 + pulse * 0.15})`;
    const bh = 30;
    const by = H - bh - 10;
    roundRect(10, by, W - 20, bh, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,46,99,0.6)';
    ctx.lineWidth = 1;
    roundRect(10, by, W - 20, bh, 8);
    ctx.stroke();

    ctx.font = '700 11px "JetBrains Mono", monospace';
    ctx.fillStyle = '#ff2e63';
    ctx.textAlign = 'center';
    ctx.fillText('⚠ REDIS UNREACHABLE: FAIL-OPEN MODE — serving from local bucket', W / 2, by + 18);
  }

  // ── Main render loop ──
  function render(time) {
    if (!canvas || !ctx) return;
    frameId = requestAnimationFrame(render);

    ctx.clearRect(0, 0, W, H);

    // Draw layers: NODES drawn first so particles, shockwaves and 429 texts render ON TOP!
    drawZones();
    drawLinks(time);
    drawNodes(time);
    drawParticles(time);
    drawEffects(time);
    drawRedisDownBanner(time);

    // Tick counters
    window.tickCounters();
  }

  // ── Particle spawning ──
  function spawnAmbientParticle() {
    ambientParticles.push({
      linkIdx: Math.floor(Math.random() * LINKS.length),
      progress: Math.random(),
      speed: 0.001 + Math.random() * 0.002,
      x: 0, y: 0,
      phase: Math.random() * Math.PI * 2,
    });
  }

  // ── Helpers ──
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}` : '255,255,255';
  }

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  // ── Public API ──
  window.Topology = {
    init,
    resize,

    /** Spawn a request particle */
    spawnParticle(pop, allowed) {
      if (S.activeParticles >= MAX_PARTICLES) return;
      if (S.lowFx && S.activeParticles > 50) return;

      const clientC = getNodeCenter('clients');
      const cdnC = getNodeCenter('cdn');
      const popC = getNodeCenter(pop || 'delhi');
      const shieldC = getNodeCenter('shield');
      const originC = getNodeCenter('origin');

      const color = allowed ? '#00ff9d' : '#ff2e63';
      const size = allowed ? 3.5 : 5.0; // Denied requests are larger, bolder and strictly bright red

      const segments = [
        { from: clientC, to: cdnC },
        { from: cdnC, to: popC },
        { from: popC, to: shieldC },
      ];
      if (allowed) {
        segments.push({ from: shieldC, to: originC });
      }

      particles.push({
        x: clientC.x,
        y: clientC.y,
        segments,
        segIdx: 0,
        progress: 0,
        speed: 0.025 + Math.random() * 0.01,
        size: size,
        color: color,
        allowed,
      });
      S.activeParticles++;

      // Glow links: green for allowed, neon red for denied
      const linkMap = {
        mumbai: ['cdn-mumbai', 'mumbai-shield'],
        delhi: ['cdn-delhi', 'delhi-shield'],
        bengaluru: ['cdn-bengaluru', 'bengaluru-shield'],
      };
      const links = linkMap[pop] || linkMap.delhi;
      const glowCol = allowed ? '#00ff9d' : '#ff2e63';
      for (const lk of links) {
        linkGlows[lk] = { val: 1.2, color: glowCol };
      }
      linkGlows['clients-cdn'] = { val: 1.2, color: glowCol };
      if (allowed) linkGlows['shield-origin'] = { val: 1.2, color: '#00ff9d' };
    },

    /** Trigger sync pulse animation */
    syncPulse(label) {
      syncPulseActive = true;
      syncPulseProgress = 0;
      syncPulseLabel = label || '';
      linkGlows['shield-redis'] = 1;
    },

    /** Update node counter text */
    setNodeCounter(key, text) {
      nodeCounters[key] = text;
    },

    /** Set shield bucket gauge level (0..1) */
    setShieldBucket(level) {
      shieldBucketLevel = level;
    },

    /** Set Redis status */
    setRedisDown(down) {
      redisDown = down;
    },

    /** Flash an AWS node */
    flashAWSNode(key, color) {
      const c = getNodeCenter(key);
      if (!c) return;
      floatingTexts.push({
        x: c.x, y: c.y - 30,
        text: key === 'sns' ? '📢' : key === 's3' ? '📥' : '📊',
        color: color || '#a78bfa',
        alpha: 1, vy: -1, life: 40
      });
    },

    /** Destroy */
    destroy() {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', resize);
    }
  };
})();
