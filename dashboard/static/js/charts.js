/* ═══════════════════════════════════════════════════════════════════════════
   charts.js — Throughput Chart, POP Distribution, Global Proof Card
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

(function() {
  const S = window.Store;
  let throughputChart = null;
  let bucketChart = null;

  function initCharts() {
    if (typeof Chart === "undefined") {
      console.warn("Chart.js not loaded");
      return;
    }

    // Global dark theme
    Chart.defaults.color = "#6b7c94";
    Chart.defaults.borderColor = "rgba(45,58,79,0.5)";
    Chart.defaults.font.family = "'JetBrains Mono', 'Consolas', monospace";
    Chart.defaults.font.size = 10;

    initThroughputChart();
    initBucketChart();
  }

  function initThroughputChart() {
    const el = document.getElementById("throughput-chart");
    if (!el) return;

    const gradientGreen = el.getContext("2d").createLinearGradient(0, 0, 0, 200);
    gradientGreen.addColorStop(0, "rgba(0,255,157,0.3)");
    gradientGreen.addColorStop(1, "rgba(0,255,157,0.02)");

    const gradientRed = el.getContext("2d").createLinearGradient(0, 0, 0, 200);
    gradientRed.addColorStop(0, "rgba(255,46,99,0.3)");
    gradientRed.addColorStop(1, "rgba(255,46,99,0.02)");

    throughputChart = new Chart(el, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Allowed",
            data: [],
            borderColor: "#00ff9d",
            backgroundColor: gradientGreen,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: "Denied",
            data: [],
            borderColor: "#ff2e63",
            backgroundColor: gradientRed,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        scales: {
          x: {
            display: true,
            ticks: {
              maxTicksLimit: 10,
              color: "#6b7c94",
              autoSkip: true,
              maxRotation: 0,
            },
            grid: { color: "rgba(45,58,79,0.3)" },
          },
          y: {
            display: true,
            beginAtZero: true,
            ticks: { color: "#6b7c94" },
            grid: { color: "rgba(45,58,79,0.3)" },
          },
        },
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 8, padding: 12, color: "#8b9bb4", font: { size: 10 } },
          },
          annotation: undefined,
        },
      },
    });
  }

  function initBucketChart() {
    const el = document.getElementById("bucket-chart");
    if (!el) return;

    bucketChart = new Chart(el, {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          label: "Tokens",
          data: [],
          borderColor: "#00ff9d",
          backgroundColor: "rgba(0,255,157,0.08)",
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
            grid: { color: "rgba(45,58,79,0.3)" },
          },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── Update functions ──

  function updateThroughputChart() {
    if (!throughputChart) return;
    const labels = S.rpsWindow.map(w => {
      const d = new Date(w.ts * 1000);
      return d.toLocaleTimeString("en-GB", { hour12: false }).substring(3);
    });
    throughputChart.data.labels = labels;
    throughputChart.data.datasets[0].data = S.rpsWindow.map(w => w.allow);
    throughputChart.data.datasets[1].data = S.rpsWindow.map(w => w.deny);
    throughputChart.update("none");
  }

  function updateBucketChart() {
    if (!bucketChart) return;
    bucketChart.data.labels = S.bucketHistory.map((_, i) => i);
    bucketChart.data.datasets[0].data = S.bucketHistory.map(h => h.tokens);
    bucketChart.update("none");
  }

  // ── Counters ──

  function updateCounters() {
    const total = S.totalAllowed + S.totalDenied;
    animateCounter("bc-total", total);
    animateCounter("bc-allow", S.totalAllowed);
    animateCounter("bc-deny", S.totalDenied);
    setText("bc-pct", total > 0 ? (S.totalDenied / total * 100).toFixed(1) + "%" : "0%");

    const lastSec = S.rpsWindow.last;
    const rps = lastSec ? lastSec.allow + lastSec.deny : 0;
    setText("bc-rps", rps);
    setText("bc-p50", S.p50.toFixed(1));
    setText("bc-p95", S.p95.toFixed(1));
  }

  // ── POP Distribution ──

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
  }

  // ── Global Proof Card ──

  function updateProofCard() {
    S.checkProofIdle();

    const verdictEl = document.getElementById("proof-verdict-text");
    const verdictContainer = document.getElementById("proof-verdict");
    const actualBar = document.getElementById("proof-actual");
    const expectedBand = document.getElementById("proof-expected-band");
    const actualLabel = document.getElementById("proof-actual-label");
    const expectedLabel = document.getElementById("proof-expected-label");
    const detailEl = document.getElementById("proof-detail");

    if (!verdictEl) return;

    const cap = S.config.bucket_capacity || 20;
    const refill = S.config.refill_per_sec || 10;

    if (!S.proof.runActive || S.totalAllowed === 0) {
      verdictEl.textContent = "AWAITING DATA";
      if (verdictContainer) verdictContainer.className = "proof-verdict neutral";
      if (actualBar) actualBar.style.width = "0%";
      if (detailEl) detailEl.textContent = `Cap: ${cap} • Refill: ${refill}/s`;
      return;
    }

    const now = Date.now() / 1000;
    const elapsed = Math.max(1, now - S.proof.firstRequestTs);
    const expected = cap + refill * elapsed;
    const actual = S.totalAllowed;
    const tolerance = expected * 0.15; // 15% tolerance
    const diff = Math.abs(actual - expected);
    const ratio = expected > 0 ? (actual / expected) * 100 : 0;

    if (actualBar) actualBar.style.width = Math.min(100, ratio) + "%";
    if (expectedBand) {
      const lowPct = Math.max(0, (1 - 0.15) * 100);
      const highPct = Math.min(100, (1 + 0.15) * 100);
      expectedBand.style.left = lowPct + "%";
      expectedBand.style.width = (highPct - lowPct) + "%";
    }
    if (actualLabel) actualLabel.textContent = `Actual: ${actual}`;
    if (expectedLabel) expectedLabel.textContent = `Expected: ≈${Math.round(expected)}`;

    if (diff <= tolerance) {
      verdictEl.textContent = "HOLDING";
      if (verdictContainer) verdictContainer.className = "proof-verdict pass";
    } else if (actual < expected) {
      verdictEl.textContent = "DRIFTING (under)";
      if (verdictContainer) verdictContainer.className = "proof-verdict warn";
    } else {
      verdictEl.textContent = "DRIFTING (over)";
      if (verdictContainer) verdictContainer.className = "proof-verdict fail";
    }

    if (detailEl) {
      detailEl.textContent = `Elapsed: ${elapsed.toFixed(0)}s • Cap: ${cap} • Refill: ${refill}/s • Δ: ${(actual - expected).toFixed(0)}`;
    }
  }

  // ── Public API ──
  window.Charts = {
    init: initCharts,
    updateThroughput: updateThroughputChart,
    updateBucket: updateBucketChart,
    updateCounters,
    updatePop: updatePopPanel,
    updateProof: updateProofCard,
  };
})();
