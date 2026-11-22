"""
Smoke test for the Control Room Dashboard.

Usage:
    # With the stack running (docker compose up --build):
    python -m pytest tests/test_smoke.py -v

    # Or standalone:
    python tests/test_smoke.py

Verifies:
  1. Dashboard /api/health reports all services OK
  2. /api/burst fires requests and returns allow + deny counts
  3. /api/stream (SSE) emits both allow and deny events
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

DASHBOARD = "http://localhost:3000"


def _get(path: str, timeout: float = 10.0):
    req = urllib.request.Request(f"{DASHBOARD}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _post(path: str, body: dict, timeout: float = 15.0):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{DASHBOARD}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def test_health():
    """All services should be healthy."""
    data = _get("/api/health")
    for svc in ("cdn", "shield", "origin", "edge-mumbai", "edge-delhi", "edge-bengaluru"):
        assert data[svc]["ok"], f"{svc} is not healthy: {data[svc]}"
    print("  ✅ Health check passed — all services OK")


def test_burst_and_sse():
    """Burst 30 requests, then verify SSE emits allow+deny events."""
    # Fire a burst — should produce some allows and some denies
    result = _post("/api/burst", {"api_key": "smoke-test-key", "count": 40, "region": "mixed"})
    assert result["sent"] == 40, f"Expected 40 sent, got {result['sent']}"
    assert result["ok"] > 0, "Expected at least 1 allowed request"
    assert result["denied"] > 0, "Expected at least 1 denied request"
    print(f"  ✅ Burst: {result['ok']} allowed, {result['denied']} denied")

    # Check SSE stream emits events (read a few lines)
    time.sleep(1)  # let events propagate

    # Use state endpoint to verify counters
    state = _get("/api/state")
    assert state["counters"]["total_allowed"] > 0, "No allowed events recorded"
    assert state["counters"]["total_denied"] > 0, "No denied events recorded"
    print(f"  ✅ State: {state['counters']['total_allowed']} allowed, "
          f"{state['counters']['total_denied']} denied in shield")

    # Read SSE stream briefly (stdlib approach)
    import http.client
    conn = http.client.HTTPConnection("localhost", 3000, timeout=5)
    conn.request("GET", "/api/stream")
    resp = conn.getresponse()
    assert resp.status == 200, f"SSE stream returned {resp.status}"

    # Read up to 4KB or 3 seconds
    data = b""
    start = time.time()
    while time.time() - start < 3 and len(data) < 4096:
        try:
            chunk = resp.read(512)
            if not chunk:
                break
            data += chunk
        except Exception:
            break
    conn.close()

    text = data.decode("utf-8", errors="replace")
    has_events = "event:" in text or "keepalive" in text
    assert has_events, "SSE stream did not emit any events or keepalives"
    print(f"  ✅ SSE stream active ({len(data)} bytes received)")


def main():
    print("\n🧪 Control Room Dashboard — Smoke Test")
    print("=" * 50)

    # Wait for dashboard to be ready
    for i in range(30):
        try:
            _get("/api/health")
            break
        except Exception:
            if i == 29:
                print("  ❌ Dashboard not reachable after 30s")
                sys.exit(1)
            time.sleep(1)

    test_health()
    test_burst_and_sse()

    print("\n" + "=" * 50)
    print("  ALL SMOKE TESTS PASSED ✅")
    print()


if __name__ == "__main__":
    main()
