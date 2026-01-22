# Load Testing Guide

## Overview

This directory contains comprehensive load tests for the POC's three critical components:

- **Hydra** (OAuth2/OIDC server) - token endpoint throughput
- **Kratos** (identity platform) - session validation and identity operations
- **Vote API** - JWT verification and vote recording under load

**Target:** Validate 10k requests per second (RPS) throughput

## Prerequisites

### Install k6 (Load Testing Tool)

**macOS:**
```bash
brew install k6
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install k6
```

**Windows:**
```bash
choco install k6
# OR download from: https://github.com/grafana/k6/releases
```

**Verify Installation:**
```bash
k6 version
```

### Ensure Services Are Running

```bash
cd .. && docker-compose up --build
```

Wait for all services to be healthy:
```bash
curl http://localhost:4444/.well-known/openid-configuration  # Hydra
curl http://localhost:4433/health                           # Kratos
curl http://localhost:4000/health                           # Vote API
```

## Test Profiles

Each test supports three load profiles:

| Profile | VUs | Duration | Target Throughput | Use Case |
|---------|-----|----------|-------------------|----------|
| **low** | 10-100 | 30-60s | Baseline | Development, quick validation |
| **medium** | 100-1000 | 60s | 5k RPS | Standard load testing |
| **high** | 1000+ | 120s | ~10k RPS | Stress testing, capacity planning |

## Running Tests

### Quick Start (Low Load)

```bash
# Test Hydra token endpoint
k6 run test/load-test-hydra.js

# Test Kratos sessions
k6 run test/load-test-kratos.js

# Test Vote API
k6 run test/load-test-vote-api.js
```

### All Tests Together

```bash
./test/run-tests.sh low      # Baseline
./test/run-tests.sh medium   # Standard load
./test/run-tests.sh high     # Stress test (10k req/s target)
```

### Custom Load Profile

```bash
# Run Hydra test with high load
k6 run -e LOAD=high test/load-test-hydra.js

# Run with custom VUs and duration
k6 run --vus 500 --duration 60s test/load-test-vote-api.js
```

## Test Descriptions

### 1. load-test-hydra.js

**What it tests:** Hydra's OAuth2 token endpoint throughput

**Flow:**
- Simulates 10-1000 concurrent OAuth clients requesting tokens
- Uses HTTP Basic auth for client authentication
- Measures latency (p95, p99) and error rates

**Expected Results (high profile):**
- Throughput: ~5,000-10,000 requests/sec (depends on backend capacity)
- P95 latency: <1 second
- P99 latency: <2 seconds
- Error rate: <10%

**Output Metrics:**
```
Total Requests: ~600,000 (120s @ 5k RPS)
Avg Duration: 150-300ms
P95 Duration: 800-1000ms
P99 Duration: 1500-2000ms
```

### 2. load-test-kratos.js

**What it tests:** Kratos session validation and identity operations

**Flow:**
- Concurrent calls to `/sessions/whoami` endpoint
- Simulates identity lookups during auth flows
- Measures identity platform throughput

**Expected Results (high profile):**
- Throughput: ~2,000-5,000 requests/sec
- P95 latency: <2 seconds
- P99 latency: <3 seconds
- Error rate: <10%

**Output Metrics:**
```
Total Requests: ~300,000 (120s @ 2.5k RPS)
Valid Sessions: 0-N (depends on existing sessions)
Avg Duration: 200-500ms
P95 Duration: 1500-2000ms
```

### 3. load-test-vote-api.js

**What it tests:** Vote API's JWT verification and vote recording

**Flow:**
- Concurrent vote submissions with JWT tokens
- Validates `vote:cast` scope requirement
- Tracks one-vote-per-election enforcement (409 responses)
- Measures vote recording latency

**Expected Results (high profile):**
- Throughput: ~1,000-5,000 votes/sec
- Succeeded votes: 60-80% (rest are conflicts/duplicates)
- P95 latency: <500ms
- P99 latency: <1000ms
- Error rate: <5%

**Output Metrics:**
```
Total Requests: ~500,000 (120s @ 4k RPS)
Succeeded: ~350,000
Conflicted (duplicate): ~150,000
Avg Duration: 100-200ms
P95 Duration: 300-500ms
P99 Duration: 800-1000ms
```

## Performance Targets

### Hydra (Token Endpoint)
- **Target:** 10,000 requests/second
- **Current Typical:** 3,000-8,000 RPS (depends on database performance)
- **Optimization:** Add caching, PostgreSQL tuning, connection pooling

### Kratos (Identity Operations)
- **Target:** 5,000 requests/second
- **Current Typical:** 2,000-5,000 RPS
- **Optimization:** Database indexing, session caching, read replicas

### Vote API (Application Layer)
- **Target:** 10,000 votes/second
- **Current Typical:** 1,000-5,000 RPS (bottleneck: in-memory, should use Kafka/DB)
- **Optimization:** Replace in-memory store with Kafka + aggregator stream

## Monitoring During Load Tests

### Watch Service Health

```bash
# In another terminal, watch container metrics
docker stats

# Or get detailed logs
docker-compose logs -f hydra
docker-compose logs -f kratos
docker-compose logs -f vote-api
docker-compose logs -f login-consent
```

### Check Database Load

```bash
# Connect to PostgreSQL
docker exec -it postgres psql -U ory -d hydra -c "SELECT * FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;"
```

### CPU & Memory Usage

```bash
docker stats --no-stream
```

## Interpreting Results

### Good Signs ✅
- P95 latency consistently under 1 second
- Error rate below 5%
- Services stay healthy during test
- No memory leaks (memory stable)

### Warning Signs ⚠️
- P99 latency trending upward
- Error rate increasing as load increases
- Memory creeping up (possible leak)
- Services becoming unresponsive

### Failure Signs ❌
- P95 latency >2 seconds
- Error rate >10%
- Service crashes or restarts
- Connection pool exhausted

## Troubleshooting

### "Connection refused" error

**Problem:** Services not running or ports incorrect

```bash
# Check services
docker-compose ps

# Verify ports
netstat -an | grep 4444  # Hydra
netstat -an | grep 4433  # Kratos
netstat -an | grep 4000  # Vote API
```

### "Too many open files" error

**Problem:** OS file descriptor limit too low

```bash
# Increase limit (macOS/Linux)
ulimit -n 65536

# Verify
ulimit -n
```

### Inconsistent test results

**Problem:** Services throttling or variable load

```bash
# Restart services between tests
docker-compose down
docker-compose up --build
sleep 30  # Wait for startup
```

### High error rates

**Problem:** Check individual component logs

```bash
docker-compose logs hydra --tail=50
docker-compose logs vote-api --tail=50
```

## Next Steps: Production Load Testing

For production validation:

1. **Deploy to staging environment** (Cloud: AWS/Azure)
2. **Run load tests from multiple geographic regions** (distributed load)
3. **Monitor end-to-end latency** (from client to database)
4. **Measure database query times** (PostgreSQL query logs)
5. **Implement Kafka** (for scalable vote storage)
6. **Add Redis caching** (for fast vote reads)
7. **Use CDN** (CloudFront, Cloudflare for token endpoint)
8. **Set up auto-scaling** (Kubernetes HPA or cloud native scaling)

## Useful k6 Commands

```bash
# Run test with output to file
k6 run test/load-test-hydra.js --out json=results.json

# Compare results between runs
k6 stats results.json

# Run test with custom VUs and duration
k6 run --vus 1000 --duration 2m test/load-test-hydra.js

# Run test with ramping load (0 → 100 VUs over 60s)
k6 run --stage "60s:100" test/load-test-hydra.js

# Real-time metrics dashboard (if using Grafana Cloud)
k6 cloud test/load-test-hydra.js
```

## Resources

- **k6 Documentation:** https://k6.io/docs/
- **k6 Examples:** https://github.com/grafana/k6/tree/master/samples
- **Hydra Performance Tuning:** https://www.ory.sh/docs/hydra/guides/performance
- **Kratos Scalability:** https://www.ory.sh/docs/kratos/guides/scalability
