<#
.SYNOPSIS
Interactive demonstration script for the Edge-Based Distributed Rate Limiting Middleware.
Run this script to step through the entire demonstration automatically with pauses.
#>

$ErrorActionPreference = "Stop"

function Wait-For-Enter {
    param([string]$Message = "Press Enter to continue to the next step...")
    Write-Host ""
    Write-Host "================================================================================" -ForegroundColor Cyan
    Read-Host -Prompt $Message
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host ""
}

Clear-Host
Write-Host "Edge-Based Distributed Rate Limiting Middleware - LIVE DEMO" -ForegroundColor Green
Write-Host "This script will walk you through the system step by step."
Wait-For-Enter "Press Enter to start the stack and verify containers..."

# -------------------------------------------------------------------------
# STEP 0: Start the stack
# -------------------------------------------------------------------------
Write-Host "[STEP 0] Starting Docker Compose stack..." -ForegroundColor Yellow
docker compose up -d
Write-Host ""
Write-Host "[STEP 0] Checking container status..." -ForegroundColor Yellow
docker compose ps

Wait-For-Enter "Press Enter to test the Edge POP Health endpoints..."

# -------------------------------------------------------------------------
# STEP 1: Health Checks
# -------------------------------------------------------------------------
Write-Host "[STEP 1] Checking Mumbai Edge POP (Port 8001)..." -ForegroundColor Yellow
$mumbaiHealth = Invoke-RestMethod -Uri "http://localhost:8001/health"
$mumbaiHealth | ConvertTo-Json -Depth 5 | Write-Host

Write-Host "`n[STEP 1] Checking Delhi Edge POP (Port 8002)..." -ForegroundColor Yellow
$delhiHealth = Invoke-RestMethod -Uri "http://localhost:8002/health"
$delhiHealth | ConvertTo-Json -Depth 5 | Write-Host

Write-Host "`n[STEP 1] Checking Bengaluru Edge POP (Port 8003)..." -ForegroundColor Yellow
$blrHealth = Invoke-RestMethod -Uri "http://localhost:8003/health"
$blrHealth | ConvertTo-Json -Depth 5 | Write-Host

Wait-For-Enter "Press Enter to test normal allowed requests..."

# -------------------------------------------------------------------------
# STEP 2: Normal Requests
# -------------------------------------------------------------------------
Write-Host "[STEP 2] Sending a normal request to Mumbai POP..." -ForegroundColor Yellow
$mumbaiResp = Invoke-WebRequest -Uri "http://localhost:8001/products" -Headers @{"x-api-key"="demo-key"}
Write-Host "Status: $($mumbaiResp.StatusCode)"
Write-Host "x-served-by-pop: $($mumbaiResp.Headers['x-served-by-pop'])"
Write-Host "X-RateLimit-Limit: $($mumbaiResp.Headers['x-ratelimit-limit'])"
Write-Host "X-RateLimit-Remaining: $($mumbaiResp.Headers['x-ratelimit-remaining'])"

Write-Host "`n[STEP 2] Sending a normal request to Delhi POP..." -ForegroundColor Yellow
$delhiResp = Invoke-WebRequest -Uri "http://localhost:8002/products" -Headers @{"x-api-key"="demo-key"}
Write-Host "Status: $($delhiResp.StatusCode)"
Write-Host "x-served-by-pop: $($delhiResp.Headers['x-served-by-pop'])"
Write-Host "X-RateLimit-Remaining: $($delhiResp.Headers['x-ratelimit-remaining'])"

Wait-For-Enter "Notice how the X-RateLimit-Remaining decreased globally. Press Enter to trigger a 429 Rate Limit..."

# -------------------------------------------------------------------------
# STEP 3: Trigger 429 Rate Limit
# -------------------------------------------------------------------------
Write-Host "[STEP 3] Spamming Mumbai POP to exhaust the bucket (25 requests)..." -ForegroundColor Yellow
for ($i = 1; $i -le 25; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8001/products" -Headers @{"x-api-key"="demo-key"} -ErrorAction Stop
        Write-Host "Req $i : HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Host "Req $i : HTTP $($_.Exception.Response.StatusCode) (RATE LIMITED!)" -ForegroundColor Red
        if ($_.Exception.Response.StatusCode -eq 429) {
            $errBody = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($errBody)
            $responseBody = $reader.ReadToEnd()
            Write-Host "Response Body: $responseBody" -ForegroundColor Red
            Write-Host "Retry-After Header: $($_.Exception.Response.Headers['Retry-After'])" -ForegroundColor Red
        }
    }
}

Wait-For-Enter "Press Enter to wait 3 seconds and see the bucket refill automatically..."

# -------------------------------------------------------------------------
# STEP 4: Token Refill
# -------------------------------------------------------------------------
Write-Host "[STEP 4] Waiting 3 seconds for token refill..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

Write-Host "`n[STEP 4] Retrying Mumbai POP..." -ForegroundColor Yellow
$mumbaiRetry = Invoke-WebRequest -Uri "http://localhost:8001/products" -Headers @{"x-api-key"="demo-key"}
Write-Host "Status: $($mumbaiRetry.StatusCode) (Tokens refilled!)" -ForegroundColor Green
Write-Host "X-RateLimit-Remaining: $($mumbaiRetry.Headers['x-ratelimit-remaining'])"

Wait-For-Enter "Press Enter to run the GLOBAL Load Test (Proof that limits are shared across all POPs)..."

# -------------------------------------------------------------------------
# STEP 5: Load Test
# -------------------------------------------------------------------------
Write-Host "[STEP 5] Running Global Load Test (python loadtest.py)..." -ForegroundColor Yellow
Write-Host "This will blast all 3 POPs round-robin at 200 req/s for 10 seconds."
Write-Host "Watch the output below:`n"
python loadtest.py

Wait-For-Enter "Press Enter to see how to stream live Docker logs..."

# -------------------------------------------------------------------------
# STEP 6: Live Logs
# -------------------------------------------------------------------------
Write-Host "[STEP 6] The demo script is complete!" -ForegroundColor Green
Write-Host "`nTo view the Origin Shield making real-time rate limit decisions, run this command in your terminal:" -ForegroundColor Yellow
Write-Host "    docker compose logs -f shield"
Write-Host "`nTo inspect the Redis global state directly, run:" -ForegroundColor Yellow
Write-Host "    docker exec -it rl-redis redis-cli"
Write-Host "    HGETALL `"rl:key:test-key-1`""
Write-Host "`nThank you for exploring the Edge-Based Distributed Rate Limiting Middleware!" -ForegroundColor Cyan
