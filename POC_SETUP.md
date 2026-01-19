# POC Setup & Quick Start

## Overview
This POC demonstrates the full flow:
1. User registers/logs in via Kratos self-service UI.
2. Kratos session → login-consent service.
3. login-consent bridges to Hydra, accepts login/consent challenges.
4. Hydra issues tokens.
5. Client calls vote-api with Hydra token.
6. vote-api verifies token via JWKS and enforces one-vote-per-election.

## Prerequisites
- Docker & Docker Compose
- curl or Postman for testing

## Startup

```bash
# From repo root
docker-compose up --build

# Wait ~30s for migrations and service startup
```

Check all services are healthy:

```bash
curl http://localhost:4444/.well-known/openid-configuration      # Hydra OIDC config
curl http://localhost:4433/health                               # Kratos public
curl http://localhost:3000/health                               # login-consent
curl http://localhost:4000/health                               # vote-api
```

## Manual Test Flow

### 1. Register a user in Kratos UI
Open browser → http://localhost:4455/registration
- Email: `voter@example.com`
- Name: `Test Voter`
- Password: `SecurePassword123`

### 2. Start OAuth flow to get a token
Register a client in Hydra, then start an auth request. For simplicity, here's a shortcut:

**Hydra Admin API** to create a client:

```bash
curl -X POST http://localhost:4445/admin/clients \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "voter-app",
    "client_secret": "my-client-secret",
    "redirect_uris": ["http://localhost:3001/callback"],
    "grant_types": ["authorization_code"],
    "response_types": ["code"],
    "scopes": ["openid", "profile", "email", "vote:cast"]
  }'
```

### 3. Get auth code → token
Simulate an OAuth client redirecting to Hydra:

```bash
# Step 1: Redirect to Hydra's auth endpoint
# In browser: http://localhost:4444/oauth2/auth?client_id=voter-app&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fcallback&scope=openid+profile+email+vote%3Acast&state=state123

# This will:
# - Redirect to login-consent /login?login_challenge=...
# - If no Kratos session, redirect to Kratos UI to log in
# - After Kratos login, return to login-consent, which accepts Hydra's login_challenge
# - Redirect to Hydra consent (login-consent /consent?consent_challenge=...)
# - After consent accept, redirect to http://localhost:3001/callback?code=...&state=state123

# Step 2: Exchange code for token (using Hydra token endpoint)
# Substitute CODE from the redirect URL above
curl -X POST http://localhost:4444/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&client_id=voter-app&client_secret=my-client-secret&code=CODE&redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fcallback"
```

This returns: `access_token`, `id_token`, `refresh_token`. Extract the `access_token`.

### 4. Cast a vote using the token

```bash
ACCESS_TOKEN="<paste token from above>"

curl -X POST http://localhost:4000/vote \
  -H 'Authorization: Bearer '"$ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "electionId": "election-2025-01",
    "candidateId": "alice"
  }'
```

Expected response (first vote succeeds):
```json
{
  "success": true,
  "vote": {
    "id": "random-id",
    "electionId": "election-2025-01",
    "candidateId": "alice",
    "sub": "kratos-identity-id",
    "votedAt": "2025-01-18T..."
  }
}
```

### 5. Verify one-vote-per-election
Try the same vote again:
```bash
curl -X POST http://localhost:4000/vote \
  -H 'Authorization: Bearer '"$ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "electionId": "election-2025-01",
    "candidateId": "bob"
  }'
```

Expected: `409 Conflict` with `{ "error": "already voted in this election" }`

### 6. View aggregated results

```bash
curl http://localhost:4000/votes/election-2025-01
```

Example response:
```json
{
  "electionId": "election-2025-01",
  "total": 1,
  "counts": {
    "alice": 1
  }
}
```

## Architecture Components (Compose)

- **postgres** (5432): databases for Hydra and Kratos
- **hydra** (4444 public, 4445 admin): OAuth2/OIDC server
- **kratos** (4433 public, 4434 admin): Identity and auth
- **kratos-ui** (4455): Kratos self-service UI (registration, login, settings)
- **login-consent** (3000): bridge between Hydra and Kratos, handles login/consent challenges
- **vote-api** (4000): API verifying Hydra JWTs and recording votes

## Next Steps (Towards Production)

1. **Database Uniqueness**: Add `votes_ledger` table with unique index `(election_id, voter_sub)` and use it as a transactional write target instead of in-memory array.
2. **Kafka Ingestion**: Replace in-memory votes with Kafka producer; add aggregator stream.
3. **Redis Cache**: Add Redis for hot counters, with periodic flush to DB.
4. **Bot Prevention**: Integrate WAF/Turnstile, rate limiting, device fingerprinting.
5. **Observability**: Add Prometheus metrics, centralized logging, and audit trails.
6. **Auth Scopes**: Define more granular scopes (e.g., `vote:read`, `vote:admin`) and enforce them.
7. **Identity Traits**: Extend Kratos identity schema to include eligibility flags, jurisdiction, and MFA status.

## Troubleshooting

- **"Connection refused" to hydra/kratos**: Services may still be starting. Wait 30s and retry.
- **JWKS fetch error**: Ensure Hydra is running. Check logs: `docker-compose logs hydra`.
- **Token verification fails**: Ensure token is from the correct issuer (http://localhost:4444/).
- **Consent redirect loops**: Check login-consent logs; verify Hydra/Kratos URLs in env.

## Cleanup

```bash
docker-compose down -v
```
