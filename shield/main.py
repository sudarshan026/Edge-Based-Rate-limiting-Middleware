"""
Origin Shield — the heart of the system.

Responsibilities
----------------
• In-memory token bucket per client_id (local, zero-latency allow/deny)
• On reject: HTTP 429 + Retry-After header
• On allow: forward to Origin Server and return its response
• Background Batch Sync Daemon (asyncio task):
    - Every SYNC_INTERVAL seconds, for every dirty client bucket:
        * Atomically report delta usage to Redis / AWS ElastiCache
        * Pull back the authoritative global token count (one Lua script)
        * Reconcile local state (drift compensation)
    - Redis failure → fail open (keep serving from local state, retry next cycle)

AWS Cloud Services (optional — activated when env vars are set)
---------------------------------------------------------------
• AWS ElastiCache (Redis) : Managed global token store.
                            Set ELASTICACHE_URL to override REDIS_URL.
• AWS CloudWatch          : Centralised structured logs from the shield.
                            Set CLOUDWATCH_LOG_GROUP to enable.
• AWS SNS                 : Real-time alert on every rate-limit (HTTP 429).
                            Set SNS_TOPIC_ARN to enable.
• AWS S3                  : Periodic JSONL audit-log flush (every request
                            decision — allow & deny).
                            Set S3_AUDIT_BUCKET to enable.

Env vars
--------
ORIGIN_URL            : URL of the origin server              (default: http://origin:8000)
REDIS_URL             : Redis connection URL                  (default: redis://redis:6379)
ELASTICACHE_URL       : AWS ElastiCache endpoint — overrides REDIS_URL when set
BUCKET_CAPACITY       : Max tokens per client bucket          (default: 20)
REFILL_PER_SEC        : Tokens added per second               (default: 10)
SYNC_INTERVAL         : Seconds between batch sync runs       (default: 1.0)
AWS_DEFAULT_REGION    : AWS region                            (default: ap-south-1)
CLOUDWATCH_LOG_GROUP  : CloudWatch log group name             (optional)
SNS_TOPIC_ARN         : SNS topic ARN for 429 alerts          (optional)
S3_AUDIT_BUCKET       : S3 bucket name for audit logs         (optional)
S3_FLUSH_INTERVAL     : Seconds between S3 audit flushes      (default: 30.0)
"""
from __future__ import annotations

import asyncio
import json
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
# ElastiCache takes priority over local Redis when set
REDIS_URL: str = (
    os.environ.get("ELASTICACHE_URL")
    or os.environ.get("REDIS_URL", "redis://redis:6379")
)
USING_ELASTICACHE: bool = bool(os.environ.get("ELASTICACHE_URL"))

BUCKET_CAPACITY: float = float(os.environ.get("BUCKET_CAPACITY", "20"))
REFILL_PER_SEC: float = float(os.environ.get("REFILL_PER_SEC", "10"))
SYNC_INTERVAL: float = float(os.environ.get("SYNC_INTERVAL", "1.0"))

# AWS config
AWS_REGION: str = os.environ.get("AWS_DEFAULT_REGION", "ap-south-1")
CLOUDWATCH_LOG_GROUP: str = os.environ.get("CLOUDWATCH_LOG_GROUP", "")
SNS_TOPIC_ARN: str = os.environ.get("SNS_TOPIC_ARN", "")
S3_AUDIT_BUCKET: str = os.environ.get("S3_AUDIT_BUCKET", "")
S3_FLUSH_INTERVAL: float = float(os.environ.get("S3_FLUSH_INTERVAL", "30.0"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [SHIELD] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lua script — executed atomically on Redis / ElastiCache
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
_s3_flush_task: asyncio.Task | None = None  # type: ignore[type-arg]

# Audit log buffer — flushed to S3 every S3_FLUSH_INTERVAL seconds
_audit_log_buffer: list[dict] = []
_audit_log_lock = asyncio.Lock()


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
# AWS CloudWatch — optional structured log forwarding
# ---------------------------------------------------------------------------
def _setup_cloudwatch_logging() -> None:
    """
    Attach a CloudWatch log handler to the root logger.

    • Log group  : CLOUDWATCH_LOG_GROUP  (e.g. /edge-rate-limiter)
    • Log stream : shield

    Silently skips setup if CLOUDWATCH_LOG_GROUP is not set or if boto3 /
    watchtower are unavailable.
    """
    if not CLOUDWATCH_LOG_GROUP:
        logger.info("CloudWatch logging disabled (CLOUDWATCH_LOG_GROUP not set).")
        return

    try:
        import boto3        # noqa: PLC0415
        import watchtower   # noqa: PLC0415

        cw_client = boto3.client("logs", region_name=AWS_REGION)
        cw_handler = watchtower.CloudWatchLogHandler(
            log_group_name=CLOUDWATCH_LOG_GROUP,
            stream_name="shield",
            boto3_client=cw_client,
            create_log_group=True,
        )
        cw_handler.setFormatter(
            logging.Formatter("%(asctime)s [SHIELD] %(levelname)s %(message)s")
        )
        logging.getLogger().addHandler(cw_handler)
        logger.info(
            "✅ AWS CloudWatch logging enabled  group=%s  stream=shield  region=%s",
            CLOUDWATCH_LOG_GROUP, AWS_REGION,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("CloudWatch setup failed (%s) — stdout only.", exc)


# ---------------------------------------------------------------------------
# AWS SNS — rate-limit alert (fire-and-forget)
# ---------------------------------------------------------------------------
async def _publish_sns_alert(client_id: str, pop: str, retry_after: int) -> None:
    """
    Publish a JSON alert to the configured SNS topic whenever a client is
    rate-limited.  Runs in the background; failures are logged and swallowed
    so they never affect the hot request path.
    """
    if not SNS_TOPIC_ARN:
        return

    payload = {
        "event": "rate_limit_exceeded",
        "service": "shield",
        "client_id": client_id,
        "pop": pop,
        "retry_after_seconds": retry_after,
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    try:
        import boto3  # noqa: PLC0415

        loop = asyncio.get_event_loop()
        sns = boto3.client("sns", region_name=AWS_REGION)

        await loop.run_in_executor(
            None,
            lambda: sns.publish(
                TopicArn=SNS_TOPIC_ARN,
                Message=json.dumps(payload, indent=2),
                Subject=f"🚫 Rate limit exceeded — {client_id} via {pop}",
            ),
        )
        logger.info(
            "✅ SNS alert published  client_id=%s  pop=%s", client_id, pop
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("SNS publish failed: %s", exc)


# ---------------------------------------------------------------------------
# AWS S3 — audit log flush daemon
# ---------------------------------------------------------------------------
async def _s3_audit_flush_daemon() -> None:
    """
    Background task that wakes every S3_FLUSH_INTERVAL seconds and writes
    any accumulated audit events to S3 as a timestamped JSONL file.

    S3 key pattern:  audit-logs/shield/YYYYMMDDTHHMMSSZ.jsonl

    Each line in the file is one JSON object representing a single request
    decision (allow or deny) made by the shield.
    """
    logger.info(
        "S3 audit flush daemon started (interval=%.0fs, bucket=%s)",
        S3_FLUSH_INTERVAL,
        S3_AUDIT_BUCKET or "disabled",
    )

    while True:
        await asyncio.sleep(S3_FLUSH_INTERVAL)

        if not S3_AUDIT_BUCKET:
            continue  # S3 not configured; keep the daemon alive for future config

        async with _audit_log_lock:
            if not _audit_log_buffer:
                continue
            batch = list(_audit_log_buffer)
            _audit_log_buffer.clear()

        try:
            import boto3  # noqa: PLC0415

            timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
            s3_key = f"audit-logs/shield/{timestamp}.jsonl"
            content = "\n".join(json.dumps(entry) for entry in batch)

            s3 = boto3.client("s3", region_name=AWS_REGION)
            loop = asyncio.get_event_loop()

            await loop.run_in_executor(
                None,
                lambda: s3.put_object(
                    Bucket=S3_AUDIT_BUCKET,
                    Key=s3_key,
                    Body=content.encode("utf-8"),
                    ContentType="application/x-ndjson",
                ),
            )
            logger.info(
                "✅ S3 audit flush  records=%d  key=%s", len(batch), s3_key
            )
        except Exception as exc:  # noqa: BLE001
            # Re-queue the batch so records aren't lost
            async with _audit_log_lock:
                _audit_log_buffer[:0] = batch
            logger.warning("S3 audit flush failed: %s — records re-queued", exc)


async def _append_audit(entry: dict) -> None:
    """Append a rate-limit decision record to the in-memory audit buffer."""
    async with _audit_log_lock:
        _audit_log_buffer.append(entry)


# ---------------------------------------------------------------------------
# Batch Sync Daemon
# ---------------------------------------------------------------------------
async def _batch_sync_daemon() -> None:
    """
    Runs in the background at SYNC_INTERVAL cadence.

    For each client that has consumed tokens since the last sync:
      1. Capture and reset the unsynced_delta atomically.
      2. Call the Lua script on Redis / ElastiCache → get the authoritative
         global token count.
      3. Reconcile the local bucket (drift compensation).
      4. On any Redis error: log, skip that client, retry next cycle (fail-open).
    """
    logger.info(
        "Batch sync daemon started  interval=%.1fs  capacity=%g  refill=%g/s"
        "  store=%s",
        SYNC_INTERVAL, BUCKET_CAPACITY, REFILL_PER_SEC,
        "ElastiCache" if USING_ELASTICACHE else "local-Redis",
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

            # --- Call Redis / ElastiCache Lua script ---
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
    global _redis_client, _http_client, _lua_sha, _sync_task, _s3_flush_task

    logger.info(
        "Shield starting — origin=%s  store=%s  capacity=%g  refill=%g/s  sync=%.1fs",
        ORIGIN_URL,
        f"ElastiCache({REDIS_URL})" if USING_ELASTICACHE else f"Redis({REDIS_URL})",
        BUCKET_CAPACITY, REFILL_PER_SEC, SYNC_INTERVAL,
    )

    # ── AWS CloudWatch ───────────────────────────────────────────────────────
    _setup_cloudwatch_logging()

    # ── Redis / AWS ElastiCache ──────────────────────────────────────────────
    _redis_client = aioredis.from_url(
        REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=3,
        retry_on_timeout=True,
    )
    if USING_ELASTICACHE:
        logger.info("✅ AWS ElastiCache (Redis) connected  url=%s", REDIS_URL)

    # Pre-load Lua script so we can use EVALSHA (saves bandwidth per call)
    try:
        _lua_sha = await _redis_client.script_load(LUA_SYNC_SCRIPT)
        logger.info("Lua script loaded — sha=%s", _lua_sha)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not pre-load Lua script (%s); will use EVAL fallback", exc)
        _lua_sha = None

    # ── HTTP client towards origin ───────────────────────────────────────────
    _http_client = httpx.AsyncClient(
        base_url=ORIGIN_URL,
        timeout=httpx.Timeout(15.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=30),
    )

    # ── Background tasks ─────────────────────────────────────────────────────
    _sync_task = asyncio.create_task(_batch_sync_daemon())
    _s3_flush_task = asyncio.create_task(_s3_audit_flush_daemon())

    yield

    # ── Teardown ─────────────────────────────────────────────────────────────
    logger.info("Shield shutting down.")

    for task in (_sync_task, _s3_flush_task):
        if task is not None:
            task.cancel()
            try:
                await task
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
        # Enforce a tight timeout so an unreachable ElastiCache/Redis
        # never causes the health check to hang and exceed its deadline.
        redis_ok = await asyncio.wait_for(_get_redis().ping(), timeout=2.0)
    except Exception:  # noqa: BLE001
        pass
    return {
        "status": "ok",
        "service": "shield",
        "redis": redis_ok,
        "redis_backend": "ElastiCache" if USING_ELASTICACHE else "local",
        "tracked_clients": len(_buckets),
        "capacity": BUCKET_CAPACITY,
        "refill_per_sec": REFILL_PER_SEC,
        "sync_interval": SYNC_INTERVAL,
        # AWS service status
        "aws": {
            "elasticache": USING_ELASTICACHE,
            "cloudwatch_log_group": CLOUDWATCH_LOG_GROUP or "disabled",
            "sns_topic_arn": SNS_TOPIC_ARN or "disabled",
            "s3_audit_bucket": S3_AUDIT_BUCKET or "disabled",
        },
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

        # ── AWS SNS alert (fire-and-forget background task) ──────────────────
        asyncio.create_task(_publish_sns_alert(client_id, pop, retry_after))

        # ── AWS S3 audit entry ───────────────────────────────────────────────
        asyncio.create_task(_append_audit({
            "decision": "deny",
            "client_id": client_id,
            "pop": pop,
            "retry_after_seconds": retry_after,
            "ts": time.time(),
            "ts_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }))

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

    # ── AWS S3 audit entry (allowed path) ────────────────────────────────────
    asyncio.create_task(_append_audit({
        "decision": "allow",
        "client_id": client_id,
        "pop": pop,
        "origin_status": origin_resp.status_code,
        "tokens_remaining": remaining_approx,
        "ts": time.time(),
        "ts_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }))

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
