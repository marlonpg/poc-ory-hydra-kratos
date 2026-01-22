#!/bin/bash

# Generates a report comparing load test results
# Usage: ./test/compare-results.sh <baseline.json> <new.json>

set -e

if [ $# -lt 2 ]; then
  echo "Usage: $0 <baseline.json> <new.json>"
  echo ""
  echo "Example:"
  echo "  $0 baseline.json after-optimization.json"
  exit 1
fi

BASELINE="$1"
NEW="$2"

if [ ! -f "$BASELINE" ]; then
  echo "❌ Baseline file not found: $BASELINE"
  exit 1
fi

if [ ! -f "$NEW" ]; then
  echo "❌ New file not found: $NEW"
  exit 1
fi

echo "📊 Load Test Comparison Report"
echo "========================================"
echo "Baseline: $BASELINE"
echo "New:      $NEW"
echo ""

# Helper to extract metric from JSON
get_metric() {
  local file="$1"
  local metric="$2"
  grep -o "\"$metric\"[^,}]*" "$file" | head -1 | cut -d: -f2 | xargs
}

# Extract metrics
echo "Metric                    | Baseline   | New        | Change"
echo "─────────────────────────┼────────────┼────────────┼────────────"

# This is a simplified example - real comparison would parse JSON properly
echo ""
echo "💡 For detailed comparison, use:"
echo "   jq '.metrics' $BASELINE"
echo "   jq '.metrics' $NEW"
echo ""
