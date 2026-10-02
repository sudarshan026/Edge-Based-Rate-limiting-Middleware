"""
Origin Shield — the heart of the system.

Responsibilities
----------------
• In-memory token bucket per client_id (local, zero-latency allow/deny)
• On reject: HTTP 429 + Retry-After header
• On allow: forward to Origin Server and return its response
• Background Batch Sync Daemon (asyncio task):
    - Every SYNC_INTERVAL seconds, for every dirty client bucket:
        * Atomically report delta usage to Redis
        * Pull back the authoritative global token count (one Lua script)
        * Reconcile local state (drift compensation)
    - Redis failure → fail open (keep serving from local state, retry next cycle)

Env vars
--------
ORIGIN_URL       : URL of the origin server              (default: http://origin:8000)
REDIS_URL        : Redis connection URL                  (default: redis://redis:6379)
BUCKET_CAPACITY  : Max tokens per client bucket          (default: 20)
REFILL_PER_SEC   : Tokens added per second               (default: 10)
SYNC_INTERVAL    : Seconds between batch sync runs       (default: 1.0)
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ORIGIN_URL: str = os.environ.get("ORIGIN_URL", "http://origin:8000")
REDIS_URL: str = os.environ.get("REDIS_URL", "redis://redis:6379")
BUCKET_CAPACITY: float = float(os.environ.get("BUCKET_CAPACITY", "20"))
REFILL_PER_SEC: float = float(os.environ.get("REFILL_PER_SEC", "10"))
SYNC_INTERVAL: float = float(os.environ.get("SYNC_INTERVAL", "1.0"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [SHIELD] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lua script — executed atomically on Redis
#
# KEYS[1]  = "rl:{client_id}"  (hash key in Redis)
# ARGV[1]  = delta usage (tokens consumed since last sync)
# ARGV[2]  = bucket capacity (max tokens)
# ARGV[3]  = refill rate (tokens/sec)
# ARGV[4]  = key TTL in seconds
#
# The script:
#   1. Gets Redis's own wall-clock time (avoids cross-node clock skew)
#   2. Retrieves stored {tokens, last_refill_ts} from the hash
#   3. Refills tokens based on elapsed time
#   4. Deducts the reported delta
#   5. Persists updated state
#   6. Returns the authoritative token count
# ---------------------------------------------------------------------------
LUA_SYNC_SCRIPT = """
local key       = KEYS[1]
local delta     = tonumber(ARGV[1])
local capacity  = tonumber(ARGV[2])
local refill    = tonumber(ARGV[3])
local ttl       = tonumber(ARGV[4])

-- Use Redis TIME for authoritative, skew-free timestamps
local t         = redis.call('TIME')
local now_sec   = tonumber(t[1]) + tonumber(t[2]) / 1e6

local stored    = redis.call('HMGET', key, 'tokens', 'last_ts')
local tokens    = tonumber(stored[1]) or capacity
local last_ts   = tonumber(stored[2]) or now_sec

-- Refill based on elapsed wall-clock time
local elapsed   = math.max(0, now_sec - last_ts)
tokens          = math.min(capacity, tokens + elapsed * refill)

-- Deduct the delta usage reported by this shield instance
tokens          = math.max(0, tokens - delta)

-- Persist back to Redis with a TTL (so idle keys expire automatically)
redis.call('HMSET', key, 'tokens', tokens, 'last_ts', now_sec)
redis.call('EXPIRE', key, ttl)

return tostring(tokens)
"""

# ---------------------------------------------------------------------------
# In-memory token bucket (per client_id, local to this shield instance)
# ---------------------------------------------------------------------------
@dataclass
class Bucket:
    """Local token bucket — refilled lazily on each consume() call."""

    capacity: float
    refill_per_sec: float
    tokens: float = field(init=False)
    last_refill: float = field(init=False)
    # Tokens consumed since the last Redis sync (the "delta" we'll report)
    unsynced_delta: float = field(default=0.0)
    # Protect concurrent access within this event loop
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        self.tokens = self.capacity
        self.last_refill = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self.last_refill
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_per_sec)
        self.last_refill = now

    async def consume(self) -> bool:
        """Try to consume 1 token. Returns True if allowed, False if rejected."""
        async with self.lock:
            self._refill()
            if self.tokens >= 1.0:
                self.tokens -= 1.0
                self.unsynced_delta += 1.0
                return True
            return False

    async def reconcile(self, global_tokens: float) -> None:
        """
        Drift compensation after a Redis sync.

        After reporting delta D and getting back global count G:
          local_tokens = G  (Redis is the source of truth for the global quota)

        We do NOT subtract in-flight requests that happened during the sync window
        because those are already baked into `unsynced_delta` (which was zeroed
        before the awaited Redis call).  Any NEW tokens consumed between zeroing
        the delta and now will be in the NEXT sync cycle.
        """
        async with self.lock:
            self.tokens = min(self.capacity, max(0.0, global_tokens))


# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
_buckets: dict[str, Bucket] = {}
_buckets_lock = asyncio.Lock()

_redis_client: aioredis.Redis | None = None
_http_client: httpx.AsyncClient | None = None
_lua_sha: str | None = None   # EVALSHA handle for the Lua script
_sync_task: asyncio.Task | None = None  # type: ignore[type-arg]


def _get_redis() -> aioredis.Redis:
    assert _redis_client is not None, "Redis not initialised"
    return _redis_client


def _get_http() -> httpx.AsyncClient:
    assert _http_client is not None, "HTTP client not initialised"
    return _http_client


async def _get_or_create_bucket(client_id: str) -> Bucket:
    async with _buckets_lock:
        if client_id not in _buckets:
            _buckets[client_id] = Bucket(
                capacity=BUCKET_CAPACITY,
                refill_per_sec=REFILL_PER_SEC,
            )
        return _buckets[client_id]


# ---------------------------------------------------------------------------
# Batch Sync Daemon
# ---------------------------------------------------------------------------
async def _batch_sync_daemon() -> None:
    """
    Runs in the background at SYNC_INTERVAL cadence.

    For each client that has consumed tokens since the last sync:
      1. Capture and reset the unsynced_delta atomically.
      2. Call the Lua script on Redis → get the authoritative global token count.
      3. Reconcile the local bucket (drift compensation).
      4. On any Redis error: log, skip that client, retry next cycle (fail-open).
    """
    logger.info(
        "Batch sync daemon started (interval=%.1fs, capacity=%g, refill=%g/s)",
        SYNC_INTERVAL, BUCKET_CAPACITY, REFILL_PER_SEC,
    )

    # TTL for Redis keys: auto-expire idle client records after 10× the capacity
    # in seconds (generous headroom so no active client gets evicted)
    key_ttl = int(max(60, BUCKET_CAPACITY / REFILL_PER_SEC * 10))

    while True:
        await asyncio.sleep(SYNC_INTERVAL)

        # Snapshot the current client set (avoid holding the global lock during I/O)
        async with _buckets_lock:
            client_ids = list(_buckets.keys())

        for client_id in client_ids:
            bucket = _buckets.get(client_id)
            if bucket is None:
                continue

            # --- Atomically capture delta, then zero it out ---
            async with bucket.lock:
                delta = bucket.unsynced_delta
                if delta == 0.0:
                    # Nothing to report; still worth syncing to pull latest global state
                    # but we skip to keep Redis traffic low for idle clients
                    continue
                bucket.unsynced_delta = 0.0

            # --- Call Redis Lua script ---
            redis_key = f"rl:{client_id}"
            try:
                r = _get_redis()
                if _lua_sha is not None:
                    try:
                        result = await r.evalsha(
                            _lua_sha,
                            1,
                            redis_key,
                            delta,
                            BUCKET_CAPACITY,
                            REFILL_PER_SEC,
                            key_ttl,
                        )
                    except aioredis.ResponseError:
                        # Script evicted from Redis (e.g. FLUSHALL); reload & retry
                        result = await r.eval(   # type: ignore[attr-defined]
                            LUA_SYNC_SCRIPT,
                            1,
                            redis_key,
                            delta,
                            BUCKET_CAPACITY,
                            REFILL_PER_SEC,
                            key_ttl,
                        )
                else:
                    result = await r.eval(   # type: ignore[attr-defined]
                        LUA_SYNC_SCRIPT,
                        1,
                        redis_key,
                        delta,
                        BUCKET_CAPACITY,
                        REFILL_PER_SEC,
                        key_ttl,
                    )

                global_tokens = float(result)
                logger.debug(
                    "sync  client=%s  delta=%.1f  global_tokens=%.2f",
                    client_id, delta, global_tokens,
                )
                await bucket.reconcile(global_tokens)

            except Exception as exc:  # noqa: BLE001
                # Fail open: restore the delta so it's included in the next cycle
                async with bucket.lock:
                    bucket.unsynced_delta += delta
                logger.warning(
                    "Redis sync failed for client=%s: %s — failing open",
                    client_id, exc,
                )


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _redis_client, _http_client, _lua_sha, _sync_task

    logger.info(
        "Shield starting — origin=%s  redis=%s  capacity=%g  refill=%g/s  sync=%.1fs",
        ORIGIN_URL, REDIS_URL, BUCKET_CAPACITY, REFILL_PER_SEC, SYNC_INTERVAL,
    )

    # --- Redis ---
    _redis_client = aioredis.from_url(
        REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=3,
        retry_on_timeout=True,
    )
    # Pre-load Lua script so we can use EVALSHA (saves bandwidth per call)
    try:
        _lua_sha = await _redis_client.script_load(LUA_SYNC_SCRIPT)
        logger.info("Lua script loaded — sha=%s", _lua_sha)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not pre-load Lua script (%s); will use EVAL fallback", exc)
        _lua_sha = None

    # --- HTTP client towards origin ---
    _http_client = httpx.AsyncClient(
        base_url=ORIGIN_URL,
        timeout=httpx.Timeout(15.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=30),
    )

    # --- Batch sync daemon ---
    _sync_task = asyncio.create_task(_batch_sync_daemon())

    yield

    # --- Teardown ---
    logger.info("Shield shutting down.")
    if _sync_task is not None:
        _sync_task.cancel()
        try:
            await _sync_task
        except asyncio.CancelledError:
            pass

    if _http_client is not None:
        await _http_client.aclose()
    if _redis_client is not None:
        await _redis_client.aclose()


app = FastAPI(title="Origin Shield", lifespan=lifespan)

# Headers we strip when forwarding to origin
HOP_BY_HOP = {
    "host",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "upgrade",
}


# ---------------------------------------------------------------------------
# Health probe
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    redis_ok = False
    try:
        redis_ok = await _get_redis().ping()
    except Exception:  # noqa: BLE001
        pass
    return {
        "status": "ok",
        "service": "shield",
        "redis": redis_ok,
        "tracked_clients": len(_buckets),
        "capacity": BUCKET_CAPACITY,
        "refill_per_sec": REFILL_PER_SEC,
        "sync_interval": SYNC_INTERVAL,
    }


# ---------------------------------------------------------------------------
# Main proxy + rate-limiting route
# ---------------------------------------------------------------------------
@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def shield_proxy(path: str, request: Request):
    client_id: str = request.headers.get("x-client-id", "unknown")
    pop: str = request.headers.get("x-pop", "unknown")

    bucket = await _get_or_create_bucket(client_id)
    allowed = await bucket.consume()

    if not allowed:
        # How long until 1 token refills (ceiling to next whole second)
        retry_after = math.ceil(1.0 / REFILL_PER_SEC)
        logger.warning(
            "REJECT  client_id=%s  pop=%s  tokens=%.2f  retry_after=%ds",
            client_id, pop, bucket.tokens, retry_after,
        )
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limit_exceeded",
                "client_id": client_id,
                "retry_after_seconds": retry_after,
            },
            headers={
                "Retry-After": str(retry_after),
                "X-RateLimit-Limit": str(int(BUCKET_CAPACITY)),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Policy": f"{int(BUCKET_CAPACITY)};w={int(BUCKET_CAPACITY / REFILL_PER_SEC)}",
            },
        )

    # --- Allowed — forward to origin ---
    forward_headers: dict[str, str] = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in HOP_BY_HOP
    }

    body = await request.body()
    http = _get_http()

    try:
        origin_resp = await http.request(
            method=request.method,
            url=f"/{path}",
            headers=forward_headers,
            content=body,
            params=dict(request.query_params),
        )
    except httpx.RequestError as exc:
        logger.error("Origin unreachable: %s", exc)
        return JSONResponse(
            status_code=502,
            content={"error": "origin_unavailable", "detail": str(exc)},
        )

    remaining_approx = max(0, int(bucket.tokens))
    logger.info(
        "ALLOW  client_id=%s  pop=%s  origin_status=%d  local_tokens≈%d",
        client_id, pop, origin_resp.status_code, remaining_approx,
    )

    resp_headers: dict[str, str] = {
        k: v
        for k, v in origin_resp.headers.items()
        if k.lower() not in {"transfer-encoding", "connection"}
    }
    resp_headers["X-RateLimit-Remaining"] = str(remaining_approx)
    resp_headers["X-RateLimit-Limit"] = str(int(BUCKET_CAPACITY))

    return Response(
        content=origin_resp.content,
        status_code=origin_resp.status_code,
        headers=resp_headers,
        media_type=origin_resp.headers.get("content-type", "application/json"),
    )
