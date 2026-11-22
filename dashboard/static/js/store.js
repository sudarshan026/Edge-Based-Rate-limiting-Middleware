/* ═══════════════════════════════════════════════════════════════════════════
   store.js — Central State Store with Ring Buffers
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

/** Ring buffer for bounded memory */
class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.data = [];
  }
  push(item) {
    this.data.push(item);
    if (this.data.length > this.capacity) this.data.shift();
  }
  get length() { return this.data.length; }
  get last() { return this.data.length > 0 ? this.data[this.data.length - 1] : null; }
  slice(start, end) { return this.data.slice(start, end); }
  clear() { this.data.length = 0; }
  [Symbol.iterator]() { return this.data[Symbol.iterator](); }
  toArray() { return this.data.slice(); }
  map(fn) { return this.data.map(fn); }
  filter(fn) { return this.data.filter(fn); }
  forEach(fn) { this.data.forEach(fn); }
}

/** Global application state */
window.Store = {
  connected: false,
  lowFx: false,
  presentationMode: false,

  // Counters
  totalAllowed: 0,
  totalDenied: 0,
  popAllowed: {},
  popDenied: {},

  // Per-second tracking
  currentSecond: 0,
  secAllow: 0,
  secDeny: 0,

  // Ring buffers
  rpsWindow: new RingBuffer(60),       // { ts, allow, deny }
  bucketHistory: new RingBuffer(60),    // { ts, tokens }
  feedLines: new RingBuffer(200),       // { text, cls, ts }
  syncTicks: new RingBuffer(60),        // sync cycle data

  // Sync/AWS counters
  syncCount: 0,
  cwCount: 0,
  snsCount: 0,
  s3Count: 0,
  lastSnsTs: 0,
  lastS3Ts: 0,
  lastS3Key: "",

  // Redis
  redisOk: true,

  // AWS
  awsState: {},

  // Config
  config: {
    bucket_capacity: 20,
    refill_per_sec: 10,
    sync_interval: 1
  },

  // Clients
  clients: new Set(),

  // Docker
  dockerControl: false,

  // Feed
  feedPaused: false,

  // Global proof tracking
  proof: {
    firstRequestTs: 0,
    runActive: false,
    lastActivityTs: 0,
    idleCheckTimer: null,
  },

  // Latency
  p50: 0,
  p95: 0,

  // Particle count for topology
  activeParticles: 0,
  maxParticles: 300,

  // Animated counter targets (for odometer effect)
  counterTargets: {},
  counterCurrents: {},

  // Entrance animation completed
  entranceComplete: false,

  // Rate limit flash shown for this run
  rateLimitFlashShown: false,

  // Event listeners
  _listeners: {},

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  },

  emit(event, data) {
    const fns = this._listeners[event];
    if (fns) fns.forEach(fn => { try { fn(data); } catch(e) { console.error(e); } });
  },

  /** Reset run-specific state */
  resetRun() {
    this.totalAllowed = 0;
    this.totalDenied = 0;
    this.popAllowed = {};
    this.popDenied = {};
    this.rpsWindow.clear();
    this.bucketHistory.clear();
    this.feedLines.clear();
    this.syncTicks.clear();
    this.syncCount = 0;
    this.cwCount = 0;
    this.snsCount = 0;
    this.s3Count = 0;
    this.secAllow = 0;
    this.secDeny = 0;
    this.proof.firstRequestTs = 0;
    this.proof.runActive = false;
    this.proof.lastActivityTs = 0;
    this.rateLimitFlashShown = false;
    this.emit('reset');
  },

  /** Mark proof run start */
  markActivity() {
    const now = Date.now() / 1000;
    if (!this.proof.runActive) {
      this.proof.firstRequestTs = now;
      this.proof.runActive = true;
    }
    this.proof.lastActivityTs = now;
  },

  /** Check if proof run should auto-stop (5s idle) */
  checkProofIdle() {
    if (!this.proof.runActive) return;
    const now = Date.now() / 1000;
    if (now - this.proof.lastActivityTs > 5) {
      this.proof.runActive = false;
      this.proof.firstRequestTs = 0;
    }
  }
};

/** Utility: safe setText */
window.setText = function(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

/** Utility: escape HTML */
window.escHTML = function(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
};

/** Utility: format large numbers */
window.fmtNum = function(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
};

/** Utility: animated counter with odometer effect */
window.animateCounter = function(id, target) {
  const S = window.Store;
  S.counterTargets[id] = target;
  if (S.counterCurrents[id] === undefined) S.counterCurrents[id] = 0;
};

/** Called each frame to interpolate counters */
window.tickCounters = function() {
  const S = window.Store;
  for (const [id, target] of Object.entries(S.counterTargets)) {
    const current = S.counterCurrents[id] || 0;
    if (current === target) continue;
    const diff = target - current;
    const step = Math.abs(diff) > 100 ? Math.ceil(diff * 0.15) :
                 Math.abs(diff) > 10 ? Math.ceil(diff * 0.3) :
                 diff;
    S.counterCurrents[id] = current + step;
    const el = document.getElementById(id);
    if (el) el.textContent = fmtNum(S.counterCurrents[id]);
  }
};
