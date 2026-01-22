# Manual Test Guide - Java Services (Vert.x)

This guide walks you through testing the Java-based services:
- **login-consent-java** (port 3001)
- **vote-api-java** (port 4001)

---

## Step 1: Health Checks

Test that both Java services are responding:

```bash
# Test Login-Consent Java
curl http://localhost:3001/health

# Test Vote API Java
curl http://localhost:4001/health

# Expected Response: {"ok":true}

---

## Step 2: Create OAuth Client in Hydra
#### Example real world scenario: This is exactly like when you register an app in Google Developer Console to use "Sign in with Google":
Register a test client that will use the Java login-consent service:

```bash
docker exec -it poc-ory-hydra-kratos-hydra-1 hydra create client \
  --endpoint http://127.0.0.1:4445 \
  --id voter-app-java \
  --secret voter-secret-java \
  --grant-type authorization_code,refresh_token \
  --response-type code \
  --scope openid,profile,email,vote:cast \
  --redirect-uri http://localhost:3001/callback \
  --redirect-uri http://localhost:3001/post-login
```

If you see "resource exists already", update or delete the client:

```bash
# Inspect existing client
docker exec -it poc-ory-hydra-kratos-hydra-1 hydra get client voter-app-java \
  --endpoint http://127.0.0.1:4445

# Option A: Delete and recreate
docker exec -it poc-ory-hydra-kratos-hydra-1 hydra delete client voter-app-java \
  --endpoint http://127.0.0.1:4445

# Then run the create command again (above)

# Option B: Update redirect URIs to 3001
curl -X PUT http://localhost:4445/admin/clients/voter-app-java \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "voter-app-java",
    "client_secret": "voter-secret-java",
    "grant_types": ["authorization_code","refresh_token"],
    "response_types": ["code"],
    "scope": "openid profile email vote:cast",
    "redirect_uris": [
      "http://localhost:3001/callback",
      "http://localhost:3001/post-login"
    ]
  }'
```

---

## Step 3: Register a Test User in Kratos
#### Example real world scenario: Like creating a Google account before using "Sign in with Google"

### Option A: Using Kratos UI (Recommended)

1. Open your browser and navigate to:
   ```
   http://localhost:4455/registration
   ```

2. Fill in the registration form:
   - Email: `testjava@example.com`
   - Password: `SecurePass123!999`

3. Click "Sign up"

4. You'll be redirected after successful registration

### Option B: Using Kratos API (Flow-Based)

Kratos uses a flow-based approach for security. You need to initialize a flow first:

```bash
# Step 3a: Initialize registration flow
FLOW_RESPONSE=$(curl -s http://localhost:4433/self-service/registration/api)
FLOW_ID=$(echo $FLOW_RESPONSE | jq -r '.id')

echo "Flow ID: $FLOW_ID"

# Step 3b: Submit registration with flow ID
curl -X POST "http://localhost:4433/self-service/registration?flow=$FLOW_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "password",
    "password": "SecurePass123!999",
    "traits": {
      "email": "testjava2@example.com"
    }
  }' | jq .

echo "Registration successful!"
```

**Note:** Save the session token from the response if you want to use it later.

---

## Step 4: Start OAuth Flow (Browser-Based)

### Option A: Manual Browser Flow

1. Open your browser and navigate to:
   ```
   http://localhost:4444/oauth2/auth?client_id=voter-app-java&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fpost-login&scope=openid+profile+email+vote%3Acast&state=state123
   ```

2. You'll be redirected to the **Java Login-Consent service** (port 3001)

3. It will redirect you to **Kratos UI** (port 4455) for login

4. Enter credentials:
   - Email: `testjava@example.com`
   - Password: `SecurePass123!`

5. After login, Kratos redirects back to **login-consent-java** → **Hydra**

6. Hydra returns an authorization code

7. Copy the `code` from the URL (e.g., `http://localhost:3001/post-login?code=XXXXXX&state=state123`)

### Option B: Automated Flow (Bash)

```bash
# Start OAuth flow
AUTH_URL="http://localhost:4444/oauth2/auth?client_id=voter-app-java&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fpost-login&scope=openid+profile+email+vote%3Acast&state=state123"
echo "Open this URL in your browser:"
echo $AUTH_URL
# On macOS, uncomment: open $AUTH_URL
# On Linux, uncomment: xdg-open $AUTH_URL
```

---

## Step 5: Exchange Code for Token

After getting the authorization code, exchange it for a JWT token:

```bash
# Replace YOUR_AUTH_CODE with the actual code from Step 4
CODE="ory_ac_L0XwUFA_AqPdtrxhJcvF9n_CwAYSCwmDUKRvdfeP64g.1b5um-aOBqChhvY1afTuTGqERWIWK3Trcqnp0RHqdfk"

# Simple version
curl -X POST http://localhost:4444/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "voter-app-java:voter-secret-java" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http://localhost:3001/post-login"

# Extract access token
ACCESS_TOKEN=$(curl -s -X POST http://localhost:4444/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "voter-app-java:voter-secret-java" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http://localhost:3001/post-login" | jq -r '.access_token')

echo "Access Token: $ACCESS_TOKEN"
```

---

## Step 6: Test Vote API Java - Submit Vote

Now use the JWT token to submit a vote to the **Java Vote API**:

```bash
# Submit first vote
curl -X POST http://localhost:4001/vote \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "electionId": "election-2026",
    "candidateId": "candidate-A"
  }' | jq .
```

**Expected Response:**
```json
{
  "success": true,
  "vote": {
    "id": "some-uuid",
    "electionId": "election-2026",
    "candidateId": "candidate-A",
    "sub": "user-identity-id",
    "votedAt": "2026-01-22T05:00:00.000Z"
  }
}
```

---

## Step 7: Test Deduplication (409 Conflict)

Try to vote again with the same token:

```bash
# Attempt duplicate vote - should return 409 Conflict
curl -X POST http://localhost:4001/vote \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "electionId": "election-2026",
    "candidateId": "candidate-B"
  }' \
  -w "\nHTTP Status: %{http_code}\n"
```

**Expected Response:**
```json
HTTP 409 Conflict
{
  "error": "already voted in this election"
}
```

---

## Step 8: Check Vote Results

Retrieve vote counts for the election:

```bash
# Get all votes
curl http://localhost:4001/votes | jq .

# Get votes for specific election
curl http://localhost:4001/votes/election-2026 | jq .
```

**Expected Response:**
```json
{
  "electionId": "election-2026",
  "total": 1,
  "counts": {
    "candidate-A": 1
  }
}
```

---

## Step 9: Test JWT Verification (JWKS Cache)

Verify that the Java service is using cached JWKS (not calling Hydra per-request):

```bash
# Check Java Vote API logs
docker logs poc-ory-hydra-kratos-vote-api-java-1 --tail=50

# Look for this log (should appear only ONCE on startup):
# "Fetching JWKS from http://hydra:4444/.well-known/jwks.json"
# "JWKS cached successfully"

# Submit 10 votes to different elections (to bypass deduplication)
for i in {1..10}; do
  ELECTION_ID="election-test-$i"
  curl -X POST http://localhost:4001/vote \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"electionId\": \"$ELECTION_ID\",
      \"candidateId\": \"candidate-X\"
    }" > /dev/null 2>&1
  echo "Vote $i submitted to $ELECTION_ID"
done

# Check logs again - JWKS should NOT be fetched again
docker logs poc-ory-hydra-kratos-vote-api-java-1 --tail=50 | grep "Fetching JWKS"
```

**Expected:** Only 1 JWKS fetch log (on startup), not 10 fetches.

---

## Step 10: Performance Comparison (Optional)

Compare Java vs Node.js performance:

```bash
# Benchmark Java Vote API (100 health check requests)
echo "Benchmarking Java Vote API..."
time for i in {1..100}; do
  curl -s http://localhost:4001/health > /dev/null
done

# For reference, Node.js version was on port 4000
# echo "Benchmarking Node.js Vote API..."
# time for i in {1..100}; do
#   curl -s http://localhost:4000/health > /dev/null
# done
```

---

## Troubleshooting

### Service Not Responding

```bash
# Check service status
docker-compose ps

# Check logs
docker logs poc-ory-hydra-kratos-login-consent-java-1
docker logs poc-ory-hydra-kratos-vote-api-java-1

# Restart services
docker-compose restart login-consent-java vote-api-java
```

### JWKS Fetch Error

```bash
# Verify Hydra is accessible from Java container
docker exec -it poc-ory-hydra-kratos-vote-api-java-1 wget -O- http://hydra:4444/.well-known/jwks.json
```

### JWT Verification Failed

```bash
# Check token is valid
curl -X POST http://localhost:4445/admin/oauth2/introspect \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=$ACCESS_TOKEN"
```

---

## Complete Test Script (Run All Steps)

```bash
#!/bin/bash
# Save this as test-java-services.sh
# Run with: bash test-java-services.sh

echo "=== Step 1: Health Checks ==="
curl http://localhost:3001/health && echo
curl http://localhost:4001/health && echo

echo -e "\n=== Step 2: Create OAuth Client ==="
docker exec -it poc-ory-hydra-kratos-hydra-1 hydra create client \
  --endpoint http://127.0.0.1:4445 \
  --id voter-app-java \
  --secret voter-secret-java \
  --grant-type authorization_code,refresh_token \
  --response-type code \
  --scope openid,profile,email,vote:cast \
  --redirect-uri http://localhost:3001/callback \
  --redirect-uri http://localhost:3001/post-login

echo -e "\n=== Step 4: Start OAuth Flow ==="
AUTH_URL="http://localhost:4444/oauth2/auth?client_id=voter-app-java&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fpost-login&scope=openid+profile+email+vote%3Acast&state=state123"
echo "Open this URL in your browser and complete the login:"
echo $AUTH_URL

echo -e "\nAfter login, enter the authorization code from the URL:"
read -p "Authorization Code: " CODE

echo -e "\n=== Step 5: Exchange Code for Token ==="
ACCESS_TOKEN=$(curl -s -X POST http://localhost:4444/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "voter-app-java:voter-secret-java" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http://localhost:3001/post-login" | jq -r '.access_token')
echo "Access Token: $ACCESS_TOKEN"

echo -e "\n=== Step 6: Submit Vote ==="
curl -X POST http://localhost:4001/vote \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "electionId": "election-2026",
    "candidateId": "candidate-A"
  }' | jq .

echo -e "\n=== Step 7: Test Deduplication ==="
echo "Attempting duplicate vote (expect 409 Conflict):"
curl -X POST http://localhost:4001/vote \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "electionId": "election-2026",
    "candidateId": "candidate-B"
  }' \
  -w "\nHTTP Status: %{http_code}\n" | jq .

echo -e "\n=== Step 8: Check Results ==="
curl http://localhost:4001/votes/election-2026 | jq .

echo -e "\n=== Test Complete ==="
```

---

## Summary

You've successfully tested:

1. ✅ Java Login-Consent service (port 3001) handling OAuth flow
2. ✅ Java Vote API (port 4001) with JWT verification
3. ✅ JWKS caching (1 fetch on startup, not per-request)
4. ✅ Vote deduplication (409 Conflict response)
5. ✅ Vote recording and retrieval

**Key Performance Insight:** The Java Vote API uses cached JWKS, so it never calls Hydra during voting - just like the Node.js version, but with better concurrency handling thanks to Vert.x!
