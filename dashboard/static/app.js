/* ═══════════════════════════════════════════════════════════════════════════
   Control Room — Dashboard Frontend Logic (v2 — polished NOC UI)
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
"use strict";

/* ══════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════ */
const S = {
  connected: false,
  totalAllowed: 0,
  totalDenied: 0,
  popAllowed: {},
  popDenied: {},
  rpsWindow: [],            // [{ts, allow, deny}]
  bucketHistory: [],         // [{ts, tokens}]
  feedLines: [],             // last 200 feed entries
  feedPaused: false,
  syncTicks: [],
  syncCount: 0,
  cwCount: 0,
  snsCount: 0,
  s3Count: 0,
  lastSnsTs: 0,
  lastS3Ts: 0,
  lastS3Key: "",
  redisOk: true,
  awsState: {},
  config: { bucket_capacity: 20, refill_per_sec: 10, sync_interval: 1 },
  clients: new Set(),
  dockerControl: false,
  currentSecond: 0,
  secAllow: 0,
  secDeny: 0,
};

const MAX_FEED = 200;
const MAX_RPS_WINDOW = 60;
const MAX_BUCKET_HIST = 60;
const MAX_SYNC_TICKS = 60;

/* ══════════════════════════════════════════════════════════════════════════
   TOPOLOGY PATHS — must match the SVG viewBox="0 0 920 300" layout
   ══════════════════════════════════════════════════════════════════════════ */
const PATHS = {
  // CDN center → POP centers  (from SVG node positions)
  "cdn-mumbai":      [[230,150],[320,60]],
  "cdn-delhi":       [[230,150],[320,150]],
  "cdn-bengaluru":   [[230,150],[320,240]],
  // POP centers → Shield center
  "mumbai-shield":   [[400,60],[480,150]],
  "delhi-shield":    [[400,150],[480,150]],
  "bengaluru-shield":[[400,240],[480,150]],
  // Shield → Origin
  "shield-origin":   [[560,150],[640,150]],
};
const SVG_NS = "http://www.w3.org/2000/svg";
let activeDots = [];
const MAX_DOTS = 60;
let dotSampleCounter = 0;

/* ── Charts ── */
let throughputChart = null;
let bucketChart = null;

/* ══════════════════════════════════════════════════════════════════════════
   SSE CONNECTION
   ══════════════════════════════════════════════════════════════════════════ */
let evtSource = null;

function connectSSE() {
  if (evtSource) { try { evtSource.close(); } catch(e){} }
  evtSource = new EventSource("/api/stream");
  const badge = document.getElementById("connection-badge");

  evtSource.onopen = () => {
    S.connected = true;
    badge.textContent = "● connected";
    badge.className = "badge ok";
    fetchState();
  };

  evtSource.onerror = () => {
    S.connected = false;
    badge.textContent = "reconnecting…";
    badge.className = "badge err";
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
  setText("cw-topo", `${S.cwCount} logs`);

  // Topology dot animation (sampled at high RPS to cap DOM nodes)
  dotSampleCounter++;
  const rps = S.secAllow + S.secDeny;
  const sampleRate = rps > 100 ? Math.max(1, Math.floor(rps / 40)) : 1;
  if (dotSampleCounter % sampleRate === 0 && activeDots.length < MAX_DOTS) {
    animateDot(d.pop, isAllow);
  }

  // Glow the links briefly
  glowLink(d.pop, isAllow);

  addFeedLine(d);
}

function handleSyncCycle(d) {
  S.syncCount = (S.syncCount || 0) + 1;
  S.redisOk = true;

  const sel = document.getElementById("bucket-client-select").value;
  if (sel === d.client_id || sel === "") {
    S.bucketHistory.push({ ts: d.ts, tokens: d.local_tokens_after });
    if (S.bucketHistory.length > MAX_BUCKET_HIST) S.bucketHistory.shift();
  }

  addSyncTick(d);
  addFeedLine(d, "sync");

  // Pulse Redis link
  const rLink = document.getElementById("link-sh-redis");
  if (rLink) {
    rLink.classList.add("link-sync-pulse");
    setTimeout(() => rLink.classList.remove("link-sync-pulse"), 600);
  }
  setText("sync-label", `sync #${S.syncCount}  Δ=${d.delta_reported}`);
}

function handleRedisStatus(d) {
  S.redisOk = d.ok;
  const banner = document.getElementById("sync-banner");
  const hDot = document.getElementById("h-redis");
  const topoSt = document.getElementById("redis-topo-st");
  if (!d.ok) {
    banner.classList.remove("hidden");
    if (hDot) hDot.classList.add("down");
    if (topoSt) { topoSt.textContent = "FAIL"; topoSt.style.fill = "#ff1744"; }
    addFeedLine({ type: "redis_status", error: d.error }, "aws");
  } else {
    banner.classList.add("hidden");
    if (hDot) hDot.classList.remove("down");
    if (topoSt) { topoSt.textContent = "OK"; topoSt.style.fill = ""; }
  }
}

function handleSns(d) {
  S.snsCount++;
  S.lastSnsTs = d.ts;
  setText("sns-topo", `alerts: ${S.snsCount}`);
  flashSVGNode(735, 130, 105, 45, "#448aff");
  addFeedLine({ type: "sns_published", client_id: d.client_id, ok: d.ok }, "aws");
}

function handleS3(d) {
  S.s3Count++;
  S.lastS3Ts = d.ts;
  S.lastS3Key = d.key || "";
  setText("s3-topo", `${d.records} recs`);
  flashSVGNode(735, 230, 105, 45, "#448aff");
  addFeedLine({ type: "s3_flush", records: d.records, key: d.key, ok: d.ok }, "aws");
}

/** Flash a temporary glow rect over an SVG node */
function flashSVGNode(x, y, w, h, color) {
  const dotsLayer = document.getElementById("topo-dots");
  if (!dotsLayer) return;
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", x); r.setAttribute("y", y);
  r.setAttribute("width", w); r.setAttribute("height", h);
  r.setAttribute("rx", "10"); r.setAttribute("fill", "none");
  r.setAttribute("stroke", color); r.setAttribute("stroke-width", "3");
  r.setAttribute("opacity", "0.9");
  dotsLayer.appendChild(r);
  let start = performance.now();
  function fade(now) {
    const t = (now - start) / 600;
    if (t >= 1) { try { r.remove(); } catch(e){} return; }
    r.setAttribute("opacity", String(0.9 * (1 - t)));
    requestAnimationFrame(fade);
  }
  requestAnimationFrame(fade);
}

/** Briefly glow the traffic links for a POP */
function glowLink(pop, isAllow) {
  const popKey = pop || "delhi";
  const cls = isAllow ? "link-active" : "link-active";
  const ids = [`link-cdn-${popKey.substring(0,3)}`, `link-${popKey.substring(0,3)}-sh`];
  // Map full pop names to link IDs
  const linkMap = {
    "mumbai": ["link-cdn-mum", "link-mum-sh"],
    "delhi": ["link-cdn-del", "link-del-sh"],
    "bengaluru": ["link-cdn-blr", "link-blr-sh"],
  };
  const links = linkMap[popKey];
  if (!links) return;
  for (const lid of links) {
    const el = document.getElementById(lid);
    if (!el) continue;
    el.classList.add("link-active");
    setTimeout(() => el.classList.remove("link-active"), 400);
  }
  // Also glow shield→origin for allows
  if (isAllow) {
    const ori = document.getElementById("link-sh-ori");
    if (ori) {
      ori.classList.add("link-active");
      setTimeout(() => ori.classList.remove("link-active"), 400);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TOPOLOGY DOT ANIMATION (smooth bezier-ish motion with glow)
   ══════════════════════════════════════════════════════════════════════════ */
function animateDot(pop, isAllow) {
  const dotsLayer = document.getElementById("topo-dots");
  if (!dotsLayer) return;

  const popKey = pop || "delhi";
  const pathA = PATHS[`cdn-${popKey}`];
  const pathB = PATHS[`${popKey}-shield`];
  if (!pathA || !pathB) return;

  const color = isAllow ? "#00e676" : "#ff1744";
  const segments = [
    { from: [80, 150], to: pathA[0], dur: 120 },   // Client → CDN
    { from: pathA[0], to: pathA[1], dur: 180 },     // CDN → POP
    { from: pathB[0], to: pathB[1], dur: 180 },     // POP → Shield
  ];
  if (isAllow) {
    segments.push({ from: [560,150], to: [640,150], dur: 120 }); // Shield → Origin
  }

  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", "3.5");
  dot.setAttribute("fill", color);
  dot.setAttribute("opacity", "0.95");
  dot.setAttribute("cx", segments[0].from[0]);
  dot.setAttribute("cy", segments[0].from[1]);
  // Glow filter
  dot.setAttribute("filter", "url(#glow)");
  dotsLayer.appendChild(dot);
  activeDots.push(dot);

  let segIdx = 0;
  let segStart = performance.now();

  function step(now) {
    if (segIdx >= segments.length) {
      if (!isAllow) {
        // Flash "429" at shield
        const flash = document.createElementNS(SVG_NS, "text");
        flash.setAttribute("x", "520"); flash.setAttribute("y", "140");
        flash.textContent = "429";
        flash.setAttribute("fill", "#ff1744");
        flash.setAttribute("font-size", "14"); flash.setAttribute("font-weight", "800");
        flash.setAttribute("font-family", "'JetBrains Mono', monospace");
        flash.setAttribute("text-anchor", "middle");
        flash.setAttribute("filter", "url(#glow)");
        dotsLayer.appendChild(flash);
        let fs = performance.now();
        function fadeFlash(n) {
          const t = (n - fs) / 600;
          if (t >= 1) { try { flash.remove(); } catch(e){} return; }
          flash.setAttribute("opacity", String(1 - t));
          flash.setAttribute("y", String(140 - t * 15));
          requestAnimationFrame(fadeFlash);
        }
        requestAnimationFrame(fadeFlash);
      }
      // Fade out the dot
      let fs2 = performance.now();
      function fadeDot(n) {
        const t = (n - fs2) / 200;
        if (t >= 1) {
          try { dot.remove(); } catch(e){}
          activeDots = activeDots.filter(d => d !== dot);
          return;
        }
        dot.setAttribute("opacity", String(0.95 * (1 - t)));
        requestAnimationFrame(fadeDot);
      }
      requestAnimationFrame(fadeDot);
      return;
    }

    const seg = segments[segIdx];
    const elapsed = now - segStart;
    const t = Math.min(1, elapsed / seg.dur);
    // Ease-out cubic
    const e = 1 - Math.pow(1 - t, 3);
    const x = seg.from[0] + (seg.to[0] - seg.from[0]) * e;
    const y = seg.from[1] + (seg.to[1] - seg.from[1]) * e;
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);

    if (t >= 1) {
      segIdx++;
      segStart = now;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ══════════════════════════════════════════════════════════════════════════
   FEED — terminal-style scrolling log
   ══════════════════════════════════════════════════════════════════════════ */
function addFeedLine(d, cls) {
  const now = new Date();
  const ts = now.toLocaleTimeString("en-GB", { hour12: false }) +
             "." + String(now.getMilliseconds()).padStart(3, "0");
  let text = "";
  let lineClass = cls || "";

  if (d.type === "request_decision" || d.decision) {
    const dec = d.decision === "allow" ? "ALLOW" : "DENY";
    lineClass = d.decision === "allow" ? "allow" : "deny";
    const icon = d.decision === "allow" ? "✓" : "✗";
    const extra = d.decision === "allow"
      ? `tokens=${d.tokens_remaining}`
      : `retry=${d.retry_after}s`;
    text = `${ts}  ${icon} ${(d.client_id||"").padEnd(14)}  ${(d.pop||"").padEnd(10)}  ${dec.padEnd(5)}  ${extra}`;
  } else if (d.type === "sync_cycle") {
    text = `${ts}  ⟳ SYNC  ${(d.client_id||"").padEnd(14)}  Δ=${d.delta_reported}  global=${d.global_tokens}  drift=${d.drift}`;
    lineClass = "sync";
  } else if (d.type === "sns_published") {
    text = `${ts}  📢 SNS alert  ${d.client_id}  ${d.ok ? "sent ✓" : "failed ✗"}`;
    lineClass = "aws";
  } else if (d.type === "s3_flush") {
    text = `${ts}  📦 S3 flush  ${d.records} records  ${d.ok ? "✓" : "✗"}  ${d.key||""}`;
    lineClass = "aws";
  } else if (d.type === "redis_status") {
    text = `${ts}  ⚠ REDIS ERROR  ${d.error || "unreachable"}`;
    lineClass = "aws";
  } else {
    text = `${ts}  ${JSON.stringify(d).substring(0, 80)}`;
  }

  S.feedLines.unshift({ text, cls: lineClass });
  if (S.feedLines.length > MAX_FEED) S.feedLines.pop();
}

function renderFeed() {
  if (S.feedPaused) return;
  const container = document.getElementById("feed");
  if (!container) return;
  const filter = document.getElementById("feed-filter").value;

  const lines = S.feedLines.filter(l => {
    if (filter === "all") return true;
    if (filter === "allow") return l.cls === "allow";
    if (filter === "deny") return l.cls === "deny";
    if (filter === "sync") return l.cls === "sync" || l.cls === "aws";
    return true;
  });

  // Build HTML efficiently
  const frags = [];
  const max = Math.min(lines.length, 60);
  for (let i = 0; i < max; i++) {
    frags.push(`<div class="feed-line ${lines[i].cls}">${esc(lines[i].text)}</div>`);
  }
  container.innerHTML = frags.join("");
}

/* ══════════════════════════════════════════════════════════════════════════
   SYNC TIMELINE
   ══════════════════════════════════════════════════════════════════════════ */
function addSyncTick(d) {
  S.syncTicks.push(d);
  if (S.syncTicks.length > MAX_SYNC_TICKS) S.syncTicks.shift();
}

function renderSyncTimeline() {
  const container = document.getElementById("sync-timeline");
  if (!container) return;

  // Only render last 30 for perf
  const ticks = S.syncTicks.slice(-30);
  let html = "";
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    const ok = t.redis_ok !== false;
    html += `<div class="sync-tick${ok ? "" : " fail"}">
      <div class="sync-id">#${S.syncTicks.length - ticks.length + i + 1}</div>
      <div>Δ ${t.delta_reported}</div>
      <div>G ${typeof t.global_tokens === "number" ? t.global_tokens.toFixed(1) : t.global_tokens}</div>
      <div>drift ${typeof t.drift === "number" ? t.drift.toFixed(1) : t.drift}</div>
    </div>`;
  }
  container.innerHTML = html;
  container.scrollLeft = container.scrollWidth;
}

/* ══════════════════════════════════════════════════════════════════════════
   PERIODIC UI UPDATE — 1 Hz via requestAnimationFrame batching
   ══════════════════════════════════════════════════════════════════════════ */
let lastUIUpdate = 0;

function uiTick(now) {
  requestAnimationFrame(uiTick);
  if (now - lastUIUpdate < 1000) return;
  lastUIUpdate = now;

  const sec = Math.floor(Date.now() / 1000);
  if (sec !== S.currentSecond) {
    S.rpsWindow.push({ ts: sec, allow: S.secAllow, deny: S.secDeny });
    if (S.rpsWindow.length > MAX_RPS_WINDOW) S.rpsWindow.shift();
    S.currentSecond = sec;
    S.secAllow = 0;
    S.secDeny = 0;
  }

  updateCounters();
  updateThroughputChart();
  updateBucketPanel();
  updatePopPanel();
  renderFeed();
  renderSyncTimeline();
  updateExplainer();
  updateTopoCounters();
  pollLoadStatus();
  updateClientDropdowns();
}

/* ══════════════════════════════════════════════════════════════════════════
   COUNTER & PANEL UPDATES
   ══════════════════════════════════════════════════════════════════════════ */
function updateCounters() {
  const total = S.totalAllowed + S.totalDenied;
  animateNum("bc-total", total);
  animateNum("bc-allow", S.totalAllowed);
  animateNum("bc-deny", S.totalDenied);
  setText("bc-pct", total > 0 ? (S.totalDenied / total * 100).toFixed(1) + "%" : "0%");

  const lastSec = S.rpsWindow.length > 0 ? S.rpsWindow[S.rpsWindow.length - 1] : null;
  const rps = lastSec ? lastSec.allow + lastSec.deny : 0;
  setText("bc-rps", rps);
}

/** Smooth number transitions for big counters */
function animateNum(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = fmtNum(target);
}

function updateThroughputChart() {
  if (!throughputChart) return;
  const labels = S.rpsWindow.map(w => {
    const d = new Date(w.ts * 1000);
    return d.toLocaleTimeString("en-GB", { hour12: false }).substring(3); // mm:ss
  });
  throughputChart.data.labels = labels;
  throughputChart.data.datasets[0].data = S.rpsWindow.map(w => w.allow);
  throughputChart.data.datasets[1].data = S.rpsWindow.map(w => w.deny);
  throughputChart.update("none");
}

function updateBucketPanel() {
  if (S.bucketHistory.length === 0) return;
  const last = S.bucketHistory[S.bucketHistory.length - 1];
  const cap = S.config.bucket_capacity || 20;
  const pct = Math.max(0, Math.min(100, (last.tokens / cap) * 100));

  const fill = document.getElementById("bucket-fill");
  if (fill) fill.style.height = pct + "%";
  setText("bucket-label", `${last.tokens.toFixed(1)} / ${cap}`);

  if (bucketChart) {
    bucketChart.data.labels = S.bucketHistory.map((_, i) => i);
    bucketChart.data.datasets[0].data = S.bucketHistory.map(h => h.tokens);
    bucketChart.update("none");
  }
}

function updatePopPanel() {
  for (const pop of ["mumbai", "delhi", "bengaluru"]) {
    const ok = S.popAllowed[pop] || 0;
    const deny = S.popDenied[pop] || 0;
    const total = ok + deny;
    const card = document.querySelector(`.pop-card[data-pop="${pop}"]`);
    if (!card) continue;

    const okBar = card.querySelector(".pop-ok");
    const denyBar = card.querySelector(".pop-deny");
    const nums = card.querySelector(".pop-nums");

    if (total > 0) {
      okBar.style.width = (ok / total * 100) + "%";
      denyBar.style.width = (deny / total * 100) + "%";
    } else {
      okBar.style.width = "0%";
      denyBar.style.width = "0%";
    }
    nums.textContent = `✓ ${ok}  ✗ ${deny}  total ${total}`;
  }

  const globalLine = document.getElementById("pop-global-line");
  if (globalLine) {
    const totalOk = S.totalAllowed;
    const cap = S.config.bucket_capacity || 20;
    const refill = S.config.refill_per_sec || 10;
    const elapsed = S.rpsWindow.length;
    const expected = cap + refill * elapsed;
    globalLine.textContent = `GLOBAL allowed: ${totalOk}  (expected ≈ ${Math.round(expected)} = cap ${cap} + ${refill}/s × ${elapsed}s)`;
  }
}

function updateExplainer() {
  const el = document.getElementById("explainer-text");
  const pulseDot = document.querySelector("#explainer .pulse-dot");
  const total = S.totalAllowed + S.totalDenied;
  const lastSec = S.rpsWindow.length > 0 ? S.rpsWindow[S.rpsWindow.length - 1] : null;
  const rps = lastSec ? lastSec.allow + lastSec.deny : 0;

  if (total === 0) {
    el.textContent = "Waiting for traffic… Use the control panel to send requests or choose a preset scenario.";
    return;
  }

  const clients = [...S.clients].map(c => c.replace("key:", "")).join(", ");
  const pops = Object.keys(S.popAllowed).filter(p => (S.popAllowed[p] || 0) + (S.popDenied[p] || 0) > 0);

  let text = `Client ${clients} → ${rps} req/s across ${pops.length} POPs. `;
  text += `Shield: ${fmtNum(S.totalAllowed)} allowed, ${fmtNum(S.totalDenied)} rejected. `;

  if (!S.redisOk) {
    text += "⚠ Redis DOWN — failing open from local bucket.";
    if (pulseDot) pulseDot.className = "pulse-dot red";
  } else {
    text += "Global rate limit holding.";
    if (pulseDot) pulseDot.className = "pulse-dot green";
  }

  el.textContent = text;
}

function updateTopoCounters() {
  const lastSec = S.rpsWindow.length > 0 ? S.rpsWindow[S.rpsWindow.length - 1] : { allow: 0, deny: 0 };
  const rps = lastSec.allow + lastSec.deny;
  setText("ctr-client", rps + " rps");
  setText("ctr-cdn", rps + " rps");
  setText("ctr-shield", `${lastSec.allow}✓ ${lastSec.deny}✗`);
  setText("ctr-origin", lastSec.allow + " ok");

  for (const pop of ["mumbai", "delhi", "bengaluru"]) {
    const ok = S.popAllowed[pop] || 0;
    const deny = S.popDenied[pop] || 0;
    setText(`ctr-${pop}`, `${ok + deny}`);
  }
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
    if (current) sel.value = current;
  }
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
      setText("bc-p50", (data.counters.p50_latency_ms || 0).toFixed(2));
      setText("bc-p95", (data.counters.p95_latency_ms || 0).toFixed(2));
    }
    if (data.config) {
      S.config = data.config;
      document.getElementById("ctl-capacity").value = data.config.bucket_capacity;
      document.getElementById("ctl-refill").value = data.config.refill_per_sec;
    }
    if (data.aws) {
      S.awsState = data.aws;
      updateAWSPanel(data.aws);
    }
    S.redisOk = data.redis_ok !== false;
    if (data.buckets) {
      for (const b of data.buckets) {
        S.clients.add(b.client_id);
        S.bucketHistory.push({ ts: Date.now() / 1000, tokens: b.local_tokens });
      }
    }

    const hResp = await fetch("/api/health");
    const hData = await hResp.json();
    S.dockerControl = hData.docker_control || false;
    updateHealthDots(hData);
    setupRedisControl();
  } catch (e) {
    console.warn("fetchState failed:", e);
  }
}

function updateHealthDots(data) {
  const mapping = {
    cdn: "h-cdn", shield: "h-shield", origin: "h-origin",
    "edge-mumbai": "h-mumbai", "edge-delhi": "h-delhi", "edge-bengaluru": "h-bengaluru",
    redis: "h-redis",
  };
  for (const [svc, dotId] of Object.entries(mapping)) {
    const dot = document.getElementById(dotId);
    const ok = data[svc] && data[svc].ok;
    if (dot) dot.classList.toggle("down", !ok);
  }
}

function updateAWSPanel(aws) {
  const cards = {
    "aws-elasticache": aws.elasticache,
    "aws-cloudwatch": aws.cloudwatch,
    "aws-sns": aws.sns,
    "aws-s3": aws.s3,
  };
  for (const [id, info] of Object.entries(cards)) {
    const card = document.getElementById(id);
    if (!card) continue;
    const st = card.querySelector(".aws-st");
    const detail = card.querySelector(".aws-detail");
    if (info && info.enabled) {
      st.textContent = "ENABLED";
      st.className = "aws-st enabled";
      card.style.borderLeftColor = "#448aff";
      if (id === "aws-cloudwatch" && info.log_group) {
        detail.textContent = info.log_group;
        setText("cw-topo", S.cwCount > 0 ? `${S.cwCount} logs` : "active");
      }
      if (id === "aws-s3" && info.buffer_size !== undefined) detail.textContent = `buffer: ${info.buffer_size}`;
    } else {
      st.textContent = "DISABLED";
      st.className = "aws-st disabled";
      card.style.borderLeftColor = "#2d3a4f";
      detail.textContent = "not configured";
      if (id === "aws-cloudwatch") setText("cw-topo", "disabled");
    }
  }
}

function setupRedisControl() {
  const area = document.getElementById("redis-control-area");
  const manual = document.getElementById("redis-manual-cmd");
  if (S.dockerControl) {
    area.style.display = "";
    manual.style.display = "none";
  } else {
    area.style.display = "none";
    manual.style.display = "";
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
    if (d.running) {
      el.textContent = `▶ ${d.sent} sent • ${d.ok} ok • ${d.denied} denied • ${d.current_rps} rps • ${d.elapsed}s`;
      el.style.color = "#00e676";
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
   CHARTS — dark-themed with transparent backgrounds
   ══════════════════════════════════════════════════════════════════════════ */
function initCharts() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js not loaded — charts will be unavailable");
    return;
  }

  // Global dark theme
  Chart.defaults.color = "#8b9bb4";
  Chart.defaults.borderColor = "#2d3a4f";
  Chart.defaults.font.family = "'JetBrains Mono', 'Consolas', monospace";
  Chart.defaults.font.size = 10;
  Chart.defaults.backgroundColor = "transparent";

  // Throughput chart — stacked bar
  const tCtx = document.getElementById("throughput-chart");
  if (tCtx) {
    throughputChart = new Chart(tCtx, {
      type: "bar",
      data: {
        labels: [],
        datasets: [
          {
            label: "Allowed (200)",
            data: [],
            backgroundColor: "rgba(0, 230, 118, 0.6)",
            borderColor: "#00e676",
            borderWidth: 1,
            borderRadius: 2,
          },
          {
            label: "Denied (429)",
            data: [],
            backgroundColor: "rgba(255, 23, 68, 0.6)",
            borderColor: "#ff1744",
            borderWidth: 1,
            borderRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            display: true,
            stacked: true,
            ticks: { maxTicksLimit: 8, color: "#6b7c94" },
            grid: { color: "rgba(45,58,79,0.5)" },
          },
          y: {
            display: true,
            stacked: true,
            beginAtZero: true,
            ticks: { color: "#6b7c94" },
            grid: { color: "rgba(45,58,79,0.5)" },
          },
        },
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 8, padding: 12, color: "#8b9bb4" },
          },
        },
      },
    });
  }

  // Bucket history — smooth line
  const bCtx = document.getElementById("bucket-chart");
  if (bCtx) {
    bucketChart = new Chart(bCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          label: "Tokens",
          data: [],
          borderColor: "#00e676",
          backgroundColor: "rgba(0, 230, 118, 0.08)",
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { display: false },
          y: {
            display: true,
            beginAtZero: true,
            suggestedMax: 25,
            ticks: { color: "#6b7c94" },
            grid: { color: "rgba(45,58,79,0.5)" },
          },
        },
        plugins: { legend: { display: false } },
      },
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CONTROL PANEL EVENT HANDLERS
   ══════════════════════════════════════════════════════════════════════════ */
function setupControls() {
  const rpsSlider = document.getElementById("ctl-rps");
  const rpsVal = document.getElementById("ctl-rps-val");
  rpsSlider.addEventListener("input", () => { rpsVal.textContent = rpsSlider.value; });

  const durSlider = document.getElementById("ctl-duration");
  const durVal = document.getElementById("ctl-duration-val");
  durSlider.addEventListener("input", () => { durVal.textContent = durSlider.value; });

  // Fire single request
  document.getElementById("btn-fire").addEventListener("click", async () => {
    const btn = document.getElementById("btn-fire");
    btn.style.transform = "scale(0.95)";
    setTimeout(() => { btn.style.transform = ""; }, 150);
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

  // Burst
  document.getElementById("btn-burst").addEventListener("click", async () => {
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

  // Load start
  document.getElementById("btn-load-start").addEventListener("click", async () => {
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

  // Load stop
  document.getElementById("btn-load-stop").addEventListener("click", async () => {
    try { await fetch("/api/load/stop", { method: "POST" }); } catch(e) {}
  });

  // Config
  document.getElementById("btn-config").addEventListener("click", async () => {
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

  // Reset
  document.getElementById("btn-reset").addEventListener("click", async () => {
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

  // Redis control
  document.getElementById("btn-redis-stop").addEventListener("click", async () => {
    try { await fetch("/api/docker/redis/stop", { method: "POST" }); } catch(e) {}
  });
  document.getElementById("btn-redis-start").addEventListener("click", async () => {
    try { await fetch("/api/docker/redis/start", { method: "POST" }); } catch(e) {}
  });

  // Feed pause
  document.getElementById("feed-pause").addEventListener("click", () => {
    S.feedPaused = !S.feedPaused;
    const btn = document.getElementById("feed-pause");
    btn.textContent = S.feedPaused ? "▶" : "⏸";
    btn.title = S.feedPaused ? "Resume feed" : "Pause feed";
  });

  // Presets
  document.querySelectorAll(".preset").forEach(btn => {
    btn.addEventListener("click", () => runPreset(btn.dataset.preset));
  });
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
   HELPERS
   ══════════════════════════════════════════════════════════════════════════ */
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function fmtNum(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + "M";
  if (n >= 10000) return (n/1000).toFixed(1) + "K";
  if (n >= 1000) return (n/1000).toFixed(1) + "K";
  return String(n);
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */
function init() {
  initCharts();
  setupControls();
  connectSSE();
  requestAnimationFrame(uiTick);

  // Periodic state refresh (latencies, AWS, bucket details)
  setInterval(async () => {
    try {
      const r = await fetch("/api/state");
      const data = await r.json();
      if (data.counters) {
        setText("bc-p50", (data.counters.p50_latency_ms || 0).toFixed(2));
        setText("bc-p95", (data.counters.p95_latency_ms || 0).toFixed(2));
      }
      if (data.aws) updateAWSPanel(data.aws);
      if (data.buckets && data.buckets.length > 0) {
        const sel = document.getElementById("bucket-client-select").value;
        const b = data.buckets.find(x => x.client_id === sel) || data.buckets[0];
        if (b) {
          setText("bucket-local", b.local_tokens.toFixed(1));
          setText("bucket-global-val", b.last_global_tokens >= 0 ? b.last_global_tokens.toFixed(1) : "—");
          setText("bucket-drift", b.last_global_tokens >= 0
            ? Math.abs(b.local_tokens - b.last_global_tokens).toFixed(1) : "—");
          setText("bucket-delta", b.unsynced_delta.toFixed(1));

          const cap = b.capacity || 20;
          const pct = Math.max(0, Math.min(100, (b.local_tokens / cap) * 100));
          const fill = document.getElementById("bucket-fill");
          if (fill) fill.style.height = pct + "%";
          setText("bucket-label", `${b.local_tokens.toFixed(1)} / ${cap}`);

          if (b.last_global_tokens >= 0) {
            const gPct = Math.max(0, Math.min(100, (b.last_global_tokens / cap) * 100));
            const gm = document.getElementById("bucket-global");
            if (gm) { gm.style.bottom = gPct + "%"; gm.style.display = ""; }
          }

          S.bucketHistory.push({ ts: Date.now() / 1000, tokens: b.local_tokens });
          if (S.bucketHistory.length > MAX_BUCKET_HIST) S.bucketHistory.shift();
        }
      }
      const mode = data.aws && data.aws.elasticache && data.aws.elasticache.enabled
        ? "ELASTICACHE" : "LOCAL REDIS";
      setText("sync-mode", mode);
    } catch(e) {}
  }, 2000);
}

document.addEventListener("DOMContentLoaded", init);

})();
