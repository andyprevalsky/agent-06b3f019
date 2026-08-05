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
#   bash scripts/run-coverage.sh --print-coverage-port # Reserve, print, and release a port
#   bash scripts/run-coverage.sh --hold-coverage-lock # Test-only run-lock probe
#   bash scripts/run-coverage.sh --hold-coverage-lock-with-child # Test-only orphan cleanup probe

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

# Match run.sh and run-blackbox-tests.sh resource naming when Conductor still
# exposes a branch-derived workspace name. Coverage needs the worktree's
# isolated Postgres container, not a shared system-Postgres fallback.
cd "$ROOT_DIR"
source scripts/lib/workspace-env.sh
normalize_conductor_workspace_env
source "$SCRIPT_DIR/local-db-container.sh"
cd "$BACKEND_DIR"

# Cursor Cloud (and similar) may inject BROWSER_PROVIDER into the process
# environment. Node dotenv does not override existing vars, so a stale value
# like "browserbase" wins over back-end/.env ("kernel") and the live
# browser-provider blackbox 500s on /init. Force a supported provider here.
case "${BROWSER_PROVIDER:-}" in
  kernel|steel) ;;
  *)
    echo "⚠️  BROWSER_PROVIDER='${BROWSER_PROVIDER:-}' is unsupported; forcing kernel for coverage."
    export BROWSER_PROVIDER=kernel
    ;;
esac

REPORT_ONLY=0
PRINT_COVERAGE_PORT=0
HOLD_COVERAGE_LOCK=0
HOLD_COVERAGE_LOCK_WITH_CHILD=0
for arg in "$@"; do
  [[ "$arg" == "--report-only" ]] && REPORT_ONLY=1
  [[ "$arg" == "--print-coverage-port" ]] && PRINT_COVERAGE_PORT=1
  [[ "$arg" == "--hold-coverage-lock" ]] && HOLD_COVERAGE_LOCK=1
  [[ "$arg" == "--hold-coverage-lock-with-child" ]] && HOLD_COVERAGE_LOCK_WITH_CHILD=1
done

# All coverage runs in one worktree share coverage/tmp, coverage/blackbox-run,
# coverage/server.log, and the workspace database. Hold OS advisory locks in a
# child that watches this shell. Unlike mkdir locks, a separately-sessioned
# guardian reaps registered test groups after SIGKILL/OOM before unlocking.
COVERAGE_RUN_LOCK_FILE="${BACKEND_COVERAGE_RUN_LOCK_FILE:-${BACKEND_COVERAGE_RUN_LOCK_DIR:-$BACKEND_DIR/coverage/.run-lock}}"
COVERAGE_RUN_LOCK_KEEPER_PID=""
COV_PORT_LOCK_KEEPER_PID=""
COVERAGE_PROCESS_GROUPS_FILE="${BACKEND_COVERAGE_PROCESS_GROUPS_FILE:-$(mktemp -t navi-backend-coverage-groups)}"
: >"$COVERAGE_PROCESS_GROUPS_FILE"

acquire_process_lock() {
  local lock_file="$1"
  local process_groups_file="${2:-}"
  local status_file lock_keeper_pid lock_status
  status_file="$(mktemp -t navi-backend-coverage-lock)"
  if [[ -n "$process_groups_file" ]]; then
    python3 "$SCRIPT_DIR/coverage-process-lock.py" \
      "$lock_file" "$status_file" "$$" "$process_groups_file" &
  else
    python3 "$SCRIPT_DIR/coverage-process-lock.py" "$lock_file" "$status_file" "$$" &
  fi
  lock_keeper_pid=$!

  for _attempt in $(seq 1 250); do
    if [[ -s "$status_file" ]]; then
      break
    fi
    if ! kill -0 "$lock_keeper_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.02
  done

  lock_status="$(cat "$status_file" 2>/dev/null || printf 'failed')"
  rm -f "$status_file"
  if [[ "$lock_status" == "acquired" ]]; then
    ACQUIRED_LOCK_KEEPER_PID="$lock_keeper_pid"
    ACQUIRED_LOCK_OWNER=""
    return 0
  fi

  wait "$lock_keeper_pid" >/dev/null 2>&1 || true
  ACQUIRED_LOCK_KEEPER_PID=""
  ACQUIRED_LOCK_OWNER="${lock_status#blocked:}"
  return 1
}

launch_coverage_process_group() {
  python3 "$SCRIPT_DIR/coverage-process-group.py" "$COVERAGE_PROCESS_GROUPS_FILE" "$@" &
  LAUNCHED_COVERAGE_PID=$!
}

release_process_lock() {
  local lock_keeper_pid="$1"
  [[ -n "$lock_keeper_pid" ]] || return 0
  kill "$lock_keeper_pid" >/dev/null 2>&1 || true
  wait "$lock_keeper_pid" >/dev/null 2>&1 || true
}

if ! acquire_process_lock "$COVERAGE_RUN_LOCK_FILE" "$COVERAGE_PROCESS_GROUPS_FILE"; then
  echo "❌ Another backend coverage run is already active (pid=$ACQUIRED_LOCK_OWNER)." >&2
  rm -f "$COVERAGE_PROCESS_GROUPS_FILE"
  exit 1
fi
COVERAGE_RUN_LOCK_KEEPER_PID="$ACQUIRED_LOCK_KEEPER_PID"

release_coverage_reservations() {
  release_process_lock "$COV_PORT_LOCK_KEEPER_PID"
  release_process_lock "$COVERAGE_RUN_LOCK_KEEPER_PID"
  rm -f "$COVERAGE_PROCESS_GROUPS_FILE"
}
trap release_coverage_reservations EXIT
trap 'exit 130' INT TERM

if [[ "$HOLD_COVERAGE_LOCK" == "1" ]]; then
  printf 'coverage lock acquired by %s\n' "$$"
  sleep "${BACKEND_COVERAGE_HOLD_SECONDS:-30}"
  exit 0
fi

if [[ "$HOLD_COVERAGE_LOCK_WITH_CHILD" == "1" ]]; then
  launch_coverage_process_group python3 -c 'import time; time.sleep(30)'
  printf 'coverage child process group %s\n' "$LAUNCHED_COVERAGE_PID"
  sleep "${BACKEND_COVERAGE_HOLD_SECONDS:-30}"
  exit 0
fi

# Returns 0 when a funded OpenAI key (GPT_API_KEY / OPENAI_API_KEY) fallback is
# available to the coverage backend — either already exported into this shell or
# present and non-empty in back-end/.env (which the backend loads via dotenv at
# startup). resolveCodexCodeAuthEnvs uses this key to authenticate the Codex Code
# E2B session when no gpt_code OAuth credential is seeded, so its presence means
# the codex-code smoke can still run (and self-SKIP when the key is exhausted).
codex_funded_fallback_configured() {
  local env_name value
  for value in "${GPT_API_KEY:-}" "${OPENAI_API_KEY:-}"; do
    [[ -n "$value" ]] && return 0
  done
  [[ -f "$BACKEND_DIR/.env" ]] || return 1
  for env_name in GPT_API_KEY OPENAI_API_KEY; do
    # Mirror the backend's dotenv semantics rather than trusting the first raw
    # grep hit: the LAST assignment wins (dotenv is last-in-wins), quoted values
    # keep '#' literally, unquoted values drop an inline "# comment", and an
    # empty/whitespace/comment-only effective value counts as absent — so a blank
    # or commented-out key cannot spuriously satisfy the fallback and skip the
    # intended no-credential failure path.
    value="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${env_name}=" "$BACKEND_DIR/.env" | tail -1 || true)"
    [[ -z "$value" ]] && continue
    value="${value#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    case "$value" in
      \"*) value="${value#\"}"; value="${value%%\"*}" ;;
      \'*) value="${value#\'}"; value="${value%%\'*}" ;;
      *)   value="${value%%#*}"
           value="${value%"${value##*[![:space:]]}"}" ;;
    esac
    [[ -n "$value" ]] && return 0
  done
  return 1
}

# Coverage data directory (NODE_V8_COVERAGE tells Node to dump raw coverage here)
COV_TMP="$BACKEND_DIR/coverage/tmp"

# Reserve one of the two currently-unused ports inside Conductor's ten-port
# workspace allocation. Port arithmetic outside that allocation is only a
# preference and can collide with a sibling workspace whose valid service has
# not started yet. A process-bound advisory lock closes the check/start race
# between cooperating processes without leaving stale reservations, while lsof
# protects against an ordinary listener already using an owned port.
BASE_PORT="${CONDUCTOR_PORT:-55000}"
COV_PORT_START="${BACKEND_COVERAGE_START_PORT:-$((BASE_PORT + 7))}"
COV_PORT_END="${BACKEND_COVERAGE_END_PORT:-$((BASE_PORT + 8))}"
COV_PORT_LOCK_ROOT="${BACKEND_COVERAGE_PORT_LOCK_ROOT:-$ROOT_DIR/.context/test-runs/.port-locks}"
mkdir -p "$COV_PORT_LOCK_ROOT"

reserve_coverage_port() {
  local candidate="$1"
  while ((candidate <= COV_PORT_END)); do
    local lock_file="$COV_PORT_LOCK_ROOT/$candidate.lock"
    if acquire_process_lock "$lock_file"; then
      if lsof -tiTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
        release_process_lock "$ACQUIRED_LOCK_KEEPER_PID"
      else
        COV_PORT="$candidate"
        COV_PORT_LOCK_KEEPER_PID="$ACQUIRED_LOCK_KEEPER_PID"
        return 0
      fi
    fi
    candidate=$((candidate + 1))
  done
  echo "❌ No available coverage port in this workspace's owned range $1-$COV_PORT_END." >&2
  return 1
}

COV_PORT=""
reserve_coverage_port "$COV_PORT_START"

if [[ "$PRINT_COVERAGE_PORT" == "1" ]]; then
  printf '%s\n' "$COV_PORT"
  exit 0
fi

rm -rf "$COV_TMP"
mkdir -p "$COV_TMP"

export TEST_BASE_URL="http://localhost:$COV_PORT"
COV_LOG="$BACKEND_DIR/coverage/server.log"

# Keep local blackbox coverage deterministic. back-end/.env points trace
# archives at R2 for development/prod, but blackbox tests assert local archive
# artifacts and fake provider boundaries.
export TRACE_ARCHIVE_ENABLED="${TRACE_ARCHIVE_ENABLED:-1}"
export TRACE_ARCHIVE_BACKEND="${TRACE_ARCHIVE_BACKEND:-local}"
export TRACE_ARCHIVE_LOCAL_DIR="${TRACE_ARCHIVE_LOCAL_DIR:-$ROOT_DIR/.context}"
export BLACKBOX_TEST_FAKE_SURGE="${BLACKBOX_TEST_FAKE_SURGE:-1}"
export BLACKBOX_TEST_FAKE_TEMPORAL="${BLACKBOX_TEST_FAKE_TEMPORAL:-1}"
export BLACKBOX_TEST_CAPTURE_OUTBOUND=1
export BLACKBOX_TEST_REPLAY_OUTBOUND=1
source "$SCRIPT_DIR/blackbox-auto-rca-env.sh"
# Only the weekly admin-health case asserts real Amplitude counts. Keep that
# strict live probe enabled while preventing non-asserting shape cases from
# spending the provider's shared query budget.
export BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES="${BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES:-weekly}"
# Coverage remains deterministic and still exercises the unavailable path.
# The deploy workflow runs one focused live weekly probe afterward, so a
# provider quota failure can be retried without rerunning all 91 deterministic domains.
export AMPLITUDE_API_KEY=""
export AMPLITUDE_SECRET_KEY=""
# Credential health is a mandatory focused deploy stage, not deterministic code
# coverage. Keep its real provider calls out of this 91-domain batch so a TLS or
# provider outage can be retried without rerunning every instrumented test.
export BLACKBOX_TEST_SKIP_DOMAINS="${BLACKBOX_TEST_SKIP_DOMAINS:+$BLACKBOX_TEST_SKIP_DOMAINS,}integration-health"
export CONTRACT_TEST_SKIP_DOMAINS="$BLACKBOX_TEST_SKIP_DOMAINS"

# Coverage is a deterministic local-code gate, not an external analytics probe.
# A full admin-health run can spend most of Amplitude's five-minute chart-query
# budget, starving the mandatory live blackbox gate that follows coverage during
# /deploy. Keep coverage offline; the later live suite still requires real
# Amplitude funnel counts when credentials are configured.
export AMPLITUDE_API_KEY=""
export AMPLITUDE_SECRET_KEY=""

# Coverage is also not the deploy credential-health gate. The integration-health
# blackbox intentionally performs live provider billing/credential probes, which
# are required later as their own /deploy stage. Exclude only that operational
# probe here so code coverage remains a deterministic local-code gate.
append_blackbox_skip_domain() {
  local current="$1"
  local domain="$2"
  case ",$current," in
    *",$domain,"*) printf '%s\n' "$current" ;;
    "") printf '%s\n' "$domain" ;;
    *) printf '%s,%s\n' "$current" "$domain" ;;
  esac
}

export BLACKBOX_TEST_SKIP_DOMAINS="$(
  append_blackbox_skip_domain "${BLACKBOX_TEST_SKIP_DOMAINS:-}" "integration-health"
)"
export CONTRACT_TEST_SKIP_DOMAINS="$(
  append_blackbox_skip_domain "${CONTRACT_TEST_SKIP_DOMAINS:-}" "integration-health"
)"

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
WORKTREE_HINT="$(basename "$ROOT_DIR")"
WORKSPACE_HINT="${CONDUCTOR_WORKSPACE_NAME:-$WORKTREE_HINT}"
LOCAL_DB_PORT=""
if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  LOCAL_DB_PORT=$(($CONDUCTOR_PORT + 5))
fi
DB_CONTAINER="victoria-db-${WORKSPACE_HINT}"
DB_FOUND=false
ISOLATED_DB_RESOLVED=false

if docker_info_quick; then
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

if ! $DB_FOUND; then
  SYSTEM_PG_PORT=5432
  if pg_isready -h localhost -p "$SYSTEM_PG_PORT" -U postgres -q 2>/dev/null; then
    LOCAL_DB_PORT="$SYSTEM_PG_PORT"
    DB_FOUND=true
    echo "Using local Postgres (system) at localhost:$SYSTEM_PG_PORT"
  fi
fi

if $DB_FOUND; then
  # Every blackbox/unit child creates its own Prisma pool. Bound each pool so
  # the prescribed parallel coverage workers cannot exceed Postgres's shared
  # max_connections ceiling before the test assertions even run.
  TEST_DB_CONNECTION_LIMIT="${BACKEND_TEST_DB_CONNECTION_LIMIT:-4}"
  if ! [[ "$TEST_DB_CONNECTION_LIMIT" =~ ^[1-9][0-9]*$ ]]; then
    echo "❌ BACKEND_TEST_DB_CONNECTION_LIMIT must be a positive integer." >&2
    exit 1
  fi
  LOCAL_PSQL_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria"
  # Docker Desktop can briefly stop accepting new TCP connections while the
  # parallel coverage lanes saturate the shared host. Prisma's five-second
  # default connect timeout made every first query fail even when Postgres
  # recovered immediately after, so keep the gate bounded but give the local
  # database the same contention-safe startup window.
  LOCAL_DB_URL="$LOCAL_PSQL_URL?connection_limit=$TEST_DB_CONNECTION_LIMIT&pool_timeout=30&connect_timeout=15"
  export DATABASE_URL="$LOCAL_DB_URL"
  export DIRECT_URL="$LOCAL_DB_URL"
  if command -v psql >/dev/null 2>&1; then
    psql "$LOCAL_PSQL_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
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
  DATABASE_URL="$LOCAL_PSQL_URL" DIRECT_URL="$LOCAL_PSQL_URL" \
    bash "$SCRIPT_DIR/apply-local-runtime-sql-hooks.sh" >/dev/null
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
      SEEDED_CODEX_COUNT="$(psql "$LOCAL_PSQL_URL" -At -v ON_ERROR_STOP=1 -c \
        "SELECT count(*) FROM \"Integration\" WHERE name='gpt_code' AND status='CONNECTED' AND \"isActive\"=true AND coalesce(config->>'encryptedCredentials','') <> '';" 2>/dev/null || printf 0)"
      if [[ "$SEEDED_CODEX_COUNT" =~ ^[1-9][0-9]*$ ]]; then
        echo "Using the connected gpt_code credential already seeded in the isolated test database."
      elif codex_funded_fallback_configured; then
        # No seeded gpt_code OAuth credential, but the Codex Code session also
        # authenticates via the funded OpenAI key (GPT_API_KEY / OPENAI_API_KEY)
        # fallback that resolveCodexCodeAuthEnvs injects when no OAuth credential
        # is present (see src/providers/e2b.ts). With that funded key configured,
        # the codex-code E2B smoke still runs end-to-end — and emits the
        # deploy-approved out-of-funds SKIP if the key is exhausted — so a missing
        # seeded credential must NOT hard-fail the whole coverage run. Only fail
        # when NO credential path exists at all (handled by the else below).
        echo "No seeded gpt_code credential; a funded OpenAI key (GPT_API_KEY/OPENAI_API_KEY) fallback is configured, so the Codex smoke will run via that fallback (and SKIP if it is out of credits/quota)."
      else
        echo "❌ Codex auth is not ChatGPT mode, the isolated test database has no connected gpt_code credential, and no funded OpenAI key (GPT_API_KEY/OPENAI_API_KEY) fallback is configured." >&2
        echo "   Run codex login, seed the integration, configure a funded key, or set BACKEND_CODEX_TOKEN_SYNC_SKIP=1 only when the caller already seeded it." >&2
        exit 1
      fi
    fi
  fi
fi

# Fast Mode cache still requires an explicit URL outside production, but a local
# coverage run must not write fixtures into (or depend on capacity from) the
# shared production cache database. The local schema includes FastModeCacheEntry,
# so point the instrumented backend at the same isolated database used by every
# other blackbox domain. scripts/run.sh retains the shared-cache behavior for
# real local agent stacks; this override is coverage-only.
export FAST_MODE_CACHE_DATABASE_URL="$LOCAL_DB_URL"

echo "Starting backend with coverage collection on port $COV_PORT..."
launch_coverage_process_group env \
  NODE_V8_COVERAGE="$COV_TMP" PORT="$COV_PORT" DISABLE_GMAIL_SYNC=1 \
  node --import tsx src/bootstrap.ts >"$COV_LOG" 2>&1
BACKEND_PID="$LAUNCHED_COVERAGE_PID"
BLACKBOX_PID=""
UNIT_PID=""

cleanup() {
  local child_pid
  for child_pid in "$UNIT_PID" "$BLACKBOX_PID" "$BACKEND_PID"; do
    [[ -n "$child_pid" ]] || continue
    kill -TERM -- "-$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" 2>/dev/null || true
  done
  # Every registered group is now explicitly reaped. Disarm the guardian before
  # releasing it so a long successful run cannot act on a recycled historical
  # PGID during normal cleanup.
  printf 'disarmed\n' >"$COVERAGE_PROCESS_GROUPS_FILE"
  # These raw blobs are inputs to the report, not durable test evidence.
  rm -rf "$COV_TMP"
  release_coverage_reservations
}
trap cleanup EXIT
trap 'exit 130' INT TERM

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
echo "Running blackbox and unit tests in parallel..."
TEST_EXIT=0
UNIT_EXIT=0
launch_coverage_process_group env \
  NODE_V8_COVERAGE="$COV_TMP" \
  BLACKBOX_TEST_USE_EXISTING_BACKEND=1 CONTRACT_TEST_USE_EXISTING_BACKEND=1 \
  BLACKBOX_TEST_DATABASE_URL="$LOCAL_DB_URL" CONTRACT_TEST_DATABASE_URL="$LOCAL_DB_URL" \
  BLACKBOX_TEST_SKIP_DB_SYNC=1 CONTRACT_TEST_SKIP_DB_SYNC=1 \
  BACKEND_CODEX_TOKEN_SYNC_SKIP=1 \
  BLACKBOX_TEST_CONCURRENCY="${BLACKBOX_TEST_CONCURRENCY:-4}" CONTRACT_TEST_CONCURRENCY="${CONTRACT_TEST_CONCURRENCY:-4}" \
  BLACKBOX_TEST_CASE_CONCURRENCY="${BLACKBOX_TEST_CASE_CONCURRENCY:-30}" CONTRACT_TEST_CASE_CONCURRENCY="${CONTRACT_TEST_CASE_CONCURRENCY:-30}" \
  bash scripts/run-blackbox-tests.sh
BLACKBOX_PID="$LAUNCHED_COVERAGE_PID"

launch_coverage_process_group env \
  BACKEND_UNIT_COVERAGE_DIR="$COV_TMP" \
  BACKEND_UNIT_CONCURRENCY="${BACKEND_UNIT_CONCURRENCY:-6}" \
  node --import tsx scripts/run-unit-tests.ts
UNIT_PID="$LAUNCHED_COVERAGE_PID"

wait "$BLACKBOX_PID" || TEST_EXIT=$?
BLACKBOX_PID=""
wait "$UNIT_PID" || UNIT_EXIT=$?
UNIT_PID=""

if [[ "$TEST_EXIT" -ne 0 || "$UNIT_EXIT" -ne 0 ]]; then
  echo "Backend test phase failed; skipping report work until the failing lifecycle is fixed."
  if [[ "$TEST_EXIT" -ne 0 ]]; then
    exit "$TEST_EXIT"
  fi
  exit "$UNIT_EXIT"
fi

# Stop the server so NODE_V8_COVERAGE flushes data
echo "Stopping backend and collecting coverage data..."
kill "$BACKEND_PID" 2>/dev/null || true
wait "$BACKEND_PID" 2>/dev/null || true
BACKEND_PID=""

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
