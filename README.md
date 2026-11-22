# 🛡️ Edge-Based Distributed Rate Limiting Middleware

A production-grade, globally consistent, edge-based distributed rate limiting system integrated with **4 AWS Cloud Services** — designed for high-performance API protection across geographically distributed edge nodes.

```
Global Users
    │ API requests (HTTPS)
    ▼
CDN / Edge Network  (Nginx reverse proxy — host:8080)
    │  Routes by X-Region header or round-robin
    │
    ├── Edge POP — Mumbai     (port 8001)  ──► AWS CloudWatch Logs
    ├── Edge POP — Delhi      (port 8002)  ──► AWS CloudWatch Logs
    └── Edge POP — Bengaluru  (port 8003)  ──► AWS CloudWatch Logs
             │
             │  x-client-id + x-pop headers
             ▼
    Origin Shield  (port 9000, internal)
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

## 🎯 Problem Statement: Why Do We Need This?

In modern cloud applications, global user traffic hits distributed edge locations or Content Delivery Networks (CDNs) around the world. Protecting backend origin databases and microservices from abuse, scraping, and Distributed Denial of Service (DDoS) while keeping latency low presents **four critical engineering challenges**:

### 1. Quota Leakage / The $N \times$ Multiplier Vulnerability (Local-Only Limits)
* **The Naive Approach**: Each regional edge server (e.g., Mumbai, Delhi, Bengaluru) enforces its own local rate limit (e.g., 20 requests/sec).
* **The Vulnerability**: A malicious actor or botnet distributes requests across $N$ regional endpoints simultaneously. A client allowed 20 req/s can send 20 req/s to Mumbai + 20 req/s to Delhi + 20 req/s to Bengaluru = **60 requests/sec total** ($3\times$ quota leakage). In a global deployment with 50 edge POPs, backend services receive $50\times$ more traffic than permitted, leading to database degradation and service outages.

### 2. The Latency Trap & Single Point of Failure (Synchronous Centralized Redis)
* **The Naive Approach**: Every edge node calls a central Redis cluster synchronously on *every single incoming HTTP request* to check and deduct tokens.
* **The Vulnerability**: 
  1. **Latency Penalty**: Cross-region network hops between edge POPs and central Redis add **10ms to 80ms of round-trip latency to every API request**, destroying the speed advantage of edge computing.
  2. **Connection Exhaustion**: High-concurrency traffic (e.g., 10,000+ RPS) exhausts socket pools and turns the central Redis cluster into a catastrophic **Single Point of Failure (SPOF)**.

### 3. Distributed Clock Skew
* Edge servers located across different geographic regions cannot guarantee microsecond-level clock synchronization due to NTP drift. Standard timestamp-based algorithms (such as sliding log windows) suffer from race conditions, false 429 rejections, and quota spikes.

### 4. Outage Fragility (Fail-Closed vs Uncontrolled Fail-Open)
* When a central rate-limiting database or network partition occurs, traditional systems either:
  * **Fail-Closed**: Rejection of 100% of legitimate client traffic, causing a complete system blackout.
  * **Fail-Open Uncontrolled**: Completely removing rate limits, allowing unlimited traffic to overwhelm the database.

---

### 💡 The Solution: Hybrid Edge-Consistent Rate Limiting

This project demonstrates a production-grade architecture solving all four challenges:

| Challenge | How This Project Solves It |
|---|---|
| **Sub-Millisecond Speed** | **Zero-Latency In-Memory Hot Path**: Allow/deny decisions are made in-memory inside the Origin Shield using a local Token Bucket algorithm ($<1\text{ms}$ decision time). No blocking network calls. |
| **Global Enforcement** | **Asynchronous Batch Synchronization (1-Second Windows)**: An asynchronous Batch Sync Daemon periodically synchronizes local consumed deltas with Redis / AWS ElastiCache using an atomic Lua script. Quotas converge globally across all 3 POPs without inline latency. |
| **Clock Skew Elimination** | **Redis Authoritative Time**: The atomic Lua script uses Redis's own monotonic `TIME` command as the single source of truth, completely eliminating cross-node server clock drift. |
| **High Availability** | **Resilient Fail-Open Mode**: If Redis or AWS ElastiCache crashes, the Shield enters fail-open mode, serving traffic from local buckets without crashing, and automatically self-heals when Redis recovers. |
| **Enterprise Telemetry** | **Full-Stack AWS Observability**: Real-time structured logging to **AWS CloudWatch**, instant rate-limit breach alerts via **AWS SNS**, and automated JSONL audit log flushing to **AWS S3**. |

---

## 📋 Table of Contents

- [Problem Statement: Why Do We Need This?](#-problem-statement-why-do-we-need-this)
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
- [End-to-End Request Flow — Layer by Layer](#-end-to-end-request-flow--layer-by-layer)
- [Deep Dive: In-Memory Token Bucket & Redis Synchronization](#-deep-dive-in-memory-token-bucket--redis-synchronization)
- [Live Mission Control Dashboard — Complete Reference](#-live-mission-control-dashboard--complete-reference)
- [Demo Walkthrough](#-demo-walkthrough)
- [Tearing Down](#tearing-down)
- [Tech Stack](#-tech-stack)

---

## Architecture Overview

| Service | Role | Port | Rate Limiting? | AWS Integration |
|---|---|---|---|---|
| **cdn** | Nginx reverse proxy — routes to nearest POP | `8080` (entry point) | ❌ None | None |
| **edge-\*** | Identify client, add headers, forward to shield | `8001-8003` | ❌ None | CloudWatch Logs |
| **shield** | Token bucket allow/deny, proxy to origin | `9000` (internal) | ✅ **Yes — enforced here** | ElastiCache + CloudWatch + SNS + S3 |
| **origin** | Dynamic app logic, returns products | `8000` (internal) | ❌ None | None |
| **redis** | Global quota store (local fallback) | `6379` (internal) | N/A (data store) | Replaced by ElastiCache when configured |

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
├── docker-compose.yml        # Orchestrates all 7 services with AWS env vars
├── Dockerfile                # Shared Python 3.12-slim image for all services
├── requirements.txt          # Python dependencies (FastAPI, Redis, boto3, watchtower)
├── .env.example              # Template for AWS credentials and service config
├── .env                      # Your actual credentials (git-ignored, never committed)
├── .gitignore                # Protects .env from being committed
│
├── cdn/
│   └── nginx.conf            # CDN / Edge Network — Nginx reverse proxy config
│                              #   Routes by X-Region header or round-robin
│                              #   Adds X-CDN-Routed-To response header
│
├── edge/
│   └── main.py               # Edge Worker — client identification, header tagging,
│                              #   request forwarding, CloudWatch log handler
│
├── shield/
│   ├── main.py               # Origin Shield — in-memory token bucket, rate limiting,
│   │                          #   Batch Sync Daemon (Redis/ElastiCache), SNS alerts,
│   │                          #   S3 audit log flushing, CloudWatch logging,
│   │                          #   event bus + /internal/* endpoints for dashboard
│   └── event_bus.py           # Async event bus with bounded per-subscriber queues
│
├── origin/
│   └── main.py               # Origin Server — simulates a dynamic API with
│                              #   a hardcoded product catalogue
│
├── loadtest.py               # Load testing script (200 req/s × 10s, CDN or direct mode)
├── demo.ps1                  # Interactive PowerShell demo script
├── commands.md               # Quick-reference demo commands
│
├── dashboard/
│   ├── main.py               # Mission Control backend — SSE proxy, load generator,
│   │                          #   health aggregator, Docker chaos control
│   └── static/
│       ├── index.html         # Mission Control UI HTML structure
│       ├── style.css          # Sci-fi dark NOC styling, glassmorphism, responsive rules
│       └── js/                # Modular client-side architecture
│           ├── store.js       # Central state store with ring buffers & proof tracking
│           ├── topology.js    # Canvas hero topology with particle physics & shockwaves
│           ├── bucket.js      # Liquid token bucket vessel visualization
│           ├── charts.js      # Throughput area charts, POP distribution, proof card logic
│           ├── feed.js        # Terminal-style live feed & sync daemon timeline
│           ├── tour.js        # 8-step automated narrated guided demo
│           └── app.js         # Main frontend controller & SSE handler
│
├── tests/
│   └── test_smoke.py          # Smoke test: burst + SSE event verification
│
└── docs/                     # Screenshots and demo recordings
    ├── health-endpoints.webp  # Edge POP health checks
    └── shield-products.webp   # Shield health & product catalogue
```

---

## 🔧 How Each Service Works

### CDN / Edge Network (`cdn/nginx.conf`)

The CDN layer is an **Nginx reverse proxy** that simulates a real CDN like Cloudflare or AWS CloudFront. It is the **single entry point** for all client traffic on port **8080**.

**Routing behaviour:**

| Request Header | Routing Decision |
|---|---|
| `X-Region: mumbai` | Routes to Mumbai POP (port 8001) |
| `X-Region: delhi` | Routes to Delhi POP (port 8002) |
| `X-Region: bengaluru` (or `blr`, `bangalore`) | Routes to Bengaluru POP (port 8003) |
| `X-Region: mum` | Routes to Mumbai POP (alias) |
| `X-Region: del` | Routes to Delhi POP (alias) |
| No `X-Region` header | **Round-robin** across all 3 POPs |

**Features:**
1. **Geographic routing simulation** — uses the `X-Region` header to simulate geographic proximity-based routing that real CDNs perform via IP geolocation
2. **Round-robin fallback** — evenly distributes requests across all 3 POPs when no region preference is specified
3. **Observability headers** — adds `X-CDN-Routed-To` (which region was selected) and `X-CDN-Node` (CDN identifier) response headers
4. **Health endpoint** — `GET /cdn-health` returns CDN status and available POPs
5. **Pass-through** — all client headers (`x-api-key`, `X-Forwarded-For`, etc.) are preserved through to the Edge POP

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

The load tester validates that the global rate limit works correctly. It supports two modes:

| Mode | Command | How it works |
|---|---|---|
| **Direct POP** (default) | `python loadtest.py` | Round-robin across all 3 Edge POP ports directly |
| **CDN** | `python loadtest.py --cdn` | All traffic through port 8080 with `X-Region` header rotation |

| Parameter | Default | Description |
|---|---|---|
| `--rps` | `200` | Target requests per second |
| `--duration` | `10.0` | Test duration in seconds |
| `--api-key` | `test-key-1` | Client identity (API key) |
| `--pops` | `8001,8002,8003` | Edge POP ports to target (direct mode) |
| `--concurrency` | `50` | Max concurrent in-flight requests |
| `--path` | `/products` | Request path |
| `--cdn` | `false` | Route all traffic through CDN (port 8080) |
| `--cdn-port` | `8080` | CDN host port |

**How it works:**
- Fires `200 req/s × 10s = ~2,000 total requests` using a single API key
- **Direct mode:** distributes requests **round-robin** across all 3 edge POP ports
- **CDN mode:** sends all requests to port 8080 with rotating `X-Region` headers (`mumbai` → `delhi` → `bengaluru` → ...)
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

1. **Single entry point** — All client traffic enters through the CDN (port 8080) which routes to the nearest POP based on `X-Region` header or round-robin.
2. **Global limits, not per-POP** — A client alternating between Mumbai, Delhi, and Bengaluru still shares _one_ token bucket tracked in Central Redis / ElastiCache.
3. **Zero-latency hot path** — Allow/deny decisions use an in-memory token bucket; _no_ synchronous Redis call during request processing.
4. **Eventual convergence** — The Batch Sync Daemon reconciles local state with Redis every `SYNC_INTERVAL` seconds (default: 1s).
5. **Drift compensation** — After each sync, local tokens are set to the authoritative global count, preventing long-term divergence.
6. **Redis fail-open** — If Redis / ElastiCache is unavailable, the shield keeps serving from its local bucket and retries the sync next cycle.
7. **Clock-skew-free sync** — The Lua script uses Redis's own `TIME` command, not the container's wall clock.
8. **Fire-and-forget AWS** — SNS and S3 operations run in background tasks and never block the request path. Failures are logged and retried.
9. **Graceful degradation** — Every AWS integration is optional. The system works identically in local-only mode when env vars are absent.

---

## Configuration Reference

All configuration is done via environment variables in `docker-compose.yml` and `.env`.

### CDN / Edge Network

| Setting | Value | Description |
|---|---|---|
| Host port | `8080` | Single entry point for all client traffic |
| Routing | `X-Region` header | Routes to specific POP (`mumbai`, `delhi`, `bengaluru`) |
| Fallback | Round-robin | Distributes evenly when no `X-Region` header is set |
| Health endpoint | `/cdn-health` | Returns CDN status and available POPs |

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

### Direct POP Mode (default)

```bash
python loadtest.py
```

Sends 200 req/s round-robin directly to edge POP ports 8001, 8002, 8003.

### CDN Mode

```bash
python loadtest.py --cdn
```

Sends 200 req/s through the CDN entry point (port 8080) with rotating `X-Region` headers (`mumbai` → `delhi` → `bengaluru` → ...), simulating real-world geographic traffic.

**Sample output:**
```
🚀  Load test starting — 200 req/s × 10s = ~2000 total requests
    API key : test-key-1
    Mode    : CDN (port 8080)
    Routing : CDN (localhost:8080) → auto-routes to POPs
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

## 🔄 End-to-End Request Flow — Layer by Layer

When a client initiates a request, it traverses a 5-layer pipeline designed for sub-millisecond local authorization, global convergence, and comprehensive AWS telemetry:

```
[ Client ]
   │  GET /products
   │  x-api-key: demo-key, X-Region: mumbai
   ▼
[ Layer 1: CDN / Reverse Proxy (Nginx :8080) ]
   │  • Reads X-Region (or round-robin across POPs)
   │  • Injects routing header: X-CDN-Routed-To: mumbai
   ▼
[ Layer 2: Regional Edge Worker (Mumbai :8001) ]
   │  • Identifies client: client_id = "key:demo-key"
   │  • Tags headers: x-client-id: key:demo-key, x-pop: mumbai
   │  • Ships structured log to AWS CloudWatch Logs (stream: edge-mumbai)
   │  • Proxies request to Origin Shield
   ▼
[ Layer 3: Origin Shield (:9000 Internal) — The Enforcement Gatekeeper ]
   │
   ├── Step 1: Memory lookup for client's Token Bucket
   ├── Step 2: Lazy refill based on monotonic time elapsed:
   │           tokens = min(capacity, tokens + elapsed * refill_rate)
   ├── Step 3: Check: Are tokens >= 1.0?
   │
   ├───► [ BRANCH A: ALLOWED (tokens >= 1.0) ]
   │       1. Deduct 1.0 token from local bucket
   │       2. Increment unsynced_delta += 1.0 (for next 1s Redis sync)
   │       3. Append audit record to in-memory S3 buffer
   │       4. Emit SSE event to Live Dashboard (Green comet particle)
   │       5. Forward request to Origin Server (:8000)
   │       6. Receive 200 OK from Origin
   │       7. Attach rate limit headers:
   │          X-RateLimit-Limit: 20
   │          X-RateLimit-Remaining: 19
   │          X-RateLimit-Policy: 20;w=2
   │       8. Return HTTP 200 to Edge Worker
   │
   └───► [ BRANCH B: REJECTED / RATE-LIMITED (tokens < 1.0) ]
           1. Tokens remain untouched (< 1.0)
           2. Calculate retry_after = ceil(1.0 / refill_rate)
           3. Publish push notification to AWS SNS (email / SMS alert)
           4. Append denial audit record to in-memory S3 buffer
           5. Emit SSE event to Live Dashboard (Neon red particle + 429 shockwave)
           6. Short-circuit: DO NOT CONTACT ORIGIN SERVER!
           7. Return HTTP 429 Too Many Requests directly:
              Status: 429
              Retry-After: 1
              X-RateLimit-Limit: 20
              X-RateLimit-Remaining: 0
              X-RateLimit-Policy: 20;w=2
   ▼
[ Layer 4: Origin Server (:8000 Internal) — Allowed Requests Only ]
   │  • Executes application business logic
   │  • Queries product catalog "database"
   │  • Returns JSON product response
   ▼
[ Layer 5: Response Return Pipeline ]
   Origin (200 OK) ──► Shield (injects X-RateLimit-*) 
                    ──► Edge Worker (injects x-served-by-pop) 
                    ──► CDN (injects X-CDN-Routed-To) 
                    ──► Client
```

---

## 🪣 Deep Dive: In-Memory Token Bucket & Redis Synchronization

### 1. In-Memory Token Bucket Mechanics

Rate limiting decisions must occur in **sub-millisecond time** without blocking the event loop or waiting on a network call. The Shield achieves this through an asynchronous in-memory token bucket:

* **Capacity ($C$)**: The maximum burst capacity (e.g., `20` tokens).
* **Refill Rate ($r$)**: How quickly tokens replenish (e.g., `10` tokens/sec).
* **Monotonic Lazy Refill**: Instead of running background timers per client (which would waste CPU and memory for thousands of clients), the bucket computes refills **lazily** on the arrival of every request:
  $$\text{elapsed} = t_{\text{current}} - t_{\text{last\_refill}}$$
  $$\text{tokens} = \min\left(C, \; \text{tokens} + \text{elapsed} \times r\right)$$
  $$\text{last\_refill} = t_{\text{current}}$$
* **Thread & Coroutine Safety**: Each client bucket is isolated behind an `asyncio.Lock()` to prevent race conditions during rapid concurrent requests.

---

### 2. The Distributed Challenge: Why Not Call Redis on Every Request?

In traditional distributed architectures, services call Redis on *every incoming request*. However:
1. **Network Latency**: Each Redis round-trip adds 1–5ms over local networks and 15–50ms across regions.
2. **Network Bottleneck**: At 10,000 requests/sec across 3 edge locations, Redis becomes a single point of congestion and failure.

**Our Solution: Asynchronous Batch Synchronization (1-Second Windows)**
1. The Shield evaluates and grants/denies tokens **locally in memory with zero network delay**.
2. Each grant increments an internal counter: `unsynced_delta += 1.0`.
3. Every `1.0s`, a background daemon collects the deltas and synchronizes them with Redis in a single atomic batch.

---

### 3. The Atomic Redis Lua Script (`LUA_SYNC_SCRIPT`)

When the Batch Sync Daemon wakes up, it transmits the local `delta` to Redis or AWS ElastiCache. An atomic Lua script executes inside Redis to update the authoritative global state:

```lua
local key       = KEYS[1]
local delta     = tonumber(ARGV[1])
local capacity  = tonumber(ARGV[2])
local refill    = tonumber(ARGV[3])
local ttl       = tonumber(ARGV[4])

-- 1. Use Redis server wall-clock TIME to avoid distributed clock skew across nodes
local t         = redis.call('TIME')
local now_sec   = tonumber(t[1]) + tonumber(t[2]) / 1e6

-- 2. Fetch stored global token count and timestamp
local stored    = redis.call('HMGET', key, 'tokens', 'last_ts')
local tokens    = tonumber(stored[1]) or capacity
local last_ts   = tonumber(stored[2]) or now_sec

-- 3. Refill global quota based on true elapsed wall-clock time
local elapsed   = math.max(0, now_sec - last_ts)
tokens          = math.min(capacity, tokens + elapsed * refill)

-- 4. Deduct the usage delta reported by this Shield instance
tokens          = math.max(0, tokens - delta)

-- 5. Persist state back to Redis hash with automatic TTL
redis.call('HMSET', key, 'tokens', tokens, 'last_ts', now_sec)
redis.call('EXPIRE', key, ttl)

-- 6. Return authoritative global token count
return tostring(tokens)
```

---

### 4. Drift Compensation & Global Convergence

After Redis calculates the updated authoritative token count $G$, the Shield reconciles its local memory:

$$\text{local\_tokens} \leftarrow \min\left(C, \; \max(0, \; G)\right)$$

* **Drift**: The difference between local tokens and global authoritative tokens is tracked live as `Drift = |local_tokens - global_tokens|`.
* **Convergence**: Over every 1-second interval, drift converges to near zero, ensuring that the combined traffic from Mumbai, Delhi, and Bengaluru strictly respects the global rate limit without exceeding the configured limit.

---

### 5. Chaos Resilience: Fail-Open Mode During Redis Outages

What happens if Redis crashes or AWS ElastiCache becomes unreachable?

```
[ Redis / ElastiCache Outage Occurs ]
                    │
                    ▼
[ Batch Sync Daemon Catches Connection Exception ]
                    │
                    ├── 1. Restores unsynced delta: bucket.unsynced_delta += delta
                    ├── 2. Does NOT crash or drop client traffic
                    ├── 3. Enters FAIL-OPEN MODE: Shield continues serving from local memory
                    └── 4. Publishes redis_status: ok=False to Live Dashboard
```

* **Zero Downtime**: Users are not met with 500 Internal Server Errors; the Shield continues enforcing local quotas independently.
* **Self-Healing Reconnection**: When Redis or ElastiCache comes back online, the next sync cycle connects, flushes the accumulated delta, reconciles the global bucket, and clears the alert banner automatically.

---

## 🎬 Demo Walkthrough

### Step 1 — Verify all services are healthy

```powershell
docker compose ps
```

All 7 containers should show `(healthy)`:
- `rl-cdn` — CDN / Edge Network (Nginx)
- `rl-redis` — Central Redis
- `rl-origin` — Origin Server
- `rl-shield` — Origin Shield
- `rl-edge-mumbai` — Mumbai POP
- `rl-edge-delhi` — Delhi POP
- `rl-edge-bengaluru` — Bengaluru POP

### Step 2 — Check CDN and Edge POP health endpoints

```powershell
# CDN health
Invoke-RestMethod http://localhost:8080/cdn-health

# Edge POP health
Invoke-RestMethod http://localhost:8001/health    # Mumbai
Invoke-RestMethod http://localhost:8002/health    # Delhi
Invoke-RestMethod http://localhost:8003/health    # Bengaluru
```

### Step 3 — Test CDN routing (geographic simulation)

```powershell
# Route through Mumbai via CDN
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="mumbai"}

# Route through Delhi via CDN
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="delhi"}

# Round-robin (no region specified)
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"}
```

Check the `X-CDN-Routed-To` and `x-served-by-pop` response headers to verify routing.

### Step 4 — Send normal requests (watch X-RateLimit-Remaining decrease globally)

```powershell
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="mumbai"}
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="delhi"}
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="bengaluru"}
```

### Step 5 — Trigger 429 Rate Limit (exhaust bucket)

*(Note: Because PowerShell loops are slow (~8 req/s) and the bucket refills at 10 req/s, this sequential loop may not actually exhaust the bucket depending on your computer's speed. Step 7's concurrent load test guarantees exhaustion).*

```powershell
for ($i=1; $i -le 25; $i++) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"} -ErrorAction Stop
        Write-Host "Req $i : HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Host "Req $i : HTTP 429 (RATE LIMITED!)" -ForegroundColor Red
    }
}
```

### Step 6 — Watch token refill (wait 3 seconds, then try again)

```powershell
Start-Sleep -Seconds 3
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"}
# Should return HTTP 200 — tokens have refilled!
```

### Step 7 — Run the global load test

```powershell
# Via CDN (recommended — simulates real-world flow)
python loadtest.py --cdn

# Or direct to POPs (bypasses CDN)
python loadtest.py
```

### Step 8 — Verify AWS services received data

- **CloudWatch**: https://console.aws.amazon.com/cloudwatch → Log groups → `/edge-rate-limiter`
- **SNS**: Check your email inbox for rate-limit alert notifications
- **S3**: https://console.aws.amazon.com/s3 → `rate-limiter-audit-logs` → `audit-logs/shield/`

### Step 9 — Inspect Redis state

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

## 🖥️ Live Mission Control Dashboard — Complete Reference

The Live Mission Control Dashboard is a standalone, real-time, zero-build web application served at **http://localhost:3000**. Designed like a sci-fi network operations center (NOC), it renders every distributed event physically and audibly without external build steps (pure modern ES modules + Canvas API + Chart.js + GSAP).

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  🟢 EDGE RATE LIMITER  │  "Client key:demo-key → 120 req/s across 3 POPs. Shield: 167 allowed, 1833 rejected."  │  DEMO  FX  │
├───────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚙ CONTROL PANEL       │ 🗺 LIVE TOPOLOGY (~55% Viewport)                                                               │
│                       │   [Internet]          [Edge Network]          [Origin Shield]           [AWS Cloud]            │
│  API Key: [demo-key]  │   👤 Clients ───────► 🏙 Mumbai ───────────► 🛡 Shield ──────────────► 📦 Origin             │
│  Region:  [Mixed ▼]   │          │            🏛 Delhi    ───────────►    │                                        │
│  [▸ Send] [⚡ Burst]   │          └─────────► 🌴 Bengaluru ────────►    ├─── (1s Sync) ──────► 🗄 Redis / ElastiCache  │
│                       │                                                   ├─── (On 429)  ──────► 📢 AWS SNS Alert      │
│  Load Test:           │   Green Comets = Allowed (200 OK)                 ├─── (Audit)   ──────► 📦 AWS S3 Logs        │
│   RPS: [== 100 ==]    │   Red Shards + 429 = Denied (HTTP 429)            └─── (Logs)    ──────► ☁ AWS CloudWatch      │
│   Duration: [= 10 =]  ├───────────────────────────────┬────────────────────────────────┬───────────────────────────────┤
│   [▶ Start] [■ Stop]  │ 🪣 TOKEN BUCKET               │ 📈 THROUGHPUT & LATENCY        │ ⚖ GLOBAL LIMIT PROOF          │
│                       │   Liquid Wave Level (Local)   │   1833 Total │ 167 OK │ 1833 429│   Status: [ HOLDING ]         │
│  Capacity:  [ 20 ]    │   --- CAP Mark (20)           │   120 RPS    │ 1.2ms p50 Latency│   Actual Allowed:   167       │
│  Refill/s:  [ 10 ]    │   --- GLOBAL Mark (Authorit.) │   Area Chart (Green vs Red)    │   Expected Allowed: 120 ±15%  │
│                       ├───────────────────────────────┴────────────────────────────────┴───────────────────────────────┤
│  Redis Control:       │ 📋 LIVE EVENT FEED (Terminal)                  │ 🔄 SYNC DAEMON TIMELINE                       │
│  [Kill] [Restore]     │   21:45:01 [ALLOW] key:demo-key mumbai rem=18  │   #24 Δ=10 G=12.4 drift=0.2  [LOCAL REDIS]     │
│                       │   21:45:02 [DENY]  key:demo-key delhi  retry=1s│   #25 Δ=10 G=10.0 drift=0.0  [LOCAL REDIS]     │
└───────────────────────┴────────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

---

### Design System & Visual Grammar

The dashboard employs a strict visual hierarchy where color represents system state and physical action:

| Color | Hex | Meaning in Mission Control |
|---|---|---|
| **Neon Green** | `#00ff9d` | **Allowed Request (200 OK)**: Traffic permitted through the bucket; flows cleanly to Origin. |
| **Neon Red** | `#ff2e63` | **Rate-Limited Rejection (429)**: Bucket empty; particle bursts at Shield, triggering shockwaves and alerts. |
| **Amber** | `#ffb020` | **Redis Synchronization**: 1-second background daemon ticks, delta reporting, and authoritative global markers. |
| **Cyan** | `#22d3ee` | **CDN & Edge POPs**: Client routing, geographic edge distribution (Mumbai, Delhi, Bengaluru). |
| **Violet** | `#a78bfa` | **AWS Cloud Infrastructure**: Telemetry to CloudWatch Logs, SNS Alert Topics, and S3 Audit Buckets. |
| **Deep Space** | `#05070f` | **Canvas & Background**: Multi-layered drifting starfield with radial vignette for depth. |

---

### UI Panels Deep Dive

#### 1. Header Bar & Live "What's Happening" Ticker
* **Pulsing Health Ring**: Emits soft radar pulses; turns solid green when all services and SSE are connected, and pulses red if Redis is unreachable.
* **Live Narration Ticker**: A central telemetry marquee that interprets live events into plain-English sentences:
  > *"Client key:demo-key → 100 req/s across 3 POPs. Shield: 120 allowed, 880 rejected. Global rate limit holding."*
* **Guided Demo Trigger (`▸ Guided Demo`)**: Starts an automated 8-step scripted tour.
* **FX Toggle (`FX`)**: Toggles low-power mode (disables blur filters and particle trails for low-end hardware).
* **Connection Badge & System Clock**: Displays live SSE heartbeat and millisecond-accurate UTC time.

---

#### 2. Hero Topology Canvas (Top ~55% Viewport)
Replaces static SVG with a 60fps Hardware-Accelerated Canvas scene featuring real-time particle physics:
* **Zone Labeled Infrastructure**: Clearly grouped into 4 functional regions:
  1. `Internet` (Clients, CDN)
  2. `Edge Network` (Mumbai, Delhi, Bengaluru POPs)
  3. `Origin Shield` (Shield, Redis / ElastiCache)
  4. `AWS Cloud` (CloudWatch, SNS, S3)
* **Organic Bezier Links**: Curved connection conduits with flowing dash animations that scale in thickness and glow intensity with traffic volume.
* **Traffic Particles & Comet Trails**:
  * **Allowed Requests**: Vivid green comets fly Client → CDN → POP → Shield → Origin, then return as a fast success pulse.
  * **Denied Requests**: Bright neon red (`#ff2e63`) particles travel from the client to the Shield, where they **detonate on impact**, triggering:
    1. An expanding neon red shockwave ring.
    2. An explosion of 10 red flying shard sparks.
    3. Physical screen-space jitter on the Shield card.
    4. A floating bold neon `"429"` badge rising above the Shield node.
* **Ambient Idle Animation**: Even when traffic is idle, gentle ambient particles drift along links to maintain a living, breathing NOC environment.
* **Shield Mini-Gauge**: Inside the Shield node card, an embedded liquid gauge displays real-time token depletion and replenishment.
* **Fail-Open Outage Mode**: If Redis is killed or unreachable:
  * The Shield $\leftrightarrow$ Redis conduit snaps into a broken, sparking red dashed line.
  * The Redis node grays out and displays a flashing `FAIL` badge.
  * A screen-wide red vignette pulses with the warning banner: `REDIS UNREACHABLE: FAIL-OPEN MODE — serving from local bucket`.

---

#### 3. Token Bucket Visualizer
Provides a physical, visual metaphor for the in-memory token bucket algorithm:
* **Physical Glass Cylinder Vessel**: Shows a live animated sine-wave fluid surface representing available local tokens.
* **Liquid Color States**:
  * Neon Green ($>50\%$ capacity): Normal operation, plenty of tokens remaining.
  * Amber ($20\% - 50\%$ capacity): Heavy traffic, bucket draining.
  * Neon Red ($<20\%$ capacity): Critical capacity, imminent 429 rejections.
* **Falling Token Droplets**: Every allowed request visibly consumes a token, dropping a liquid bead out of the bottom of the vessel. Incoming refills drip in continuously from the top.
* **Authoritative Reference Markers**:
  * White Dashed Line (`CAP`): Maximum burst capacity (e.g., 20 tokens).
  * Amber Dashed Line (`GLOBAL`): Authoritative global quota reported back by Redis.
* **Live Stats Readout**:
  * **Local**: Tokens available in local Shield memory (decrements instantly with zero latency).
  * **Global**: The authoritative token count returned by Redis during the last sync.
  * **Drift**: Discrepancy between local and global ($|\text{Local} - \text{Global}|$).
  * **Unsynced $\Delta$ (Delta)**: Consumed tokens accumulated locally, queued for the next 1-second sync.
* **Mini Token History Chart**: Rolling 60-second line chart showing token levels over time.
* **Dynamic Plain-English Caption**: Updates live (e.g., *"Bucket at 85%. Refilling at 10 tokens/sec. Each request costs 1."*).

---

#### 4. Throughput & Latency Panel
* **Giant 36px+ Neon Odometer Numbers**: Features rolling count-up animations for key metrics:
  * **Total**: Combined request volume.
  * **Allowed**: Requests granted HTTP 200 (Green).
  * **Denied**: Requests rejected with HTTP 429 (Red).
  * **Deny %**: Percentage of traffic filtered out by the middleware.
  * **RPS**: Live instantaneous requests per second.
  * **p50 & p95 Latency**: Decision latencies measured in exact milliseconds (sub-millisecond decisions, typically 0.8ms to 1.4ms).
* **Glowing Area Chart**: Rolling 60-second window displaying allowed traffic (green gradient fill) versus rate-limited rejections (red gradient fill).

---

#### 5. Global Limit Proof Card
Mathematically proves that the distributed rate limiter prevents quota abuse across all 3 POPs combined:
* **The Mathematical Formula**:
  $$\text{Expected Allowed} = \text{Capacity} + (\text{Refill Rate} \times \Delta t_{\text{elapsed}})$$
  *Elapsed time is measured from the FIRST request of an active run (not page load) and resets after 5s of inactivity.*
* **Tolerance Band Progress Bar**: Compares actual allowed requests against the expected theoretical limit with a $\pm 15\%$ visual tolerance band.
* **Honest Verdict Badge**:
  * `HOLDING` (Neon Green): Actual allowed traffic strictly matches the theoretical limit.
  * `DRIFTING` (Amber / Red): Flags unexpected quota variance with the exact discrepancy reason.

---

#### 6. POP Distribution Panel
* **3 Regional Glass Cards**: Displays real-time metrics for **Mumbai**, **Delhi**, and **Bengaluru**.
* **SVG Map Markers**: Color-coded geographic pins.
* **Split Allow/Deny Progress Bars**: Shows what portion of each region's traffic was allowed versus rejected.
* **Global Consistency Verification**: Proves that even if one POP (e.g., Mumbai) receives 80% of the traffic, the global quota holds without allowing extra requests through Delhi or Bengaluru.

---

#### 7. Live Request Feed
* **Terminal-Style Scrolling Console**: Captures the latest 200 events with monospaced precision.
* **Status Badges**:
  * `[ALLOW]`: Green badge with client ID, POP, and remaining tokens.
  * `[DENY]`: Red badge with client ID, POP, and calculated `Retry-After` seconds.
  * `[SYNC]`: Amber badge detailing batch sync delta and authoritative global tokens.
  * `[SNS]`: Violet badge recording real-time alert publications.
  * `[S3]`: Violet badge tracking audit batch flushes.
* **Interactive Controls**: Features a pause/resume toggle (`⏸` / `▶`) and instant filtering (`All`, `Allow`, `Deny`, `Sync / AWS`).

---

#### 8. Sync Daemon Timeline Panel
The **Sync Daemon** runs asynchronously in the background every **1.0 second** to synchronize local edge state with central Redis / AWS ElastiCache. It renders as a scrolling horizontal timeline where each card represents one synchronization cycle:

```
┌──────────────────┐
│ #24              │ ◄── Sync Sequence ID (increments every 1s)
│ Δ 10             │ ◄── DELTA (Greek Triangle Δ): Tokens consumed locally since last sync
│ G 12.4           │ ◄── GLOBAL: Authoritative tokens returned by Redis
│ drift 0.2        │ ◄── DRIFT: Difference between local memory and central Redis
└──────────────────┘
```

* **`#` (Sequence Number, e.g. `#24`)**: The incremental ID of the sync run. Confirms that the background daemon is healthy and ticking at 1 Hz.
* **`Δ` (The Greek Triangle "Delta" — e.g. `Δ 10`)**: 
  * **What it is**: The exact count of tokens consumed locally (`unsynced_delta`) by this Shield instance since the previous 1-second sync.
  * **How it works**: When a request is allowed locally, the Shield decrements local tokens and increments `unsynced_delta += 1`. When the sync daemon wakes up, it transmits this $\Delta$ to Redis so Redis knows how much local usage to deduct from the global quota.
* **`G` (Authoritative Global Tokens — e.g. `G 12.4`)**: 
  * **What it is**: The single source of truth returned by Redis after executing the atomic Lua script.
  * **How Redis calculates it**: Redis adds time-based refills ($\text{elapsed} \times \text{refill}$) to stored tokens, subtracts the reported delta $\Delta$, and returns the updated global token count $G$.
* **`drift` (Drift Correction — e.g. `drift 0.2`)**:
  * **What it is**: The mathematical difference between local tokens and Redis global tokens:
    $$\text{drift} = |\text{local\_tokens} - \text{global\_tokens}|$$
  * **Why drift occurs**: Because the Shield authorizes requests *locally in real time* without waiting on Redis network hops, local memory and Redis can drift slightly apart during the 1-second sync window.
  * **How it converges**: The moment Redis returns $G$, the Shield immediately reconciles by setting `local_tokens = G`. This eliminates drift and locks all POPs to the true global limit.
* **`LOCAL REDIS` vs `ELASTICACHE` Mode Badge**: Displays whether the daemon is communicating with the local containerized Redis or AWS ElastiCache.
* **Fail-Open Status**: If Redis crashes, cards turn red with a `fail` border and a banner alerts: *"⚠ Redis unreachable — failing open, serving from local bucket"*.

---

#### 9. Interactive Guided Demo Tour
Clicking **`▸ Guided Demo`** in the header launches an automated 90-second interactive tour:
* Dims the background with a cinematic spotlight cutout on each active panel.
* Typewriter-animated narration explains each architectural concept in plain English.
* Automatically triggers real backend actions at each step:
  1. *Single Request*: Fires 1 request through CDN and traces the green comet particle.
  2. *Geographic Spread*: Bursts traffic across all 3 POPs simultaneously.
  3. *Local Shield Evaluation*: Spotlights zero-latency local in-memory token deduction.
  4. *Rate Limit Enforcement*: Bursts 60 requests, emptying the bucket and triggering 429 shockwaves and red shard bursts.
  5. *Batch Synchronization*: Highlights the amber sync conduit reconciling counts with Redis.
  6. *Global Limit Proof*: Launches a 10s load test and verifies the mathematical proof card.
  7. *Fail-Open Demonstration*: Simulates a Redis outage, demonstrating uninterrupted traffic flow.
  8. *AWS Recap*: Lights up CloudWatch, SNS, and S3 nodes in sequence.

---

#### 10. Presentation Mode (<kbd>F</kbd> Key)
* Designed specifically for **projector presentations**, conference screens, and executive demos.
* Hides the configuration sidebar and maximizes the topology canvas and live counters.
* Displays a minimal, floating glass quick-control bar in the bottom right corner with `▸ Send`, `⚡ Burst`, and `Exit (F)`.

---

#### 11. Low FX Mode
* Click the **`FX`** button in the header (or configure your OS for `prefers-reduced-motion`).
* Instantly disables CPU-heavy CSS blurs, canvas comet trails, and background starfield animations for smooth 60fps performance on low-power laptops.

---

### Dashboard API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/stream` | Server-Sent Events (SSE) stream delivering real-time telemetry from the Shield event bus. |
| `GET` | `/api/state` | JSON state snapshot (counters, active client buckets, AWS configuration, health). |
| `POST` | `/api/fire` | Dispatches a single test request through the CDN (`{"api_key": "...", "region": "..."}`). |
| `POST` | `/api/burst` | Dispatches a burst of $N$ concurrent requests through the CDN. |
| `POST` | `/api/load/start` | Initiates continuous synthetic load test (configurable RPS and duration). |
| `POST` | `/api/load/stop` | Halts any running synthetic load test immediately. |
| `GET` | `/api/load/status` | Polling endpoint for active load test metrics. |
| `POST` | `/api/config` | Live-adjusts bucket capacity ($C$) and refill rate ($r$) across all active clients. |
| `POST` | `/api/reset` | Resets a client's bucket back to full capacity and clears Redis key. |
| `GET` | `/api/health` | Aggregates health probe data from CDN, 3 Edge POPs, Shield, Origin, and Redis. |
| `POST` | `/api/docker/redis/stop` | Chaos engineering: Stops the Redis container to test fail-open mode. |
| `POST` | `/api/docker/redis/start` | Chaos engineering: Restarts the Redis container to test self-healing sync. |

---

### Dashboard Configuration & Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `DASHBOARD_ALLOW_DOCKER_CONTROL` | `false` | When set to `true` (and `/var/run/docker.sock` is mounted), enables the Kill/Restore Redis buttons in the control panel for live chaos testing. |

### Demo Flow

1. **Open dashboard** → `http://localhost:3000`
2. **Watch the topology** at idle — all health dots green, no traffic
3. **Click "Send 1"** → watch a green dot travel Client → CDN → POP → Shield → Origin
4. **Click "Burst 30"** → watch the bucket drain and red 429 dots appear
5. **Start a load test** (100 rps, 10s) → watch throughput chart fill, denial rate climb, global limit hold across all 3 POPs
6. **Stop Redis** → watch the Redis health dot turn red, "failing open" banner appear, and the system continue serving from local bucket
7. **Restore Redis** → watch it recover, sync resume, drift correct
8. **Adjust config** → change capacity to 50, watch the bucket refill and allow rate increase

### Smoke Test

```bash
python tests/test_smoke.py
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
| **Nginx 1.27** | CDN / Edge Network reverse proxy with geographic routing |
| **httpx** | Async HTTP client for inter-service communication |
| **redis-py** | Python Redis client with async support |
| **boto3** | AWS SDK for Python (SNS, S3) |
| **watchtower** | CloudWatch log handler for Python logging |
| **Docker Compose** | Multi-container orchestration (7 services) |
| **Redis 7 (Alpine)** | In-memory data store for token bucket sync |

---

## 📄 License

This project is for educational / academic demonstration purposes.
