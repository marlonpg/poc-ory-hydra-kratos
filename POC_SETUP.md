# POC Setup & Quick Start

## Overview
This POC demonstrates the full flow:
1) **Kratos (4455 UI, 4433 public):** User registers/logs in.
2) **Login-Consent (3000):** Bridges Kratos session to Hydra login/consent challenges.
3) **Hydra (4444 public, 4445 admin):** Issues OAuth2/OIDC tokens.
4) **Vote API (4000):** Validates Hydra JWTs and enforces one vote per election.

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
curl http://localhost:3000/health                               # login-consent
curl http://localhost:4000/health                               # vote-api
open http://localhost:4455/registration                         # Kratos self-service UI (browser)
```

## Manual Test Flow

### 1. Register a user in Kratos UI (creates account)
Open browser → http://localhost:4455/registration
- Email: `voter@example.com`
- Password: any strong password

### 2. Create OAuth client in Hydra (what Hydra uses to issue tokens)
```bash
curl -X POST http://localhost:4445/admin/clients \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "voter-app",
    "client_secret": "my-client-secret",
    "redirect_uris": ["http://localhost:3000/post-login"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code", "id_token"],
    "scope": "openid profile email vote:cast"
  }'
```

### 3. Start OAuth flow (browser) via login-consent (bridges Hydra ↔ Kratos)
Open in browser:
```
http://localhost:4444/oauth2/auth?client_id=voter-app&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fpost-login&scope=openid+profile+email+vote%3Acast&state=state123
```
Flow:
- Hydra → login-consent `/login`
- If no Kratos session, login-consent redirects to Kratos UI (4455) to sign in
- On success, login-consent accepts Hydra login/consent and redirects to `http://localhost:3000/post-login?code=...`

### 4. Exchange code for tokens (Hydra token endpoint)
Use the code from `post-login?code=...` and HTTP Basic auth (`-u client:secret`):
```bash
curl -X POST http://localhost:4444/oauth2/token \
  -u voter-app:my-client-secret \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=PASTE_CODE_HERE&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fpost-login'
```
Returns: `access_token`, `id_token`, `refresh_token`.

### 5. Cast a vote using the token (calls vote-api 4000)

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

### 6. Verify one-vote-per-election
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

### 7. View aggregated results

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
- **hydra** (4444 public, 4445 admin): OAuth2/OIDC server (token issuer)
- **kratos** (4433 public, 4434 admin) + **kratos-ui** (4455): identity and self-service UI (account creation/login)
- **login-consent** (3000): small Node app that bridges Hydra login/consent to Kratos sessions, and provides the `/post-login` page with the auth link
- **vote-api** (4000): small Node API that verifies Hydra JWTs (JWKS from hydra) and enforces one vote per election

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
