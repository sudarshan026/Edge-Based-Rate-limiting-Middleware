# Demo Commands
Run these commands sequentially in your terminal to demonstrate the rate limiting system.

### 1. Start the stack and verify
```powershell
docker compose up -d
docker compose ps
```

### 2. Verify CDN and all 3 Edge POPs are alive
```powershell
Invoke-RestMethod http://localhost:8080/cdn-health
Invoke-RestMethod http://localhost:8001/health
Invoke-RestMethod http://localhost:8002/health
Invoke-RestMethod http://localhost:8003/health
```

### 3. Normal Requests through CDN (Notice `X-RateLimit-Remaining` decreases globally)
```powershell
Invoke-WebRequest -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="mumbai"}
Invoke-WebRequest -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="delhi"}
Invoke-WebRequest -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"; "X-Region"="bengaluru"}
```

### 4. Trigger 429 Rate Limit (Run 30 requests rapidly through CDN)
```powershell
for ($i=1; $i -le 30; $i++) {
    $r = Invoke-WebRequest -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"} -SkipHttpErrorCheck
    Write-Host "Req $i : HTTP $($r.StatusCode)"
}
```

### 5. Watch Token Refill (Wait 3 seconds, then try again)
```powershell
Start-Sleep -Seconds 3
Invoke-WebRequest -Uri "http://localhost:8080/products" -Headers @{"x-api-key"="demo-key"}
```

### 6. Run the Global Load Test (Proves limits are shared across POPs)
```powershell
# Via CDN (Simulates geographic routing)
python loadtest.py --cdn

# Or bypass CDN, hitting POPs directly
python loadtest.py
```

### 7. Inspect Live Logs (Run in a separate terminal)
```powershell
# Watch the shield making decisions
docker compose logs -f shield

# Watch all traffic
docker compose logs -f
```

### 8. Inspect Redis State (Run in a separate terminal)
```powershell
docker exec -it rl-redis redis-cli
HGETALL "rl:key:demo-key"
```
