/* ═══════════════════════════════════════════════════════════════════════════
   tour.js — Guided Demo & Self-Explanatory Layer
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

(function() {
  const S = window.Store;
  let overlay, spotlight, caption, textEl, progressEl;
  let currentStep = 0;
  let isRunning = false;
  let isPaused = false;
  let stepTimer = null;

  const STEPS = [
    {
      target: '#topology-panel',
      text: '🌐 A client sends a request through the CDN to one of 3 edge POPs (Mumbai, Delhi, Bengaluru).',
      action: () => fireRequest(1),
      duration: 6000,
    },
    {
      target: '#topology-panel',
      text: '🏙 Requests are automatically spread across 3 Points of Presence for geographic distribution.',
      action: () => burstMixed(5),
      duration: 6000,
    },
    {
      target: '#topology-panel',
      text: '🛡 The Shield decides locally with zero latency using a Token Bucket algorithm — no Redis round-trip needed.',
      action: null,
      duration: 6000,
    },
    {
      target: '#bucket-panel',
      text: '🪣 When the bucket empties, requests are rejected with HTTP 429 Too Many Requests. Watch the tokens drain!',
      action: () => burstMixed(60),
      duration: 8000,
    },
    {
      target: '#sync-panel',
      text: '🔄 Every second, the Batch Sync Daemon reconciles local counts with Redis — the amber pulses show this.',
      action: null,
      duration: 7000,
    },
    {
      target: '#proof-panel',
      text: '📊 The Global Limit Proof card verifies that the total allowed requests match the expected rate across ALL POPs.',
      action: () => startLoadTest(50, 10),
      duration: 12000,
    },
    {
      target: '#throughput-panel',
      text: '📈 Throughput chart shows real-time allowed vs denied. The rate limit holds the green line steady even under burst traffic.',
      action: null,
      duration: 6000,
    },
    {
      target: '#topology-panel',
      text: '☁ AWS integration: CloudWatch logs every decision, SNS alerts on rate-limit events, S3 archives batches. Watch them light up!',
      action: null,
      duration: 8000,
    },
  ];

  function init() {
    overlay = document.getElementById('demo-overlay');
    spotlight = document.getElementById('demo-spotlight');
    caption = document.getElementById('demo-caption');
    textEl = document.getElementById('demo-text');
    progressEl = document.getElementById('demo-progress');

    const startBtn = document.getElementById('btn-guided-demo');
    if (startBtn) startBtn.addEventListener('click', toggle);

    const nextBtn = document.getElementById('demo-next');
    const prevBtn = document.getElementById('demo-prev');
    const skipBtn = document.getElementById('demo-skip');
    if (nextBtn) nextBtn.addEventListener('click', nextStep);
    if (prevBtn) prevBtn.addEventListener('click', prevStep);
    if (skipBtn) skipBtn.addEventListener('click', stop);

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (!isRunning) return;
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); nextStep(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prevStep(); }
      if (e.key === 'Escape') stop();
    });
  }

  function toggle() {
    if (isRunning) stop();
    else start();
  }

  function start() {
    isRunning = true;
    currentStep = 0;
    if (overlay) overlay.classList.remove('hidden');
    showStep(0);
  }

  function stop() {
    isRunning = false;
    isPaused = false;
    clearTimeout(stepTimer);
    if (overlay) overlay.classList.add('hidden');
  }

  function showStep(idx) {
    if (idx < 0 || idx >= STEPS.length) {
      stop();
      return;
    }
    currentStep = idx;
    const step = STEPS[idx];

    // Update text with typewriter effect
    if (textEl) typewrite(textEl, step.text);

    // Update progress dots
    if (progressEl) {
      progressEl.innerHTML = STEPS.map((_, i) =>
        `<span class="demo-dot${i === idx ? ' active' : i < idx ? ' done' : ''}"></span>`
      ).join('');
    }

    // Spotlight the target panel
    if (step.target && spotlight) {
      const el = document.querySelector(step.target);
      if (el) {
        const rect = el.getBoundingClientRect();
        spotlight.style.left = (rect.left - 8) + 'px';
        spotlight.style.top = (rect.top - 8) + 'px';
        spotlight.style.width = (rect.width + 16) + 'px';
        spotlight.style.height = (rect.height + 16) + 'px';
      }
    }

    // Execute action
    if (step.action) {
      setTimeout(() => { try { step.action(); } catch(e) {} }, 500);
    }

    // Auto-advance
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      if (isRunning && !isPaused) nextStep();
    }, step.duration);
  }

  function nextStep() {
    clearTimeout(stepTimer);
    if (currentStep < STEPS.length - 1) {
      showStep(currentStep + 1);
    } else {
      stop();
    }
  }

  function prevStep() {
    clearTimeout(stepTimer);
    if (currentStep > 0) {
      showStep(currentStep - 1);
    }
  }

  function typewrite(el, text) {
    el.textContent = '';
    let i = 0;
    function type() {
      if (i < text.length) {
        el.textContent += text[i];
        i++;
        setTimeout(type, 15);
      }
    }
    type();
  }

  // ── Tour Actions ──
  async function fireRequest(count) {
    for (let i = 0; i < count; i++) {
      try {
        await fetch("/api/fire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: "demo-key", region: "" }),
        });
      } catch(e) {}
    }
  }

  async function burstMixed(count) {
    try {
      await fetch("/api/burst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: "demo-key", count, region: "mixed" }),
      });
    } catch(e) {}
  }

  async function startLoadTest(rps, duration) {
    try {
      await fetch("/api/load/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: "demo-key",
          rps,
          duration,
          regions: ["mumbai", "delhi", "bengaluru"],
        }),
      });
    } catch(e) {}
  }

  // ── Ticker (What's Happening) ──
  function updateTicker() {
    const el = document.getElementById('ticker');
    if (!el) return;

    const total = S.totalAllowed + S.totalDenied;
    const lastSec = S.rpsWindow.last;
    const rps = lastSec ? lastSec.allow + lastSec.deny : 0;

    if (total === 0) {
      el.textContent = "Awaiting traffic… Use the control panel to send requests or choose a preset scenario.";
      return;
    }

    const clients = [...S.clients].map(c => c.replace("key:", "")).join(", ");
    const pops = Object.keys(S.popAllowed).filter(p => (S.popAllowed[p] || 0) + (S.popDenied[p] || 0) > 0);

    let text = `Client ${clients} → ${rps} req/s across ${pops.length} POPs. `;
    text += `Shield: ${fmtNum(S.totalAllowed)} allowed, ${fmtNum(S.totalDenied)} rejected. `;

    if (!S.redisOk) {
      text += "⚠ Redis DOWN — failing open from local bucket.";
    } else {
      text += "Global rate limit holding.";
    }

    el.textContent = text;
  }

  // ── Public API ──
  window.Tour = {
    init,
    updateTicker,
    isRunning: () => isRunning,
  };
})();
