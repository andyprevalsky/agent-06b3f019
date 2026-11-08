#!/usr/bin/env bash
# /deploy semantic lane as one versioned command (the local stack, the semantic
# suite and the E2B smoke; `run_deploy_pipeline.py plan --semantic-stack` / `--e2b-smoke`).
#
# Default mode starts this worktree's local stack through `run.sh --benchmark`
# on the deploy stack database, runs the Playwright UI semantics (four workers,
# latency ratchet excluded) and the chat-lifecycle latency ratchet (one worker)
# through run-deploy-stage, then tears the stack down. The Step 6c Claude Code
# E2B smoke is a separate step: `--e2b-smoke-only` runs it alone through the
# standalone blackbox runner against the workspace Postgres (the `e2b-smoke`
# pipeline lane: no stack, no sweep); `--with-e2b-smoke` appends it to the
# stack lane, the 2026-10-30/31 launcher behaviour. Each step keeps its own
# stage record (semantic, semantic-latency, claude-code-e2b-smoke).
#
# Usage:
#   bash scripts/run-deploy-semantic-stack.sh                   # stack + UI semantics + latency ratchet
#   bash scripts/run-deploy-semantic-stack.sh --with-e2b-smoke  # ... then the E2B smoke on the same Postgres
#   bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only  # E2B smoke alone (no stack)
#
# Environment:
#   CONDUCTOR_PORT            required; run.sh fans backend/frontend/health out from it
#   CONDUCTOR_WORKSPACE_NAME  normalized by scripts/lib/workspace-env.sh (.cloud-env or
#                             .context/deploy-worktree.env); defaults to the checkout basename
#   ROSE_USE_SYSTEM_PG=true   system Postgres on localhost:5432 instead of the Docker
#                             container on CONDUCTOR_PORT+5 (scripts/lib/deploy-local-env.sh)
#   DEPLOY_E2B_DB_PORT        explicit Postgres port for the E2B smoke database; default is
#                             the running stack's manifest port, else LOCAL_DB_PORT
#   DEPLOY_SEMANTIC_WORKER_PROCESSES
#                             agent worker processes for the stack's run.sh (WORKER_PROCESSES);
#                             default 8, the stack's standard value. Lower it only to fit a
#                             memory-bounded host; the specs and their assertions are unchanged
#
# The E2B smoke prints its own verdict line, E2B_SMOKE_VERDICT PASS|SKIPPED|FAIL
# (deploy.md 6c L2133-2148). PASS requires exit 0, the summary line
# `PASS  smoke -- Claude Code answers 2+2 (real E2B sandbox)` and a CLAUDE_E2B_DONE
# observed from a real sandbox. A credential or billing block only the user can fix
# is SKIPPED with its evidence (exit 1, never a pass); every other path is FAIL.
#
# Exit codes: 0 every step passed; 1 a step failed, was SKIPPED or the stack never
# became ready; 2 usage, environment or prerequisite error (nothing was started).
set -uo pipefail

usage() {
    echo "usage: bash scripts/run-deploy-semantic-stack.sh [--with-e2b-smoke | --e2b-smoke-only]"
    echo "  (no flag)         local stack + UI semantics + chat-lifecycle latency ratchet"
    echo "  --with-e2b-smoke  the same, then the Claude Code E2B smoke on the workspace Postgres"
    echo "  --e2b-smoke-only  only the Claude Code E2B smoke (standalone blackbox runner, no stack)"
}

MODE=stack
case "${1:-}" in
    "") ;;
    --with-e2b-smoke) MODE=stack-and-e2b ;;
    --e2b-smoke-only) MODE=e2b-only ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
    echo "Too many arguments: $*" >&2
    usage >&2
    exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR" || exit 2
# shellcheck source=scripts/lib/workspace-env.sh
. scripts/lib/workspace-env.sh
# shellcheck source=scripts/lib/deploy-local-env.sh
. scripts/lib/deploy-local-env.sh
# Refuses without CONDUCTOR_PORT; exports SMOKE_*_URL, LOCAL_DB_PORT, the
# strict run.sh port contract and a unique deploy Temporal queue.
# The fallback precedes the normalizer so the stack and the E2B smoke read one
# workspace identity; the normalizer still exports the .cloud-env name when the
# trust flag is unset.
export CONDUCTOR_WORKSPACE_NAME="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$ROOT_DIR")}"
configure_deploy_local_env || exit 2

require_command() {
    command -v "$1" >/dev/null 2>&1 && return 0
    echo "$1 is required but was not found on PATH (pg_isready, psql and createdb come from the PostgreSQL client tools)." >&2
    return 2
}

require_postgres() {
    local port="$1" what="$2"
    require_command pg_isready || return 2
    if ! pg_isready -h localhost -p "$port" -U postgres -q 2>/dev/null; then
        echo "$what: Postgres is not ready on localhost:$port (start the workspace database first: bash scripts/prepare-deploy-worktree.sh)." >&2
        return 2
    fi
}

# Step 6c: the standalone blackbox runner owns its own backend (never the
# capture-only Step 5 stack) and needs the separate victoria_<workspace>
# database on the workspace Postgres. The port comes from DEPLOY_E2B_DB_PORT,
# else the running stack's manifest (scripts/resolve-deploy-stack-db.sh), else
# the deploy environment's LOCAL_DB_PORT.
run_e2b_smoke() {
    local backend_port="$CONDUCTOR_PORT" db_port="${DEPLOY_E2B_DB_PORT:-}" stack_ports db_name db_url artifacts
    if [ -z "$db_port" ]; then
        if stack_ports=$(bash scripts/resolve-deploy-stack-db.sh 2>/dev/null); then
            read -r backend_port db_port <<< "$stack_ports"
        else
            db_port="$LOCAL_DB_PORT"
        fi
    fi
    if ! [[ "$db_port" =~ ^[0-9]+$ ]] || (( db_port < 1 || db_port > 65535 )); then
        echo "E2B smoke: invalid Postgres port '$db_port'." >&2
        return 2
    fi
    require_postgres "$db_port" "E2B smoke" || return 2
    require_command psql || return 2
    db_name="victoria_$CONDUCTOR_WORKSPACE_NAME"
    db_url="postgresql://postgres:postgres@localhost:$db_port/$db_name"
    if ! psql "$db_url" -At -c 'SELECT 1' >/dev/null 2>&1; then
        require_command createdb || return 2
        if ! PGPASSWORD=postgres createdb -h localhost -p "$db_port" -U postgres "$db_name"; then
            echo "E2B smoke: could not create $db_name on localhost:$db_port." >&2
            return 2
        fi
    fi
    artifacts="$ROOT_DIR/.context/deploy-e2b-smoke/$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mkdir -p "$artifacts" || return 2
    echo "E2B_SMOKE_START $(date -u +%FT%TZ) db=localhost:$db_port/$db_name artifacts=$artifacts"
    (
        cd back-end || exit 2
        CONDUCTOR_PORT="$backend_port" BLACKBOX_SMOKE=1 BLACKBOX_TEST_DATABASE_URL="$db_url" \
            BLACKBOX_TEST_ARTIFACT_DIR="$artifacts" \
            bash ../scripts/run-deploy-stage claude-code-e2b-smoke -- bash scripts/run-blackbox-tests.sh claude-code
    )
    e2b_smoke_verdict "$?" "$artifacts/claude-code.log"
}

# The gate's own result from the claude-code domain log the blackbox runner keeps.
e2b_smoke_verdict() {
    local status="$1" log="$2" name='smoke -- Claude Code answers 2+2 (real E2B sandbox)' skip kind
    if [ "$status" = 0 ] && [ -f "$log" ] && grep -Fq "  PASS  $name (" "$log" \
        && grep -Fq 'CLAUDE_E2B_DONE observed from real E2B sandbox' "$log" \
        && grep -Eq '^Results: [0-9]+ passed, 0 failed, 0 skipped, [0-9]+ total$' "$log" \
        && grep -Fxq 'ALL CLAUDE-CODE BLACK-BOX TESTS PASSED' "$log"; then
        echo "E2B_SMOKE_VERDICT PASS $(grep -F 'CLAUDE_E2B_DONE observed from real E2B sandbox' "$log" | head -1 | sed 's/^ *//') log=$log"
        return 0
    fi
    skip=$(grep -F "  SKIP  $name -- USER ACTION REQUIRED (" "$log" 2>/dev/null | head -1)
    kind=$(sed -nE 's/.* -- USER ACTION REQUIRED \((credential|billing)\): .*/\1/p' <<<"$skip")
    if [ "$status" = 1 ] && [ -n "$kind" ] \
        && [ "$(grep -c -- '^  SKIP  ' "$log")" = 1 ] && ! grep -q -- '^  FAIL  ' "$log" \
        && grep -Eq '^Results: [0-9]+ passed, 0 failed, 1 skipped, [0-9]+ total$' "$log" \
        && grep -Fxq 'CLAUDE-CODE SMOKE SKIPPED -- USER ACTION REQUIRED (NOT A PASS)' "$log"; then
        echo "E2B_SMOKE_VERDICT SKIPPED class=$kind (only the user can fix this $kind block; NOT A PASS)"
        echo "  evidence: ${skip#  SKIP  }"
        echo "  log: $log"
        return 1
    fi
    echo "E2B_SMOKE_VERDICT FAIL exit=$status (no PASS with an observed real-sandbox CLAUDE_E2B_DONE, and no user-action SKIP) log=$log"
    [ "$status" = 0 ] && return 1
    return "$status"
}

if [ "$MODE" = e2b-only ]; then
    run_e2b_smoke
    status=$?
    printf 'SEMANTIC_GROUP_RESULTS ui=skipped latency=skipped e2b=%s\n' "$status"
    exit "$status"
fi

# Prerequisites before any side effect: a valid worker count, and the stack
# database must already be up (the prepared worktree pre-starts it so run.sh never
# owns or stops it).
SEMANTIC_WORKER_PROCESSES="${DEPLOY_SEMANTIC_WORKER_PROCESSES:-8}"
if ! [[ "$SEMANTIC_WORKER_PROCESSES" =~ ^[1-9][0-9]{0,2}$ ]]; then
    echo "DEPLOY_SEMANTIC_WORKER_PROCESSES must be a positive integer (default 8), got '$SEMANTIC_WORKER_PROCESSES'." >&2
    exit 2
fi
require_postgres "$LOCAL_DB_PORT" "Semantic stack" || exit 2
require_command jq || exit 2
require_command curl || exit 2

echo "STACK_START $(date -u +%FT%TZ) epoch=$(date +%s)"
# Step 5.0 pre-flight garbage collection: stale run.sh trees from aborted runs
# in this worktree. Live isolated benchmark runs are spared by their owner
# records and BENCHMARK_RUN_ID (scripts/tests/kill-services.test.sh).
bash scripts/kill-services.sh || exit 2
stack_pid=''
ready=0
semantic_report_lane() {
    if [ -n "${DEPLOY_SEMANTIC_ARTIFACT_DIR:-}" ]; then
        export SEMANTIC_NATIVE_REPORT_PREFIX="$DEPLOY_SEMANTIC_ARTIFACT_DIR/$1"
    fi
}
cleanup() {
    if [ -n "$stack_pid" ] && kill -0 "$stack_pid" 2>/dev/null; then
        kill -TERM "$stack_pid" 2>/dev/null || true
        wait "$stack_pid" || true
    fi
    local cleanup_status=0
    bash scripts/kill-services.sh || cleanup_status=$?
    if [ -n "${DEPLOY_SEMANTIC_ARTIFACT_DIR:-}" ]; then
        jq -n --arg token "$DEPLOY_SEMANTIC_TOKEN" --argjson source "$DEPLOY_SEMANTIC_SOURCE" \
            --argjson ready "$ready" --argjson cleanup "$cleanup_status" \
            --argjson ui "${r1:-null}" --argjson latency "${r2:-null}" \
            '{token:$token,source:$source,ready:($ready==1),cleanup_complete:($cleanup==0),cleanup_exit:$cleanup,ui:$ui,latency:$latency}' \
            > "$DEPLOY_SEMANTIC_ARTIFACT_DIR/stack.json.tmp" && \
            mv "$DEPLOY_SEMANTIC_ARTIFACT_DIR/stack.json.tmp" "$DEPLOY_SEMANTIC_ARTIFACT_DIR/stack.json"
    fi
    echo "STACK_TEARDOWN_DONE $(date -u +%FT%TZ)"
}
trap cleanup EXIT
mkdir -p .context
# No semantic spec reaches the stack through a public origin, so the stack takes no tunnel.
# Every deploy's gate VM checks out to .../rose/rose and so derived the same reserved ngrok
# domain (rose-rose.ngrok.app): a second deploy, or any `rose` checkout running a stack, held
# it and this gate died before readiness (ERR_NGROK_334, 2026-11-07).
BENCHMARK_SKIP_PUBLIC_TUNNEL=1 BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES="$SEMANTIC_WORKER_PROCESSES" TRACE_ARCHIVE_ENABLED=0 \
    bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1 &
stack_pid=$!
printf 'STEP5_STACK_PID=%s\n' "$stack_pid"
printf 'STEP5_STACK_WORKER_PROCESSES=%s\n' "$SEMANTIC_WORKER_PROCESSES"
ready=0
for _ in $(seq 1 300); do
    if ! kill -0 "$stack_pid" 2>/dev/null; then
        echo "Step5 stack exited before readiness (see .context/deploy-smoke.log)" >&2
        exit 1
    fi
    if curl -sf --max-time 5 "$SMOKE_BASE_URL/health" >/dev/null && curl -sf --max-time 5 "$SMOKE_HEALTH_URL/health" >/dev/null \
        && curl -sf --max-time 5 "$SMOKE_FRONTEND_URL" >/dev/null \
        && [ "$(jq -r '.status' .context/services.json 2>/dev/null)" = running ]; then
        ready=1
        break
    fi
    sleep 2
done
if [ "$ready" != 1 ]; then
    echo "Step5 stack readiness failed after 600 s (see .context/deploy-smoke.log)" >&2
    exit 1
fi
echo "STACK_READY $(date -u +%FT%TZ) epoch=$(date +%s)"
CP=$(jq -er '.ports.backend' .context/services.json) || exit 2
DBP=$(jq -er '.database.runtime_port' .context/services.json) || exit 2
# Step 6b: UI specs on four workers with the latency ratchet excluded, then
# the ratchet alone on one worker (the chat-lifecycle-ratchet.yml split).
semantic_report_lane ui
SEMANTIC_GREP_INVERT="chat full-lifecycle latency" SEMANTIC_WORKERS=4 LOCAL_DB_PORT=$DBP BACKEND_PORT=$CP FRONTEND_PORT=$((CP + 1)) \
    bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh
r1=$?
semantic_report_lane latency
SEMANTIC_WORKERS=1 LOCAL_DB_PORT=$DBP BACKEND_PORT=$CP FRONTEND_PORT=$((CP + 1)) \
    bash scripts/run-deploy-stage semantic-latency -- bash front-end/scripts/run-semantic-tests.sh chat-lifecycle-latency
r2=$?
r3=skipped
if [ "$MODE" = stack-and-e2b ]; then
    run_e2b_smoke
    r3=$?
fi
printf 'SEMANTIC_GROUP_RESULTS ui=%s latency=%s e2b=%s\n' "$r1" "$r2" "$r3"
echo "STACK_LANE_END $(date -u +%FT%TZ) epoch=$(date +%s)"
[ "$r1" = 0 ] && [ "$r2" = 0 ] && { [ "$r3" = skipped ] || [ "$r3" = 0 ]; }
