# Load Testing Guide

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites & Installation](#prerequisites--installation)
4. [Running Tests](#running-tests)
5. [Test Descriptions](#test-descriptions)
6. [Performance Targets](#performance-targets)
7. [Monitoring & Analysis](#monitoring--analysis)
8. [Troubleshooting](#troubleshooting)
9. [Optimization Strategies](#optimization-strategies)
10. [References](#references)

---

## Overview

This directory contains comprehensive load tests to validate the POC's three critical components can handle **10,000 requests per second (RPS)**:

- **Hydra** - OAuth2/OIDC token endpoint throughput
- **Kratos** - Identity platform session validation
- **Vote API** - JWT verification and vote recording under load

**Files Structure:**
```
/test/
├── LOAD_TESTING.md           <- This file
├── load-test-hydra.js        <- Hydra token endpoint test
├── load-test-kratos.js       <- Kratos identity/session test
├── load-test-vote-api.js     <- Vote API JWT + voting test
├── run-tests.sh              <- Bash runner (Linux/macOS)
├── run-tests.ps1             <- PowerShell runner (Windows)
└── compare-results.sh        <- Compare test runs
```

---

## Architecture

### System Under Test

```
                          User/Client
                               |
                +--------------+---------------+
                |                              |
                v                              v
           [Kratos]                        [Hydra]
           (4433)                          (4444)
        Identity Platform              OAuth2/OIDC Server
        - Registration                 - Token Issuance
        - Session Management           - Client Validation
        - Password Verification        - Scope Management
                |                              |
                |                              v
                +----------> [Login-Consent] <-+
                            (3000)
                        Bridge/Middleware
                        - Connects Kratos sessions
                          to Hydra challenges
                               |
                               v
                          [Vote API]
                           (4000)
                        - JWT Verification
                        - Vote Recording
                        - Deduplication
                               |
                               v
                         [PostgreSQL]
                           (5432)
                      Vote Ledger + Identity
```

### Load Test Architecture

```
                    [k6 Load Generator]
                            |
        +-------------------+-------------------+
        |                   |                   |
        v                   v                   v
[load-test-hydra.js]  [load-test-kratos.js]  [load-test-vote-api.js]
        |                   |                   |
        v                   v                   v
    [Hydra:4444]       [Kratos:4433]       [Vote API:4000]
        |                   |                   |
        +-------------------+-------------------+
                            |
                            v
                      [PostgreSQL:5432]
```

**Key Testing Approach:**

1. **Hydra Test** - Simulates OAuth2 clients requesting tokens
   - Measures token issuance throughput
   - Validates HTTP Basic auth handling
   - Monitors latency under concurrent load

2. **Kratos Test** - Simulates session validation requests
   - Tests `/sessions/whoami` endpoint
   - Measures identity lookup performance
   - Validates database query optimization

3. **Vote API Test** - Simulates vote submissions
   - Tests JWT verification via JWKS
   - Validates one-vote-per-election enforcement (409 responses)
   - Measures vote recording throughput

---

## Prerequisites & Installation

### 1. Install k6 (Load Testing Tool)

**macOS:**
```bash
brew install k6
```

**Linux (Ubuntu/Debian):**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Windows (PowerShell admin):**
```powershell
choco install k6
# OR download from: https://github.com/grafana/k6/releases
```

**Verify Installation:**
```bash
k6 version
# Expected: k6 v0.48.0 (or later)
```

### 2. Ensure Services Are Running

```bash
cd /path/to/poc-ory-hydra-kratos
docker-compose up --build
```

Wait ~30 seconds, then verify all services are healthy:

```bash
# Hydra OIDC config
curl http://localhost:4444/.well-known/openid-configuration

# Kratos health
curl http://localhost:4433/health

# Vote API health
curl http://localhost:4000/health

# All services status
docker-compose ps
```

All services should show status "Up" and "healthy".

---

## Running Tests

### Load Profiles

Each test supports three load profiles:

| Profile | VUs (Virtual Users) | Duration | Target Throughput | Use Case |
|---------|---------------------|----------|-------------------|----------|
| **low** | 10-100 | 30-60s | ~1,000 RPS | Quick baseline validation |
| **medium** | 100-1000 | 60s | ~5,000 RPS | Standard load testing |
| **high** | 1000+ | 120s | ~10,000 RPS | Stress testing, capacity planning |

### Quick Start - Individual Tests

```bash
# Run individual test with low load (default)
k6 run test/load-test-hydra.js

# Run with specific profile
k6 run -e LOAD=medium test/load-test-kratos.js
k6 run -e LOAD=high test/load-test-vote-api.js

# Custom VUs and duration
k6 run --vus 500 --duration 60s test/load-test-vote-api.js
```

### All Tests Together

**Bash/Linux/macOS:**
```bash
./test/run-tests.sh low      # Baseline (5 min)
./test/run-tests.sh medium   # Standard load (10 min)
./test/run-tests.sh high     # Stress test (15 min)
```

**PowerShell/Windows:**
```powershell
.\test\run-tests.ps1 -Profile low
.\test\run-tests.ps1 -Profile medium
.\test\run-tests.ps1 -Profile high
```

### Advanced: Custom Test Scenarios

```bash
# Spike test (ramp up fast, then back down)
k6 run --stage "30s:100" --stage "5s:5000" --stage "30s:100" test/load-test-vote-api.js

# Sustained load (30 min)
k6 run --vus 500 --duration 30m test/load-test-hydra.js

# Save results to JSON
k6 run --out json=results.json test/load-test-hydra.js
```

---

## Test Descriptions

### Test 1: load-test-hydra.js

**Purpose:** Validate Hydra's JWKS endpoint throughput

**What it tests:**
- JWKS (public keys) serving under load
- This is the actual endpoint Vote API calls to verify JWT tokens
- Response caching behavior
- Public endpoint availability

**Why JWKS and not token endpoint:**
In the real voting scenario:
1. Users authenticate ONCE -> Hydra issues JWT tokens (low frequency)
2. Users vote MANY TIMES -> Vote API fetches JWKS to verify tokens (high frequency)
3. JWKS endpoint is called by every Vote API instance on startup, then cached

**Load Profile Configuration:**
- **Low:** 10 VUs, 30s duration
- **Medium:** 100 VUs, 60s duration
- **High:** 1000 VUs, 120s duration

**Expected Results (high profile):**
```
Total Requests:    ~600,000 (120s @ 5,000 RPS)
Success Rate:      >99%
Avg Duration:      5-10ms
P95 Duration:      <100ms (target)
P99 Duration:      <200ms (target)
Error Rate:        <1%
```

**Success Criteria:**
- P95 latency < 100ms
- Error rate < 1%
- No service crashes

### Test 2: load-test-kratos.js

**Purpose:** Validate Kratos identity and session management throughput

**What it tests:**
- Session validation (`/sessions/whoami`)
- Database query performance (identity lookups)
- Session cookie handling
- Identity schema validation

**Load Profile Configuration:**
- **Low:** 10 VUs, 30s duration
- **Medium:** 100 VUs, 60s duration
- **High:** 500 VUs, 120s duration

**Expected Results (high profile):**
```
Total Requests:    ~300,000 (120s @ 2,500 RPS)
Valid Sessions:    Varies (depends on existing sessions)
Avg Duration:      200-500ms
P95 Duration:      <2,000ms (target)
P99 Duration:      <3,000ms (target)
Error Rate:        <10%
```

**Success Criteria:**
- P95 latency < 2 seconds
- Error rate < 10%
- Memory stable (no leaks)

### Test 3: load-test-vote-api.js

**Purpose:** Validate Vote API's JWT verification and vote recording

**What it tests:**
- JWT verification via JWKS fetch from Hydra (cached)
- Scope validation (`vote:cast` requirement)
- Vote recording throughput
- One-vote-per-election enforcement (409 Conflict responses)
- In-memory storage performance

**Real Voting Scenario:**
```
User Authentication (ONE TIME):
  User -> Kratos (login) -> Login-Consent -> Hydra -> JWT Token

User Voting (MANY TIMES):
  User -> Vote API (with token) -> Verify JWT locally (JWKS) -> Record vote
  
NO Hydra calls during voting (JWKS cached in Vote API)
```

**Note:** This test uses mock tokens to measure throughput. In production:
- Tokens come from Hydra OAuth flow
- Vote API fetches JWKS once on startup, then caches it
- JWT verification happens locally (no per-request Hydra calls)

**Load Profile Configuration:**
- **Low:** 10 VUs, 30s duration
- **Medium:** 100 VUs, 60s duration
- **High:** 1000 VUs, 120s duration

**Expected Results (high profile):**
```
Total Requests:    ~500,000 (120s @ 4,000 RPS)
Votes Succeeded:   Variable (depends on token validity)
Unauthorized:      Expected (mock tokens)
Avg Duration:      100-200ms
P95 Duration:      <500ms (target)
P99 Duration:      <1,000ms (target)
Error Rate:        <5%
```

**Success Criteria:**
- P95 latency < 500ms
- Error rate < 5% (excluding 401 from mock tokens)
- Zero duplicate votes (all conflicts are 409 responses)

---

## Performance Targets

### Hydra (Token Endpoint)

| Metric | Target | Current | After Optimization |
|--------|--------|---------|-------------------|
| Throughput | 10,000 RPS | ~5,000 RPS | ~10,000 RPS |
| P95 Latency | <1s | 800-1000ms | <500ms |
| Error Rate | <1% | 5-10% | <1% |

**Current Bottlenecks:**
- Token signing (RSA signatures are CPU-intensive)
- Database lookups for client validation
- Connection pool limits (default: 10 connections)

**Optimization Path:**
1. Add Redis cache for client configurations
2. Increase PostgreSQL connection pool to 50+
3. Use CDN for token endpoint with caching headers
4. Horizontal scaling with load balancer

### Kratos (Identity Platform)

| Metric | Target | Current | After Optimization |
|--------|--------|---------|-------------------|
| Throughput | 5,000 RPS | ~3,000 RPS | ~8,000 RPS |
| P95 Latency | <2s | 1500-2000ms | <1s |
| Error Rate | <2% | 5-10% | <2% |

**Current Bottlenecks:**
- Session validation (DB query per request)
- Identity schema validation overhead
- PostgreSQL connection pool exhaustion

**Optimization Path:**
1. Add Redis session cache (reduce DB hits)
2. Create read replicas for session lookups
3. Batch identity validation where possible
4. Increase connection pool (default: 10 -> 50)

### Vote API (Application Layer)

| Metric | Target | Current | After Optimization |
|--------|--------|---------|-------------------|
| Throughput | 10,000 RPS | ~5,000 RPS | ~20,000 RPS |
| P95 Latency | <500ms | 300-500ms | <200ms |
| Error Rate | <0.1% | 3-5% | <0.5% |

**Current Bottlenecks:**
- In-memory array storage (doesn't scale, not durable)
- JWKS fetch on every request (should cache)
- Single-process Node.js (no horizontal scaling)

**Optimization Path (Critical):**
1. **Phase 1:** Add PostgreSQL with unique constraint `(election_id, voter_sub)`
2. **Phase 2:** Add Kafka producer for vote events (durability + scale)
3. **Phase 3:** Add aggregator stream (Kafka Streams/Flink) for real-time counts
4. **Phase 4:** Add Redis for hot vote counters (fast reads)

**Expected After Kafka:**
- Throughput: 20,000+ votes/sec (distributed across partitions)
- Durability: 100% (Kafka replication)
- Scalability: Horizontal (add more consumers)

---

## Monitoring & Analysis

### Real-Time Monitoring During Tests

**Terminal 1: Run Test**
```bash
./test/run-tests.sh high
```

**Terminal 2: Watch Container Stats**
```bash
watch -n 1 'docker stats --no-stream'
# Monitor CPU %, Memory usage, Network I/O
```

**Terminal 3: Watch Service Logs**
```bash
docker-compose logs -f hydra vote-api
# Look for errors, slow queries, connection issues
```

**Terminal 4: Monitor Database**
```bash
# Active connections
docker exec -it postgres psql -U ory -d hydra -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"

# Slow queries
docker exec -it postgres psql -U ory -d hydra -c "SELECT query, calls, total_time FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;"
```

### Key Metrics to Watch

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| CPU Usage | <50% | 50-80% | >80% |
| Memory | Stable | Growing slowly | >90% or OOM |
| P95 Latency | <1s | 1-2s | >2s |
| Error Rate | <1% | 1-5% | >5% |
| DB Connections | <50% pool | 50-90% pool | Pool exhausted |

### Interpreting Results

**Good Signs:**
- P95 latency consistently under target
- Error rate below 5%
- Services stay healthy throughout test
- Memory usage stable (no leaks)
- CPU usage predictable

**Warning Signs:**
- P99 latency trending upward over time
- Error rate increasing as load increases
- Memory slowly creeping up (possible leak)
- Services becoming unresponsive
- Database connections nearing pool limit

**Failure Signs:**
- P95 latency >2 seconds
- Error rate >10%
- Service crashes or container restarts
- Connection pool exhausted
- Out of memory (OOM) kills

### Collecting Results

```bash
# Export test results to JSON
k6 run --out json=results.json test/load-test-hydra.js

# View summary statistics
k6 stats results.json

# Parse specific metric
grep "http_req_duration" results.json | jq '.value'

# Compare two test runs
./test/compare-results.sh baseline.json after-optimization.json
```

---

## Troubleshooting

### "Connection refused" error

**Problem:** Services not running or ports incorrect

**Solution:**
```bash
# Check service status
docker-compose ps

# Restart services
docker-compose down
docker-compose up --build
sleep 30  # Wait for startup

# Verify ports
netstat -an | grep 4444  # Hydra
netstat -an | grep 4433  # Kratos
netstat -an | grep 4000  # Vote API
```

### "Too many open files" error

**Problem:** OS file descriptor limit too low for high concurrent connections

**Solution (macOS/Linux):**
```bash
# Increase limit temporarily
ulimit -n 65536

# Verify
ulimit -n

# Permanent (add to ~/.bashrc or ~/.zshrc)
echo "ulimit -n 65536" >> ~/.bashrc
```

**Solution (Windows):**
No file descriptor limit, but check connection pool settings in services.

### High error rates (>10%)

**Problem:** Services overwhelmed or misconfigured

**Solution:**
```bash
# Check service logs for specific errors
docker-compose logs hydra --tail=100
docker-compose logs vote-api --tail=100

# Common issues:
# - Database connection pool exhausted
# - Memory limit reached
# - Network timeouts

# Increase database connection pool
# Edit docker-compose.yml:
# DSN=postgres://ory:secret@postgres:5432/hydra?sslmode=disable&max_conns=50

# Restart services
docker-compose restart
```

### Inconsistent test results

**Problem:** Services throttling or variable load from other processes

**Solution:**
```bash
# Restart services between tests
docker-compose down
docker-compose up --build
sleep 30  # Wait for stable startup

# Run test multiple times and average results
for i in {1..3}; do
  k6 run -e LOAD=high --out json=results-run-$i.json test/load-test-hydra.js
  sleep 60  # Rest between runs
done
```

### Memory leaks detected

**Problem:** Service memory growing continuously during test

**Solution:**
```bash
# Monitor memory over time
watch -n 5 'docker stats --no-stream | grep vote-api'

# Restart service to clear memory
docker-compose restart vote-api

# Investigate with Node.js profiler
# Add to vote-api:
# npm install clinic
# clinic doctor -- node src/index.js
```

---

## Optimization Strategies

### Phase 1: Quick Wins (Week 1)

**1. Increase Database Connection Pools**

Edit `docker-compose.yml`:
```yaml
services:
  hydra:
    environment:
      - DSN=postgres://ory:secret@postgres:5432/hydra?sslmode=disable&max_conns=50
  
  kratos:
    environment:
      - DSN=postgres://ory:secret@postgres:5432/kratos?sslmode=disable&max_conns=50
```

**2. Add PostgreSQL Tuning**

Create `postgres/postgresql.conf`:
```conf
max_connections = 200
shared_buffers = 4GB
effective_cache_size = 12GB
maintenance_work_mem = 1GB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1
effective_io_concurrency = 200
work_mem = 10MB
```

**3. Enable Compression**

In `vote-api/src/index.js`:
```javascript
const compression = require('compression');
app.use(compression());
```

### Phase 2: Caching Layer (Week 2)

**1. Add Redis for Hydra Client Cache**

`docker-compose.yml`:
```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
```

**2. Add Redis for Kratos Sessions**

Update Kratos config to use Redis for sessions:
```yaml
session:
  cookie:
    persistent: true
  lifespan: 24h
```

**3. Cache JWKS in Vote API**

`vote-api/src/index.js`:
```javascript
let jwksCache = null;
let jwksCacheExpiry = 0;

async function getJWKS() {
  const now = Date.now();
  if (jwksCache && now < jwksCacheExpiry) {
    return jwksCache;
  }
  
  const response = await fetch(OIDC_JWKS_URL);
  jwksCache = await response.json();
  jwksCacheExpiry = now + (3600 * 1000);  // Cache for 1 hour
  return jwksCache;
}
```

### Phase 3: Kafka Integration (Week 3)

**1. Add Kafka to docker-compose.yml**

```yaml
services:
  zookeeper:
    image: confluentinc/cp-zookeeper:latest
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181

  kafka:
    image: confluentinc/cp-kafka:latest
    depends_on:
      - zookeeper
    ports:
      - "9092:9092"
    environment:
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
```

**2. Update Vote API to Use Kafka Producer**

`vote-api/src/index.js`:
```javascript
const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'vote-api',
  brokers: ['kafka:9092']
});

const producer = kafka.producer();

app.post('/vote', async (req, res) => {
  // ... JWT verification ...
  
  // Send to Kafka instead of in-memory array
  await producer.send({
    topic: 'votes-in',
    messages: [{
      key: `${electionId}:${sub}`,
      value: JSON.stringify({ electionId, candidateId, sub, votedAt: new Date().toISOString() })
    }]
  });
  
  res.json({ success: true });
});
```

**3. Create Aggregator Stream**

See separate guide for Kafka Streams or Flink implementation.

### Phase 4: Horizontal Scaling (Week 4)

**1. Add Load Balancer**

Use nginx or cloud load balancer to distribute across multiple Vote API instances.

**2. Database Read Replicas**

Add PostgreSQL read replicas for Kratos session lookups.

**3. Auto-Scaling**

Deploy to Kubernetes with Horizontal Pod Autoscaler (HPA).

---

## References

### Load Testing Tools

- **k6 Documentation:** https://k6.io/docs/
- **k6 Examples:** https://github.com/grafana/k6/tree/master/samples
- **k6 Cloud (Grafana):** https://k6.io/cloud/

### Ory Project Documentation

- **Hydra Performance Guide:** https://www.ory.sh/docs/hydra/guides/performance
- **Kratos Scalability:** https://www.ory.sh/docs/kratos/guides/scalability
- **Ory Performance Best Practices:** https://www.ory.sh/docs/ecosystem/performance

### Database Optimization

- **PostgreSQL Performance Tuning:** https://wiki.postgresql.org/wiki/Performance_Optimization
- **PostgreSQL Connection Pooling:** https://www.postgresql.org/docs/current/runtime-config-connection.html
- **pgBouncer (Connection Pooler):** https://www.pgbouncer.org/

### Caching & Messaging

- **Redis Documentation:** https://redis.io/documentation
- **Kafka Performance:** https://kafka.apache.org/documentation/#performance
- **Kafka Streams:** https://kafka.apache.org/documentation/streams/

### Monitoring & Observability

- **Prometheus + Grafana:** https://prometheus.io/docs/visualization/grafana/
- **OpenTelemetry:** https://opentelemetry.io/docs/
- **Loki (Log Aggregation):** https://grafana.com/docs/loki/latest/

### General Performance

- **Node.js Performance:** https://nodejs.org/en/docs/guides/simple-profiling/
- **Docker Performance:** https://docs.docker.com/config/containers/resource_constraints/
- **Load Testing Best Practices:** https://www.nginx.com/blog/load-testing-best-practices/
