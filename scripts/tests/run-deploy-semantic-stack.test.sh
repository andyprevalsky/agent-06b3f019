#!/usr/bin/env bash
# Regression for scripts/run-deploy-semantic-stack.sh, the versioned Group 4
# semantic lane (deploy.md Steps 5, 6b, 6c; `run_deploy_pipeline.py plan
# --semantic-stack` / `--e2b-smoke`, follow-up 12, 2026-10-31). The script
# must parse, refuse to run without its required environment before any side
# effect (no sweep, no stack, no stage record), honour its three modes, carry
# the deploy.md semantic/E2B invariants verbatim and keep no launcher paths.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/run-deploy-semantic-stack.sh"
PIPELINE="$ROOT_DIR/scripts/run_deploy_pipeline.py"
GATES="$ROOT_DIR/scripts/run-deploy-structural-gates.py"
DEPLOY_MD="$ROOT_DIR/.claude/commands/deploy.md"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

require_text() {
    grep -Fq -- "$2" "$1" || fail "$3"
}

forbid_text() {
    if grep -Fq -- "$2" "$1"; then
        fail "$3"
    fi
}

[ -f "$SCRIPT" ] || fail "missing $SCRIPT"
[ -x "$SCRIPT" ] || fail "run-deploy-semantic-stack.sh must be executable"
bash -n "$SCRIPT" || fail "run-deploy-semantic-stack.sh must parse"
command -v pg_isready >/dev/null 2>&1 || fail "pg_isready is required (PostgreSQL client tools); the lane refuses without it"
command -v jq >/dev/null 2>&1 || fail "jq is required by scripts/resolve-deploy-stack-db.sh"

# ── Static invariants shared with deploy.md and the pipeline ──────────────────
require_text "$SCRIPT" 'SEMANTIC_GREP_INVERT="chat full-lifecycle latency" SEMANTIC_WORKERS=4' "UI semantics: four workers, latency ratchet excluded"
require_text "$SCRIPT" 'SEMANTIC_WORKERS=1 LOCAL_DB_PORT=$DBP BACKEND_PORT=$CP FRONTEND_PORT=$((CP + 1))' "latency ratchet: one worker on the live stack ports"
require_text "$SCRIPT" 'bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh' "UI semantics keep their own stage record"
require_text "$SCRIPT" 'bash scripts/run-deploy-stage semantic-latency -- bash front-end/scripts/run-semantic-tests.sh chat-lifecycle-latency' "latency ratchet keeps its own stage record"
require_text "$SCRIPT" 'bash ../scripts/run-deploy-stage claude-code-e2b-smoke -- bash scripts/run-blackbox-tests.sh claude-code' "E2B smoke keeps its Step 6c stage record"
require_text "$SCRIPT" 'BLACKBOX_SMOKE=1' "E2B smoke must run the real sandbox cases"
require_text "$SCRIPT" 'db_name="victoria_$CONDUCTOR_WORKSPACE_NAME"' "E2B smoke must name the isolated workspace test database"
require_text "$SCRIPT" 'BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES=8 TRACE_ARCHIVE_ENABLED=0' "stack launch must keep the deploy.md Step 5 environment"
require_text "$SCRIPT" 'bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1 &' "stack must be the Step 5 run.sh --benchmark launch"
require_text "$SCRIPT" 'configure_deploy_local_env || exit 2' "the deploy environment library must gate every mode"
require_text "$SCRIPT" 'bash scripts/resolve-deploy-stack-db.sh' "E2B smoke must prefer the running stack's database port"
forbid_text "$SCRIPT" 'BLACKBOX_TEST_REPLAY_OUTBOUND=1' "the semantic stack stays capture-only"
forbid_text "$SCRIPT" 'BLACKBOX_TEST_USE_EXISTING_BACKEND=1' "the E2B smoke must own its backend"
forbid_text "$SCRIPT" '/var/tmp' "no launcher-private paths"
require_text "$PIPELINE" 'SEMANTIC_STACK_SCRIPT = "scripts/run-deploy-semantic-stack.sh"' "the plan must emit this script"
require_text "$PIPELINE" '"--e2b-smoke-only"' "the plan's e2b-smoke lane must use the standalone mode"
require_text "$GATES" 'scripts/tests/run-deploy-semantic-stack.test.sh' "this suite must be a registered deploy gate"
require_text "$DEPLOY_MD" 'bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only' "deploy.md Step 6c must name the standalone E2B mode"
require_text "$DEPLOY_MD" 'plan --live-probes --semantic-stack' "deploy.md must document the plan flags"

# ── Behaviour in an isolated fixture checkout ────────────────────────────────
# Copies keep the real worktree's .context/services.json and kill-services.sh
# out of the picture; a fake sweep records whether it was ever invoked.
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
FIXTURE_PHYS="$(cd "$FIXTURE" && pwd -P)"
mkdir -p "$FIXTURE/scripts/lib" "$FIXTURE/back-end" "$FIXTURE/.context"
cp "$SCRIPT" "$FIXTURE/scripts/"
cp "$ROOT_DIR/scripts/lib/workspace-env.sh" "$ROOT_DIR/scripts/lib/deploy-local-env.sh" "$FIXTURE/scripts/lib/"
cp "$ROOT_DIR/scripts/resolve-deploy-stack-db.sh" "$FIXTURE/scripts/"
SWEEP_MARKER="$FIXTURE/.context/sweep-invoked"
printf '#!/usr/bin/env bash\ntouch "%s"\n' "$SWEEP_MARKER" > "$FIXTURE/scripts/kill-services.sh"
chmod +x "$FIXTURE/scripts/kill-services.sh"

# A Conductor base port whose database port (base + 5) has no listener.
closed_base=""
for candidate in 1 2 3 4; do
    if ! pg_isready -h localhost -p "$((candidate + 5))" -U postgres -q 2>/dev/null; then
        closed_base="$candidate"
        break
    fi
done
[ -n "$closed_base" ] || fail "could not find a closed Postgres port among 6-9"

run_lane() {
    # Scrub the caller's deploy identity so each case controls its own.
    (cd "$FIXTURE" && env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME -u ROSE_USE_SYSTEM_PG -u DEPLOY_E2B_DB_PORT \
        -u CONDUCTOR_WORKSPACE_PATH -u ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME "$@")
}

expect_exit() {
    local expected="$1"
    shift
    set +e
    OUTPUT="$(run_lane "$@" 2>&1)"
    STATUS=$?
    set -e
    [ "$STATUS" = "$expected" ] || fail "expected exit $expected, got $STATUS for: $* -- output: $OUTPUT"
}

expect_output() {
    grep -Fq -- "$1" <<<"$OUTPUT" || fail "$2 -- output: $OUTPUT"
}

# 1. No CONDUCTOR_PORT: refused by the deploy environment library, exit 2.
expect_exit 2 bash scripts/run-deploy-semantic-stack.sh
expect_output "CONDUCTOR_PORT must be set" "missing CONDUCTOR_PORT must be named"
[ ! -e "$SWEEP_MARKER" ] || fail "no sweep may run without CONDUCTOR_PORT"
expect_exit 2 bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only
expect_output "CONDUCTOR_PORT must be set" "E2B-only mode must also require CONDUCTOR_PORT"

# 2. Usage errors exit 2 with the usage text; --help exits 0.
expect_exit 2 bash scripts/run-deploy-semantic-stack.sh --bogus
expect_output "Unknown option: --bogus" "unknown flags are refused"
expect_output "--e2b-smoke-only" "usage lists the standalone mode"
expect_exit 2 bash scripts/run-deploy-semantic-stack.sh --with-e2b-smoke --e2b-smoke-only
expect_output "Too many arguments" "the modes are exclusive"
expect_exit 0 bash scripts/run-deploy-semantic-stack.sh --help
expect_output "--with-e2b-smoke" "help lists the combined mode"

# 3. Stack mode with no database on LOCAL_DB_PORT: exit 2 before the Step 5.0
#    sweep, the stack launch or any stage record.
expect_exit 2 env CONDUCTOR_PORT="$closed_base" bash scripts/run-deploy-semantic-stack.sh
expect_output "Semantic stack: Postgres is not ready on localhost:$((closed_base + 5))" "stack mode must name the missing database port"
[ ! -e "$SWEEP_MARKER" ] || fail "the stack mode must check Postgres before sweeping the worktree"
[ ! -e "$FIXTURE/.context/deploy-smoke.log" ] || fail "no stack may start without a database"

# 4. E2B-only mode resolves its database port: LOCAL_DB_PORT by default, the
#    running stack's manifest when one exists for this checkout, and
#    DEPLOY_E2B_DB_PORT over both; each refusal names the port and exits 2.
expect_exit 2 env CONDUCTOR_PORT="$closed_base" bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only
expect_output "E2B smoke: Postgres is not ready on localhost:$((closed_base + 5))" "E2B-only mode defaults to LOCAL_DB_PORT"
expect_output "SEMANTIC_GROUP_RESULTS ui=skipped latency=skipped e2b=2" "E2B-only mode reports only the E2B step"
expect_exit 2 env CONDUCTOR_PORT="$closed_base" DEPLOY_E2B_DB_PORT=65535 bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only
expect_output "E2B smoke: Postgres is not ready on localhost:65535" "DEPLOY_E2B_DB_PORT must win"
expect_exit 2 env CONDUCTOR_PORT="$closed_base" DEPLOY_E2B_DB_PORT=abc bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only
expect_output "E2B smoke: invalid Postgres port 'abc'" "a non-numeric port is refused"
cat > "$FIXTURE/.context/services.json" <<JSON
{"status": "running", "worktree": "$FIXTURE_PHYS", "ports": {"backend": 55170}, "database": {"runtime_port": 65534}}
JSON
expect_exit 2 env CONDUCTOR_PORT="$closed_base" bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only
expect_output "E2B smoke: Postgres is not ready on localhost:65534" "a running stack manifest supplies the database port"
[ ! -e "$SWEEP_MARKER" ] || fail "E2B-only mode must never sweep the worktree"

echo "run-deploy-semantic-stack: all checks passed"
