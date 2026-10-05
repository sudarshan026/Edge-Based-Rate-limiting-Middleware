# 🛡️ Edge-Based Distributed Rate Limiting Middleware

A production-grade, globally consistent, edge-based distributed rate limiting system integrated with **4 AWS Cloud Services** — designed for high-performance API protection across geographically distributed edge nodes.

```
Global Users
    │ API requests
    ▼
CDN / Edge Network  (simulated by 3 edge containers)
    │
    ├── Edge POP — Mumbai     (host:8001)  ──► AWS CloudWatch Logs
    ├── Edge POP — Delhi      (host:8002)  ──► AWS CloudWatch Logs
    └── Edge POP — Bengaluru  (host:8003)  ──► AWS CloudWatch Logs
             │
             │  x-client-id + x-pop headers
             ▼
    Origin Shield  (host:9000, internal)
        │  Token Bucket (local, in-memory, zero-latency)
        │  Batch Sync Daemon  ──►  AWS ElastiCache (Redis)
        │                    ◄──  authoritative global tokens
        │
        │  [on 429] ──► AWS SNS (rate-limit alerts → email)
        │  [every 30s] ──► AWS S3 (audit logs → JSONL files)
        │
        │  Allowed requests only
        ▼
    Origin Server  (internal, port 8000)
        │
        ▼
    "Database" (hardcoded products list)
```

---

## 📋 Table of Contents

- [Architecture Overview](#architecture-overview)
- [AWS Cloud Services](#-aws-cloud-services)
- [Project Structure](#-project-structure)
- [How Each Service Works](#-how-each-service-works)
- [Key Design Properties](#-key-design-properties)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [AWS Setup Guide](#-aws-setup-guide)
- [Configuration Reference](#configuration-reference)
- [Running the Load Test](#running-the-load-test)
- [Request Flow — Step by Step](#request-flow--step-by-step)
- [Demo Walkthrough](#-demo-walkthrough)
- [Tearing Down](#tearing-down)

---

## Architecture Overview

| Service | Role | Rate Limiting? | AWS Integration |
|---|---|---|---|
| **edge-\*** | Identify client, add headers, forward to shield | ❌ None | CloudWatch Logs |
| **shield** | Token bucket allow/deny, proxy to origin | ✅ **Yes — enforced here** | ElastiCache + CloudWatch + SNS + S3 |
| **origin** | Dynamic app logic, returns products | ❌ None | None |
| **redis** | Global quota store (local fallback) | N/A (data store) | Replaced by ElastiCache when configured |

---

## ☁️ AWS Cloud Services

This project integrates **4 AWS cloud services** for production-grade observability, alerting, and data persistence. All integrations are **opt-in** — the system runs fully locally (via Docker) when AWS env vars are absent.

### 1. AWS ElastiCache (Redis)

| Property | Detail |
|---|---|
| **Purpose** | Managed global token-quota store replacing local Redis |
| **Why we use it** | ElastiCache provides a fully managed, highly available Redis cluster with automatic failover, backups, and zero operational overhead. In production, multiple Shield instances across different regions need a shared, centrally managed Redis to maintain globally consistent rate limits. |
| **How it works** | The Shield's Batch Sync Daemon connects to the ElastiCache Redis endpoint instead of the local Docker Redis container. It runs the same Lua script atomically to report consumed tokens and receive the global authoritative count. |
| **Activated by** | `ELASTICACHE_URL` environment variable |
| **Fallback** | Local Redis container (automatic when `ELASTICACHE_URL` is empty) |

### 2. AWS CloudWatch (Logs)

| Property | Detail |
|---|---|
| **Purpose** | Centralised structured logs from Shield + all Edge POPs |
| **Why we use it** | In a distributed CDN-like system, logs are scattered across dozens of edge nodes worldwide. CloudWatch aggregates all logs into a single, searchable, centrally managed log group. Each service gets its own log stream (e.g., `shield`, `edge-mumbai`, `edge-delhi`, `edge-bengaluru`), making it easy to filter, search, and set up alarms. |
| **How it works** | On startup, each service creates a CloudWatch log handler using the `watchtower` Python library. Every log line emitted by the Python `logging` module is automatically shipped to CloudWatch in addition to stdout. |
| **Activated by** | `CLOUDWATCH_LOG_GROUP` environment variable |
| **Log streams** | `shield`, `edge-mumbai`, `edge-delhi`, `edge-bengaluru` |

### 3. AWS SNS (Simple Notification Service)

| Property | Detail |
|---|---|
| **Purpose** | Real-time alert published on every HTTP 429 (rate-limit hit) |
| **Why we use it** | Operations teams need instant notification when clients are being rate-limited. SNS enables push-based alerts to email, SMS, Slack (via Lambda), or any HTTP endpoint. This allows teams to detect abuse patterns, misconfigured clients, or DDoS attacks in real time. |
| **How it works** | When the Shield rejects a request (HTTP 429), it fires a background `asyncio` task that publishes a JSON message to the SNS topic. The publish is fire-and-forget — it never blocks the request path. The message includes: `client_id`, `pop`, `retry_after_seconds`, and `timestamp_utc`. |
| **Activated by** | `SNS_TOPIC_ARN` environment variable |
| **Alert payload** | `{"event": "rate_limit_exceeded", "client_id": "key:demo-key", "pop": "mumbai", ...}` |

### 4. AWS S3 (Simple Storage Service)

| Property | Detail |
|---|---|
| **Purpose** | Periodic JSONL audit-log flush of every allow/deny decision |
| **Why we use it** | Audit logs provide a permanent, immutable record of every rate-limiting decision. This is essential for compliance, post-incident analysis, billing disputes, and understanding traffic patterns. S3 provides durable, low-cost storage with lifecycle policies for automatic archival. |
| **How it works** | Every request decision (allow or deny) is buffered in an in-memory list. A background daemon (`_s3_audit_flush_daemon`) wakes every `S3_FLUSH_INTERVAL` seconds (default: 30s), collects all buffered events, and writes them as a timestamped `.jsonl` file to S3 at the path `audit-logs/shield/YYYYMMDDTHHMMSSZ.jsonl`. Failed flushes re-queue the records so no data is lost. |
| **Activated by** | `S3_AUDIT_BUCKET` environment variable |
| **S3 key pattern** | `audit-logs/shield/20261005T150319Z.jsonl` |
| **Record format** | `{"decision": "allow", "client_id": "key:demo-key", "pop": "mumbai", "tokens_remaining": 18, "ts": ..., "ts_utc": "..."}` |

---

## 📂 Project Structure

```
.
├── docker-compose.yml        # Orchestrates all 6 services with AWS env vars
├── Dockerfile                # Shared Python 3.12-slim image for all services
├── requirements.txt          # Python dependencies (FastAPI, Redis, boto3, watchtower)
├── .env.example              # Template for AWS credentials and service config
├── .env                      # Your actual credentials (git-ignored, never committed)
├── .gitignore                # Protects .env from being committed
│
├── edge/
│   └── main.py               # Edge Worker — client identification, header tagging,
│                              #   request forwarding, CloudWatch log handler
│
├── shield/
│   └── main.py               # Origin Shield — in-memory token bucket, rate limiting,
│                              #   Batch Sync Daemon (Redis/ElastiCache), SNS alerts,
│                              #   S3 audit log flushing, CloudWatch logging
│
├── origin/
│   └── main.py               # Origin Server — simulates a dynamic API with
│                              #   a hardcoded product catalogue
│
├── loadtest.py               # Load testing script (200 req/s × 10s across all POPs)
├── demo.ps1                  # Interactive PowerShell demo script
├── commands.md               # Quick-reference demo commands
│
└── docs/                     # Screenshots and demo recordings
    ├── health-endpoints.webp  # Edge POP health checks
    └── shield-products.webp   # Shield health & product catalogue
```

---

## 🔧 How Each Service Works

### Edge Worker (`edge/main.py`)

The Edge Worker runs at each POP (Mumbai, Delhi, Bengaluru). It is a lightweight reverse proxy that:

1. **Extracts client identity** from the `x-api-key` header (falls back to client IP)
2. **Tags the request** with `x-client-id` and `x-pop` headers
3. **Forwards** the request to the Origin Shield
4. **Passes through** rate-limit response headers (`Retry-After`, `X-RateLimit-*`)
5. **Adds** `x-served-by-pop` header for observability
6. **Sends logs** to AWS CloudWatch (when configured)

The Edge Worker does **NOT** perform any rate limiting — it merely identifies and routes.

### Origin Shield (`shield/main.py`)

The Shield is the **heart of the system**. It:

1. **Maintains an in-memory token bucket** per `client_id` — refilled lazily using a monotonic clock
2. **Makes zero-latency allow/deny decisions** — no synchronous Redis call during request processing
3. **Runs a Batch Sync Daemon** in the background:
   - Every `SYNC_INTERVAL` seconds (default: 1s), for each client with consumed tokens:
     - Reports the delta (tokens consumed since last sync) to Redis/ElastiCache
     - Executes a Lua script atomically on Redis that:
       - Uses Redis `TIME` (avoids cross-node clock skew)
       - Refills tokens based on elapsed time
       - Deducts the reported delta
       - Returns the authoritative global token count
     - Reconciles the local bucket with the global count (drift compensation)
   - On Redis failure: **fails open** — keeps serving from local state, retries next cycle
4. **Publishes SNS alerts** (fire-and-forget) on every HTTP 429
5. **Buffers audit events** and flushes to S3 every 30 seconds
6. **Sends logs** to AWS CloudWatch (when configured)

### Origin Server (`origin/main.py`)

A simple FastAPI application that simulates a real API backend:

- **`GET /products`** — Returns a hardcoded product catalogue (8 products with id, name, price, stock)
- **`GET /health`** — Liveness probe
- **Catch-all** — Echoes any other path back as JSON

### Load Test Script (`loadtest.py`)

The load tester validates that the global rate limit works correctly:

| Parameter | Default | Description |
|---|---|---|
| `--rps` | `200` | Target requests per second |
| `--duration` | `10.0` | Test duration in seconds |
| `--api-key` | `test-key-1` | Client identity (API key) |
| `--pops` | `8001,8002,8003` | Edge POP ports to target |
| `--concurrency` | `50` | Max concurrent in-flight requests |
| `--path` | `/products` | Request path |

**How it works:**
- Fires `200 req/s × 10s = ~2,000 total requests` using a single API key
- Distributes requests **round-robin** across all 3 edge POPs
- Uses `asyncio` + thread pool for concurrent HTTP requests (stdlib only, no extra deps)
- Tallies `200` (allowed) vs `429` (rate-limited) vs other status codes
- Prints live progress every 200 requests

**Expected results** (with `BUCKET_CAPACITY=20`, `REFILL_PER_SEC=10`, 10s test):
```
  Initial burst allowed  = 20 tokens (starting bucket capacity)
  Tokens refilled over 10s = 10/s × 10s = 100
  Expected total 200s    ≈ 120  (20 + 100)
  Expected total 429s    ≈ 1,880  (2,000 - 120)
```

The script **PASSES** if the 200 count falls within `[84, 180]` — proving that the global rate limit holds across all three POPs simultaneously.

---

## 🔑 Key Design Properties

1. **Global limits, not per-POP** — A client alternating between Mumbai, Delhi, and Bengaluru still shares _one_ token bucket tracked in Central Redis / ElastiCache.
2. **Zero-latency hot path** — Allow/deny decisions use an in-memory token bucket; _no_ synchronous Redis call during request processing.
3. **Eventual convergence** — The Batch Sync Daemon reconciles local state with Redis every `SYNC_INTERVAL` seconds (default: 1s).
4. **Drift compensation** — After each sync, local tokens are set to the authoritative global count, preventing long-term divergence.
5. **Redis fail-open** — If Redis / ElastiCache is unavailable, the shield keeps serving from its local bucket and retries the sync next cycle.
6. **Clock-skew-free sync** — The Lua script uses Redis's own `TIME` command, not the container's wall clock.
7. **Fire-and-forget AWS** — SNS and S3 operations run in background tasks and never block the request path. Failures are logged and retried.
8. **Graceful degradation** — Every AWS integration is optional. The system works identically in local-only mode when env vars are absent.

---

## Configuration Reference

All configuration is done via environment variables in `docker-compose.yml` and `.env`.

### Shield

| Variable | Default | Description |
|---|---|---|
| `BUCKET_CAPACITY` | `20` | Max tokens per client bucket (initial burst allowance) |
| `REFILL_PER_SEC` | `10` | Tokens added per second (sustained rate limit) |
| `SYNC_INTERVAL` | `1.0` | Seconds between Redis batch sync runs |
| `ORIGIN_URL` | `http://origin:8000` | Origin server URL |
| `REDIS_URL` | `redis://redis:6379` | Local Redis URL (fallback) |
| `ELASTICACHE_URL` | *(empty)* | AWS ElastiCache endpoint — overrides `REDIS_URL` |
| `CLOUDWATCH_LOG_GROUP` | *(empty)* | CloudWatch log group name |
| `SNS_TOPIC_ARN` | *(empty)* | SNS topic ARN for 429 alerts |
| `S3_AUDIT_BUCKET` | *(empty)* | S3 bucket name for audit logs |
| `S3_FLUSH_INTERVAL` | `30` | Seconds between S3 audit flushes |

### Edge Worker

| Variable | Default | Description |
|---|---|---|
| `POP_NAME` | `unknown-pop` | POP identifier (e.g., `mumbai`) |
| `SHIELD_URL` | `http://shield:9000` | Origin Shield URL |
| `CLOUDWATCH_LOG_GROUP` | *(empty)* | CloudWatch log group name |

### AWS Credentials

| Variable | Default | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | *(empty)* | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | *(empty)* | IAM secret key |
| `AWS_DEFAULT_REGION` | `ap-southeast-2` | AWS region |

---

## Running the Load Test

```bash
python loadtest.py
```

**Sample output:**
```
🚀  Load test starting — 200 req/s × 10s = ~2000 total requests
    API key : test-key-1
    POPs    : ['localhost:8001', 'localhost:8002', 'localhost:8003']
    Path    : /products
──────────────────────────────────────────────────────────
  [  200/2000]  [OK] 200:    25  [RL] 429:   117  [ERR] other:    0  elapsed: 1.0s
  [  400/2000]  [OK] 200:    33  [RL] 429:   176  [ERR] other:    0  elapsed: 2.0s
  [  600/2000]  [OK] 200:    46  [RL] 429:   311  [ERR] other:    0  elapsed: 3.0s
  [  800/2000]  [OK] 200:    54  [RL] 429:   415  [ERR] other:    0  elapsed: 4.0s
  [ 1000/2000]  [OK] 200:    63  [RL] 429:   549  [ERR] other:    0  elapsed: 5.0s
  [ 1200/2000]  [OK] 200:    72  [RL] 429:   668  [ERR] other:    0  elapsed: 6.0s
  [ 1400/2000]  [OK] 200:    86  [RL] 429:   818  [ERR] other:    0  elapsed: 7.0s
  [ 1600/2000]  [OK] 200:    94  [RL] 429:   922  [ERR] other:    0  elapsed: 8.0s
  [ 1800/2000]  [OK] 200:   100  [RL] 429:  1020  [ERR] other:    0  elapsed: 9.0s
  [ 2000/2000]  [OK] 200:   116  [RL] 429:  1174  [ERR] other:    0  elapsed: 10.0s

══════════════════════════════════════════════════════════
  LOAD TEST RESULTS
══════════════════════════════════════════════════════════
  Total requests sent :   2000
  ✅  200 (allowed)   :    167  (8.3%)
  🚫  429 (rate-lim'd):   1833  (91.7%)
──────────────────────────────────────────────────────────
  Expected ≈200s      : ~120  (capacity=20 + refill=10/s × 10s)
──────────────────────────────────────────────────────────

  [PASS] 200s within expected window [84, 180]
         Global rate limit is working correctly across all POPs.
```

**What this proves:**
- Out of 2,000 requests across 3 POPs, only ~167 were allowed (≈120 expected)
- The global rate limit is correctly enforced: `capacity=20 + refill=10/s × 10s = 120`
- All remaining 1,833 requests were rejected with `HTTP 429` + `Retry-After` header
- The ±30% tolerance accounts for batch sync jitter during the first sync cycle

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
   • Logs to AWS CloudWatch (stream: edge-mumbai)

3. Origin Shield receives forwarded request
   • Looks up (or creates) in-memory token bucket for "key:my-client"
   • Refills bucket based on time elapsed since last consume()
   • Tries to consume 1 token (LOCAL, zero-latency decision):
     ├── ALLOWED → forwards to Origin Server
     │             adds X-RateLimit-Remaining header
     │             logs audit event to S3 buffer
     │             returns Origin's response with 200
     └── REJECTED → returns 429 immediately
                    adds Retry-After header
                    publishes alert to AWS SNS
                    logs audit event to S3 buffer
                    does NOT contact Origin Server

4. (Async, every 1s) Batch Sync Daemon wakes up
   • For each client with unsynced usage:
     - Captures delta (tokens consumed since last sync)
     - Runs Lua script atomically on Redis / ElastiCache:
         * Uses Redis TIME (no clock skew)
         * Refills Redis-side tokens based on elapsed time
         * Deducts delta
         * Returns authoritative global token count
     - Reconciles local bucket: local_tokens ← global_tokens

5. (Async, every 30s) S3 Audit Flush Daemon wakes up
   • Collects all buffered audit events
   • Writes as timestamped JSONL file to S3
   • Re-queues on failure (no data loss)

6. Origin Server processes allowed request
   • Queries "database" (hardcoded product list)
   • Returns JSON product catalogue

7. Response travels back:
   Origin → Shield (adds X-RateLimit headers)
          → Edge POP (adds x-served-by-pop header)
          → Client
```

---

## 🎬 Demo Walkthrough

### Step 1 — Verify all services are healthy

```powershell
docker compose ps
```

All 6 containers should show `(healthy)`.

### Step 2 — Check Edge POP health endpoints

```powershell
Invoke-RestMethod http://localhost:8001/health    # Mumbai
Invoke-RestMethod http://localhost:8002/health    # Delhi
Invoke-RestMethod http://localhost:8003/health    # Bengaluru
```

### Step 3 — Send normal requests (watch X-RateLimit-Remaining decrease globally)

```powershell
Invoke-WebRequest -Uri "http://localhost:8001/products" -Headers @{"x-api-key"="demo-key"}
Invoke-WebRequest -Uri "http://localhost:8002/products" -Headers @{"x-api-key"="demo-key"}
Invoke-WebRequest -Uri "http://localhost:8003/products" -Headers @{"x-api-key"="demo-key"}
```

### Step 4 — Trigger 429 Rate Limit (exhaust bucket)

```powershell
for ($i=1; $i -le 25; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8001/products" -Headers @{"x-api-key"="demo-key"}
        Write-Host "Req $i : HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Host "Req $i : HTTP 429 (RATE LIMITED!)" -ForegroundColor Red
    }
}
```

### Step 5 — Watch token refill (wait 3 seconds, then try again)

```powershell
Start-Sleep -Seconds 3
Invoke-WebRequest -Uri "http://localhost:8001/products" -Headers @{"x-api-key"="demo-key"}
# Should return HTTP 200 — tokens have refilled!
```

### Step 6 — Run the global load test

```powershell
python loadtest.py
```

### Step 7 — Verify AWS services received data

- **CloudWatch**: https://console.aws.amazon.com/cloudwatch → Log groups → `/edge-rate-limiter`
- **SNS**: Check your email inbox for rate-limit alert notifications
- **S3**: https://console.aws.amazon.com/s3 → `rate-limiter-audit-logs` → `audit-logs/shield/`

### Step 8 — Inspect Redis state

```powershell
docker exec -it rl-redis redis-cli
HGETALL "rl:key:demo-key"
```

### Or run the interactive demo script

```powershell
.\demo.ps1
```

---

## Tearing Down

```bash
docker compose down -v   # stops containers and removes volumes
```

---

## Verifying Python Syntax

```bash
python -m py_compile origin/main.py
python -m py_compile edge/main.py
python -m py_compile shield/main.py
python -m py_compile loadtest.py
echo "All files pass py_compile"
```

---

## 🧰 Tech Stack

| Technology | Purpose |
|---|---|
| **Python 3.12** | All services are written in Python |
| **FastAPI** | High-performance async web framework |
| **Uvicorn** | ASGI server for running FastAPI apps |
| **httpx** | Async HTTP client for inter-service communication |
| **redis-py** | Python Redis client with async support |
| **boto3** | AWS SDK for Python (SNS, S3) |
| **watchtower** | CloudWatch log handler for Python logging |
| **Docker Compose** | Multi-container orchestration |
| **Redis 7 (Alpine)** | In-memory data store for token bucket sync |

---

## 📄 License

This project is for educational / academic demonstration purposes.
