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

# Check port is free
if lsof -ti :"$COV_PORT" >/dev/null 2>&1; then
  echo "❌ Port $COV_PORT is in use. Free it or set a different CONDUCTOR_PORT."
  exit 1
fi

export TEST_BASE_URL="http://localhost:$COV_PORT"
COV_LOG="$BACKEND_DIR/coverage/server.log"

# Pin the blackbox artifact dir so failures leave a known log path. Without this
# the blackbox runner mints a random RUN_ID dir, which gets lost if the caller
# tails output — forcing a full rerun just to find failures.
BLACKBOX_ARTIFACT_DIR="$BACKEND_DIR/coverage/blackbox-run"
rm -rf "$BLACKBOX_ARTIFACT_DIR"
mkdir -p "$BLACKBOX_ARTIFACT_DIR"
export BLACKBOX_TEST_ARTIFACT_DIR="$BLACKBOX_ARTIFACT_DIR"
export CONTRACT_TEST_ARTIFACT_DIR="$BLACKBOX_ARTIFACT_DIR"

# ── Use local Postgres when Conductor provides port info ──
# Mirror the same logic from run-blackbox-tests.sh so the coverage backend
# and the test runner both hit the same local DB (avoids FK / 404 mismatches).
if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 10))
  DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}"
  ACTUAL_PORT=$(docker port "$DB_CONTAINER" 5432 2>/dev/null | head -1 | sed 's/.*://') || true
  if [[ -n "$ACTUAL_PORT" ]]; then
    LOCAL_DB_PORT="$ACTUAL_PORT"
  fi
  LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"
  if docker exec "$DB_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
    export DATABASE_URL="$LOCAL_DB_URL"
    export DIRECT_URL="$LOCAL_DB_URL"
    echo "Using local Postgres at localhost:$LOCAL_DB_PORT"
  fi
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

# Wait for backend to be ready
READY=0
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "$TEST_BASE_URL/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "❌ Backend process exited before becoming ready"
    tail -n 40 "$COV_LOG" || true
    exit 1
  fi
  sleep 0.5
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
  bash scripts/run-blackbox-tests.sh || TEST_EXIT=$?

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
if [[ "$TEST_EXIT" -ne 0 ]]; then
  RUNNER_LOG="$BLACKBOX_ARTIFACT_DIR/runner.log"
  echo ""
  echo "⚠️  Blackbox tests failed (exit code $TEST_EXIT). Coverage data may be incomplete."
  echo "    Full runner log: $RUNNER_LOG"
  echo "    Backend log:     $BLACKBOX_ARTIFACT_DIR/backend.log"
  if [[ -f "$RUNNER_LOG" ]]; then
    echo ""
    echo "=== Failure tail (last 120 lines of runner.log) ==="
    tail -n 120 "$RUNNER_LOG"
    echo "=== End failure tail ==="
  fi
  exit "$TEST_EXIT"
fi
