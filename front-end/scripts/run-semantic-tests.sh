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
#   bash scripts/run-semantic-tests.sh                         # list available tests
#   bash scripts/run-semantic-tests.sh agent-realtime          # run specific test
#   bash scripts/run-semantic-tests.sh --list                  # list available tests
#   bash scripts/run-semantic-tests.sh --print <name>          # print test instructions
#   bash scripts/run-semantic-tests.sh --record <name> <pass|fail> [reason]
#       Writes .context/semantic-results/<name>.json tagged with HEAD SHA.
#       Used by scripts/run-smoke-and-semantic.sh to enforce the gate.
#
# Requirements:
#   - Backend running on $BACKEND_PORT (default: 3001)
#   - Frontend running on $FRONTEND_PORT (default: 3002)
#   - Worker running (Temporal)
#   - Chrome with Claude extension connected (for CDP)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"
SEMANTIC_DIR="$FRONTEND_DIR/src/tests/semantic"
RESULTS_DIR="$REPO_ROOT/.context/semantic-results"
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

# --record mode: write pass/fail result for one test (used by the combined
# smoke+semantic runner to gate the deploy on actual completion). The result
# is tagged with the current git HEAD SHA so the gate rejects results from
# an older commit.
if [[ "${1:-}" == "--record" ]]; then
  TEST_NAME="${2:-}"
  STATUS="${3:-}"
  REASON="${4:-}"
  if [[ -z "$TEST_NAME" || -z "$STATUS" ]]; then
    echo "Usage: run-semantic-tests.sh --record <name> <pass|fail> [reason]" >&2
    exit 2
  fi
  if [[ "$STATUS" != "pass" && "$STATUS" != "fail" ]]; then
    echo "Error: status must be 'pass' or 'fail' (got: $STATUS)" >&2
    exit 2
  fi
  TEST_FILE="$SEMANTIC_DIR/${TEST_NAME}.semantic.md"
  if [[ ! -f "$TEST_FILE" ]]; then
    echo "Error: No semantic test found: $TEST_NAME" >&2
    exit 2
  fi
  mkdir -p "$RESULTS_DIR"
  HEAD_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo unknown)"
  TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # JSON-escape reason via python for safety
  python3 - "$RESULTS_DIR/${TEST_NAME}.json" "$TEST_NAME" "$STATUS" "$REASON" "$HEAD_SHA" "$TIMESTAMP" <<'PY'
import json, sys
path, name, status, reason, head_sha, ts = sys.argv[1:7]
with open(path, "w") as f:
    json.dump({
        "name": name,
        "status": status,
        "reason": reason,
        "head_sha": head_sha,
        "recorded_at": ts,
    }, f, indent=2)
PY
  echo "Recorded: $TEST_NAME=$STATUS (HEAD=$HEAD_SHA)"
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
