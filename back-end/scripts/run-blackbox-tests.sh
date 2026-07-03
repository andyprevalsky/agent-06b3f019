#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_DIR"

ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
RUN_ID="${BLACKBOX_TEST_RUN_ID:-${CONTRACT_TEST_RUN_ID:-$(date +%s)-$$-$RANDOM}}"
export BLACKBOX_TEST_RUN_ID="$RUN_ID"
export CONTRACT_TEST_RUN_ID="$RUN_ID"
ARTIFACT_ROOT="${BLACKBOX_TEST_ARTIFACT_ROOT:-${CONTRACT_TEST_ARTIFACT_ROOT:-$ROOT_DIR/.context/test-runs}}"
ARTIFACT_DIR="${BLACKBOX_TEST_ARTIFACT_DIR:-${CONTRACT_TEST_ARTIFACT_DIR:-$ARTIFACT_ROOT/$RUN_ID}}"
PORT_LOCK_ROOT="$ARTIFACT_ROOT/.port-locks"
mkdir -p "$ARTIFACT_DIR" "$PORT_LOCK_ROOT"
export BLACKBOX_TEST_ARTIFACT_DIR="$ARTIFACT_DIR"
export CONTRACT_TEST_ARTIFACT_DIR="$ARTIFACT_DIR"

RUNNER_CMD=(npx tsx src/tests/blackbox/run.ts)
RUNNER_LOG="$ARTIFACT_DIR/runner.log"
MANIFEST_PATH="$ARTIFACT_DIR/manifest.json"

# --list only needs filesystem discovery; skip backend boot for speed.
for arg in "$@"; do
  if [[ "$arg" == "--list" ]]; then
    "${RUNNER_CMD[@]}" "$@"
    exit $?
  fi
done

# ── Use local Postgres for blackbox tests ──
# run.sh launches a per-workspace Postgres container on CONDUCTOR_PORT+5.
# Mirror that here so the isolated test backend + test scripts both hit the
# local DB instead of the remote Supabase pooler (avoids pgbouncer cross-
# process visibility issues that cause flaky FK / 404 failures, AND avoids
# DB-mismatch bugs where direct-prisma seed writes go to prod while the
# backend reads from local — manifests as silent 403s, missing rows, etc).
# Falls back to system Postgres (port 5432) when Docker is unavailable.
#
# We must run this whether or not CONDUCTOR_PORT/CONDUCTOR_WORKSPACE_NAME are
# set in the caller's env, because back-end/.env's DATABASE_URL points at
# prod Supabase by default; silently inheriting it for tests is a footgun.
WORKSPACE_HINT="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$(cd "$BACKEND_DIR/.." && pwd)")}"
LOCAL_DB_PORT=""
if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
fi
DB_CONTAINER="victoria-db-${WORKSPACE_HINT}"
DB_FOUND=false

# Try Docker container first
if docker info >/dev/null 2>&1; then
  # Prefer the workspace-named container; fall back to the only running
  # victoria-db-* container if there's exactly one (covers cases where the
  # caller hasn't exported CONDUCTOR_WORKSPACE_NAME).
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

# Fall back to system Postgres
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
else
  echo "❌ No local Postgres available. Blackbox tests require a local DB to"
  echo "   avoid writing test fixtures into prod Supabase."
  echo "   Either start Docker container: docker start $DB_CONTAINER"
  echo "   Or install system Postgres: scripts/cloud-build.sh"
  exit 1
fi

USE_EXISTING_BACKEND="${BLACKBOX_TEST_USE_EXISTING_BACKEND:-${CONTRACT_TEST_USE_EXISTING_BACKEND:-0}}"

if [[ "$USE_EXISTING_BACKEND" == "1" ]]; then
  if [[ -z "${TEST_BASE_URL:-}" ]]; then
    echo "❌ TEST_BASE_URL must be set when BLACKBOX_TEST_USE_EXISTING_BACKEND=1 or CONTRACT_TEST_USE_EXISTING_BACKEND=1"
    exit 1
  fi
  cat >"$MANIFEST_PATH" <<EOF
{"run_id":"$RUN_ID","mode":"existing-blackbox-backend","base_url":"$TEST_BASE_URL","artifact_dir":"$ARTIFACT_DIR","runner_log":"$RUNNER_LOG"}
EOF
  echo "Artifacts: $ARTIFACT_DIR"
  echo "Using existing backend at $TEST_BASE_URL"
  set +e
  "${RUNNER_CMD[@]}" "$@" 2>&1 | tee "$RUNNER_LOG"
  RUNNER_EXIT=${PIPESTATUS[0]}
  set -e
  if [[ "$RUNNER_EXIT" -ne 0 ]]; then
    echo "❌ Black-box tests failed (exit $RUNNER_EXIT). Runner log: $RUNNER_LOG"
  fi
  exit "$RUNNER_EXIT"
fi

# Conductor.run uses BACKEND_PORT=CONDUCTOR_PORT. For black-box tests we keep branch affinity
# but use a separate port range to avoid reusing the live workspace backend port.
BASE_PORT="${CONDUCTOR_PORT:-55000}"
START_PORT="${BLACKBOX_TEST_BACKEND_START_PORT:-${CONTRACT_TEST_BACKEND_START_PORT:-$((BASE_PORT + 100))}}"
PORT="${BLACKBOX_TEST_BACKEND_PORT:-${CONTRACT_TEST_BACKEND_PORT:-$START_PORT}}"
PORT_LOCK_DIR=""

reserve_port() {
  local candidate="$1"

  while true; do
    local lock_dir="$PORT_LOCK_ROOT/$candidate"
    if mkdir "$lock_dir" 2>/dev/null; then
      if lsof -ti :"$candidate" >/dev/null 2>&1; then
        rmdir "$lock_dir" >/dev/null 2>&1 || true
      else
        PORT_LOCK_DIR="$lock_dir"
        echo "$candidate"
        return 0
      fi
    fi
    candidate=$((candidate + 1))
  done
}

if [[ -z "${BLACKBOX_TEST_BACKEND_PORT:-${CONTRACT_TEST_BACKEND_PORT:-}}" ]]; then
  PORT="$(reserve_port "$START_PORT")"
else
  PORT_LOCK_DIR="$PORT_LOCK_ROOT/$PORT"
  if ! mkdir "$PORT_LOCK_DIR" 2>/dev/null; then
    echo "❌ Failed to reserve requested black-box test port $PORT"
    exit 1
  fi
fi

export TEST_BASE_URL="http://localhost:$PORT"
BACKEND_LOG="${BLACKBOX_TEST_BACKEND_LOG:-${CONTRACT_TEST_BACKEND_LOG:-$ARTIFACT_DIR/backend.log}}"

# Deterministic SMS smoke fixtures for the isolated backend. These are only
# consumed when BLACKBOX_TEST_CAPTURE_OUTBOUND=1, so production/development
# behavior is unchanged.
export SURGE_API_KEY="${SURGE_API_KEY:-blackbox-surge-key}"
export SURGE_ACCOUNT_ID="${SURGE_ACCOUNT_ID:-blackbox-surge-account}"
export BLACKBOX_TEST_FAKE_SURGE="${BLACKBOX_TEST_FAKE_SURGE:-1}"
if [[ -z "${BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON:-}" ]]; then
  export BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON='{"reasoning":"blackbox smoke fixture","tool_calls":[{"tool":"attempt_completion","arguments":{"message":"Blackbox SMS smoke reply"}}]}'
fi

cat >"$MANIFEST_PATH" <<EOF
{"run_id":"$RUN_ID","mode":"isolated-blackbox-backend","base_url":"$TEST_BASE_URL","port":$PORT,"artifact_dir":"$ARTIFACT_DIR","backend_log":"$BACKEND_LOG","runner_log":"$RUNNER_LOG","disable_gmail_sync":true}
EOF

echo "Starting isolated backend for black-box tests on port $PORT"
echo "Backend log: $BACKEND_LOG"
echo "Artifacts: $ARTIFACT_DIR"

PORT="$PORT" DISABLE_GMAIL_SYNC=1 BLACKBOX_TEST_CAPTURE_OUTBOUND=1 npx tsx src/server.ts >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

cleanup() {
  if kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ -n "$PORT_LOCK_DIR" && -d "$PORT_LOCK_DIR" ]]; then
    rmdir "$PORT_LOCK_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

READY=0
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "$TEST_BASE_URL/health" >/dev/null 2>&1; then
    READY=1
    break
  fi

  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "❌ Backend process exited before becoming ready"
    echo "Last backend log lines:"
    tail -n 80 "$BACKEND_LOG" || true
    exit 1
  fi

  sleep 0.5
done

if [[ "$READY" -ne 1 ]]; then
  echo "❌ Timed out waiting for backend health on $TEST_BASE_URL/health"
  echo "Last backend log lines:"
  tail -n 80 "$BACKEND_LOG" || true
  exit 1
fi

echo "Backend ready at $TEST_BASE_URL"
set +e
"${RUNNER_CMD[@]}" "$@" 2>&1 | tee "$RUNNER_LOG"
RUNNER_EXIT=${PIPESTATUS[0]}
set -e
if [[ "$RUNNER_EXIT" -ne 0 ]]; then
  echo "❌ Black-box tests failed (exit $RUNNER_EXIT)."
  echo "   Runner log:  $RUNNER_LOG"
  echo "   Backend log: $BACKEND_LOG"
  echo "   Artifacts:   $ARTIFACT_DIR"
  exit "$RUNNER_EXIT"
fi
