# Realtime voting system requirements
- Never loose data
- Be secure and prevent bots and bad actors
- Handle 300M users
- Handle peak of 250k RPS
- Must ensure users vote only once

## Restrictions (do not use)
- Serveless
- MongoDB
- On-Premise, Google Cloud, Azure
- OpenShift
- Mainframes
- Monolith Solutions


# Realtime Voting System with Ory Hydra + Kratos (Architecture Plan)

This document proposes a concrete, scalable, and secure architecture that uses Ory Hydra (OAuth2/OIDC) and Ory Kratos (Identity) to meet the following requirements and restrictions.

## Requirements → Design
- Never lose data → Append-only event log (Kafka), durable Postgres writes (Aurora), multi-AZ, backups, and replayable pipelines.
- Be secure and prevent bots → OIDC with Hydra/Kratos, MFA/WebAuthn, WAF + bot management, rate limits, proof-of-work fallback, device fingerprinting, and anomaly detection.
- Handle 300M users → Horizontally scalable identity (Kratos), partitioned data, and high-cardinality storage tuned for read/write patterns.
- Handle peak of 250k RPS → Stateless API tier, Kafka (MSK) buffering, partitioned aggregation, Redis for hot counters, and backpressure control.
- Ensure users vote only once → Strong uniqueness guarantees via identity `sub`, idempotency keys, Kafka compaction, and DB unique constraints per election.

## Restrictions (observed)
Do NOT use: Serverless, MongoDB, On-Prem, Google Cloud, Azure, OpenShift, Mainframes, Monolith solutions. The reference design targets AWS with Kubernetes (EKS) and managed services that are not serverless compute.

---

## High-Level Architecture
- Identity & Auth
  - Ory Kratos: user lifecycle (registration, login, recovery, MFA, WebAuthn), identity schema (traits: email, name, eligibility flags).
  - Ory Hydra: OAuth2/OIDC authorization server issuing access/ID/refresh tokens to voting apps and APIs.
  - Login/Consent App: small web service that bridges Hydra flows to Kratos sessions; renders consent and maps Kratos identity → Hydra token claims.
- API & Gateway
  - API Gateway (Envoy/Nginx/Traefik) validating Hydra JWTs via JWKS and enforcing baseline rate limits.
  - Voting API (stateless, autoscaled) receives signed votes over HTTPS, verifies token/scopes, and writes to Kafka with idempotent producers.
- Streaming & State
  - Kafka (Amazon MSK): append-only ingestion (`votes-in`), dedupe stream (`votes-unique` compacted), aggregation stream (`votes-agg`).
  - Aggregators (Kafka Streams/Flink): exactly-once processing (EOSv2), maintain state stores, emit incremental aggregates.
  - Redis (ElastiCache) for hot counters and low-latency reads; periodic snapshots to Postgres.
  - Aurora PostgreSQL: system of record for results, uniqueness ledger, and audit trails.
- Edge & Anti-Abuse
  - CDN + WAF (CloudFront + AWS WAF) or Cloudflare in front of the web client and API.
  - Bot management + challenges (e.g., Cloudflare Turnstile), device attestation (WebAuthn), IP reputation, and velocity controls.
- Observability & Ops
  - Metrics (Prometheus/Grafana), logs (Loki/ELK), tracing (OpenTelemetry/Jaeger), audit logs for identity and vote lifecycles.
  - Backups (Aurora snapshots, Kafka retention/backups), DR with cross-region replication.

---

## Hydra ↔ Kratos Integration
- Flow
  1. Client app redirects to Hydra `/oauth2/auth`.
  2. Hydra initiates `login_challenge` → redirects to Login/Consent app.
  3. Login/Consent app uses Kratos session (`/sessions/whoami`) or drives Kratos login/registration/MFA.
  4. On success, it accepts `login_challenge` with `subject = kratos_identity_id` (stable unique ID).
  5. Hydra issues `consent_challenge` → consent UI; app decides scopes and injects claims from Kratos traits into `session.id_token`/`session.access_token`.
  6. Hydra completes the flow, returns code → tokens to client; APIs verify via Hydra JWKS.
- Tokens & Claims
  - `sub`: Kratos identity ID.
  - Claims: `email`, `eligible`, `locale`, optionally `roles` or `jurisdiction` if applicable.
  - Scopes: `openid profile email vote:cast` (custom) to authorize vote-casting endpoint.

---

## Vote Lifecycle and Data Integrity
- Step-by-step
  1. User logs in via Kratos; obtains tokens from Hydra.
  2. Client sends `POST /vote` with Authorization: Bearer <access_token>, payload `{ electionId, candidateId }` and Idempotency-Key header = `SHA-256(sub + electionId)`.
  3. Voting API verifies JWT (issuer = Hydra), required scopes (`vote:cast`), CSRF where relevant, and eligibility claim (`eligible=true`).
  4. Voting API publishes to Kafka `votes-in` with key = `electionId:sub`. Use idempotent producer and acks=all.
  5. Dedup Stream (Kafka Streams/Flink):
     - Uses a compacted `votes-unique` topic keyed by `electionId:sub` (value = accepted vote metadata).
     - If key absent, write to `votes-unique`; emit to `votes-accepted`.
     - If key present, drop (enforces single vote per identity per election).
  6. Aggregation Stream: consume `votes-accepted`, increment counters per `electionId:candidateId` in state store; update Redis hot counters and periodically persist to Postgres.
  7. Read APIs fetch counts from Redis (low latency); authoritative reconciliation comes from replaying `votes-accepted` → Aurora.
- Guarantees
  - Exactly-once processing: Kafka EOS v2, transactional producers/consumers, idempotency keys, and DB unique constraints.
  - DB layer: Aurora table with unique index `(election_id, voter_sub)` as backstop if needed (used by a writer path or reconciliation job).
  - Durability: Kafka replication (e.g., RF=3), Aurora multi-AZ, backups.

---

## Preventing Bots and Abuse (without serverless)
- At Edge
  - CDN + WAF with managed rulesets, geo/IP reputation, and L7 DDoS protections.
  - Bot challenge (e.g., Cloudflare Bot Management/Turnstile) on suspicious patterns and high-sensitivity paths.
- In App
  - WebAuthn passkeys (Kratos), optional TOTP MFA for enrollment.
  - Device fingerprinting (privacy mindful) and rate limiting by token `sub`, IP, and device.
  - Risk scoring in a dedicated microservice (containerized), not serverless; hooks to escalate to challenge or temporary block.
- In API
  - Sliding window rate limits (Envoy + Redis), per `sub` and IP.
  - Proof-of-work (configurable) for abusive clients as last resort.

---

## Capacity and Partitioning (250k RPS peak)
- Kafka (MSK)
  - Topic `votes-in`: partition count sized for throughput; start 256–512 partitions, adjust via load tests (consider 1–2 MB/s per partition target depending on instance types).
  - Acks=all, min.insync.replicas=2, replication.factor=3.
  - Producer idempotence + compression (lz4/zstd) to reduce bandwidth.
- Aggregation
  - Key by `electionId:candidateId` for counters; ensure skew management (many candidates per election or bucketization).
  - Use repartition topics where necessary; scale stream workers horizontally.
- API
  - NLB/ALB → gateway → API pods. Keep handlers CPU-cheap; rely on Kafka for buffering and backpressure.
- Storage
  - Redis cluster for hot counters; Aurora with tuned write IOPS. Periodic batch upserts from stream.

---

## Data Model (Aurora PostgreSQL)
```sql
-- Uniqueness ledger (optional backstop if using DB write path directly)
CREATE TABLE votes_ledger (
  election_id   TEXT    NOT NULL,
  voter_sub     TEXT    NOT NULL,
  candidate_id  TEXT    NOT NULL,
  voted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (election_id, voter_sub)
);

-- Aggregates persisted periodically
CREATE TABLE vote_totals (
  election_id   TEXT    NOT NULL,
  candidate_id  TEXT    NOT NULL,
  count         BIGINT  NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (election_id, candidate_id)
);
```

---

## Deployment (AWS, no serverless)
- Compute: Amazon EKS (multi-AZ). Each component in its own deployment: Hydra, Kratos, Login/Consent, Gateway, Voting API, Streams/Aggregators.
- Persistence: Amazon MSK (Kafka), Aurora PostgreSQL (Multi-AZ), ElastiCache Redis Cluster.
- Edge: CloudFront + AWS WAF (or Cloudflare) in front of client/web/API.
- Networking: Private subnets for data plane; public for edge ingress; SGs with least privilege.
- Secrets: AWS Secrets Manager or HashiCorp Vault for DB creds, Hydra secrets, etc.
- DR: Cross-region MSK/Aurora replication; runbook to fail over DNS and control plane.

---

## How Hydra/Kratos Fit Day-to-Day
- Kratos powers registration/login/MFA and stores identity traits.
- Hydra issues tokens so clients and APIs don’t need to talk directly to Kratos for auth.
- APIs validate Hydra JWTs via JWKS and authorize via scopes/claims. The `sub` links every vote to a single identity.

---

## Next Steps
1. POC (local): Docker Compose for Hydra, Kratos, Postgres, and a minimal Login/Consent app; stub Voting API validating Hydra JWTs.
2. Baseline load tests for API-only throughput with idempotent writes to Kafka replaced by an in-memory queue.
3. Add Kafka (MSK) and a small aggregator; then wire Redis and Aurora.
4. Expand anti-bot controls (WAF rules, Turnstile, WebAuthn enrollment) and end-to-end observability.

## POC Happy Path (local, Docker Compose)
- Create identity: Kratos UI at http://localhost:4455/registration.
- OAuth client: Hydra admin at http://localhost:4445/admin/clients (example client: id `voter-app`, secret `my-client-secret`, redirect `http://localhost:3000/post-login`, scopes `openid profile email vote:cast`).
- Start auth: browser to http://localhost:4444/oauth2/auth?client_id=voter-app&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fpost-login&scope=openid+profile+email+vote%3Acast&state=state123 (Hydra → login-consent → Kratos UI if no session → back to login-consent → consent → code at /post-login).
- Exchange code for tokens: POST http://localhost:4444/oauth2/token with Basic auth `voter-app:my-client-secret`, body `grant_type=authorization_code&code=...&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fpost-login`.
- Cast vote: POST http://localhost:4000/vote with Bearer access_token, JSON `{ "electionId": "election-2025-01", "candidateId": "alice" }`. Second vote with same token returns 409. Counts: GET http://localhost:4000/votes/election-2025-01.

If you want, I can scaffold the POC (Compose + minimal services) under this repo to get you moving quickly.
