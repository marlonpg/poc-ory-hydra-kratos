# Architecture Brainstorm - Authentication & Voting Flow

## Complete User Journey

```
USER/BROWSER              LOGIN-CONSENT          KRATOS              HYDRA           VOTE-API        POSTGRESQL
     |                         |                    |                  |                 |                |
     |---> Visit app --------->|                    |                  |                 |                |
     |                         |                    |                  |                 |                |
     |<-- "Login needed" ------|                    |                  |                 |                |
     |                         |                    |                  |                 |                |
     |---> Click Login ------->|---> /login challenge ---------->|      |                 |                |
     |                         |<-- No session? ------|              |                 |                |
     |                         |                    |                  |                 |                |
     |<-- Redirect to Kratos login page <-------------|                |                 |                |
     |     (Identity Provider)                       |                  |                 |                |
     |                         |                    |                  |                 |                |
     |---> Enter email/pwd ---->|                    |                 |                 |                |
     |     (at Kratos)         |                    |                  |                 |                |
     |                         |---> Create session ----->|            |                 |                |
     |                         |<--- Session OK <--------|              |                 |                |
     |                         |                    |                  |                 |                |
     |<-- Redirect back (with login_challenge) <----|                |                 |                |
     |     (back to Login-Consent)                  |                  |                 |                |
     |                         |                    |                  |                 |                |
     |                         |---> Accept login challenge ----------->|                |                 |
     |                         |     (to Hydra)    |                  |                 |                |
     |                         |<--- Auth code <------------------------|                |                 |
     |                         |     (from Hydra) |                  |                 |                |
     |                         |                    |                  |                 |                |
     |<-- Redirect with code <-|                    |                  |                 |                |
     |     (from Login-Consent)                     |                  |                 |                |
     |                         |                    |                  |                 |                |
     |---> Exchange code for JWT (backend) ------>|                    |                 |                |
     |     (Vote API calls Hydra)                 |                  |                 |                |
     |                         |                   |<--- JWT Token <----|                 |                |
     |                         |                   |   (from Hydra)  |                 |                |
     |                         |                    |                  |                 |                |
     |---> POST /vote (with JWT) ----->|                    |                 |                |
     |     (to Vote API)              |                    |                 |                |
     |                         |                    |                  |                 |                |
     |                         |                    |                  |  |---> Verify JWT signature |
     |                         |                    |                  |  |    (using CACHED JWKS    |
     |                         |                    |                  |  |     from Hydra)          |
     |                         |                    |                  |  |    NO HYDRA CALL!        |
     |                         |                    |                  |  |                          |
     |                         |                    |                  |  |---> Record vote ------->|
     |                         |                    |                  |  |      (to PostgreSQL)  |
     |<--- Vote recorded <-|                    |                  |  |<------ Vote stored <----|
     |     (from Vote API)              |                    |                  |                |
     |                         |                    |                  |                 |                |
     |---> Another vote (same JWT) ---->|                    |                  |                 |                |
     |     (to Vote API)              |                    |                  |                 |                |
     |                         |                    |                  |                 |                |
     |                         |                    |                  |  |---> Verify JWT (CACHED) |
     |                         |                    |                  |  |    (no Hydra call)     |
     |                         |                    |                  |  |                        |
     |                         |                    |                  |  |---> Check: Already voted? |
     |                         |                    |                  |  |                        |
     |<--- 409 Conflict <-|                    |                  |  |    (from Vote API)      |
     |     Error: Already voted                   |                  |                 |                |
```

## Key Insights

### Phase 1: Authentication (ONE TIME per user)

1. **Login-Consent** redirects user to **Kratos** for login
2. **Kratos** (Identity Provider) creates session after password verification
3. **Kratos** redirects back to **Login-Consent** with login_challenge
4. **Login-Consent** forwards challenge to **Hydra** (OAuth Server)
5. **Hydra** issues auth code
6. **Vote API** (backend) exchanges code for JWT with **Hydra**
7. User receives JWT token

**Services Involved:** Kratos, Hydra, Login-Consent, Vote API
**Database Calls:** PostgreSQL (store session, user identity)
**Load:** LOW (happens once per user per session)

### Phase 2: Voting (MANY TIMES per user)

1. User submits vote with JWT token to **Vote API**
2. **Vote API** verifies JWT signature using **CACHED JWKS** from Hydra
3. **Vote API** records vote in **PostgreSQL**
4. On duplicate vote: **Vote API** returns 409 Conflict

**Services Involved:** Vote API, PostgreSQL
**Hydra Calls:** ZERO (using cached JWKS, not calling Hydra)
**Load:** HIGH (scales with voting activity)

## Why This Matters for Load Testing

| Phase | Service | Frequency | Load Profile | Bottleneck |
|-------|---------|-----------|--------------|------------|
| **Auth** | Kratos | 1x per session | ~1,000 RPS | DB query speed, connection pool |
| **Auth** | Hydra | 1x per session | ~1,000 RPS | Token signing (CPU-intensive) |
| **Voting** | Vote API | 100x per user | ~10,000 RPS | In-memory vote storage, Vote API throughput |
| **Voting** | PostgreSQL | 100x per user | ~10,000 RPS | Write performance, unique constraints |

## Architecture Decisions

### Why Separate Services?

- **Kratos** = Identity management (who you are) - reusable across apps
- **Hydra** = Authorization server (permission to access) - standard OAuth2
- **Login-Consent** = Custom bridge (app-specific login flow)
- **Vote API** = Business logic (vote recording) - only cares about JWT validity
- **PostgreSQL** = Persistent storage (durability)

### Why Cache JWKS?

- **Hydra issues tokens:** 1-2 times per user per session
- **Vote API verifies tokens:** 100+ times per user per voting session
- **JWKS endpoint:** Called by Vote API on startup, cached for 1 hour
- **Result:** No per-vote Hydra calls, massive scaling benefit

### Why 409 Conflict for Duplicate Votes?

- User tries to vote twice with same JWT
- **Vote API** has deduplication logic
- Returns 409 Conflict instead of silently accepting duplicate
- Prevents vote fraud while allowing client-side retry logic

## Real-World Analogy: Google Login

```
USER ACTION                    WHAT HAPPENS INTERNALLY
================              ==========================

1. "Sign in with Google"  →   Browser redirects to Login-Consent app
2. Redirected to Google   →   Google = Kratos (Identity Provider)
3. Enter email/password    →   Google verifies identity, creates session
4. Google redirects back   →   With login_challenge parameter
5. "Approve access"        →   Login-Consent → Hydra exchange
6. Auth code returned      →   Hydra creates authorization
7. Backend exchange        →   Vote API exchanges code for JWT
8. Receive JWT token       →   User authenticated
9. Submit vote with JWT    →   Vote API verifies JWT (cached Google's keys)
10. Vote recorded          →   No Google calls during voting!
11. Try to vote again       →   Vote API detects duplicate, returns 409
```

The key insight: **Google's keys are cached, not fetched per request.**

## Performance Implications

### Without Caching (❌ Bad)
- User votes 100 times
- Vote API calls Hydra 100 times to verify JWT
- Hydra becomes bottleneck
- Cannot scale beyond Hydra throughput (~5,000 RPS)

### With Caching (✅ Good)
- User votes 100 times
- Vote API calls Hydra 0 times (uses cache)
- Vote API becomes bottleneck (not Hydra)
- Can scale to 10,000+ RPS at Vote API level

### Scaling Levels

**Level 1: Single Instance**
- All services in one docker-compose
- ~1,000 RPS max (due to Vote API single-process Node.js)

**Level 2: Vote API Horizontal Scaling**
- Multiple Vote API instances behind load balancer
- JWKS caching critical (reduces Hydra load)
- ~5,000 RPS

**Level 3: Kafka + Aggregation**
- Vote API producers write to Kafka
- Aggregator stream processes votes
- PostgreSQL only stores results (no per-vote writes)
- ~20,000+ RPS

## Load Testing Strategy

### Test 1: Hydra JWKS (Baseline)
- Measures JWKS endpoint throughput
- Vote API calls this on startup (not per-vote)
- Should show <10ms latency at 10,000 RPS

### Test 2: Kratos Sessions
- Measures authentication-phase load
- Only called during login (not voting)
- Should show <2s latency at 1,000 RPS

### Test 3: Vote API
- Measures voting-phase load
- Uses cached JWKS (no Hydra calls)
- Should show <500ms latency at 10,000 RPS
- Deduplication enforcement (409 responses)
