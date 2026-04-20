#!/usr/bin/env bash
set -euo pipefail

# Frontend Semantic Test Runner (Playwright)
#
# Runs browser-based e2e tests via Playwright/Chromium against the running
# local stack. These tests are the only gate proving realtime broadcasts
# reach the UI and that the login path works end-to-end.
#
# Usage:
#   bash scripts/run-semantic-tests.sh              # run all semantic tests
#   bash scripts/run-semantic-tests.sh <name>       # run specific test (e.g. login, agent-realtime)
#   bash scripts/run-semantic-tests.sh --list       # list available tests
#
# Requirements:
#   - Backend running on $BACKEND_PORT (default: 3001)
#   - Frontend running on $FRONTEND_PORT (default: 3002)
#   - Chromium downloaded: `npx playwright install chromium`

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
cd "$FRONTEND_DIR"

BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3002}"
export BACKEND_PORT FRONTEND_PORT

if [[ "${1:-}" == "--list" ]]; then
  for f in tests-e2e/*.spec.ts; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .spec.ts)
    echo "  $name"
  done
  exit 0
fi

# Pre-condition: backend + frontend reachable.
if ! curl -sf "http://localhost:$BACKEND_PORT/health" > /dev/null 2>&1; then
  echo "FAIL: Backend not healthy at http://localhost:$BACKEND_PORT/health" >&2
  exit 1
fi
if ! curl -sf "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
  echo "FAIL: Frontend not accessible at http://localhost:$FRONTEND_PORT" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  exec npx playwright test --reporter=list
fi

TEST_NAME="$1"
TEST_FILE="tests-e2e/${TEST_NAME}.spec.ts"
if [[ ! -f "$TEST_FILE" ]]; then
  echo "Error: No semantic test found: $TEST_NAME" >&2
  echo "Available:" >&2
  for f in tests-e2e/*.spec.ts; do
    [ -f "$f" ] || continue
    echo "  $(basename "$f" .spec.ts)" >&2
  done
  exit 1
fi

exec npx playwright test "$TEST_FILE" --reporter=list
