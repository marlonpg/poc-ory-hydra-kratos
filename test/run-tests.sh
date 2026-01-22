#!/bin/bash

# Load Test Runner Script
# Runs all k6 tests against Hydra, Kratos, and Vote API
# Usage: ./test/run-tests.sh [low|medium|high]

set -e

LOAD_PROFILE="${1:-low}"

if [[ ! "$LOAD_PROFILE" =~ ^(low|medium|high)$ ]]; then
  echo "Usage: ./test/run-tests.sh [low|medium|high]"
  echo ""
  echo "Profiles:"
  echo "  low    - 10-100 VUs (gentle testing)"
  echo "  medium - 100-1000 VUs (normal load)"
  echo "  high   - 1000+ VUs (stress test, aims for ~10k req/s)"
  exit 1
fi

echo "========================================"
echo "POC Load Testing Suite"
echo "========================================"
echo "Profile: $LOAD_PROFILE"
echo "Time: $(date)"
echo ""

# Check if k6 is installed
if ! command -v k6 &> /dev/null; then
  echo "❌ k6 not found. Install from: https://k6.io/docs/getting-started/installation/"
  exit 1
fi

echo "k6 version: $(k6 version)"
echo ""

# Verify services are running
echo "🔍 Checking if services are running..."
services=("hydra:4444" "kratos:4433" "vote-api:4000")
for service in "${services[@]}"; do
  IFS=':' read -r name port <<< "$service"
  if curl -s "http://localhost:$port/health" > /dev/null 2>&1 || \
     curl -s "http://localhost:$port/.well-known/openid-configuration" > /dev/null 2>&1; then
    echo "✅ $name:$port is running"
  else
    echo "⚠️  $name:$port may not be responding (will retry during test)"
  fi
done
echo ""

# Run tests
echo "📊 Starting load tests..."
echo ""

# Test 1: Hydra Token Endpoint
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1️⃣  Testing Hydra Token Endpoint"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
k6 run -e LOAD="$LOAD_PROFILE" test/load-test-hydra.js || echo "⚠️  Hydra test had issues"
echo ""

# Test 2: Kratos Identity & Sessions
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2️⃣  Testing Kratos Sessions"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
k6 run -e LOAD="$LOAD_PROFILE" test/load-test-kratos.js || echo "⚠️  Kratos test had issues"
echo ""

# Test 3: Vote API
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3️⃣  Testing Vote API"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
k6 run -e LOAD="$LOAD_PROFILE" test/load-test-vote-api.js || echo "⚠️  Vote API test had issues"
echo ""

echo "========================================"
echo "✅ All tests completed!"
echo "========================================"
echo ""
echo "📈 Tips:"
echo "  - Run with LOAD=high for stress testing (10k req/s target)"
echo "  - Monitor service logs: docker-compose logs -f <service>"
echo "  - Check CPU/memory: docker stats"
echo ""
