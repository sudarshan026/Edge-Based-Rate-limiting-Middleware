"""
Load-testing script for the Edge-Based Distributed Rate Limiting Middleware.

Behaviour
---------
• Fires ~200 req/s against a single API key for 10 seconds (≈ 2 000 total requests)
• Spreads requests round-robin across all 3 edge POPs (ports 8001, 8002, 8003)
• Tallies 200 (allowed) vs 429 (rate-limited) vs other status codes
• Prints a formatted summary at the end

Expected result (with BUCKET_CAPACITY=20, REFILL_PER_SEC=10, 10-second test)
-----------------------------------------------------------------------------
  Global quota consumed per second ≈ 200 req/s → massively exceeds 10 tok/s refill
  Initial burst allowed             = 20 tokens (the starting bucket capacity)
  Tokens refilled over 10 s         = 10 × 10 = 100
  Expected total 200s               ≈ 20 + 100 = 120   (first ~0.1 s + refill)
  Expected total 429s               ≈ 2 000 - 120 = 1 880

Because local token buckets are refilled locally and synced to Redis every 1 s,
the actual 200 count may be slightly above 120 during the first sync window, then
converge. The important property is that it is far below 200 × 10 = 2 000 —
demonstrating that the global limit holds across all three POPs.

Usage
-----
  python loadtest.py [--rps 200] [--duration 10] [--api-key test-key-1]
                     [--pops 8001,8002,8003] [--concurrency 50]

Requirements: Python 3.12 standard library only (no extra packages needed).
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import io
import sys
import time
import urllib.error
import urllib.request
from typing import Counter

# Force UTF-8 output on Windows (default console is cp1252 which chokes on emoji)
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() not in ("utf-8", "utf8"):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")



# ---------------------------------------------------------------------------
# Single request (uses stdlib urllib — no extra deps)
# ---------------------------------------------------------------------------
def _do_request(url: str, api_key: str) -> int:
    """Send a single GET and return the HTTP status code."""
    req = urllib.request.Request(
        url,
        headers={
            "x-api-key": api_key,
            "User-Agent": "rl-loadtest/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status  # type: ignore[return-value]
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:  # noqa: BLE001
        return 0  # connection error / timeout


# ---------------------------------------------------------------------------
# Async worker pool — drives many concurrent requests using asyncio + threads
# ---------------------------------------------------------------------------
async def _run_load_test(
    *,
    pops: list[int],
    api_key: str,
    rps: int,
    duration: float,
    concurrency: int,
    path: str,
) -> Counter[int]:
    """
    Send `rps` requests per second for `duration` seconds, round-robin across
    `pops`, with up to `concurrency` in-flight requests at any time.

    Returns a Counter mapping HTTP status code → count.
    """
    status_counter: Counter[int] = collections.Counter()
    lock = asyncio.Lock()

    pop_cycle: list[int] = list(pops) * (rps * int(duration) // len(pops) + 1)
    pop_idx = 0
    pop_idx_lock = asyncio.Lock()

    total_to_send = rps * int(duration)
    semaphore = asyncio.Semaphore(concurrency)
    loop = asyncio.get_running_loop()

    async def worker(url: str) -> None:
        async with semaphore:
            status = await loop.run_in_executor(None, _do_request, url, api_key)
            async with lock:
                status_counter[status] += 1

    tasks: list[asyncio.Task] = []  # type: ignore[type-arg]
    start = time.monotonic()
    interval = 1.0 / rps  # ideal spacing between requests

    print(
        f"\n🚀  Load test starting — "
        f"{rps} req/s × {duration:.0f}s = ~{total_to_send} total requests\n"
        f"    API key : {api_key}\n"
        f"    POPs    : {[f'localhost:{p}' for p in pops]}\n"
        f"    Path    : {path}\n"
        f"{'─' * 58}"
    )

    for i in range(total_to_send):
        # Pick next POP round-robin
        async with pop_idx_lock:
            port = pop_cycle[i % len(pops)]

        url = f"http://localhost:{port}{path}"
        tasks.append(asyncio.create_task(worker(url)))

        # Throttle dispatch to approximately `rps` per second
        elapsed = time.monotonic() - start
        expected_elapsed = (i + 1) * interval
        sleep_for = expected_elapsed - elapsed
        if sleep_for > 0:
            await asyncio.sleep(sleep_for)

        # Print live progress every 200 requests
        if (i + 1) % 200 == 0:
            async with lock:
                ok = status_counter[200]
                rl = status_counter[429]
                err = sum(v for k, v in status_counter.items() if k not in (200, 429))
            sent = i + 1
            print(
                f"  [{sent:>5}/{total_to_send}]  "
                f"[OK] 200: {ok:>5}  "
                f"[RL] 429: {rl:>5}  "
                f"[ERR] other: {err:>4}  "
                f"elapsed: {time.monotonic()-start:.1f}s"
            )

    # Drain all in-flight tasks
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    return status_counter


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Load tester for Edge Rate Limiting Middleware",
    )
    parser.add_argument("--rps",         type=int,   default=200,         help="Target requests per second")
    parser.add_argument("--duration",    type=float, default=10.0,        help="Test duration in seconds")
    parser.add_argument("--api-key",     type=str,   default="test-key-1",help="API key to use as client identity")
    parser.add_argument("--pops",        type=str,   default="8001,8002,8003", help="Comma-separated host ports")
    parser.add_argument("--concurrency", type=int,   default=50,          help="Max concurrent in-flight requests")
    parser.add_argument("--path",        type=str,   default="/products",  help="Request path")
    args = parser.parse_args()

    pops = [int(p.strip()) for p in args.pops.split(",")]
    capacity = 20   # keep in sync with docker-compose BUCKET_CAPACITY
    refill   = 10   # keep in sync with docker-compose REFILL_PER_SEC

    status_counter = asyncio.run(
        _run_load_test(
            pops=pops,
            api_key=args.api_key,
            rps=args.rps,
            duration=args.duration,
            concurrency=args.concurrency,
            path=args.path,
        )
    )

    total    = sum(status_counter.values())
    ok_count = status_counter[200]
    rl_count = status_counter[429]
    err_count = total - ok_count - rl_count

    expected_ok_approx = capacity + int(refill * args.duration)

    print(f"\n{'═' * 58}")
    print("  LOAD TEST RESULTS")
    print(f"{'═' * 58}")
    print(f"  Total requests sent : {total:>6}")
    print(f"  ✅  200 (allowed)   : {ok_count:>6}  ({100*ok_count/total:.1f}%)")
    print(f"  🚫  429 (rate-lim'd): {rl_count:>6}  ({100*rl_count/total:.1f}%)")
    if err_count:
        print(f"  ❌  Other/errors    : {err_count:>6}  ({100*err_count/total:.1f}%)")
    print(f"{'─' * 58}")
    print(f"  Expected ≈200s      : ~{expected_ok_approx}  "
          f"(capacity={capacity} + refill={refill}/s × {args.duration:.0f}s)")
    print(f"{'─' * 58}")

    # Pass/fail verdict
    # Allow ±30% tolerance around the expected 200 count (due to sync jitter)
    lo = int(expected_ok_approx * 0.7)
    hi = int(expected_ok_approx * 1.5)  # generous upper bound for first-cycle burst
    passed = lo <= ok_count <= hi and rl_count > 0

    if passed:
        print(f"\n  [PASS] 200s within expected window [{lo}, {hi}]")
        print(      "         Global rate limit is working correctly across all POPs.")
    else:
        print(f"\n  [FAIL] 200s = {ok_count}, expected [{lo}, {hi}]")
        if ok_count > hi:
            print("         Too many requests allowed -- rate limit may not be enforced.")
        elif ok_count < lo:
            print("         Too few requests allowed -- bucket may be misconfigured.")
        if rl_count == 0:
            print("         No 429s received -- check that the shield is running.")
        sys.exit(1)

    print()


if __name__ == "__main__":
    main()
