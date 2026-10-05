# 🛡️ Edge-Based Distributed Rate Limiting Middleware

A production-grade, globally consistent, edge-based distributed rate limiting system integrated with **4 AWS Cloud Services** — designed for high-performance API protection across geographically distributed edge nodes.

```text
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
```

---

## ☁️ AWS Cloud Services Integrations

This project integrates AWS cloud services for production-grade observability and alerting. The system gracefully falls back to local execution via Docker when AWS environment variables are absent.

1. **AWS ElastiCache (Redis)**: Managed global token-quota store. Replaces local Redis to maintain globally consistent rate limits across multiple instances.
2. **AWS CloudWatch**: Centralised structured logging from Shield and all Edge POPs. Aggregates logs into a single, searchable stream.
3. **AWS SNS**: Real-time push alerts on every HTTP 429 (rate-limit hit), allowing teams to detect abuse patterns instantly.
4. **AWS S3**: Periodic JSONL audit-log flush of every allow/deny decision, providing an immutable record for compliance and analysis.

---

## 🔧 System Components

- **Edge Worker (`edge/main.py`)**: A lightweight reverse proxy at each POP (Mumbai, Delhi, Bengaluru) that identifies clients via `x-api-key`, tags requests, and forwards them to the Shield. Does not perform rate limiting.
- **Origin Shield (`shield/main.py`)**: The core rate limiter. Maintains an in-memory token bucket for zero-latency decisions. A background Batch Sync Daemon reconciles usage with ElastiCache/Redis every second. Also handles SNS alerts and S3 log flushing asynchronously.
- **Origin Server (`origin/main.py`)**: Simulates a backend API, returning a hardcoded product catalogue.
- **Load Test Script (`loadtest.py`)**: Validates the global rate limit across POPs using concurrent requests.

### Key Design Properties
- **Global limits**: Clients share one token bucket across all edge locations.
- **Zero-latency hot path**: Decisions use an in-memory bucket without synchronous Redis calls during request processing.
- **Eventual convergence**: The Batch Sync Daemon resolves drift with Redis using `TIME` commands to prevent clock skew issues.
- **Fail-open & Graceful degradation**: System operates normally even if Redis or AWS services are unavailable.

---

## 🚀 Quick Start

### Prerequisites
- Docker Desktop ≥ 24
- Python 3.12 (for the load tester)
- *(Optional)* AWS credentials configured in `.env`

### Run the Stack

```bash
# 1. Bring up all services
docker compose up --build -d

# 2. Wait for health checks
docker compose ps
```

### Smoke Test

```bash
# Test Mumbai POP
curl -s -H "x-api-key: my-client" http://localhost:8001/products

# Test Delhi POP (shares the same global quota)
curl -s -H "x-api-key: my-client" http://localhost:8002/products
```

---

## 📈 Running the Load Test

The load tester proves the global rate limit holds across all three POPs simultaneously. 
It fires 200 requests/sec for 10 seconds across all edge nodes.

```bash
python loadtest.py
```

**Expected Results:**
- Out of ~2,000 requests, only ~120 should be allowed (Capacity: 20 + Refill: 10/s × 10s).
- Remaining requests are rejected with `HTTP 429` + `Retry-After`.

---

## 🎬 Demo Walkthrough

Try these commands to observe the system in action:

1. **Verify Edge POP Health**:
   ```powershell
   Invoke-RestMethod http://localhost:8001/health
   Invoke-RestMethod http://localhost:8002/health
   Invoke-RestMethod http://localhost:8003/health
   ```

2. **Send Normal Requests (Notice `X-RateLimit-Remaining` decrease)**:
   ```powershell
   Invoke-WebRequest -Uri "http://localhost:8001/products" -Headers @{"x-api-key"="demo-key"}
   ```

3. **Trigger Rate Limit (HTTP 429)**: Send >20 requests rapidly to exhaust the bucket.

4. **Observe Live Logs**:
   ```powershell
   # Watch Origin Shield decisions and AWS uploads
   docker compose logs -f shield
   ```

---

## ⚙️ Configuration Reference

All configuration is handled in `docker-compose.yml` and `.env`.

- `BUCKET_CAPACITY` (default: 20): Initial burst allowance per client.
- `REFILL_PER_SEC` (default: 10): Tokens refilled per second.
- `SYNC_INTERVAL` (default: 1.0s): Redis batch sync frequency.
- **AWS variables** (`ELASTICACHE_URL`, `CLOUDWATCH_LOG_GROUP`, `SNS_TOPIC_ARN`, `S3_AUDIT_BUCKET`): Leave blank to disable AWS integration and use local equivalents.

---

## 🧰 Tech Stack

- **Python 3.12** / **FastAPI** / **Uvicorn**
- **httpx** / **redis-py** / **boto3** / **watchtower**
- **Docker Compose** / **Redis 7**
