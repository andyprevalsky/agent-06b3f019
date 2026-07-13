#!/usr/bin/env bash
set -euo pipefail

# Frontend Semantic Test Runner (Playwright)
#
# Runs browser-based e2e tests via Playwright/Chromium against the running
# local stack or production.
#
# Usage:
#   bash scripts/run-semantic-tests.sh              # run all (local)
#   bash scripts/run-semantic-tests.sh <name>       # run specific test (local)
#   bash scripts/run-semantic-tests.sh --prod       # run all against production
#   bash scripts/run-semantic-tests.sh --prod <name> # run specific test against production
#   bash scripts/run-semantic-tests.sh --list       # list available tests
#
# Requirements (local):
#   - Backend running on $BACKEND_PORT (default: 3001)
#   - Frontend running on $FRONTEND_PORT (default: 3002)
#   - Chromium downloaded: `npx playwright install chromium`
#
# Requirements (--prod):
#   - SUPABASE_JWT_SECRET, or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
#   - Chromium downloaded: `npx playwright install chromium`

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$FRONTEND_DIR")"
cd "$FRONTEND_DIR"

PROD_MODE=0

# Parse --prod flag (can appear anywhere in args)
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--prod" ]]; then
    PROD_MODE=1
  else
    ARGS+=("$arg")
  fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [[ "${1:-}" == "--list" ]]; then
  for f in tests-e2e/*.spec.ts; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .spec.ts)
    echo "  $name"
  done
  exit 0
fi

if [[ "$PROD_MODE" -eq 1 ]]; then
  # ── Production mode ──────────────────────────────────────────────────
  export BACKEND_URL="${BACKEND_URL:-https://navi-j9a9.onrender.com}"
  export FRONTEND_URL="${FRONTEND_URL:-https://roselabs.ai}"
  export SEMANTIC_PROD=1

  echo "=== Semantic tests: PRODUCTION mode ==="
  echo "  Backend:  $BACKEND_URL"
  echo "  Frontend: $FRONTEND_URL"

  # Health checks against prod
  if ! curl -sf "$BACKEND_URL/health" > /dev/null 2>&1; then
    echo "FAIL: Prod backend not healthy at $BACKEND_URL/health" >&2
    exit 1
  fi
  if ! curl -sf -o /dev/null -w '' "$FRONTEND_URL" 2>&1; then
    echo "FAIL: Prod frontend not accessible at $FRONTEND_URL" >&2
    exit 1
  fi

else
  # ── Local mode (default) ─────────────────────────────────────────────
  BACKEND_PORT="${BACKEND_PORT:-3001}"
  FRONTEND_PORT="${FRONTEND_PORT:-3002}"
  export BACKEND_PORT FRONTEND_PORT

  if ! curl -sf "http://localhost:$BACKEND_PORT/health" > /dev/null 2>&1; then
    echo "FAIL: Backend not healthy at http://localhost:$BACKEND_PORT/health" >&2
    exit 1
  fi
  if ! curl -sf "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
    echo "FAIL: Frontend not accessible at http://localhost:$FRONTEND_PORT" >&2
    exit 1
  fi
fi

# Generate exactly one authenticated session for the complete Playwright run.
# Every worker injects this session instead of racing the OTP endpoints.
echo "Generating shared semantic test session..."
SEMANTIC_SESSION=$(cd "$REPO_DIR/back-end" && npx tsx scripts/generate-test-session.ts)
if [[ -z "$SEMANTIC_SESSION" ]]; then
  echo "FAIL: Could not generate semantic session. Check Supabase test credentials." >&2
  exit 1
fi
export SEMANTIC_SESSION
TEST_USER_ID=$(printf '%s' "$SEMANTIC_SESSION" | node -e \
  'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).user.id));')
export TEST_USER_ID
echo "  Session generated for test user $TEST_USER_ID"

SEMANTIC_WORKERS="${SEMANTIC_WORKERS:-1}"
if ! [[ "$SEMANTIC_WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: SEMANTIC_WORKERS must be a positive integer, got $SEMANTIC_WORKERS" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  exec npx playwright test --reporter=list --workers="$SEMANTIC_WORKERS"
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

exec npx playwright test "$TEST_FILE" --reporter=list --workers="$SEMANTIC_WORKERS"
