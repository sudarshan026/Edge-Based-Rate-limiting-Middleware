/* ═══════════════════════════════════════════════════════════════════════════
   app.js — Main Application Controller
   Orchestrates: SSE, event handling, UI updates, controls, effects
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

(function() {
  const S = window.Store;
  let evtSource = null;
  let dotSampleCounter = 0;
  let lastUIUpdate = 0;

  /* ══════════════════════════════════════════════════════════════════════════
     SSE CONNECTION
     ══════════════════════════════════════════════════════════════════════════ */
  function connectSSE() {
    if (evtSource) { try { evtSource.close(); } catch(e){} }
    evtSource = new EventSource("/api/stream");
    const badge = document.getElementById("connection-badge");

    evtSource.onopen = () => {
      S.connected = true;
      if (badge) { badge.textContent = "● CONNECTED"; badge.className = "badge ok"; }
      fetchState();
    };

    evtSource.onerror = () => {
      S.connected = false;
      if (badge) { badge.textContent = "RECONNECTING…"; badge.className = "badge err"; }
    };

    evtSource.addEventListener("request_decision", e => {
      try { handleRequestDecision(JSON.parse(e.data)); } catch(x){}
    });
    evtSource.addEventListener("sync_cycle", e => {
      try { handleSyncCycle(JSON.parse(e.data)); } catch(x){}
    });
    evtSource.addEventListener("redis_status", e => {
      try { handleRedisStatus(JSON.parse(e.data)); } catch(x){}
    });
    evtSource.addEventListener("sns_published", e => {
      try { handleSns(JSON.parse(e.data)); } catch(x){}
    });
    evtSource.addEventListener("s3_flush", e => {
      try { handleS3(JSON.parse(e.data)); } catch(x){}
    });
    evtSource.addEventListener("config_changed", e => {
      try {
        const d = JSON.parse(e.data);
        S.config.bucket_capacity = d.capacity;
        S.config.refill_per_sec = d.refill_per_sec;
        document.getElementById("ctl-capacity").value = d.capacity;
        document.getElementById("ctl-refill").value = d.refill_per_sec;
      } catch(x){}
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     EVENT HANDLERS
     ══════════════════════════════════════════════════════════════════════════ */
  function handleRequestDecision(d) {
    const isAllow = d.decision === "allow";

    if (isAllow) { S.totalAllowed++; S.secAllow++; }
    else         { S.totalDenied++;  S.secDeny++;  }

    S.popAllowed[d.pop] = (S.popAllowed[d.pop] || 0) + (isAllow ? 1 : 0);
    S.popDenied[d.pop]  = (S.popDenied[d.pop]  || 0) + (isAllow ? 0 : 1);
    S.clients.add(d.client_id);
    S.cwCount = (S.cwCount || 0) + 1;
    S.markActivity();

    // Rate limit flash on first 429
    if (!isAllow && !S.rateLimitFlashShown) {
      S.rateLimitFlashShown = true;
      showRateLimitFlash();
    }

    // Topology particle animation: ALWAYS spawn denied requests so 429s are never missed!
    dotSampleCounter++;
    const rps = S.secAllow + S.secDeny;
    const sampleRate = rps > 100 ? Math.max(1, Math.floor(rps / 40)) : 1;
    const shouldSpawn = !isAllow || (dotSampleCounter % sampleRate === 0);
    if (shouldSpawn) {
      window.Topology.spawnParticle(d.pop, isAllow);
    }

    // Update shield bucket gauge
    if (d.tokens_remaining !== undefined) {
      const cap = S.config.bucket_capacity || 20;
      window.Topology.setShieldBucket(d.tokens_remaining / cap);
    }

    // Bucket consume animation
    if (isAllow) {
      window.Bucket.consumeToken();
    }

    Feed.addLine(d);
  }

  function handleSyncCycle(d) {
    S.syncCount = (S.syncCount || 0) + 1;
    S.redisOk = true;

    const sel = document.getElementById("bucket-client-select").value;
    if (sel === d.client_id || sel === "") {
      S.bucketHistory.push({ ts: d.ts, tokens: d.local_tokens_after });
    }

    Feed.addSyncTick(d);
    Feed.addLine(d, "sync");

    // Sync pulse in topology
    window.Topology.syncPulse(`Δ ${d.delta_reported} → G ${typeof d.global_tokens === 'number' ? d.global_tokens.toFixed(0) : d.global_tokens}`);

    // Update sync label
    setText("sync-label", `sync #${S.syncCount}  Δ=${d.delta_reported}`);
  }

  function handleRedisStatus(d) {
    S.redisOk = d.ok;
    window.Topology.setRedisDown(!d.ok);

    const banner = document.getElementById("sync-banner");
    if (!d.ok) {
      if (banner) banner.classList.remove("hidden");
      Feed.addLine({ type: "redis_status", error: d.error }, "aws");
    } else {
      if (banner) banner.classList.add("hidden");
    }
  }

  function handleSns(d) {
    S.snsCount++;
    S.lastSnsTs = d.ts;
    window.Topology.setNodeCounter('sns', `alerts: ${S.snsCount}`);
    window.Topology.flashAWSNode('sns', '#a78bfa');
    Feed.addLine({ type: "sns_published", client_id: d.client_id, ok: d.ok }, "aws");
  }

  function handleS3(d) {
    S.s3Count++;
    S.lastS3Ts = d.ts;
    S.lastS3Key = d.key || "";
    window.Topology.setNodeCounter('s3', `${d.records} recs`);
    window.Topology.flashAWSNode('s3', '#a78bfa');
    Feed.addLine({ type: "s3_flush", records: d.records, key: d.key, ok: d.ok }, "aws");
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PERIODIC UI UPDATE — 1 Hz via requestAnimationFrame
     ══════════════════════════════════════════════════════════════════════════ */
  function uiTick(now) {
    requestAnimationFrame(uiTick);
    if (now - lastUIUpdate < 1000) return;
    lastUIUpdate = now;

    const sec = Math.floor(Date.now() / 1000);
    if (sec !== S.currentSecond) {
      S.rpsWindow.push({ ts: sec, allow: S.secAllow, deny: S.secDeny });
      S.currentSecond = sec;
      S.secAllow = 0;
      S.secDeny = 0;
    }

    // Update all UI modules
    Charts.updateCounters();
    Charts.updateThroughput();
    Charts.updateBucket();
    Charts.updatePop();
    Charts.updateProof();
    Feed.render();
    Feed.renderSync();
    Tour.updateTicker();
    updateTopoCounters();
    updateBucketPanel();
    updateClientDropdowns();
    pollLoadStatus();
    updateClock();
    updateIdleHint();
    updateConnectionDot();
  }

  function updateTopoCounters() {
    const lastSec = S.rpsWindow.last || { allow: 0, deny: 0 };
    const rps = lastSec.allow + lastSec.deny;
    window.Topology.setNodeCounter('clients', rps + ' rps');
    window.Topology.setNodeCounter('cdn', rps + ' rps');
    window.Topology.setNodeCounter('shield', `${lastSec.allow}✓ ${lastSec.deny}✗`);
    window.Topology.setNodeCounter('origin', lastSec.allow + ' ok');
    window.Topology.setNodeCounter('cloudwatch', S.cwCount > 0 ? `${S.cwCount} logs` : 'active');
    window.Topology.setNodeCounter('redis', S.redisOk ? 'OK' : 'FAIL');

    for (const pop of ["mumbai", "delhi", "bengaluru"]) {
      const ok = S.popAllowed[pop] || 0;
      const deny = S.popDenied[pop] || 0;
      window.Topology.setNodeCounter(pop, `${ok + deny}`);
    }
  }

  function updateBucketPanel() {
    // Handled via periodic state fetch (below)
  }

  function updateClientDropdowns() {
    const selBucket = document.getElementById("bucket-client-select");
    const selReset = document.getElementById("ctl-reset-client");
    const clients = [...S.clients];

    for (const sel of [selBucket, selReset]) {
      if (!sel) continue;
      const current = sel.value;
      for (const c of clients) {
        if (!sel.querySelector(`option[value="${c}"]`)) {
          const opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          sel.appendChild(opt);
        }
      }
      // Auto-select first client if none selected (fix "Select client..." bug)
      if (!current && clients.length > 0 && sel === selBucket) {
        sel.value = clients[0];
      } else if (current) {
        sel.value = current;
      }
    }
  }

  function updateClock() {
    const el = document.getElementById("clock");
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
  }

  function updateIdleHint() {
    const hint = document.getElementById("topo-idle-hint");
    if (!hint) return;
    const total = S.totalAllowed + S.totalDenied;
    hint.style.display = total === 0 ? "" : "none";
  }

  function updateConnectionDot() {
    const pulseDot = document.querySelector("#header-bar .pulse-ring");
    if (!pulseDot) return;
    if (!S.redisOk) {
      pulseDot.className = "pulse-ring red";
    } else if (S.connected) {
      pulseDot.className = "pulse-ring green";
    } else {
      pulseDot.className = "pulse-ring";
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RATE LIMIT ENGAGED FLASH
     ══════════════════════════════════════════════════════════════════════════ */
  function showRateLimitFlash() {
    const el = document.getElementById("rate-limit-flash");
    if (!el || S.lowFx) return;
    el.classList.remove("hidden");
    el.classList.add("flash-animate");
    setTimeout(() => {
      el.classList.add("hidden");
      el.classList.remove("flash-animate");
    }, 2000);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     FETCH STATE (resync on SSE reconnect)
     ══════════════════════════════════════════════════════════════════════════ */
  async function fetchState() {
    try {
      const r = await fetch("/api/state");
      const data = await r.json();
      if (data.counters) {
        S.totalAllowed = data.counters.total_allowed || 0;
        S.totalDenied = data.counters.total_denied || 0;
        S.cwCount = S.totalAllowed + S.totalDenied;
        S.popAllowed = data.counters.pop_allowed || {};
        S.popDenied = data.counters.pop_denied || {};
        S.syncCount = data.counters.sync_count || 0;
        S.p50 = data.counters.p50_latency_ms || 0;
        S.p95 = data.counters.p95_latency_ms || 0;
      }
      if (data.config) {
        S.config = data.config;
        document.getElementById("ctl-capacity").value = data.config.bucket_capacity;
        document.getElementById("ctl-refill").value = data.config.refill_per_sec;
      }
      S.redisOk = data.redis_ok !== false;
      window.Topology.setRedisDown(!S.redisOk);

      if (data.buckets) {
        for (const b of data.buckets) {
          S.clients.add(b.client_id);
          S.bucketHistory.push({ ts: Date.now() / 1000, tokens: b.local_tokens });
        }
      }

      const hResp = await fetch("/api/health");
      const hData = await hResp.json();
      S.dockerControl = hData.docker_control || false;
      setupRedisControl();
    } catch (e) {
      console.warn("fetchState failed:", e);
    }
  }

  function setupRedisControl() {
    const area = document.getElementById("redis-control-area");
    const manual = document.getElementById("redis-manual-cmd");
    if (S.dockerControl) {
      if (area) area.style.display = "";
      if (manual) manual.style.display = "none";
    } else {
      if (area) area.style.display = "none";
      if (manual) manual.style.display = "";
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     LOAD STATUS POLLING
     ══════════════════════════════════════════════════════════════════════════ */
  async function pollLoadStatus() {
    try {
      const r = await fetch("/api/load/status");
      const d = await r.json();
      const el = document.getElementById("load-status");
      if (!el) return;
      if (d.running) {
        el.textContent = `▶ ${d.sent} sent • ${d.ok} ok • ${d.denied} denied • ${d.current_rps} rps • ${d.elapsed}s`;
        el.style.color = "#00ff9d";
        document.getElementById("btn-load-start").disabled = true;
        document.getElementById("btn-load-stop").disabled = false;
      } else if (d.sent > 0) {
        el.textContent = `✓ Done: ${d.sent} sent • ${d.ok} ok • ${d.denied} denied • ${d.elapsed}s`;
        el.style.color = "#8b9bb4";
        document.getElementById("btn-load-start").disabled = false;
        document.getElementById("btn-load-stop").disabled = true;
      } else {
        el.textContent = "";
        document.getElementById("btn-load-start").disabled = false;
        document.getElementById("btn-load-stop").disabled = true;
      }
    } catch(e) {}
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PERIODIC STATE REFRESH — 2s interval
     ══════════════════════════════════════════════════════════════════════════ */
  function startPeriodicRefresh() {
    setInterval(async () => {
      try {
        const r = await fetch("/api/state");
        const data = await r.json();
        if (data.counters) {
          S.p50 = data.counters.p50_latency_ms || 0;
          S.p95 = data.counters.p95_latency_ms || 0;
        }
        if (data.buckets && data.buckets.length > 0) {
          const sel = document.getElementById("bucket-client-select").value;
          const b = data.buckets.find(x => x.client_id === sel) || data.buckets[0];
          if (b) {
            setText("bucket-local", b.local_tokens.toFixed(1));
            setText("bucket-global-val", b.last_global_tokens >= 0 ? b.last_global_tokens.toFixed(1) : "—");
            const drift = b.last_global_tokens >= 0 ? Math.abs(b.local_tokens - b.last_global_tokens).toFixed(1) : "—";
            setText("bucket-drift", drift);
            setText("bucket-delta", b.unsynced_delta.toFixed(1));

            const cap = b.capacity || 20;
            window.Bucket.setLevel(b.local_tokens, cap);
            window.Bucket.setGlobalLevel(b.last_global_tokens, cap);
            window.Topology.setShieldBucket(b.local_tokens / cap);

            // Caption
            const refill = S.config.refill_per_sec || 10;
            const pct = ((b.local_tokens / cap) * 100).toFixed(0);
            if (b.local_tokens >= cap * 0.9) {
              window.Bucket.updateCaption(`Bucket is nearly full (${pct}%). Refilling at ${refill} tokens/sec.`);
            } else if (b.local_tokens <= cap * 0.1) {
              window.Bucket.updateCaption(`Bucket nearly empty! Requests will be rate-limited (429).`);
            } else {
              window.Bucket.updateCaption(`Bucket at ${pct}%. Refilling at ${refill} tokens/sec. Each request costs 1.`);
            }

            S.bucketHistory.push({ ts: Date.now() / 1000, tokens: b.local_tokens });
          }
        }
        const mode = data.aws && data.aws.elasticache && data.aws.elasticache.enabled
          ? "ELASTICACHE" : "LOCAL REDIS";
        setText("sync-mode", mode);
      } catch(e) {}
    }, 2000);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CONTROL PANEL EVENT HANDLERS
     ══════════════════════════════════════════════════════════════════════════ */
  function setupControls() {
    const rpsSlider = document.getElementById("ctl-rps");
    const rpsVal = document.getElementById("ctl-rps-val");
    if (rpsSlider && rpsVal) {
      rpsSlider.addEventListener("input", () => { rpsVal.textContent = rpsSlider.value; });
    }

    const durSlider = document.getElementById("ctl-duration");
    const durVal = document.getElementById("ctl-duration-val");
    if (durSlider && durVal) {
      durSlider.addEventListener("input", () => { durVal.textContent = durSlider.value; });
    }

    // Fire single request
    const btnFire = document.getElementById("btn-fire");
    if (btnFire) {
      btnFire.addEventListener("click", async () => {
        btnFire.classList.add("btn-ripple");
        setTimeout(() => btnFire.classList.remove("btn-ripple"), 300);
        try {
          await fetch("/api/fire", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: document.getElementById("ctl-apikey").value,
              region: document.getElementById("ctl-region").value,
            }),
          });
        } catch(e) { console.error(e); }
      });
    }

    // Burst
    const btnBurst = document.getElementById("btn-burst");
    if (btnBurst) {
      btnBurst.addEventListener("click", async () => {
        try {
          await fetch("/api/burst", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: document.getElementById("ctl-apikey").value,
              count: 30,
              region: document.getElementById("ctl-region").value || "mixed",
            }),
          });
        } catch(e) { console.error(e); }
      });
    }

    // Load start
    const btnStart = document.getElementById("btn-load-start");
    if (btnStart) {
      btnStart.addEventListener("click", async () => {
        const region = document.getElementById("ctl-region").value;
        let regions = ["mumbai", "delhi", "bengaluru"];
        if (region && region !== "mixed" && region !== "") regions = [region];
        try {
          await fetch("/api/load/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: document.getElementById("ctl-apikey").value,
              rps: parseInt(rpsSlider.value),
              duration: parseInt(durSlider.value),
              regions,
            }),
          });
        } catch(e) { console.error(e); }
      });
    }

    // Load stop
    const btnStop = document.getElementById("btn-load-stop");
    if (btnStop) {
      btnStop.addEventListener("click", async () => {
        try { await fetch("/api/load/stop", { method: "POST" }); } catch(e) {}
      });
    }

    // Config
    const btnConfig = document.getElementById("btn-config");
    if (btnConfig) {
      btnConfig.addEventListener("click", async () => {
        try {
          await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              capacity: parseFloat(document.getElementById("ctl-capacity").value),
              refill_per_sec: parseFloat(document.getElementById("ctl-refill").value),
            }),
          });
        } catch(e) { console.error(e); }
      });
    }

    // Reset
    const btnReset = document.getElementById("btn-reset");
    if (btnReset) {
      btnReset.addEventListener("click", async () => {
        const clientId = document.getElementById("ctl-reset-client").value;
        if (!clientId) return;
        try {
          await fetch("/api/reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: clientId }),
          });
        } catch(e) { console.error(e); }
      });
    }

    // Redis control
    const btnRedisStop = document.getElementById("btn-redis-stop");
    if (btnRedisStop) {
      btnRedisStop.addEventListener("click", async () => {
        try { await fetch("/api/docker/redis/stop", { method: "POST" }); } catch(e) {}
      });
    }
    const btnRedisStart = document.getElementById("btn-redis-start");
    if (btnRedisStart) {
      btnRedisStart.addEventListener("click", async () => {
        try { await fetch("/api/docker/redis/start", { method: "POST" }); } catch(e) {}
      });
    }

    // Feed pause
    const btnPause = document.getElementById("feed-pause");
    if (btnPause) {
      btnPause.addEventListener("click", () => {
        S.feedPaused = !S.feedPaused;
        btnPause.textContent = S.feedPaused ? "▶" : "⏸";
        btnPause.title = S.feedPaused ? "Resume feed" : "Pause feed";
      });
    }

    // Presets
    document.querySelectorAll(".preset").forEach(btn => {
      btn.addEventListener("click", () => runPreset(btn.dataset.preset));
    });

    // Low FX toggle
    const btnLowFx = document.getElementById("btn-lowfx");
    if (btnLowFx) {
      btnLowFx.addEventListener("click", () => {
        S.lowFx = !S.lowFx;
        document.body.classList.toggle("low-fx", S.lowFx);
        btnLowFx.classList.toggle("active", S.lowFx);
      });
    }

    // Presentation mode (F key)
    document.addEventListener("keydown", e => {
      if (e.key === "f" || e.key === "F") {
        if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
        e.preventDefault();
        togglePresentationMode();
      }
    });

    // Pres bar buttons
    const presFire = document.getElementById("pres-fire");
    if (presFire) presFire.addEventListener("click", () => { if (btnFire) btnFire.click(); });
    const presBurst = document.getElementById("pres-burst");
    if (presBurst) presBurst.addEventListener("click", () => { if (btnBurst) btnBurst.click(); });
    const presExit = document.getElementById("pres-exit");
    if (presExit) presExit.addEventListener("click", togglePresentationMode);

    // Respect prefers-reduced-motion
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      S.lowFx = true;
      document.body.classList.add("low-fx");
    }
  }

  function togglePresentationMode() {
    S.presentationMode = !S.presentationMode;
    document.body.classList.toggle("presentation-mode", S.presentationMode);
    const presBar = document.getElementById("pres-bar");
    if (presBar) presBar.classList.toggle("hidden", !S.presentationMode);
  }

  async function runPreset(name) {
    const apiKeyEl = document.getElementById("ctl-apikey");
    const rpsEl = document.getElementById("ctl-rps");
    const durEl = document.getElementById("ctl-duration");
    const rpsVal = document.getElementById("ctl-rps-val");
    const durVal = document.getElementById("ctl-duration-val");

    switch (name) {
      case "normal":
        apiKeyEl.value = "demo-key";
        rpsEl.value = "10"; rpsVal.textContent = "10";
        durEl.value = "10"; durVal.textContent = "10";
        document.getElementById("btn-load-start").click();
        break;
      case "burst":
        apiKeyEl.value = "demo-key";
        rpsEl.value = "300"; rpsVal.textContent = "300";
        durEl.value = "10"; durVal.textContent = "10";
        document.getElementById("btn-load-start").click();
        break;
      case "multikey":
        for (let i = 1; i <= 5; i++) {
          fetch("/api/burst", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: `key-${i}`, count: 30, region: "mixed" }),
          });
        }
        break;
      case "redis-outage":
        await fetch("/api/docker/redis/stop", { method: "POST" });
        setTimeout(() => {
          apiKeyEl.value = "demo-key";
          rpsEl.value = "50"; rpsVal.textContent = "50";
          durEl.value = "5"; durVal.textContent = "5";
          document.getElementById("btn-load-start").click();
        }, 2000);
        setTimeout(() => {
          fetch("/api/docker/redis/start", { method: "POST" });
        }, 10000);
        break;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ENTRANCE ANIMATION
     ══════════════════════════════════════════════════════════════════════════ */
  function playEntrance() {
    if (S.lowFx) {
      S.entranceComplete = true;
      return;
    }
    const panels = document.querySelectorAll('.panel');
    panels.forEach((p, i) => {
      p.style.opacity = '0';
      p.style.transform = 'translateY(20px)';
      setTimeout(() => {
        p.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        p.style.opacity = '1';
        p.style.transform = 'translateY(0)';
      }, 150 + i * 100);
    });
    setTimeout(() => { S.entranceComplete = true; }, 1500);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     INIT
     ══════════════════════════════════════════════════════════════════════════ */
  function init() {
    // Initialize all modules
    window.Topology.init();
    window.Bucket.init();
    window.Charts.init();
    window.Feed.init();
    window.Tour.init();

    setupControls();
    connectSSE();
    requestAnimationFrame(uiTick);
    startPeriodicRefresh();
    playEntrance();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
