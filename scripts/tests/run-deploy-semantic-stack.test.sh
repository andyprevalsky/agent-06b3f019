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
require_text "$SCRIPT" 'curl -sf --max-time 5 "$SMOKE_BASE_URL/health"' "readiness probes must bound each curl so a wedged port cannot hang the 600 s loop"
# The workspace-name fallback must be exported before the normalizer runs so the stack and the E2B smoke read one identity.
EXPORT_LINE=$(grep -n '^export CONDUCTOR_WORKSPACE_NAME=' "$SCRIPT" | head -1 | cut -d: -f1)
CONFIGURE_LINE=$(grep -n '^configure_deploy_local_env || exit 2' "$SCRIPT" | head -1 | cut -d: -f1)
[ -n "$EXPORT_LINE" ] && [ -n "$CONFIGURE_LINE" ] && [ "$EXPORT_LINE" -lt "$CONFIGURE_LINE" ] || fail "CONDUCTOR_WORKSPACE_NAME fallback (line ${EXPORT_LINE:-?}) must precede configure_deploy_local_env (line ${CONFIGURE_LINE:-?})"
require_text "$SCRIPT" 'BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES="$SEMANTIC_WORKER_PROCESSES" TRACE_ARCHIVE_ENABLED=0' "stack launch must keep the deploy.md Step 5 environment"
# The worker count is overridable for memory-bounded hosts, but the deploy.md Step 5 default stays 8.
require_text "$SCRIPT" 'SEMANTIC_WORKER_PROCESSES="${DEPLOY_SEMANTIC_WORKER_PROCESSES:-8}"' "the stack must default to deploy.md's WORKER_PROCESSES=8"
[ "$(grep -Ec '(^|[[:space:]])WORKER_PROCESSES=' "$SCRIPT")" = 1 ] || fail "only the defaulted override may set the stack's WORKER_PROCESSES"
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

# 3b. An invalid DEPLOY_SEMANTIC_WORKER_PROCESSES is refused (exit 2) before the
#     database check, the sweep or the stack launch; the E2B-only mode ignores it.
for bad in 0 abc -1 2x 1000 ' 2'; do
    expect_exit 2 env CONDUCTOR_PORT="$closed_base" DEPLOY_SEMANTIC_WORKER_PROCESSES="$bad" bash scripts/run-deploy-semantic-stack.sh
    expect_output "DEPLOY_SEMANTIC_WORKER_PROCESSES must be a positive integer (default 8), got '$bad'." "invalid worker count '$bad' must be refused by name"
done
# Empty means unset (the default 8), so the next refusal is the missing database.
expect_exit 2 env CONDUCTOR_PORT="$closed_base" DEPLOY_SEMANTIC_WORKER_PROCESSES= bash scripts/run-deploy-semantic-stack.sh
expect_output "Semantic stack: Postgres is not ready" "an empty worker count falls back to the default"
expect_exit 2 env CONDUCTOR_PORT="$closed_base" DEPLOY_SEMANTIC_WORKER_PROCESSES=2 bash scripts/run-deploy-semantic-stack.sh
expect_output "Semantic stack: Postgres is not ready" "a valid worker count proceeds to the database check"
expect_exit 2 env CONDUCTOR_PORT="$closed_base" DEPLOY_SEMANTIC_WORKER_PROCESSES=abc bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only
expect_output "E2B smoke: Postgres is not ready" "the E2B-only mode launches no stack and ignores the worker count"
[ ! -e "$SWEEP_MARKER" ] || fail "an invalid worker count must be refused before sweeping the worktree"
[ ! -e "$FIXTURE/.context/deploy-smoke.log" ] || fail "no stack may start with an invalid worker count"

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

# 5. The E2B gate's own verdict (deploy.md 6c L2133-2148). PASS needs exit 0, the summary line
#    `PASS  smoke -- Claude Code answers 2+2 (real E2B sandbox)` and an observed CLAUDE_E2B_DONE from
#    a real sandbox. A credential/billing block only the user can fix is a loud SKIPPED with its
#    evidence (exit 1, never PASS); every other no-sandbox path is FAIL.
# The blackbox prints these through its outcome module (structural claude-code-smoke-outcome.test.ts
# pins that claude-code.blackbox.ts uses it).
OUTCOME="$ROOT_DIR/back-end/src/tests/blackbox/claude-code-smoke-outcome.support.ts"
require_text "$OUTCOME" "SANDBOX_PROOF = 'CLAUDE_E2B_DONE observed from real E2B sandbox'" "the blackbox must print the sandbox proof the gate requires"
require_text "$OUTCOME" '-- USER ACTION REQUIRED (${result.skipped.kind}): ' "the blackbox must print the user-action SKIP line the gate classifies"
require_text "$OUTCOME" "SMOKE_SKIP_BANNER = 'CLAUDE-CODE SMOKE SKIPPED -- USER ACTION REQUIRED (NOT A PASS)'" "the blackbox must end a skip with its not-a-pass banner"
require_text "$OUTCOME" '${result.skipped.evidence} (${result.duration}ms)' "the SKIP line keeps its evidence"
SHIMS="$FIXTURE/.context/shims"
mkdir -p "$SHIMS"
for tool in pg_isready psql; do printf '#!/usr/bin/env bash\nexit 0\n' > "$SHIMS/$tool"; chmod +x "$SHIMS/$tool"; done
cat > "$FIXTURE/scripts/run-deploy-stage" <<'STAGE'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$FAKE_E2B_ARGS"
mkdir -p "$BLACKBOX_TEST_ARTIFACT_DIR"
[ -z "$FAKE_E2B_LOG" ] || cp "$FAKE_E2B_LOG" "$BLACKBOX_TEST_ARTIFACT_DIR/claude-code.log"
exit "$FAKE_E2B_EXIT"
STAGE
chmod +x "$FIXTURE/scripts/run-deploy-stage"
SMOKE_NAME='smoke -- Claude Code answers 2+2 (real E2B sandbox)'
fake_log() {  # <name> <lines...>
    local file="$FIXTURE/.context/fake-$1.log"
    shift
    printf '%s\n' "$@" > "$file"
    printf '%s' "$file"
}
PASS_LOG=$(fake_log pass "  PASS  boundary -- health (3ms)" "    ↳ CLAUDE_E2B_DONE observed from real E2B sandbox sbx-123" \
    "  PASS  $SMOKE_NAME (90000ms)" "Results: 40 passed, 0 failed, 0 skipped, 40 total" "ALL CLAUDE-CODE BLACK-BOX TESTS PASSED")
LEGACY_SKIP_LOG=$(fake_log legacy "    [skip] Claude E2B smoke reached the SDK server, but the configured Claude credential is invalid (401)" \
    "  PASS  $SMOKE_NAME (900ms)" "Results: 40 passed, 0 failed, 40 total" "ALL CLAUDE-CODE BLACK-BOX TESTS PASSED")
NO_SMOKE_LOG=$(fake_log nosmoke "Skipping Claude Code smoke tests (BLACKBOX_SMOKE!=1)" \
    "Results: 39 passed, 0 failed, 0 skipped, 39 total" "ALL CLAUDE-CODE BLACK-BOX TESTS PASSED")
CREDENTIAL_LOG=$(fake_log credential \
    "  SKIP  $SMOKE_NAME -- USER ACTION REQUIRED (credential): SDK server returned 401 Invalid authentication credentials (900ms)" \
    "Results: 39 passed, 0 failed, 1 skipped, 40 total" "CLAUDE-CODE SMOKE SKIPPED -- USER ACTION REQUIRED (NOT A PASS)")
BILLING_LOG=$(fake_log billing \
    "  SKIP  $SMOKE_NAME -- USER ACTION REQUIRED (billing): create 403: team is blocked: missing payment method (40ms)" \
    "Results: 39 passed, 0 failed, 1 skipped, 40 total" "CLAUDE-CODE SMOKE SKIPPED -- USER ACTION REQUIRED (NOT A PASS)")
MIXED_LOG=$(fake_log mixed "  FAIL  boundary -- health -- boom (3ms)" \
    "  SKIP  $SMOKE_NAME -- USER ACTION REQUIRED (credential): 401 (900ms)" \
    "Results: 38 passed, 1 failed, 1 skipped, 40 total" "FAILURES:")
run_e2b_case() {  # <expected exit> <log or ''> <fake exit>
    local expected="$1" log="$2" code="$3"
    expect_exit "$expected" env CONDUCTOR_PORT=40000 DEPLOY_E2B_DB_PORT=55432 PATH="$SHIMS:$PATH" \
        FAKE_E2B_LOG="$log" FAKE_E2B_EXIT="$code" FAKE_E2B_ARGS="$FIXTURE/.context/fake-args" \
        bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only
}
run_e2b_case 0 "$PASS_LOG" 0
expect_output "E2B_SMOKE_VERDICT PASS" "a real-sandbox pass is the only PASS"
grep -Fxq 'claude-code-e2b-smoke -- bash scripts/run-blackbox-tests.sh claude-code' "$FIXTURE/.context/fake-args" \
    || fail "the gate must run the unchanged Step 6c stage command"
run_e2b_case 1 "$LEGACY_SKIP_LOG" 0
expect_output "E2B_SMOKE_VERDICT FAIL" "a [skip] that printed PASS without a sandbox proof must FAIL"
run_e2b_case 1 "$NO_SMOKE_LOG" 0
expect_output "E2B_SMOKE_VERDICT FAIL" "a run that never executed the smoke must FAIL"
run_e2b_case 1 "" 0
expect_output "E2B_SMOKE_VERDICT FAIL" "a missing domain log must FAIL"
run_e2b_case 1 "$PASS_LOG" 1
expect_output "E2B_SMOKE_VERDICT FAIL" "a non-zero runner exit is never PASS"
run_e2b_case 1 "$CREDENTIAL_LOG" 1
expect_output "E2B_SMOKE_VERDICT SKIPPED class=credential" "a credential block is a loud SKIPPED"
expect_output "SDK server returned 401 Invalid authentication credentials" "SKIPPED keeps its evidence"
expect_output "NOT A PASS" "SKIPPED says it is not a pass"
if grep -Fq 'E2B_SMOKE_VERDICT PASS' <<<"$OUTPUT"; then fail "a SKIPPED smoke must never report PASS"; fi
run_e2b_case 1 "$BILLING_LOG" 1
expect_output "E2B_SMOKE_VERDICT SKIPPED class=billing" "a billing block is a loud SKIPPED"
expect_output "team is blocked: missing payment method" "SKIPPED keeps its billing evidence"
run_e2b_case 1 "$CREDENTIAL_LOG" 0
expect_output "E2B_SMOKE_VERDICT FAIL" "a skip with a zero runner exit is inconsistent and FAILS"
run_e2b_case 1 "$MIXED_LOG" 1
expect_output "E2B_SMOKE_VERDICT FAIL" "any other failing case keeps the gate FAIL"
run_e2b_case 143 "$CREDENTIAL_LOG" 143
expect_output "E2B_SMOKE_VERDICT FAIL" "an interrupted runner is not a SKIPPED and keeps its native exit"
[ ! -e "$SWEEP_MARKER" ] || fail "E2B-only mode must never sweep the worktree"

echo "run-deploy-semantic-stack: all checks passed"
