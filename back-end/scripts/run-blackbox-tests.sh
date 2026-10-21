#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/blackbox-phone-env.sh"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

# Returns 0 when a funded OpenAI key (GPT_API_KEY / OPENAI_API_KEY) fallback is
# available to the test backend — either already exported into this shell or
# present and non-empty in back-end/.env (which the backend loads via dotenv at
# startup). resolveCodexCodeAuthEnvs uses this key to authenticate the Codex Code
# E2B session when no gpt_code OAuth credential is seeded, so its presence means
# the codex-code smoke can still run (and self-SKIP when the key is exhausted).
# Mirrors the identical preflight in scripts/run-coverage.sh so any blackbox
# entrypoint — including the credential-independent admin-health/Amplitude probe
# that seeds through this script — is not blocked by a Codex funding state.
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

# Match run.sh's resource naming even when Conductor exposes a stale branch-
# based workspace name. Without normalization, tests can miss the worktree's
# Docker database and silently fall back to a shared system Postgres instance.
cd "$ROOT_DIR"
source scripts/lib/workspace-env.sh
source scripts/lib/run-process-cleanup.sh
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
# Cursor Cloud injects TRACE_ARCHIVE_BACKEND=r2 from prod secrets. Force a
# local backend so archive fixtures the test process writes are the same
# files the isolated backend greps. `${VAR:-local}` cannot override an
# already-set r2 value.
case "${TRACE_ARCHIVE_BACKEND:-}" in
  local|fake-r2) ;;
  *)
    echo "⚠️  TRACE_ARCHIVE_BACKEND='${TRACE_ARCHIVE_BACKEND:-}' is not a local blackbox backend; forcing local."
    export TRACE_ARCHIVE_BACKEND=local
    ;;
esac
export TRACE_ARCHIVE_LOCAL_DIR="${TRACE_ARCHIVE_LOCAL_DIR:-$ROOT_DIR/.context}"

# rose_user_ui versions are stored hermetically on local disk for tests (the
# user-ui blackbox reads back published bytes); prod uses Supabase Storage.
export USER_UI_STORAGE_BACKEND=local
export USER_UI_STORAGE_LOCAL_DIR="${USER_UI_STORAGE_LOCAL_DIR:-$ARTIFACT_DIR/user-ui-storage}"
# display-tool media (domains/display) uses the same hermetic local store.
export DISPLAY_STORAGE_BACKEND=local
export DISPLAY_STORAGE_LOCAL_DIR="${DISPLAY_STORAGE_LOCAL_DIR:-$ARTIFACT_DIR/display-storage}"
# User-tool handlers (POST /api/user-ui/tools/run) run in a local code-session
# HOME instead of E2B; the backend refuses this mode in production.
export USER_TOOLS_SESSION_SANDBOX=local
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
if [[ "$USE_EXISTING_BACKEND" != "1" ]]; then
  # This script owns both processes, so the share-link contract can use a
  # local-only key without depending on a production benchmark secret.
  export BENCHMARK_SHARE_SECRET="${BENCHMARK_SHARE_SECRET:-blackbox-local-benchmark-share-secret}"
fi

# --list only needs filesystem discovery; skip backend boot for speed.
for arg in "$@"; do
  if [[ "$arg" == "--list" ]]; then
    "${RUNNER_CMD[@]}" "$@"
    exit $?
  fi
done

# A standalone blackbox run starts its own backend. Keep the benchmark-share
# bearer-link fixture self-contained when no share key was exported.
if [[ "$USE_EXISTING_BACKEND" != "1" && -z "${BENCHMARK_SHARE_SECRET:-}" ]]; then
  export BENCHMARK_SHARE_SECRET="$(openssl rand -hex 32)"
fi

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
ENSURE_SYSTEM_DB_NAME=""
ISOLATED_DB_RESOLVED=false

# Managed callers (for example, run-coverage.sh) may know the exact isolated
# database to use. Prefer that explicit contract over local discovery.
EXPLICIT_TEST_DB_URL="${BLACKBOX_TEST_DATABASE_URL:-${CONTRACT_TEST_DATABASE_URL:-}}"
if [[ -n "$EXPLICIT_TEST_DB_URL" ]]; then
  STACK_DB_EXPECTED=true
  if [[ ! "$EXPLICIT_TEST_DB_URL" =~ ^postgres(ql)?://([^/]*@)?(localhost|127\.0\.0\.1)(:[0-9]+)?/ ]]; then
    echo "❌ BLACKBOX_TEST_DATABASE_URL must point at localhost for fixture safety."
    exit 1
  fi
  if [[ "$USE_EXISTING_BACKEND" != "1" ]] && ! node -e '
    const url = new URL(process.env.BLACKBOX_TEST_DATABASE_URL || process.env.CONTRACT_TEST_DATABASE_URL);
    const expectedName = `victoria_${process.argv[1]}`;
    if (decodeURIComponent(url.pathname.slice(1)) !== expectedName || url.search !== "" || url.hash !== "") process.exit(1);
  ' "$WORKSPACE_HINT"; then
    echo "❌ Standalone blackbox DATABASE_URL must name the local victoria_$WORKSPACE_HINT database." >&2
    exit 1
  fi
  # Prisma accepts connection-pool tuning in the URL query string, but libpq
  # rejects those Prisma-only parameters. Probe the same local database with
  # the plain URL while preserving the bounded URL for Prisma test children.
  EXPLICIT_TEST_PSQL_URL="${EXPLICIT_TEST_DB_URL%%\?*}"
  if psql "$EXPLICIT_TEST_PSQL_URL" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
    DB_FOUND=true
    SELECTED_DB_URL="$EXPLICIT_TEST_DB_URL"
    echo "Using explicitly provided isolated test database"
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

# Fall back to system Postgres. Prefer the Conductor-derived local DB port
# (CONDUCTOR_PORT+5) so cloud/native Postgres installs that follow run.sh's
# port layout are found before the generic 5432 default.
if ! $STACK_DB_EXPECTED && ! $DB_FOUND; then
  SYSTEM_PG_CANDIDATES=()
  if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
    SYSTEM_PG_CANDIDATES+=("$((CONDUCTOR_PORT + 5))")
  fi
  SYSTEM_PG_CANDIDATES+=(5432)
  for SYSTEM_PG_PORT in "${SYSTEM_PG_CANDIDATES[@]}"; do
    if pg_isready -h localhost -p "$SYSTEM_PG_PORT" -U postgres -q 2>/dev/null; then
      # Never the shared `victoria`: this workspace's own database only.
      if ! SYSTEM_DB_NAME="$(workspace_system_db_name "$WORKSPACE_HINT")"; then
        echo "❌ Workspace name '$WORKSPACE_HINT' cannot name a test database (letters, digits, - and _ only)." >&2
        exit 1
      fi
      # Created after the Prisma freshness check: stale deps touch no DB.
      ENSURE_SYSTEM_DB_NAME="$SYSTEM_DB_NAME"
      LOCAL_DB_PORT="$SYSTEM_PG_PORT"
      SELECTED_DB_URL="postgresql://postgres:postgres@localhost:$SYSTEM_PG_PORT/$SYSTEM_DB_NAME"
      DB_FOUND=true
      echo "Using local Postgres (system) at localhost:$SYSTEM_PG_PORT, database $SYSTEM_DB_NAME"
      break
    fi
  done
fi

if $STACK_DB_EXPECTED && ! $DB_FOUND; then
  echo "❌ The explicitly selected local test database is unavailable."
  echo "   Refusing to select a different local database because fixtures would be invisible to the backend."
  exit 1
fi

if $DB_FOUND; then
  LOCAL_DB_URL="${SELECTED_DB_URL:-postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria}"
  export DATABASE_URL="$LOCAL_DB_URL"
  export DIRECT_URL="$LOCAL_DB_URL"
  export FAST_MODE_CACHE_DATABASE_URL="${FAST_MODE_CACHE_DATABASE_URL:-$LOCAL_DB_URL}"
  SKIP_DB_SYNC="${BLACKBOX_TEST_SKIP_DB_SYNC:-${CONTRACT_TEST_SKIP_DB_SYNC:-0}}"
  if [[ "$SKIP_DB_SYNC" == "1" ]]; then
    if [[ "$USE_EXISTING_BACKEND" != "1" ]]; then
      echo "❌ BLACKBOX_TEST_SKIP_DB_SYNC is only valid with an existing backend." >&2
      exit 1
    fi
    echo "Skipping local DB schema sync; existing backend caller prepared the test database."
  else
    node "$SCRIPT_DIR/assert-prisma-client-current.mjs"
    if [[ -n "${ENSURE_SYSTEM_DB_NAME:-}" ]] &&
      ! ensure_workspace_system_db "$LOCAL_DB_PORT" "$ENSURE_SYSTEM_DB_NAME"; then
      echo "❌ Could not create the test database $ENSURE_SYSTEM_DB_NAME on localhost:$LOCAL_DB_PORT." >&2
      exit 1
    fi
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
  -- On system Postgres this database is shared with the local stack, whose
  -- real provider quota failures persist process-global funded-key cooldowns.
  -- Tests that exercise the funded routes assume no backoff is active.
  IF to_regclass('"Integration"') IS NOT NULL THEN
    DELETE FROM "Integration"
    WHERE "userId" = '00000000-0000-0000-0000-000000000000'
      AND name IN ('gpt_api_key_cooldown', 'anthropic_api_key_cooldown');
  END IF;
END $$;
SQL
    fi
    echo "Syncing Prisma schema to local test database..."
    bash "$SCRIPT_DIR/normalize-local-user-phones.sh" "$LOCAL_DB_URL" >/dev/null
    npx prisma db push --skip-generate --accept-data-loss >/dev/null
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
        SEEDED_CODEX_COUNT="$(psql "$LOCAL_DB_URL" -At -v ON_ERROR_STOP=1 -c \
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
          # seeded credential must NOT hard-fail the seed for every blackbox domain
          # (e.g. the credential-independent admin-health/Amplitude probe). Only fail
          # when NO credential path exists at all (handled by the else below).
          echo "No seeded gpt_code credential; a funded OpenAI key (GPT_API_KEY/OPENAI_API_KEY) fallback is configured, so the Codex smoke will run via that fallback (and SKIP if it is out of credits/quota)."
        else
          echo "❌ Codex auth is not ChatGPT mode, the isolated test database has no connected gpt_code credential, and no funded OpenAI key (GPT_API_KEY/OPENAI_API_KEY) fallback is configured." >&2
          echo "   Run codex login, seed the integration, configure a funded key, or set BACKEND_CODEX_TOKEN_SYNC_SKIP=1 only when the caller already seeded it." >&2
          exit 1
        fi
      fi
    fi

    # Real-LLM blackbox users are freshly provisioned and own no compute
    # credential, so without a pooled token every claudeAuth path in the suite
    # silently degrades to the paid waterfall — a different model than
    # production runs, which makes model-behavior acceptances meaningless.
    # Seed the local Claude Code envelope the same way gpt_code is seeded, and
    # mark it poolable so provisioned test users can draw it. Best-effort: no
    # keychain (CI, Linux) leaves the previous waterfall behavior untouched.
    if [[ "${BACKEND_CLAUDE_TOKEN_SYNC_SKIP:-0}" != "1" ]] &&
      security find-generic-password -s "Claude Code-credentials" -w >/dev/null 2>&1; then
      echo "Syncing local Claude Code credentials to local test database..."
      # The seeder owns the pooling flag: its upsert is scoped to the single
      # {userId, claude_code} row, so no follow-up SQL is needed here. Shelling
      # out to psql would also have put the DB password in the process table.
      if DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        npx tsx scripts/seed-claude-code-token-from-keychain.ts >/dev/null 2>&1; then
        :
      else
        echo "   Claude Code credential sync failed; claudeAuth paths will use the waterfall."
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
BACKEND_PID=""

# npm/tsx can leave the server below a launcher process. Snapshot and drain
# the owned descendants before terminating that launcher, then join its PID.
source "$ROOT_DIR/scripts/lib/cloudbench-env.sh"
source "$ROOT_DIR/scripts/lib/port-probe.sh"
cleanup() {
  local result=$? cleaned=1
  trap - EXIT INT TERM
  if [[ -n "$BACKEND_PID" ]]; then
    if cloudbench_terminate_tree_and_wait 5 "$BACKEND_PID"; then
      wait "$BACKEND_PID" 2>/dev/null || true
    else
      echo "❌ Could not verify isolated backend process-tree cleanup" >&2
      result=1
      cleaned=0
    fi
  fi

  if [[ "$cleaned" == 1 && -n "$PORT_LOCK_DIR" && -d "$PORT_LOCK_DIR" ]]; then
    rmdir "$PORT_LOCK_DIR" >/dev/null 2>&1 || true
  fi
  exit "$result"
}
# Bash resumes the script after a signal trap returns, so INT/TERM must exit
# (and let the EXIT trap clean up) rather than release the lock and keep going.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Sets PORT and PORT_LOCK_DIR in the caller's shell; running it in a command
# substitution would drop PORT_LOCK_DIR and leave the lock behind forever.
reserve_port() {
  local candidate="$1"

  while true; do
    local lock_dir="$PORT_LOCK_ROOT/$candidate"
    if mkdir "$lock_dir" 2>/dev/null; then
      if local_port_in_use "$candidate"; then
        rmdir "$lock_dir" >/dev/null 2>&1 || true
      else
        PORT_LOCK_DIR="$lock_dir"
        PORT="$candidate"
        return 0
      fi
    fi
    candidate=$((candidate + 1))
  done
}

if [[ -z "${BLACKBOX_TEST_BACKEND_PORT:-${CONTRACT_TEST_BACKEND_PORT:-}}" ]]; then
  reserve_port "$START_PORT"
else
  if ! mkdir "$PORT_LOCK_ROOT/$PORT" 2>/dev/null; then
    echo "❌ Failed to reserve requested black-box test port $PORT"
    exit 1
  fi
  PORT_LOCK_DIR="$PORT_LOCK_ROOT/$PORT"
fi

export TEST_BASE_URL="http://localhost:$PORT"
BACKEND_LOG="${BLACKBOX_TEST_BACKEND_LOG:-${CONTRACT_TEST_BACKEND_LOG:-$ARTIFACT_DIR/backend.log}}"

# Deterministic SMS smoke fixtures for the isolated backend. These are only
# consumed when BLACKBOX_TEST_CAPTURE_OUTBOUND=1, so production/development
# behavior is unchanged.
export SURGE_API_KEY="${SURGE_API_KEY:-blackbox-surge-key}"
export SURGE_ACCOUNT_ID="${SURGE_ACCOUNT_ID:-blackbox-surge-account}"
export BLACKBOX_TEST_FAKE_SURGE="${BLACKBOX_TEST_FAKE_SURGE:-1}"
export BLACKBOX_TEST_FAKE_WHATSAPP="${BLACKBOX_TEST_FAKE_WHATSAPP:-1}"
export BLACKBOX_TEST_FAKE_TWILIO="${BLACKBOX_TEST_FAKE_TWILIO:-1}"
export BLACKBOX_TEST_FAKE_TEMPORAL="${BLACKBOX_TEST_FAKE_TEMPORAL:-1}"
export BLACKBOX_TEST_CAPTURE_OUTBOUND=1
export BLACKBOX_TEST_REPLAY_OUTBOUND=1
# OAuth start tests only inspect the generated consent URL. Keep their client
# separate from the verified production client, which local development rejects.
export GOOGLE_CLIENT_ID="${BLACKBOX_GOOGLE_CLIENT_ID:-rose-local-blackbox.apps.googleusercontent.com}"
source "$SCRIPT_DIR/blackbox-auto-rca-env.sh"
# The isolated backend must not inherit a developer's workspace tunnel. E2B
# cannot reach localhost, and stale ngrok URLs turn the direct Codex smoke into
# a test of unrelated local Fast Mode infrastructure. Explicit BLACKBOX_*
# overrides remain available for proxy-specific blackbox runs.
export FAST_MODE_ANTHROPIC_PROXY_URL="${BLACKBOX_FAST_MODE_ANTHROPIC_PROXY_URL:-}"
export FAST_MODE_CODEX_PROXY_URL="${BLACKBOX_FAST_MODE_CODEX_PROXY_URL:-}"

launch_backend() {
  cat >"$MANIFEST_PATH" <<EOF
{"run_id":"$RUN_ID","mode":"isolated-blackbox-backend","base_url":"$TEST_BASE_URL","port":$PORT,"artifact_dir":"$ARTIFACT_DIR","backend_log":"$BACKEND_LOG","runner_log":"$RUNNER_LOG","disable_gmail_sync":true}
EOF

  echo "Starting isolated backend for black-box tests on port $PORT"
  echo "Backend log: $BACKEND_LOG"
  echo "Artifacts: $ARTIFACT_DIR"

  # Defer cancellation only across the background-child ownership handoff.
  BACKEND_PENDING_SIGNAL=0
  trap 'BACKEND_PENDING_SIGNAL=130' INT
  trap 'BACKEND_PENDING_SIGNAL=143' TERM

  PORT="$PORT" \
  DISABLE_GMAIL_SYNC=1 \
  npx tsx src/bootstrap.ts >"$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ "$BACKEND_PENDING_SIGNAL" != 0 ]]; then
    exit "$BACKEND_PENDING_SIGNAL"
  fi
}
launch_backend


READY=0
BIND_RETRIES=0
for _ in $(seq 1 120); do
  # Port locks are per worktree, so another worktree's isolated backend can
  # take the same port between the free-port probe and our bind. /health alone
  # would then pass against THAT backend and every test would run against the
  # wrong code. Ready means our own process logged that it serves this port.
  if curl -fsS -m 2 "$TEST_BASE_URL/health" >/dev/null 2>&1 &&
    grep -Eq "Server started.*port[\"=:]+ ?${PORT}([^0-9]|$)" "$BACKEND_LOG" 2>/dev/null; then
    READY=1
    break
  fi

  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    # Another worktree's runner took this port between our free-port probe and
    # the bind. Without an explicitly requested port, move to the next free one.
    if [[ -z "${BLACKBOX_TEST_BACKEND_PORT:-${CONTRACT_TEST_BACKEND_PORT:-}}" ]] &&
      [[ "$BIND_RETRIES" -lt 5 ]] && grep -q "EADDRINUSE" "$BACKEND_LOG" 2>/dev/null; then
      BIND_RETRIES=$((BIND_RETRIES + 1))
      echo "⚠️  Port $PORT was taken before the isolated backend bound it; retrying on the next free port"
      wait "$BACKEND_PID" >/dev/null 2>&1 || true
      BACKEND_PID=""
      rmdir "$PORT_LOCK_DIR" >/dev/null 2>&1 || true
      PORT_LOCK_DIR=""
      reserve_port "$((PORT + 1))"
      export TEST_BASE_URL="http://localhost:$PORT"
      launch_backend
      continue
    fi
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
