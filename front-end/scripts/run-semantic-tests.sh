#!/usr/bin/env bash
set -euo pipefail

# Frontend Semantic Test Runner
#
# Semantic tests are browser-based e2e tests executed by a Claude sub-agent
# using Chrome CDP. Each test is a .semantic.md file containing structured
# instructions: pre-conditions, steps, invariants, and termination conditions.
#
# Unlike blackbox tests (jsdom + MSW), semantic tests hit REAL running services
# and verify behavior through an actual browser.
#
# Usage:
#   bash scripts/run-semantic-tests.sh                    # list available tests
#   bash scripts/run-semantic-tests.sh agent-realtime     # run specific test
#   bash scripts/run-semantic-tests.sh --list             # list available tests
#   bash scripts/run-semantic-tests.sh --print <name>     # print test instructions
#
# Requirements:
#   - Backend running on $BACKEND_PORT (default: 3001)
#   - Frontend running on $FRONTEND_PORT (default: 3002)
#   - Worker running (Temporal)
#   - Chrome with Claude extension connected (for CDP)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
SEMANTIC_DIR="$FRONTEND_DIR/src/tests/semantic"
cd "$FRONTEND_DIR"

BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3002}"

# --list mode
if [[ "${1:-}" == "--list" ]] || [[ -z "${1:-}" ]]; then
  echo "Available semantic tests:"
  for f in "$SEMANTIC_DIR"/*.semantic.md; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .semantic.md)
    # Extract first line of ## Summary section as description
    desc=$(sed -n '/^## Summary/{n;p;}' "$f" | head -1)
    echo "  $name — $desc"
  done
  exit 0
fi

# --print mode: output test instructions for Claude agent
if [[ "${1:-}" == "--print" ]]; then
  TEST_NAME="${2:-}"
  TEST_FILE="$SEMANTIC_DIR/${TEST_NAME}.semantic.md"
  if [[ ! -f "$TEST_FILE" ]]; then
    echo "Error: No semantic test found: $TEST_NAME"
    exit 1
  fi
  cat "$TEST_FILE"
  exit 0
fi

# Run mode: validate pre-conditions then output instructions
TEST_NAME="$1"
TEST_FILE="$SEMANTIC_DIR/${TEST_NAME}.semantic.md"

if [[ ! -f "$TEST_FILE" ]]; then
  echo "Error: No semantic test found: $TEST_NAME"
  echo "Available tests:"
  for f in "$SEMANTIC_DIR"/*.semantic.md; do
    [ -f "$f" ] || continue
    echo "  $(basename "$f" .semantic.md)"
  done
  exit 1
fi

# Generate run ID and artifact directory
RUN_ID="$(date +%Y%m%d_%H%M%S)_$$"
ARTIFACT_DIR=".context/test-runs/$RUN_ID"
mkdir -p "$ARTIFACT_DIR"

# Write manifest
cat > "$ARTIFACT_DIR/manifest.json" <<EOF
{
  "run_id": "$RUN_ID",
  "mode": "semantic-browser",
  "artifact_dir": "$ARTIFACT_DIR",
  "test_environment": "chrome-cdp",
  "framework": "react",
  "test_name": "$TEST_NAME",
  "backend_port": $BACKEND_PORT,
  "frontend_port": $FRONTEND_PORT,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "=== Semantic Test Run: $RUN_ID ==="
echo "Test: $TEST_NAME"
echo "Artifact dir: $ARTIFACT_DIR"
echo ""

# Pre-condition checks
echo "Checking pre-conditions..."

# Backend health
if ! curl -sf "http://localhost:$BACKEND_PORT/health" > /dev/null 2>&1; then
  echo "FAIL: Backend not healthy at http://localhost:$BACKEND_PORT/health"
  exit 1
fi
echo "  Backend: healthy"

# Frontend accessible
if ! curl -sf "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
  echo "FAIL: Frontend not accessible at http://localhost:$FRONTEND_PORT"
  exit 1
fi
echo "  Frontend: accessible"

echo ""
echo "Pre-conditions passed. Test instructions follow."
echo "═══════════════════════════════════════════════════"
echo ""
cat "$TEST_FILE"
echo ""
echo "═══════════════════════════════════════════════════"
echo "Execute these instructions using Chrome CDP browser tools."
echo "Artifact dir for results: $ARTIFACT_DIR"
