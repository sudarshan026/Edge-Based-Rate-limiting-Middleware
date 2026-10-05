"""
Regional Edge Worker — one instance per POP (Mumbai / Delhi / Bengaluru).

Responsibilities:
  • Extract client identity from x-api-key header (fallback: client IP)
  • Tag the request with x-client-id and x-pop
  • Forward every request (any method, any path) to the Origin Shield
  • Pass through rate-limit response headers (Retry-After, X-RateLimit-*)
  • Add x-served-by-pop for observability
  • Does NOT perform any rate limiting itself

AWS Cloud Services (optional — activated when env vars are set)
---------------------------------------------------------------
• AWS CloudWatch : Structured logs from every POP forwarded to a central
                   CloudWatch log group (CLOUDWATCH_LOG_GROUP env var).
                   Each POP gets its own log stream (stream name = POP_NAME).
                   Falls back to stdout-only logging when not configured.

Env vars
--------
POP_NAME              : POP identifier              (default: unknown-pop)
SHIELD_URL            : Origin Shield URL           (default: http://shield:9000)
AWS_DEFAULT_REGION    : AWS region for CloudWatch   (default: ap-south-1)
CLOUDWATCH_LOG_GROUP  : CloudWatch log group name   (optional)
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
POP_NAME: str = os.environ.get("POP_NAME", "unknown-pop")
SHIELD_URL: str = os.environ.get("SHIELD_URL", "http://shield:9000")
AWS_REGION: str = os.environ.get("AWS_DEFAULT_REGION", "ap-south-1")
CLOUDWATCH_LOG_GROUP: str = os.environ.get("CLOUDWATCH_LOG_GROUP", "")

logging.basicConfig(
    level=logging.INFO,
    format=f"%(asctime)s [{POP_NAME.upper()}] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# Headers that we always pass through from the shield → client
PASSTHROUGH_RESPONSE_HEADERS = {
    "retry-after",
    "x-ratelimit-remaining",
    "x-ratelimit-limit",
    "x-ratelimit-reset",
    "content-type",
    "x-origin-served-at",
    "x-client-id",
}

# Headers we strip from the upstream request before forwarding
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
# AWS CloudWatch — optional structured log forwarding
# ---------------------------------------------------------------------------
def _setup_cloudwatch_logging() -> None:
    """
    Attach a CloudWatch log handler to the root logger so every log line
    emitted by this edge POP is also shipped to AWS CloudWatch.

    • Log group  : CLOUDWATCH_LOG_GROUP  (e.g. /edge-rate-limiter)
    • Log stream : POP_NAME              (e.g. edge-mumbai)

    Silently skips setup if CLOUDWATCH_LOG_GROUP is not set or if boto3 /
    watchtower are unavailable — local-only mode continues to work normally.
    """
    if not CLOUDWATCH_LOG_GROUP:
        logger.info("CloudWatch logging disabled (CLOUDWATCH_LOG_GROUP not set).")
        return

    try:
        import boto3                        # noqa: PLC0415
        import watchtower                   # noqa: PLC0415

        cw_client = boto3.client("logs", region_name=AWS_REGION)
        cw_handler = watchtower.CloudWatchLogHandler(
            log_group_name=CLOUDWATCH_LOG_GROUP,
            stream_name=f"edge-{POP_NAME}",   # e.g.  edge-mumbai
            boto3_client=cw_client,
            create_log_group=True,             # creates the group if absent
        )
        cw_handler.setFormatter(
            logging.Formatter(
                f"%(asctime)s [{POP_NAME.upper()}] %(levelname)s %(message)s"
            )
        )
        logging.getLogger().addHandler(cw_handler)
        logger.info(
            "✅ AWS CloudWatch logging enabled  group=%s  stream=edge-%s  region=%s",
            CLOUDWATCH_LOG_GROUP, POP_NAME, AWS_REGION,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "CloudWatch setup failed (%s) — falling back to stdout only.", exc
        )


# ---------------------------------------------------------------------------
# HTTP client (shared, reused across requests)
# ---------------------------------------------------------------------------
_http_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    assert _http_client is not None, "HTTP client not initialised"
    return _http_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http_client
    logger.info("Edge POP '%s' starting — shield=%s", POP_NAME, SHIELD_URL)

    # ── AWS CloudWatch ──────────────────────────────────────────────────────
    _setup_cloudwatch_logging()

    _http_client = httpx.AsyncClient(
        base_url=SHIELD_URL,
        timeout=httpx.Timeout(10.0),
        limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
    )
    yield
    logger.info("Edge POP '%s' shutting down.", POP_NAME)
    await _http_client.aclose()


app = FastAPI(title=f"Edge Worker — {POP_NAME}", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Health probe (answered locally, no forwarding needed)
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "pop": POP_NAME,
        "shield": SHIELD_URL,
        "cloudwatch_log_group": CLOUDWATCH_LOG_GROUP or "disabled",
    }


# ---------------------------------------------------------------------------
# Catch-all proxy — forwards everything else to the shield
# ---------------------------------------------------------------------------
@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
)
async def proxy(path: str, request: Request):
    # ---- 1. Extract client identity ----------------------------------------
    api_key = request.headers.get("x-api-key")
    if api_key:
        client_id = f"key:{api_key}"
    else:
        # Fall back to client IP (strips port, handles X-Forwarded-For)
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            client_id = f"ip:{forwarded_for.split(',')[0].strip()}"
        else:
            host = request.client.host if request.client else "unknown"
            client_id = f"ip:{host}"

    logger.info(
        "→ shield  method=%s path=/%s client_id=%s",
        request.method,
        path,
        client_id,
    )

    # ---- 2. Build forwarded headers ----------------------------------------
    forward_headers: dict[str, str] = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in HOP_BY_HOP
    }
    forward_headers["x-client-id"] = client_id
    forward_headers["x-pop"] = POP_NAME
    # Let the shield know the original client IP
    forward_headers.setdefault(
        "x-forwarded-for",
        request.client.host if request.client else "unknown",
    )

    # ---- 3. Forward to shield ----------------------------------------------
    body = await request.body()
    client = get_http_client()

    try:
        shield_resp = await client.request(
            method=request.method,
            url=f"/{path}",
            headers=forward_headers,
            content=body,
            params=dict(request.query_params),
        )
    except httpx.RequestError as exc:
        logger.error("Shield unreachable: %s", exc)
        return JSONResponse(
            status_code=502,
            content={"error": "shield_unavailable", "detail": str(exc)},
        )

    # ---- 4. Build response, passing through relevant headers ---------------
    resp_headers: dict[str, str] = {}
    for header_name, header_val in shield_resp.headers.items():
        if header_name.lower() in PASSTHROUGH_RESPONSE_HEADERS:
            resp_headers[header_name] = header_val

    # Observability header: which POP served this request
    resp_headers["x-served-by-pop"] = POP_NAME

    # Surface 429 distinctly in logs
    if shield_resp.status_code == 429:
        logger.warning(
            "RATE-LIMITED  client_id=%s  retry-after=%s",
            client_id,
            shield_resp.headers.get("retry-after", "?"),
        )
    else:
        logger.info(
            "← shield  status=%d  client_id=%s", shield_resp.status_code, client_id
        )

    return Response(
        content=shield_resp.content,
        status_code=shield_resp.status_code,
        headers=resp_headers,
        media_type=shield_resp.headers.get("content-type", "application/json"),
    )
