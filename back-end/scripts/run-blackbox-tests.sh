#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

# Match run.sh's resource naming even when Conductor exposes a stale branch-
# based workspace name. Without normalization, tests can miss the worktree's
# Docker database and silently fall back to a shared system Postgres instance.
cd "$ROOT_DIR"
source scripts/lib/workspace-env.sh
normalize_conductor_workspace_env
cd "$BACKEND_DIR"
source "$SCRIPT_DIR/local-db-container.sh"
RUN_ID="${BLACKBOX_TEST_RUN_ID:-${CONTRACT_TEST_RUN_ID:-$(date +%s)-$$-$RANDOM}}"
export BLACKBOX_TEST_RUN_ID="$RUN_ID"
export CONTRACT_TEST_RUN_ID="$RUN_ID"
ARTIFACT_ROOT="${BLACKBOX_TEST_ARTIFACT_ROOT:-${CONTRACT_TEST_ARTIFACT_ROOT:-$ROOT_DIR/.context/test-runs}}"
ARTIFACT_DIR="${BLACKBOX_TEST_ARTIFACT_DIR:-${CONTRACT_TEST_ARTIFACT_DIR:-$ARTIFACT_ROOT/$RUN_ID}}"
PORT_LOCK_ROOT="$ARTIFACT_ROOT/.port-locks"
mkdir -p "$ARTIFACT_DIR" "$PORT_LOCK_ROOT"
export BLACKBOX_TEST_ARTIFACT_DIR="$ARTIFACT_DIR"
export CONTRACT_TEST_ARTIFACT_DIR="$ARTIFACT_DIR"
export TRACE_ARCHIVE_ENABLED="${TRACE_ARCHIVE_ENABLED:-1}"
export TRACE_ARCHIVE_BACKEND="${TRACE_ARCHIVE_BACKEND:-local}"
export TRACE_ARCHIVE_LOCAL_DIR="${TRACE_ARCHIVE_LOCAL_DIR:-$ROOT_DIR/.context}"
export BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES="${BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES:-weekly}"
export BLACKBOX_TEST_CAPTURE_OUTBOUND="${BLACKBOX_TEST_CAPTURE_OUTBOUND:-1}"

# Domains share one test database and several suites intentionally clean up
# broad fixture classes. Run domains serially by default so one suite cannot
# delete another suite's records; callers can still opt into parallel domains.
export BLACKBOX_TEST_CONCURRENCY="${BLACKBOX_TEST_CONCURRENCY:-${CONTRACT_TEST_CONCURRENCY:-1}}"
export CONTRACT_TEST_CONCURRENCY="$BLACKBOX_TEST_CONCURRENCY"

RUNNER_CMD=(node --import tsx src/tests/blackbox/run.ts)
RUNNER_LOG="$ARTIFACT_DIR/runner.log"
MANIFEST_PATH="$ARTIFACT_DIR/manifest.json"
USE_EXISTING_BACKEND="${BLACKBOX_TEST_USE_EXISTING_BACKEND:-${CONTRACT_TEST_USE_EXISTING_BACKEND:-0}}"

# --list only needs filesystem discovery; skip backend boot for speed.
for arg in "$@"; do
  if [[ "$arg" == "--list" ]]; then
    "${RUNNER_CMD[@]}" "$@"
    exit $?
  fi
done

# Fixture-backed domains write deterministic outbound responses into the
# fast-forward cache. When the full suite targets an existing backend, prove
# that backend consumes those fixtures before any database setup or test can
# reach a live provider. Capture-only benchmark stacks deliberately fail this
# contract; callers must relaunch them with the explicit replay opt-in.
if [[ "$USE_EXISTING_BACKEND" == "1" ]]; then
  if [[ -z "${TEST_BASE_URL:-}" ]]; then
    echo "❌ TEST_BASE_URL must be set when BLACKBOX_TEST_USE_EXISTING_BACKEND=1 or CONTRACT_TEST_USE_EXISTING_BACKEND=1"
    exit 1
  fi
  CAPTURE_STATUS_URL="${TEST_BASE_URL%/}/api/test/captures/status"
  if ! CAPTURE_STATUS_JSON=$(curl -fsS --max-time 5 "$CAPTURE_STATUS_URL" 2>/dev/null); then
    echo "❌ Existing backend does not expose blackbox capture capabilities: $CAPTURE_STATUS_URL"
    exit 1
  fi
  if ! jq -e '.captureEnabled == true and .replayEnabled == true' \
    <<<"$CAPTURE_STATUS_JSON" >/dev/null; then
    echo "❌ Existing-backend blackbox requires outbound capture and replay; got: $CAPTURE_STATUS_JSON"
    echo "   Relaunch the local test stack with BLACKBOX_TEST_REPLAY_OUTBOUND=1."
    exit 1
  fi
fi

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
WORKTREE_HINT="$(basename "$ROOT_DIR")"
WORKSPACE_HINT="${CONDUCTOR_WORKSPACE_NAME:-$WORKTREE_HINT}"
LOCAL_DB_PORT=""
if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
fi
DB_CONTAINER="victoria-db-${WORKSPACE_HINT}"
DB_FOUND=false
STACK_DB_EXPECTED=false
SELECTED_DB_URL=""
ISOLATED_DB_RESOLVED=false

# Managed existing-backend callers (for example, run-coverage.sh) know the
# exact database used by the backend they launched. Prefer that explicit
# contract over every local discovery mechanism.
EXPLICIT_TEST_DB_URL="${BLACKBOX_TEST_DATABASE_URL:-${CONTRACT_TEST_DATABASE_URL:-}}"
if [[ "$USE_EXISTING_BACKEND" == "1" && -n "$EXPLICIT_TEST_DB_URL" ]]; then
  STACK_DB_EXPECTED=true
  if [[ ! "$EXPLICIT_TEST_DB_URL" =~ ^postgres(ql)?://([^/]*@)?(localhost|127\.0\.0\.1)(:[0-9]+)?/ ]]; then
    echo "❌ BLACKBOX_TEST_DATABASE_URL must point at localhost for fixture safety."
    exit 1
  fi
  if psql "$EXPLICIT_TEST_DB_URL" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
    DB_FOUND=true
    SELECTED_DB_URL="$EXPLICIT_TEST_DB_URL"
    echo "Using database explicitly provided by the existing backend launcher"
  fi
fi

# When testing an already-running stack, use the same database selected by
# run.sh. Re-probing Docker here can choose a different healthy local database
# after run.sh has fallen back to system Postgres (or vice versa).
STACK_MANIFEST="$ROOT_DIR/.context/services.json"
if ! $STACK_DB_EXPECTED && [[ "$USE_EXISTING_BACKEND" == "1" && -f "$STACK_MANIFEST" && -n "${TEST_BASE_URL:-}" ]]; then
  MANIFEST_BACKEND_URL=$(jq -r '.urls.backend // empty' "$STACK_MANIFEST")
  if [[ "${TEST_BASE_URL%/}" == "${MANIFEST_BACKEND_URL%/}" ]]; then
    STACK_DB_EXPECTED=true
    USE_MANIFEST_SYSTEM_PG=$(jq -r '.database.use_system_postgres // false' "$STACK_MANIFEST")
    if [[ "$USE_MANIFEST_SYSTEM_PG" == "true" ]]; then
      LOCAL_DB_PORT=$(jq -r '.database.runtime_port // 5432' "$STACK_MANIFEST")
      if pg_isready -h localhost -p "$LOCAL_DB_PORT" -U postgres -q 2>/dev/null; then
        DB_FOUND=true
        echo "Using existing stack Postgres (system) at localhost:$LOCAL_DB_PORT"
      fi
    else
      MANIFEST_DB_CONTAINER=$(jq -r '.database.container // empty' "$STACK_MANIFEST")
      if [[ -n "$MANIFEST_DB_CONTAINER" ]]; then
        DB_CONTAINER="$MANIFEST_DB_CONTAINER"
      fi
      MANIFEST_DB_PORT=$(jq -r '.database.runtime_port // .ports.local_db // empty' "$STACK_MANIFEST")
      ACTUAL_PORT=$(docker_quick port "$DB_CONTAINER" 5432 | head -1 | sed 's/.*://') || true
      LOCAL_DB_PORT="${ACTUAL_PORT:-$MANIFEST_DB_PORT}"
      if [[ -n "$LOCAL_DB_PORT" ]] && docker_quick exec "$DB_CONTAINER" pg_isready -U postgres -q >/dev/null; then
        DB_FOUND=true
        echo "Using existing stack Postgres (Docker container=$DB_CONTAINER) at localhost:$LOCAL_DB_PORT"
      fi
    fi
  fi
fi
# Try Docker container first
if ! $STACK_DB_EXPECTED && docker_info_quick; then
  # Prefer the workspace-named container; fall back to the only running
  # victoria-db-* container if there's exactly one (covers cases where the
  # caller hasn't exported CONDUCTOR_WORKSPACE_NAME).
  if RESOLVED_CONTAINER="$(resolve_local_db_container "$WORKSPACE_HINT" "$WORKTREE_HINT")"; then
    DB_CONTAINER="$RESOLVED_CONTAINER"
    ISOLATED_DB_RESOLVED=true
  else
    if ! system_db_fallback_is_safe; then
      echo "❌ No ready Postgres container owned by this worktree." >&2
      echo "   Tried: victoria-db-$WORKSPACE_HINT and victoria-db-$WORKTREE_HINT" >&2
      echo "   Refusing shared system Postgres while other workspace DBs are active." >&2
      exit 1
    fi
  fi

  ACTUAL_PORT=$(docker_quick port "$DB_CONTAINER" 5432 | head -1 | sed 's/.*://') || true
  if [[ -n "$ACTUAL_PORT" ]]; then
    LOCAL_DB_PORT="$ACTUAL_PORT"
  fi
  if [[ -n "$LOCAL_DB_PORT" ]] && docker_quick exec "$DB_CONTAINER" pg_isready -U postgres -q >/dev/null; then
    DB_FOUND=true
    echo "Using local Postgres (Docker container=$DB_CONTAINER) at localhost:$LOCAL_DB_PORT"
  fi
  if $ISOLATED_DB_RESOLVED && ! $DB_FOUND; then
    echo "❌ Owned Postgres container $DB_CONTAINER is not reachable on a mapped port." >&2
    exit 1
  fi
fi

# Fall back to system Postgres
if ! $STACK_DB_EXPECTED && ! $DB_FOUND; then
  SYSTEM_PG_PORT=5432
  if pg_isready -h localhost -p "$SYSTEM_PG_PORT" -U postgres -q 2>/dev/null; then
    LOCAL_DB_PORT="$SYSTEM_PG_PORT"
    DB_FOUND=true
    echo "Using local Postgres (system) at localhost:$SYSTEM_PG_PORT"
  fi
fi

if $STACK_DB_EXPECTED && ! $DB_FOUND; then
  echo "❌ The database recorded for existing backend $TEST_BASE_URL is unavailable."
  echo "   Refusing to select a different local database because fixtures would be invisible to the backend."
  exit 1
fi

if $DB_FOUND; then
  LOCAL_DB_URL="${SELECTED_DB_URL:-postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria}"
  export DATABASE_URL="$LOCAL_DB_URL"
  export DIRECT_URL="$LOCAL_DB_URL"
  export FAST_MODE_CACHE_DATABASE_URL="${FAST_MODE_CACHE_DATABASE_URL:-$LOCAL_DB_URL}"
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
    CODEX_AUTH_FILE="${CODEX_AUTH_PATH:-$HOME/.codex/auth.json}"
    CODEX_AUTH_MODE="$(jq -r '.auth_mode // empty' "$CODEX_AUTH_FILE" 2>/dev/null || true)"
    if [[ "$CODEX_AUTH_MODE" == "chatgpt" ]]; then
      echo "Syncing local Codex credentials to local test database..."
      npx tsx scripts/sync-codex-token.ts >/dev/null
    else
      SEEDED_CODEX_COUNT="$(psql "$LOCAL_DB_URL" -At -v ON_ERROR_STOP=1 -c \
        "SELECT count(*) FROM \"Integration\" WHERE name='gpt_code' AND status='CONNECTED' AND \"isActive\"=true AND coalesce(config->>'encryptedCredentials','') <> '';" 2>/dev/null || printf 0)"
      if [[ "$SEEDED_CODEX_COUNT" =~ ^[1-9][0-9]*$ ]]; then
        echo "Using the connected gpt_code credential already seeded in the isolated test database."
      else
        echo "❌ Codex auth is not ChatGPT mode and the isolated test database has no connected gpt_code credential." >&2
        echo "   Run codex login, seed the integration, or set BACKEND_CODEX_TOKEN_SYNC_SKIP=1 only when the caller already seeded it." >&2
        exit 1
      fi
    fi
  fi
else
  echo "❌ No local Postgres available. Blackbox tests require a local DB to"
  echo "   avoid writing test fixtures into prod Supabase."
  echo "   Either start Docker container: docker start $DB_CONTAINER"
  echo "   Or install system Postgres: scripts/cloud-build.sh"
  exit 1
fi

if [[ "$USE_EXISTING_BACKEND" == "1" ]]; then
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
export BLACKBOX_TEST_CAPTURE_OUTBOUND=1
export BLACKBOX_TEST_REPLAY_OUTBOUND=1
source "$SCRIPT_DIR/blackbox-auto-rca-env.sh"
# The isolated backend must not inherit a developer's workspace tunnel. E2B
# cannot reach localhost, and stale ngrok URLs turn the direct Codex smoke into
# a test of unrelated local Fast Mode infrastructure. Explicit BLACKBOX_*
# overrides remain available for proxy-specific blackbox runs.
export FAST_MODE_ANTHROPIC_PROXY_URL="${BLACKBOX_FAST_MODE_ANTHROPIC_PROXY_URL:-}"
export FAST_MODE_CODEX_PROXY_URL="${BLACKBOX_FAST_MODE_CODEX_PROXY_URL:-}"
if [[ -z "${BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON:-}" ]]; then
  export BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON='{"reasoning":"blackbox smoke fixture","tool_calls":[{"tool":"send_user_message","arguments":{"message":"Blackbox SMS smoke reply"}},{"tool":"attempt_completion","arguments":{}}]}'
fi

cat >"$MANIFEST_PATH" <<EOF
{"run_id":"$RUN_ID","mode":"isolated-blackbox-backend","base_url":"$TEST_BASE_URL","port":$PORT,"artifact_dir":"$ARTIFACT_DIR","backend_log":"$BACKEND_LOG","runner_log":"$RUNNER_LOG","disable_gmail_sync":true}
EOF

echo "Starting isolated backend for black-box tests on port $PORT"
echo "Backend log: $BACKEND_LOG"
echo "Artifacts: $ARTIFACT_DIR"

PORT="$PORT" \
DISABLE_GMAIL_SYNC=1 \
npx tsx src/bootstrap.ts >"$BACKEND_LOG" 2>&1 &
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
