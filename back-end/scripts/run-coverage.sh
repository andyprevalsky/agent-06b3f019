#!/usr/bin/env bash
set -euo pipefail

# Run backend tests with code coverage collection.
#
# How it works:
#   1. Starts the backend server with NODE_V8_COVERAGE to collect raw V8 coverage data
#   2. Runs the blackbox test suite against it
#   3. Stops the server and uses c8 to generate the coverage report
#
# Usage:
#   bash scripts/run-coverage.sh              # Run with threshold enforcement
#   bash scripts/run-coverage.sh --report-only # Just report (no threshold check)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
cd "$BACKEND_DIR"

REPORT_ONLY=0
for arg in "$@"; do
  [[ "$arg" == "--report-only" ]] && REPORT_ONLY=1
done

# Coverage data directory (NODE_V8_COVERAGE tells Node to dump raw coverage here)
COV_TMP="$BACKEND_DIR/coverage/tmp"
rm -rf "$COV_TMP"
mkdir -p "$COV_TMP"

# Pick an isolated port
BASE_PORT="${CONDUCTOR_PORT:-55000}"
COV_PORT=$((BASE_PORT + 200))

# Check whether a server is already listening on the coverage port. Restricting
# the lookup to LISTEN avoids false positives from unrelated outbound sockets
# that happen to use the same ephemeral local port.
if lsof -tiTCP:"$COV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ Port $COV_PORT is in use. Free it or set a different CONDUCTOR_PORT."
  exit 1
fi

export TEST_BASE_URL="http://localhost:$COV_PORT"
COV_LOG="$BACKEND_DIR/coverage/server.log"

# Keep local blackbox coverage deterministic. back-end/.env points trace
# archives at R2 for development/prod, but blackbox tests assert local archive
# artifacts and fake provider boundaries.
export TRACE_ARCHIVE_ENABLED="${TRACE_ARCHIVE_ENABLED:-1}"
export TRACE_ARCHIVE_BACKEND="${TRACE_ARCHIVE_BACKEND:-local}"
export TRACE_ARCHIVE_LOCAL_DIR="${TRACE_ARCHIVE_LOCAL_DIR:-$ROOT_DIR/.context}"
export BLACKBOX_TEST_FAKE_SURGE="${BLACKBOX_TEST_FAKE_SURGE:-1}"

# Coverage starts only a local backend. E2B smoke sandboxes cannot reach stale
# developer ngrok URLs from .env, so keep those smoke sessions on direct provider
# calls unless the caller explicitly opts into a known-live tunnel.
if [[ "${BACKEND_COVERAGE_USE_FAST_MODE_PROXY:-0}" != "1" ]]; then
  export FAST_MODE_ANTHROPIC_PROXY_URL=""
  export FAST_MODE_CODEX_PROXY_URL=""
fi

# Pin the blackbox artifact dir so failures leave a known log path. Without this
# the blackbox runner mints a random RUN_ID dir, which gets lost if the caller
# tails output — forcing a full rerun just to find failures.
BLACKBOX_ARTIFACT_DIR="$BACKEND_DIR/coverage/blackbox-run"
rm -rf "$BLACKBOX_ARTIFACT_DIR"
mkdir -p "$BLACKBOX_ARTIFACT_DIR"
export BLACKBOX_TEST_ARTIFACT_DIR="$BLACKBOX_ARTIFACT_DIR"
export CONTRACT_TEST_ARTIFACT_DIR="$BLACKBOX_ARTIFACT_DIR"

# ── Use local Postgres for coverage blackbox tests ──
# Keep this in sync with run-blackbox-tests.sh so the instrumented backend and
# test processes read/write the same database even when Conductor env vars are
# not exported in the shell.
WORKSPACE_HINT="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$(cd "$BACKEND_DIR/.." && pwd)")}"
LOCAL_DB_PORT=""
if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
fi
DB_CONTAINER="victoria-db-${WORKSPACE_HINT}"
DB_FOUND=false

if docker info >/dev/null 2>&1; then
  if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    CANDIDATES=$(docker ps --filter "name=^victoria-db-" --format "{{.Names}}")
    CANDIDATE_COUNT=$(echo "$CANDIDATES" | grep -c . || true)
    if [[ "$CANDIDATE_COUNT" == "1" ]]; then
      DB_CONTAINER="$CANDIDATES"
    fi
  fi

  ACTUAL_PORT=$(docker port "$DB_CONTAINER" 5432 2>/dev/null | head -1 | sed 's/.*://') || true
  if [[ -n "$ACTUAL_PORT" ]]; then
    LOCAL_DB_PORT="$ACTUAL_PORT"
  fi
  if [[ -n "$LOCAL_DB_PORT" ]] && docker exec "$DB_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
    DB_FOUND=true
    echo "Using local Postgres (Docker container=$DB_CONTAINER) at localhost:$LOCAL_DB_PORT"
  fi
fi

if ! $DB_FOUND; then
  SYSTEM_PG_PORT=5432
  if pg_isready -h localhost -p "$SYSTEM_PG_PORT" -U postgres -q 2>/dev/null; then
    LOCAL_DB_PORT="$SYSTEM_PG_PORT"
    DB_FOUND=true
    echo "Using local Postgres (system) at localhost:$SYSTEM_PG_PORT"
  fi
fi

if $DB_FOUND; then
  LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"
  export DATABASE_URL="$LOCAL_DB_URL"
  export DIRECT_URL="$LOCAL_DB_URL"
  if command -v psql >/dev/null 2>&1; then
    psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
BEGIN
  IF to_regclass('"UserAuthAssistanceRequest"') IS NOT NULL
     AND to_regclass('"AgentAttentionRequest"') IS NOT NULL THEN
    DELETE FROM "UserAuthAssistanceRequest" request
    WHERE NOT EXISTS (
      SELECT 1
      FROM "AgentAttentionRequest" attention
      WHERE attention.id = request.id
    );
  END IF;
END $$;
SQL
  fi
  echo "Syncing Prisma schema to local test database..."
  npx prisma db push --skip-generate --accept-data-loss >/dev/null
  # Credential seeding and smoke execution are separate controls. A caller may
  # pre-seed a valid production credential without disabling the real Codex
  # black-box test that consumes it.
  if [[ "${BACKEND_CODEX_TOKEN_SYNC_SKIP:-0}" != "1" ]]; then
    echo "Syncing local Codex credentials to local test database..."
    npx tsx scripts/sync-codex-token.ts >/dev/null
  fi
fi

# Fast Mode cache requires an explicit URL outside production (no fallback to the
# local app database). Mirror scripts/run.sh: derive it from back-end/.env's
# DATABASE_URL (the shared cache DB) before DATABASE_URL is overridden to the
# local test database above. Without this, every /api/fast-cache route 500s and
# the fast-cache blackbox domain fails under coverage.
if [[ -z "${FAST_MODE_CACHE_DATABASE_URL:-}" && -f .env ]]; then
  ENV_DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  if [[ -n "$ENV_DATABASE_URL" ]]; then
    export FAST_MODE_CACHE_DATABASE_URL="$ENV_DATABASE_URL"
  fi
fi
if [[ -z "${FAST_MODE_CACHE_DATABASE_URL:-}" ]]; then
  echo "❌ FAST_MODE_CACHE_DATABASE_URL is required (or keep DATABASE_URL in back-end/.env so it can be derived)." >&2
  exit 1
fi

echo "Starting backend with coverage collection on port $COV_PORT..."
NODE_V8_COVERAGE="$COV_TMP" PORT="$COV_PORT" DISABLE_GMAIL_SYNC=1 BLACKBOX_TEST_CAPTURE_OUTBOUND=1 \
  npx tsx src/server.ts >"$COV_LOG" 2>&1 &
BACKEND_PID=$!

cleanup() {
  if kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Wait for backend to be ready. Instrumented TypeScript startup can exceed a
# minute on a busy shared host, so use a wall-clock five-minute deadline and
# emit progress every ten seconds instead of failing silently.
READY=0
READINESS_STARTED_AT=$SECONDS
READINESS_DEADLINE=$((READINESS_STARTED_AT + 300))
NEXT_READINESS_PROGRESS=10
while ((SECONDS < READINESS_DEADLINE)); do
  REMAINING_READINESS_SECONDS=$((READINESS_DEADLINE - SECONDS))
  CURL_TIMEOUT_SECONDS=2
  if ((REMAINING_READINESS_SECONDS < CURL_TIMEOUT_SECONDS)); then
    CURL_TIMEOUT_SECONDS=$REMAINING_READINESS_SECONDS
  fi
  if curl -fsS -m "$CURL_TIMEOUT_SECONDS" "$TEST_BASE_URL/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "❌ Backend process exited before becoming ready"
    tail -n 40 "$COV_LOG" || true
    exit 1
  fi
  READINESS_ELAPSED=$((SECONDS - READINESS_STARTED_AT))
  if ((READINESS_ELAPSED >= NEXT_READINESS_PROGRESS)); then
    echo "Waiting for backend health on $TEST_BASE_URL/health (${READINESS_ELAPSED}s elapsed)..."
    NEXT_READINESS_PROGRESS=$((READINESS_ELAPSED + 10))
  fi
  if ((SECONDS < READINESS_DEADLINE)); then
    sleep 0.5
  fi
done

if [[ "$READY" -ne 1 ]]; then
  echo "❌ Timed out waiting for backend health on $TEST_BASE_URL/health"
  tail -n 40 "$COV_LOG" || true
  exit 1
fi

echo "Backend ready at $TEST_BASE_URL"

# Run the blackbox test suite (the comprehensive test that exercises business logic).
# Propagate NODE_V8_COVERAGE so test processes ALSO dump V8 coverage — this
# picks up module-level fetch-stubbed suites (e.g. rose.blackbox.ts) that
# exercise provider code in the test process rather than via HTTP to the
# instrumented backend. All per-process coverage files merge at report time.
echo "Running blackbox tests..."
TEST_EXIT=0
NODE_V8_COVERAGE="$COV_TMP" \
BLACKBOX_TEST_USE_EXISTING_BACKEND=1 CONTRACT_TEST_USE_EXISTING_BACKEND=1 \
BLACKBOX_TEST_CONCURRENCY="${BLACKBOX_TEST_CONCURRENCY:-1}" CONTRACT_TEST_CONCURRENCY="${CONTRACT_TEST_CONCURRENCY:-1}" \
BLACKBOX_TEST_CASE_CONCURRENCY="${BLACKBOX_TEST_CASE_CONCURRENCY:-1}" CONTRACT_TEST_CASE_CONCURRENCY="${CONTRACT_TEST_CASE_CONCURRENCY:-1}" \
  bash scripts/run-blackbox-tests.sh || TEST_EXIT=$?

if $DB_FOUND; then
  echo "Re-syncing Prisma schema before unit tests..."
  if command -v psql >/dev/null 2>&1; then
    psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
BEGIN
  IF to_regclass('"UserAuthAssistanceRequest"') IS NOT NULL
     AND to_regclass('"AgentAttentionRequest"') IS NOT NULL THEN
    DELETE FROM "UserAuthAssistanceRequest" request
    WHERE NOT EXISTS (
      SELECT 1
      FROM "AgentAttentionRequest" attention
      WHERE attention.id = request.id
    );
  END IF;
END $$;
SQL
  fi
  npx prisma db push --skip-generate --accept-data-loss >/dev/null
fi

echo "Running unit tests..."
UNIT_EXIT=0
while IFS= read -r test_file; do
  NODE_V8_COVERAGE="$COV_TMP" npx tsx "$test_file" || UNIT_EXIT=$?
done < <(find src/tests/unit -type f -name '*.test.ts' | sort)

# Stop the server so NODE_V8_COVERAGE flushes data
echo "Stopping backend and collecting coverage data..."
kill "$BACKEND_PID" 2>/dev/null || true
wait "$BACKEND_PID" 2>/dev/null || true

# Generate the coverage report and also the json-summary for the gap analysis
echo ""
echo "=== Coverage Report ==="
COV_EXIT=0
if [[ "$REPORT_ONLY" -eq 1 ]]; then
  npx c8 report --temp-directory="$COV_TMP" --reporter=text --reporter=text-summary --reporter=json-summary || COV_EXIT=$?
else
  npx c8 report --temp-directory="$COV_TMP" --reporter=text --reporter=text-summary --reporter=json-summary --check-coverage || COV_EXIT=$?
fi

# If coverage thresholds failed, show actionable guidance
if [[ "$COV_EXIT" -ne 0 ]]; then
  SUMMARY_FILE="$BACKEND_DIR/coverage/coverage-summary.json"
  if [[ -f "$SUMMARY_FILE" ]]; then
    echo ""
    echo "=== How to fix: files with the most uncovered lines ==="
    echo ""
    COV_SUMMARY_FILE="$SUMMARY_FILE" COV_BACKEND_DIR="$BACKEND_DIR" python3 <<'PYEOF'
import json, sys, os

summary_file = os.environ.get("COV_SUMMARY_FILE", "")
backend_dir = os.environ.get("COV_BACKEND_DIR", "")

with open(summary_file) as f:
    data = json.load(f)

# Read threshold from .c8rc.json
c8rc_path = os.path.join(backend_dir, ".c8rc.json")
threshold = 88  # default
try:
    with open(c8rc_path) as f2:
        c8rc = json.load(f2)
    threshold = c8rc.get("lines", 88)
except Exception:
    pass
cwd = backend_dir + "/"

# Collect per-file gaps
gaps = []
for filepath, metrics in data.items():
    if filepath == "total":
        continue
    display = filepath.replace(cwd, "")
    lines = metrics.get("lines", {})
    total = lines.get("total", 0)
    covered = lines.get("covered", 0)
    pct = lines.get("pct", 100)
    uncovered = total - covered
    if uncovered > 0 and pct < threshold:
        gaps.append((display, pct, uncovered, total, covered))

# Sort by uncovered lines descending
gaps.sort(key=lambda x: -x[2])

# Show top 20 files
header = "{:<60} {:>5} {:>10} {:>6}".format("File", "Cov%", "Uncovered", "Total")
print(header)
print("-" * 85)
for name, pct, uncov, total, cov in gaps[:20]:
    print("{:<60} {:>4.0f}% {:>10} {:>6}".format(name, pct, uncov, total))

# Show totals
total_all = data.get("total", {})
lines_total = total_all.get("lines", {})
cur_pct = lines_total.get("pct", 0)
cur_covered = lines_total.get("covered", 0)
cur_total = lines_total.get("total", 0)
needed = int(cur_total * threshold / 100) - cur_covered
print()
print("Current:  {}/{} lines covered ({:.1f}%)".format(cur_covered, cur_total, cur_pct))
print("Target:   {}% = {} lines".format(threshold, int(cur_total * threshold / 100)))
print("Gap:      {} more lines need coverage".format(needed))
print()
print("Tip: Focus on the files above -- they have the most uncovered lines.")
print("     Run  npm run test:coverage:report  to see per-file details.")
print("     Add or expand blackbox tests in  src/tests/blackbox/<domain>.blackbox.ts")
PYEOF
  fi
  exit "$COV_EXIT"
fi

# If blackbox tests failed, surface the runner log path + failure tail so the
# caller can diagnose without rerunning the whole coverage suite.
if [[ "$TEST_EXIT" -ne 0 || "$UNIT_EXIT" -ne 0 ]]; then
  RUNNER_LOG="$BLACKBOX_ARTIFACT_DIR/runner.log"
  echo ""
  echo "⚠️  Tests failed (blackbox exit $TEST_EXIT, unit exit $UNIT_EXIT). Coverage data may be incomplete."
  echo "    Full runner log: $RUNNER_LOG"
  echo "    Backend log:     $BLACKBOX_ARTIFACT_DIR/backend.log"
  if [[ -f "$RUNNER_LOG" ]]; then
    echo ""
    echo "=== Failure tail (last 120 lines of runner.log) ==="
    tail -n 120 "$RUNNER_LOG"
    echo "=== End failure tail ==="
  fi
  if [[ "$TEST_EXIT" -ne 0 ]]; then
    exit "$TEST_EXIT"
  fi
  exit "$UNIT_EXIT"
fi
