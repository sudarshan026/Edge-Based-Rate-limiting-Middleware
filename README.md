# Edge-Based Distributed Rate Limiting Middleware

A local simulation of a production-grade, globally consistent, edge-based distributed rate limiting system.

```
Global Users
    │ API requests
    ▼
CDN / Edge Network  (simulated by 3 edge containers)
    │
    ├── Edge POP — Mumbai     (host:8001)
    ├── Edge POP — Delhi      (host:8002)
    └── Edge POP — Bengaluru  (host:8003)
             │
             │  x-client-id + x-pop headers
             ▼
    Origin Shield  (host:9000, internal)
        │  Token Bucket (local, in-memory, zero-latency)
        │  Batch Sync Daemon  ──►  Central Redis 7
        │                    ◄──  authoritative global tokens
        │
        │  Allowed requests only
        ▼
    Origin Server  (internal, port 8000)
        │
        ▼
    "Database" (hardcoded products list)
```

## Architecture Overview

| Service | Role | Rate Limiting? |
|---|---|---|
| **edge-\*** | Identify client, add headers, forward to shield | ❌ None |
| **shield** | Token bucket allow/deny, proxy to origin | ✅ **Yes — enforced here** |
| **origin** | Dynamic app logic, returns products | ❌ None |
| **redis** | Global quota store, source of truth | N/A (data store) |

### Key Design Properties

1. **Global limits, not per-POP** — A client alternating between Mumbai, Delhi, and Bengaluru still shares _one_ token bucket tracked in Central Redis.
2. **Zero-latency hot path** — Allow/deny decisions use an in-memory token bucket; _no_ synchronous Redis call during request processing.
3. **Eventual convergence** — The Batch Sync Daemon reconciles local state with Redis every `SYNC_INTERVAL` seconds (default: 1 s).
4. **Drift compensation** — After each sync, local tokens are set to the authoritative global count, preventing long-term divergence.
5. **Redis fail-open** — If Redis is unavailable, the shield keeps serving from its local bucket and retries the sync next cycle.
6. **Clock-skew-free sync** — The Lua script uses Redis's own `TIME` command, not the container's wall clock.

---

## Prerequisites

- **Docker Desktop** ≥ 24 (with Compose v2 bundled)
- **Python 3.12** (only for running the load-tester locally)
- Ports `6379`, `8001`, `8002`, `8003` free on the host

---

## Quick Start

### 1. Build & bring up all services

```bash
cd <project-root>
docker compose up --build -d
```

### 2. Wait for all services to become healthy

```bash
docker compose ps
# All 6 containers should show "healthy" within ~30 s
```

### 3. Smoke-test the edge POPs

```bash
# Mumbai POP
curl -s -H "x-api-key: my-client" http://localhost:8001/products | python -m json.tool

# Delhi POP (same API key, same global quota)
curl -s -H "x-api-key: my-client" http://localhost:8002/products | python -m json.tool

# Check rate-limit headers
curl -si -H "x-api-key: my-client" http://localhost:8003/products | grep -i "x-rate\|x-served\|retry"
```

### 4. Observe logs in real time

```bash
# All services together
docker compose logs -f

# Just the shield (where decisions are made)
docker compose logs -f shield

# Just one edge POP
docker compose logs -f edge-mumbai
```

---

## Running the Load Test

```bash
python loadtest.py
```

The script targets all 3 POPs simultaneously, round-robin, at ~200 req/s for 10 seconds.

```
Expected output (approximately):

══════════════════════════════════════════════════════════
  LOAD TEST RESULTS
══════════════════════════════════════════════════════════
  Total requests sent :   2000
  ✅  200 (allowed)   :    124  (6.2%)
  🚫  429 (rate-lim'd):   1876  (93.8%)
──────────────────────────────────────────────────────────
  Expected ≈200s      : ~120  (capacity=20 + refill=10/s × 10s)
──────────────────────────────────────────────────────────

  ✅  PASS — 200s within expected window [84, 180]
            Global rate limit is working correctly across all POPs.
```

### Load test options

| Flag | Default | Description |
|---|---|---|
| `--rps` | `200` | Target requests per second |
| `--duration` | `10.0` | Test duration in seconds |
| `--api-key` | `test-key-1` | Client identity |
| `--pops` | `8001,8002,8003` | Edge POP ports to target |
| `--concurrency` | `50` | Max concurrent in-flight requests |
| `--path` | `/products` | Request path |

---

## Configuration Reference

All configuration is done via environment variables in `docker-compose.yml`.

### Shield

| Variable | Default | Description |
|---|---|---|
| `BUCKET_CAPACITY` | `20` | Max tokens per client bucket (initial burst allowance) |
| `REFILL_PER_SEC` | `10` | Tokens added per second (sustained rate limit) |
| `SYNC_INTERVAL` | `1.0` | Seconds between Redis batch sync runs |
| `ORIGIN_URL` | `http://origin:8000` | Origin server URL |
| `REDIS_URL` | `redis://redis:6379` | Central Redis URL |

### Edge Worker

| Variable | Default | Description |
|---|---|---|
| `POP_NAME` | `unknown-pop` | POP identifier (e.g., `mumbai`) |
| `SHIELD_URL` | `http://shield:9000` | Origin Shield URL |

---

## Request Flow — Step by Step

```
1. Client sends:
   GET /products  HTTP/1.1
   Host: localhost:8001
   x-api-key: my-client

2. Edge POP (Mumbai) receives request on :8001
   • Extracts identity: client_id = "key:my-client"
   • Adds headers:  x-client-id: key:my-client
                    x-pop: mumbai
   • Forwards to Shield at http://shield:9000/products

3. Origin Shield receives forwarded request
   • Looks up (or creates) in-memory token bucket for "key:my-client"
   • Refills bucket based on time elapsed since last consume()
   • Tries to consume 1 token (LOCAL, zero-latency decision):
     ├── ALLOWED → forwards to Origin Server
     │             adds X-RateLimit-Remaining header
     │             returns Origin's response with 200
     └── REJECTED → returns 429 immediately
                    adds Retry-After header
                    does NOT contact Origin Server

4. (Async, every 1 s) Batch Sync Daemon wakes up
   • For each client with unsynced usage:
     - Captures delta (tokens consumed since last sync)
     - Runs Lua script atomically on Redis:
         * Uses Redis TIME (no clock skew)
         * Refills Redis-side tokens based on elapsed time
         * Deducts delta
         * Returns authoritative global token count
     - Reconciles local bucket: local_tokens ← global_tokens

5. Origin Server processes allowed request
   • Queries "database" (hardcoded list)
   • Returns JSON product catalogue

6. Response travels back:
   Origin → Shield (adds X-RateLimit headers)
          → Edge POP (adds x-served-by-pop header)
          → Client
```

---

## Tearing Down

```bash
docker compose down -v   # stops containers and removes volumes
```

---

## Verifying Python syntax

```bash
python -m py_compile origin/main.py
python -m py_compile edge/main.py
python -m py_compile shield/main.py
python -m py_compile loadtest.py
echo "All files pass py_compile"
```
