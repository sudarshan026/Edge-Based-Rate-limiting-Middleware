/* ═══════════════════════════════════════════════════════════════════════════
   feed.js — Live Feed & Sync Timeline
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

(function() {
  const S = window.Store;
  let feedContainer, syncContainer;
  let lastFeedLength = 0;
  let lastSyncLength = 0;

  function init() {
    feedContainer = document.getElementById("feed");
    syncContainer = document.getElementById("sync-timeline");
  }

  // ── Feed Lines ──

  function addFeedLine(d, cls) {
    const now = new Date();
    const ts = now.toLocaleTimeString("en-GB", { hour12: false }) +
               "." + String(now.getMilliseconds()).padStart(3, "0");
    let text = "";
    let lineClass = cls || "";
    let badge = "";

    if (d.type === "request_decision" || d.decision) {
      const isAllow = d.decision === "allow";
      lineClass = isAllow ? "allow" : "deny";
      badge = isAllow ? '<span class="feed-badge allow">ALLOW</span>' : '<span class="feed-badge deny">DENY</span>';
      const extra = isAllow ? `tokens=${d.tokens_remaining}` : `retry=${d.retry_after}s`;
      text = `${ts}  ${(d.client_id || "").padEnd(14)}  ${(d.pop || "").padEnd(10)}  ${extra}`;
    } else if (d.type === "sync_cycle") {
      badge = '<span class="feed-badge sync">SYNC</span>';
      text = `${ts}  ${(d.client_id || "").padEnd(14)}  Δ=${d.delta_reported}  global=${d.global_tokens}  drift=${d.drift}`;
      lineClass = "sync";
    } else if (d.type === "sns_published") {
      badge = '<span class="feed-badge aws">SNS</span>';
      text = `${ts}  ${d.client_id}  ${d.ok ? "sent ✓" : "failed ✗"}`;
      lineClass = "aws";
    } else if (d.type === "s3_flush") {
      badge = '<span class="feed-badge aws">S3</span>';
      text = `${ts}  ${d.records} records  ${d.ok ? "✓" : "✗"}  ${d.key || ""}`;
      lineClass = "aws";
    } else if (d.type === "redis_status") {
      badge = '<span class="feed-badge deny">REDIS</span>';
      text = `${ts}  ${d.error || "unreachable"}`;
      lineClass = "aws";
    } else {
      text = `${ts}  ${JSON.stringify(d).substring(0, 80)}`;
    }

    S.feedLines.push({ text, cls: lineClass, badge, ts: Date.now() });
  }

  function renderFeed() {
    if (!feedContainer || S.feedPaused) return;

    const filter = document.getElementById("feed-filter");
    const filterVal = filter ? filter.value : "all";

    const lines = S.feedLines.filter(l => {
      if (filterVal === "all") return true;
      if (filterVal === "allow") return l.cls === "allow";
      if (filterVal === "deny") return l.cls === "deny";
      if (filterVal === "sync") return l.cls === "sync" || l.cls === "aws";
      return true;
    });

    // Show/hide empty state
    const emptyEl = document.getElementById("feed-empty");
    if (emptyEl) emptyEl.style.display = lines.length === 0 ? "" : "none";
    if (lines.length === 0) return;

    const max = Math.min(lines.length, 60);
    const recent = lines.slice(-max).reverse();
    const isNewLine = S.feedLines.length !== lastFeedLength;
    lastFeedLength = S.feedLines.length;

    const frags = [];
    for (let i = 0; i < recent.length; i++) {
      const l = recent[i];
      const slideClass = i === 0 && isNewLine ? ' slide-in' : '';
      const glowClass = i === 0 && isNewLine ? ' glow-flash' : '';
      frags.push(`<div class="feed-line ${l.cls}${slideClass}${glowClass}">${l.badge || ''}${escHTML(l.text)}</div>`);
    }
    feedContainer.innerHTML = frags.join("");
  }

  // ── Sync Timeline ──

  function addSyncTick(d) {
    S.syncTicks.push(d);
  }

  function renderSyncTimeline() {
    if (!syncContainer) return;

    const ticks = S.syncTicks.slice(-30);

    // Show/hide empty state
    const emptyEl = document.getElementById("sync-empty");
    if (emptyEl) emptyEl.style.display = ticks.length === 0 ? "" : "none";
    if (ticks.length === 0) return;

    let html = "";
    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i];
      const ok = t.redis_ok !== false;
      html += `<div class="sync-tick${ok ? '' : ' fail'}">
        <div class="sync-id">#${S.syncTicks.length - ticks.length + i + 1}</div>
        <div>Δ ${t.delta_reported}</div>
        <div>G ${typeof t.global_tokens === "number" ? t.global_tokens.toFixed(1) : t.global_tokens}</div>
        <div>drift ${typeof t.drift === "number" ? t.drift.toFixed(1) : t.drift}</div>
      </div>`;
    }
    syncContainer.innerHTML = html;
    syncContainer.scrollLeft = syncContainer.scrollWidth;
  }

  // ── Public API ──
  window.Feed = {
    init,
    addLine: addFeedLine,
    render: renderFeed,
    addSyncTick,
    renderSync: renderSyncTimeline,
  };
})();
