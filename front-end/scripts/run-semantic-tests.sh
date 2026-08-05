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
if [[ "$PROD_MODE" -eq 1 ]]; then
  SEMANTIC_SESSION=$(node scripts/generate-prod-test-session.mjs)
else
  SEMANTIC_SESSION=$(cd "$REPO_DIR/back-end" && npx tsx scripts/generate-test-session.ts)
fi
if [[ -z "$SEMANTIC_SESSION" ]]; then
  echo "FAIL: Could not generate semantic session. Check Supabase test credentials." >&2
  exit 1
fi
export SEMANTIC_SESSION
TEST_USER_ID=$(printf '%s' "$SEMANTIC_SESSION" | node -e \
  'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).user.id));')
export TEST_USER_ID
echo "  Session generated for test user $TEST_USER_ID"

# Ensure the test account is off the waitlist. A freshly-provisioned account
# (e.g. the prod chat-lifecycle ratchet) has usedInviteCode=null, so the app
# renders WaitlistGate instead of the chat — the agent then produces 0 realtime
# bubbles and every lifecycle assertion fails. A real user isn't gated, so the
# auto-login must land the account in the same state: redeem the master invite
# code (181818) once. Idempotent — an already-redeemed account is a no-op.
SEMANTIC_ACCESS_TOKEN=$(printf '%s' "$SEMANTIC_SESSION" | node -e \
  'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).access_token || ""));')
# Prod mode sets BACKEND_URL; local mode only sets BACKEND_PORT. Default-expand
# so `set -u` doesn't trip when BACKEND_URL is unset (local).
INVITE_BACKEND_URL="${BACKEND_URL:-http://localhost:${BACKEND_PORT:-3001}}"
if [[ -n "$SEMANTIC_ACCESS_TOKEN" ]]; then
  INVITE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INVITE_BACKEND_URL/api/invite-codes/use" \
    -H "Authorization: Bearer $SEMANTIC_ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"inviteCode":181818}' || echo "000")
  echo "  Waitlist bypass (invite 181818) -> HTTP $INVITE_STATUS"
fi

SEMANTIC_WORKERS="${SEMANTIC_WORKERS:-1}"
if ! [[ "$SEMANTIC_WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "FAIL: SEMANTIC_WORKERS must be a positive integer, got $SEMANTIC_WORKERS" >&2
  exit 1
fi

# Resolve the test runner from this package explicitly. In the root npm
# workspace, `npx playwright` can select the backend's Playwright CLI while the
# specs import the frontend's @playwright/test singleton, making every suite
# fail during discovery with a misleading duplicate-version error.
# Prefer frontend-local .bin, then the CLI declared by the exact @playwright/test
# the specs resolve (via node), then a repo-root hoist as last resort. Resolving
# the package's own bin entry keeps the original guarantee: a shared .bin is
# flat and unnamespaced, so a same-named binary from another package can win
# there and silently run a different Playwright than the one the specs import.
PLAYWRIGHT_BIN=""
if [[ -x "$FRONTEND_DIR/node_modules/.bin/playwright" ]]; then
  PLAYWRIGHT_BIN="$FRONTEND_DIR/node_modules/.bin/playwright"
fi
PLAYWRIGHT_CLI=""
if [[ -z "$PLAYWRIGHT_BIN" ]]; then
  PLAYWRIGHT_CLI="$(cd "$FRONTEND_DIR" && node -e "
    const path = require('path');
    const pkgPath = require.resolve('@playwright/test/package.json');
    const bin = require(pkgPath).bin;
    const rel = typeof bin === 'string' ? bin : bin && bin.playwright;
    if (!rel) process.exit(1);
    console.log(path.join(path.dirname(pkgPath), rel));
  " 2>/dev/null || true)"
fi
if [[ -z "$PLAYWRIGHT_BIN" && ! -f "$PLAYWRIGHT_CLI" && -x "$REPO_DIR/node_modules/.bin/playwright" ]]; then
  PLAYWRIGHT_BIN="$REPO_DIR/node_modules/.bin/playwright"
fi
if [[ -z "$PLAYWRIGHT_BIN" && ! -f "$PLAYWRIGHT_CLI" ]]; then
  echo "FAIL: Frontend Playwright is not installed (checked front-end/, @playwright/test package, and repo-root .bin)" >&2
  exit 1
fi

# Prefer the frontend-local symlink; otherwise run the resolved package CLI
# under node so the exact @playwright/test the specs import is what executes.
run_playwright() {
  if [[ -x "$PLAYWRIGHT_BIN" ]]; then
    exec "$PLAYWRIGHT_BIN" "$@"
  fi
  exec node "$PLAYWRIGHT_CLI" "$@"
}

if [[ $# -eq 0 ]]; then
  PLAYWRIGHT_ARGS=(--reporter=list --workers="$SEMANTIC_WORKERS")
  if [[ -n "${SEMANTIC_GREP_INVERT:-}" ]]; then
    PLAYWRIGHT_ARGS+=(--grep-invert="$SEMANTIC_GREP_INVERT")
  fi
  run_playwright test "${PLAYWRIGHT_ARGS[@]}"
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

run_playwright test "$TEST_FILE" --reporter=list --workers="$SEMANTIC_WORKERS"
