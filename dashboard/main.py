"""
Control Room Dashboard — backend.

Responsibilities:
  • Serve the single-page dashboard UI on port 3000
  • Proxy shield SSE stream and state to the browser
  • Server-side load generator (fires requests through the CDN)
  • Aggregated health of all services
  • Optional Docker control (stop/start Redis for fail-open demo)
"""
from __future__ import annotations

import asyncio
import http.client
import json
import logging
import os
import socket
import time
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SHIELD_URL = os.environ.get("SHIELD_URL", "http://shield:9000")
CDN_URL = os.environ.get("CDN_URL", "http://cdn:80")
DOCKER_CONTROL = os.environ.get("DASHBOARD_ALLOW_DOCKER_CONTROL", "false").lower() == "true"

EDGE_SERVICES = {
    "mumbai": "http://edge-mumbai:8001",
    "delhi": "http://edge-delhi:8002",
    "bengaluru": "http://edge-bengaluru:8003",
}
ORIGIN_URL_INTERNAL = "http://origin:8000"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [DASHBOARD] %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Control Room Dashboard")

# ---------------------------------------------------------------------------
# Load test state
# ---------------------------------------------------------------------------
_load_running = False
_load_task: asyncio.Task | None = None
_load_stats: dict[str, Any] = {
    "running": False, "sent": 0, "ok": 0, "denied": 0, "other": 0,
    "target_rps": 0, "duration": 0, "elapsed": 0.0, "current_rps": 0.0,
}
_load_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Health — aggregated from all services
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def api_health():
    results: dict[str, Any] = {}
    urls = {
        "cdn": f"{CDN_URL}/cdn-health",
        "shield": f"{SHIELD_URL}/health",
        "origin": f"{ORIGIN_URL_INTERNAL}/health",
    }
    for name, url in EDGE_SERVICES.items():
        urls[f"edge-{name}"] = f"{url}/health"

    async with httpx.AsyncClient(timeout=3.0) as client:
        for name, url in urls.items():
            try:
                r = await client.get(url)
                results[name] = {"ok": r.status_code == 200, "status": r.status_code}
                if r.status_code == 200:
                    results[name]["data"] = r.json()
            except Exception as e:
                results[name] = {"ok": False, "error": str(e)}

    shield_data = results.get("shield", {}).get("data", {})
    results["redis"] = {"ok": shield_data.get("redis", False)}
    results["docker_control"] = DOCKER_CONTROL
    return results


# ---------------------------------------------------------------------------
# SSE proxy — shield → browser
# ---------------------------------------------------------------------------
@app.get("/api/stream")
async def api_stream():
    async def _generate():
        while True:
            try:
                async with httpx.AsyncClient() as client:
                    async with client.stream(
                        "GET",
                        f"{SHIELD_URL}/internal/events",
                        timeout=httpx.Timeout(connect=5.0, read=60.0, write=5.0, pool=5.0),
                    ) as resp:
                        async for chunk in resp.aiter_bytes():
                            yield chunk
            except Exception:
                yield b": reconnecting\n\n"
                await asyncio.sleep(2)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# State proxy
# ---------------------------------------------------------------------------
@app.get("/api/state")
async def api_state():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{SHIELD_URL}/internal/state")
            return r.json()
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": str(e)})


# ---------------------------------------------------------------------------
# Single request
# ---------------------------------------------------------------------------
@app.post("/api/fire")
async def api_fire(request: Request):
    body = await request.json()
    api_key = body.get("api_key", "demo-key")
    region = body.get("region", "")

    headers: dict[str, str] = {"x-api-key": api_key}
    if region and region not in ("round-robin", ""):
        headers["X-Region"] = region

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{CDN_URL}/products", headers=headers)
        return {
            "status": r.status_code,
            "headers": {
                k: v for k, v in r.headers.items()
                if k.lower() in (
                    "x-cdn-routed-to", "x-served-by-pop",
                    "x-ratelimit-remaining", "x-ratelimit-limit", "retry-after",
                )
            },
        }


# ---------------------------------------------------------------------------
# Burst
# ---------------------------------------------------------------------------
@app.post("/api/burst")
async def api_burst(request: Request):
    body = await request.json()
    api_key = body.get("api_key", "demo-key")
    count = min(int(body.get("count", 30)), 500)
    region = body.get("region", "")
    regions = ["mumbai", "delhi", "bengaluru"]

    results: dict[str, int] = {"sent": 0, "ok": 0, "denied": 0, "other": 0}

    async with httpx.AsyncClient(
        timeout=10.0,
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=50),
    ) as client:
        tasks = []
        for i in range(count):
            hdrs: dict[str, str] = {"x-api-key": api_key}
            if region == "mixed":
                hdrs["X-Region"] = regions[i % 3]
            elif region and region not in ("round-robin", ""):
                hdrs["X-Region"] = region
            tasks.append(client.get(f"{CDN_URL}/products", headers=hdrs))

        responses = await asyncio.gather(*tasks, return_exceptions=True)
        for r in responses:
            results["sent"] += 1
            if isinstance(r, Exception):
                results["other"] += 1
            elif r.status_code == 200:
                results["ok"] += 1
            elif r.status_code == 429:
                results["denied"] += 1
            else:
                results["other"] += 1

    return results


# ---------------------------------------------------------------------------
# Continuous load test
# ---------------------------------------------------------------------------
async def _run_load(api_key: str, rps: int, duration: int, regions: list[str]):
    global _load_running

    async with _load_lock:
        _load_stats.update({
            "running": True, "sent": 0, "ok": 0, "denied": 0, "other": 0,
            "target_rps": rps, "duration": duration, "elapsed": 0.0, "current_rps": 0.0,
        })

    total = rps * duration
    interval = 1.0 / rps if rps > 0 else 1.0
    start = time.monotonic()
    sem = asyncio.Semaphore(min(rps * 2, 200))

    async with httpx.AsyncClient(
        timeout=10.0,
        limits=httpx.Limits(max_connections=200, max_keepalive_connections=80),
    ) as client:
        async def _fire(idx: int):
            hdrs: dict[str, str] = {"x-api-key": api_key}
            if regions:
                hdrs["X-Region"] = regions[idx % len(regions)]
            async with sem:
                try:
                    r = await client.get(f"{CDN_URL}/products", headers=hdrs)
                    async with _load_lock:
                        _load_stats["sent"] += 1
                        if r.status_code == 200:
                            _load_stats["ok"] += 1
                        elif r.status_code == 429:
                            _load_stats["denied"] += 1
                        else:
                            _load_stats["other"] += 1
                except Exception:
                    async with _load_lock:
                        _load_stats["sent"] += 1
                        _load_stats["other"] += 1

        tasks: list[asyncio.Task] = []
        for i in range(total):
            if not _load_running:
                break
            tasks.append(asyncio.create_task(_fire(i)))
            elapsed = time.monotonic() - start
            expected = (i + 1) * interval
            sleep_for = expected - elapsed
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

            if (i + 1) % max(1, rps // 2) == 0:
                async with _load_lock:
                    _load_stats["elapsed"] = round(time.monotonic() - start, 1)
                    if _load_stats["elapsed"] > 0:
                        _load_stats["current_rps"] = round(
                            _load_stats["sent"] / _load_stats["elapsed"], 1
                        )

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async with _load_lock:
        _load_stats["running"] = False
        _load_stats["elapsed"] = round(time.monotonic() - start, 1)
    _load_running = False


@app.post("/api/load/start")
async def api_load_start(request: Request):
    global _load_running, _load_task
    if _load_running:
        return JSONResponse(status_code=409, content={"error": "load test already running"})

    body = await request.json()
    api_key = body.get("api_key", "demo-key")
    rps = min(int(body.get("rps", 100)), 500)
    duration = min(int(body.get("duration", 10)), 120)
    regions = body.get("regions", ["mumbai", "delhi", "bengaluru"])

    _load_running = True
    _load_task = asyncio.create_task(_run_load(api_key, rps, duration, regions))
    return {"status": "started", "rps": rps, "duration": duration}


@app.post("/api/load/stop")
async def api_load_stop():
    global _load_running
    _load_running = False
    return {"status": "stopping"}


@app.get("/api/load/status")
async def api_load_status():
    async with _load_lock:
        return dict(_load_stats)


# ---------------------------------------------------------------------------
# Proxied shield controls
# ---------------------------------------------------------------------------
@app.post("/api/reset")
async def api_reset(request: Request):
    body = await request.json()
    client_id = body.get("client_id")
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.post(f"{SHIELD_URL}/internal/reset", params={"client_id": client_id})
        return r.json()


@app.post("/api/config")
async def api_config(request: Request):
    body = await request.json()
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.post(f"{SHIELD_URL}/internal/config", json=body)
        return r.json()


# ---------------------------------------------------------------------------
# Docker control (optional)
# ---------------------------------------------------------------------------
class _DockerSocket:
    """Minimal Docker Engine API client via Unix socket (stdlib only)."""
    SOCKET_PATH = "/var/run/docker.sock"

    @staticmethod
    def _call(method: str, path: str) -> tuple[int, str]:
        conn = http.client.HTTPConnection("localhost")
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(_DockerSocket.SOCKET_PATH)
            conn.sock = sock
            conn.request(method, path)
            resp = conn.getresponse()
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
        except Exception as e:
            return 0, str(e)
        finally:
            conn.close()


@app.post("/api/docker/redis/stop")
async def docker_redis_stop():
    if not DOCKER_CONTROL:
        return JSONResponse(status_code=403, content={
            "error": "Docker control disabled",
            "command": "docker stop rl-redis",
        })
    loop = asyncio.get_event_loop()
    status, body = await loop.run_in_executor(
        None, _DockerSocket._call, "POST", "/containers/rl-redis/stop"
    )
    return {"action": "stop", "docker_status": status, "response": body}


@app.post("/api/docker/redis/start")
async def docker_redis_start():
    if not DOCKER_CONTROL:
        return JSONResponse(status_code=403, content={
            "error": "Docker control disabled",
            "command": "docker start rl-redis",
        })
    loop = asyncio.get_event_loop()
    status, body = await loop.run_in_executor(
        None, _DockerSocket._call, "POST", "/containers/rl-redis/start"
    )
    return {"action": "start", "docker_status": status, "response": body}


# ---------------------------------------------------------------------------
# Serve the dashboard SPA
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
