#!/usr/bin/env bash
# Regression for scripts/run-deploy-semantic-stack.sh, the versioned Group 4
# semantic lane (the former deploy.md Steps 5, 6b, 6c, kept in
# the former /deploy skill; `run_deploy_pipeline.py plan
# --semantic-stack` / `--e2b-smoke`, follow-up 12, 2026-10-31). The script
# must parse, refuse to run without its required environment before any side
# effect (no sweep, no stack, no stage record), honour its three modes, carry
# the semantic/E2B invariants of those steps verbatim and keep no launcher
# paths. The lane wiring is anchored to the sources that execute it: the
# pipeline driver's lane commands, the staged planner's flags
# (deploy_test_plan.py) and the structural gate registry.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/run-deploy-semantic-stack.sh"
PIPELINE="$ROOT_DIR/scripts/run_deploy_pipeline.py"
GATES="$ROOT_DIR/scripts/run-deploy-structural-gates.py"
PLANNER="$ROOT_DIR/scripts/deploy_test_plan.py"

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

# ── Static invariants shared with the pipeline, the staged planner and the gate registry ──────────────────
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
require_text "$SCRIPT" 'BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES="$SEMANTIC_WORKER_PROCESSES" TRACE_ARCHIVE_ENABLED=0' "stack launch must keep the Step 5 environment (the former /deploy skill)"
# The worker count is overridable for memory-bounded hosts, but the Step 5 default (the former /deploy skill) stays 8.
require_text "$SCRIPT" 'SEMANTIC_WORKER_PROCESSES="${DEPLOY_SEMANTIC_WORKER_PROCESSES:-8}"' "the stack must default to the Step 5 WORKER_PROCESSES=8"
[ "$(grep -Ec '(^|[[:space:]])WORKER_PROCESSES=' "$SCRIPT")" = 1 ] || fail "only the defaulted override may set the stack's WORKER_PROCESSES"
require_text "$SCRIPT" 'bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1 &' "stack must be the Step 5 run.sh --benchmark launch"
# 2026-11-11 (PR #1940): unroutable trycloudflare quick tunnels cost every Blacksmith run ~3.5 min and the
# gate's 1800 s deadline cancelled runs whose UI and latency stages had passed. Go straight to run.sh's
# run-scoped ngrok endpoint (zero quick-tunnel attempts), never the shared workspace domain.
require_text "$SCRIPT" 'BENCHMARK_SKIP_PUBLIC_TUNNEL=0 BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL=1 CLOUDFLARE_TUNNEL_MAX_ATTEMPTS=0' "the semantic stack must not spend its gate deadline on quick-tunnel retries"
# 2026-11-07: every deploy's gate VM derived the same reserved ngrok domain, so a
# concurrent deploy holding it killed this stack before readiness. No semantic spec
# uses a public origin: the stack must start without a tunnel.
# Public callback behavior is verified by the real launcher/helper fixture below.
require_text "$SCRIPT" 'configure_deploy_local_env || exit 2' "the deploy environment library must gate every mode"
require_text "$SCRIPT" 'bash scripts/resolve-deploy-stack-db.sh' "E2B smoke must prefer the running stack's database port"
forbid_text "$SCRIPT" 'BLACKBOX_TEST_REPLAY_OUTBOUND=1' "the semantic stack stays capture-only"
forbid_text "$SCRIPT" 'BLACKBOX_TEST_USE_EXISTING_BACKEND=1' "the E2B smoke must own its backend"
forbid_text "$SCRIPT" '/var/tmp' "no launcher-private paths"
require_text "$PIPELINE" 'SEMANTIC_STACK_SCRIPT = "scripts/run-deploy-semantic-stack.sh"' "the plan must emit this script"
require_text "$PIPELINE" '"--e2b-smoke-only"' "the plan's e2b-smoke lane must use the standalone mode"
require_text "$GATES" 'scripts/tests/run-deploy-semantic-stack.test.sh' "this suite must be a registered deploy gate"
# The former deploy.md Step 6c / plan-flag wording is retired with that document; the executing sources pin
# the same facts: the driver's e2b-smoke and semantic-stack lane commands, and the staged planner behind
# `scripts/deploy gates`, which requests the three versioned lanes from the driver's plan.
require_text "$PIPELINE" 'SEMANTIC_STACK_COMMAND = ["bash", SEMANTIC_STACK_SCRIPT]' "the plan's semantic-stack lane must run this script"
require_text "$PIPELINE" 'E2B_SMOKE_COMMAND = ["bash", SEMANTIC_STACK_SCRIPT, "--e2b-smoke-only"]' "the plan's e2b-smoke lane must name the standalone E2B mode"
require_text "$PLANNER" '"--live-probes", "--semantic-stack", "--e2b-smoke"' "the staged planner must request the versioned Group 4 lanes from the driver's plan"

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

# 5. The E2B gate's own verdict (Step 6c, the former /deploy skill). PASS needs exit 0, the summary line
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

# 6. The actual launcher environment must give the real tools producer a
# run-owned public callback while the frontend/DB/workspace remain local.
cp "$ROOT_DIR/scripts/lib/ngrok-tunnel.sh" "$FIXTURE/scripts/lib/"
python3 - "$ROOT_DIR/scripts/run.sh" "$FIXTURE/.context/tunnel-functions.sh" <<'PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text();chunks=[]
for name in ('dns_label_from_workspace','ngrok_reported_owned_origin','start_ngrok_ephemeral_tunnel','reap_failed_ngrok_tunnel','start_public_tunnel'):
 start=text.index(name+'() {');end=text.index('\n}',start)+2;chunks.append(text[start:end])
Path(sys.argv[2]).write_text('\n\n'.join(chunks)+'\n')
start=text.index('if [ "${BENCHMARK_SKIP_PUBLIC_TUNNEL:-}" = "1" ]; then', text.index('# Public URL flow:'))
end=text.index('export_sandbox_backend_base_url',start)+len('export_sandbox_backend_base_url')
Path(sys.argv[2]).with_name('tunnel-flow.sh').write_text(text[start:end]+'\n')
start=text.index('if [ "${DISABLE_FAST_MODE_PROXY:-}" = "1" ]; then',end)
end=text.index('unset FAST_MODE_CODEX_PROXY_URL',start)+len('unset FAST_MODE_CODEX_PROXY_URL')
Path(sys.argv[2]).with_name('proxy-flow.sh').write_text(text[start:end]+'\n')
PY
cat > "$SHIMS/curl" <<'TOOL'
#!/usr/bin/env bash
[ -f .context/services.json ]
TOOL
chmod +x "$SHIMS/curl"
cat > "$FIXTURE/scripts/run-deploy-stage" <<'STAGE'
#!/usr/bin/env bash
exit 0
STAGE
cat > "$FIXTURE/scripts/run.sh" <<'STACK'
#!/usr/bin/env bash
set -euo pipefail
. scripts/lib/workspace-env.sh
. scripts/lib/ngrok-tunnel.sh
. .context/tunnel-functions.sh
RUN_CONTEXT_DIR="$PWD/.context/tunnel-fixture"
mkdir -p "$RUN_CONTEXT_DIR"
FRONTEND_PORT=$((CONDUCTOR_PORT + 1)); BACKEND_URL="http://localhost:$CONDUCTOR_PORT"; export BACKEND_URL
ALLOWED_ORIGINS="http://localhost:$FRONTEND_PORT"
PIDS=(999999); NAMES=(protected)
NGROK_AUTHTOKEN=offline-fixture; NGROK_API_KEY=offline_fixture
ensure_ngrok_domain_reserved() { echo RESERVATION >> "$RUN_CONTEXT_DIR/actions"; return 1; }
start_cloudflare_quick_tunnel() { return 1; }
start_ngrok_public_tunnel() { echo SHARED_FALLBACK >> "$RUN_CONTEXT_DIR/actions"; return 1; }
ngrok_tunnel_edge_is_routing() { printf 'edge %s %s\n' "$1" "$2" >> "$RUN_CONTEXT_DIR/actions"; }
# The fixture reports an endpoint only; no callback or model response is synthesized.
ngrok() {
 local port="$2" domain=""; shift 2
 while [ "$#" -gt 0 ]; do if [ "$1" = --domain ]; then domain="$2"; shift; fi; shift; done
 [ "${TEST_TUNNEL_FAIL:-0}" != 1 ] || domain=foreign.example.test
 printf '{"msg":"started tunnel","obj":"tunnels","name":"command_line","url":"https://%s","addr":"http://localhost:%s"}\n' "$domain" "$port"
}
kill() { [ "${1:-}" = -0 ] || printf 'cleanup %s\n' "$1" >> "$RUN_CONTEXT_DIR/actions"; }
trap 'reap_failed_ngrok_tunnel' EXIT
. .context/tunnel-flow.sh
. .context/proxy-flow.sh
if [ -n "${BENCHMARK_PUBLIC_TUNNEL_RUN_ID:-}" ]; then
 public_tunnel_process_is_required ngrok 1
 ! public_tunnel_process_is_optional ngrok 1
fi
AGENT_TOOLS_TOKEN_SECRET=offline-fixture-only TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 \
 node --import "$PRODUCER_TSX_IMPORT" -e '
const {withAgentTools}=require(process.env.PRODUCER_SOURCE);
const w=withAgentTools(null,{userId:"fixture",agentId:"fixture-root",taskId:"fixture-task",provider:"codex",roseDesktop:false});
console.log(JSON.stringify({callback:w.envs.ROSE_TOOLS_URL,backend:process.env.BACKEND_URL,workspace:process.env.CONDUCTOR_WORKSPACE_NAME,queue:process.env.TEMPORAL_TASK_QUEUE,frontend:process.env.SMOKE_FRONTEND_URL,db_port:process.env.LOCAL_DB_PORT,usercontent:process.env.USERCONTENT_BASE_URL,anthropic_proxy:process.env.FAST_MODE_ANTHROPIC_PROXY_URL,codex_proxy:process.env.FAST_MODE_CODEX_PROXY_URL,proxy_disabled:process.env.DISABLE_FAST_MODE_PROXY}));
' > "$RUN_CONTEXT_DIR/producer.log"
reap_failed_ngrok_tunnel
[ "${PIDS[*]}" = 999999 ] && [ "${NAMES[*]}" = protected ]
printf '{"status":"running","ports":{"backend":%s},"database":{"runtime_port":%s}}\n' "$CONDUCTOR_PORT" "$((CONDUCTOR_PORT+5))" > .context/services.json
trap 'exit 0' TERM
while :; do sleep 0.1; done
STACK
chmod +x "$FIXTURE/scripts/run.sh"
callback_for_run() {
 rm -f "$FIXTURE/.context/tunnel-fixture/actions" "$FIXTURE/.context/tunnel-fixture/producer.log" "$FIXTURE/.context/services.json"
 expect_exit 0 env -u USERCONTENT_BASE_URL -u PUBLIC_BASE_URL ROSE_UI_PUBLISH_BASE_URL="${2:-}" \
  CONDUCTOR_PORT=40000 CONDUCTOR_WORKSPACE_NAME=same-workspace ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 \
  DEPLOY_SEMANTIC_TOKEN="$1" PATH="$SHIMS:$PATH" PRODUCER_TSX_IMPORT="$ROOT_DIR/node_modules/tsx/dist/loader.mjs" PRODUCER_SOURCE="$ROOT_DIR/back-end/src/providers/agentTools/workspace.ts" \
  bash scripts/run-deploy-semantic-stack.sh
 python3 - "$FIXTURE/.context/tunnel-fixture/producer.log" "$FIXTURE/.context/tunnel-fixture/actions" <<'PY'
from pathlib import Path
from urllib.parse import urlsplit
import json,sys
rows=[json.loads(x) for x in Path(sys.argv[1]).read_text().splitlines() if x.startswith('{')];r=rows[-1];u=urlsplit(r['callback']);actions=Path(sys.argv[2]).read_text() if Path(sys.argv[2]).exists() else ''
assert u.scheme=='https' and u.hostname and u.hostname!='rose-rose.ngrok.app',r
assert u.path=='/api/agent-tools/fixture-root',u.path
assert r['backend']=='http://localhost:40000' and r['workspace']=='same-workspace',r
assert r['queue'].startswith('navi-agent-tasks-same-workspace-deploy-'),r
assert r['anthropic_proxy']=='' and r.get('codex_proxy') is None and r['proxy_disabled']=='1',r
assert r['frontend']=='http://localhost:40001' and r['db_port']=='40005' and r['usercontent']=='http://localhost:40000',r
assert 'RESERVATION' not in actions and 'SHARED_FALLBACK' not in actions,actions
assert f'edge https://{u.hostname} 40001' in actions and 'cleanup ' in actions,actions
print(u.hostname)
PY
}
FIRST=$(callback_for_run aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
SECOND=$(callback_for_run bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
[ "$FIRST" != "$SECOND" ] || fail "distinct runs must own distinct tunnel domains"
echo "callback-origin fixture: $FIRST / $SECOND; no reservation; local identity and owned cleanup preserved"
# Foreign provider output must fail closed; never reuse a shared reserved name.
rm -f "$FIXTURE/.context/services.json"
expect_exit 1 env -u ROSE_UI_PUBLISH_BASE_URL -u PUBLIC_BASE_URL CONDUCTOR_PORT=40000 \
 DEPLOY_SEMANTIC_TOKEN=cccccccccccccccccccccccccccccccc TEST_TUNNEL_FAIL=1 PATH="$SHIMS:$PATH" \
 PRODUCER_TSX_IMPORT="$ROOT_DIR/node_modules/tsx/dist/loader.mjs" PRODUCER_SOURCE="$ROOT_DIR/back-end/src/providers/agentTools/workspace.ts" bash scripts/run-deploy-semantic-stack.sh
! grep -qE 'RESERVATION|SHARED_FALLBACK' "$FIXTURE/.context/tunnel-fixture/actions" || fail "run-scoped failure touched a shared reservation"



# Scoped callback ownership: reject inherited loopback/foreign origins before publication.
for inherited in http://localhost:40000 https://foreign.example.test; do
 rm -f "$FIXTURE/.context/services.json" "$FIXTURE/.context/tunnel-fixture/producer.log"
 expect_exit 1 env -u PUBLIC_BASE_URL ROSE_UI_PUBLISH_BASE_URL="$inherited" \
  CONDUCTOR_PORT=40000 DEPLOY_SEMANTIC_TOKEN=dddddddddddddddddddddddddddddddd PATH="$SHIMS:$PATH" \
  PRODUCER_TSX_IMPORT="$ROOT_DIR/node_modules/tsx/dist/loader.mjs" PRODUCER_SOURCE="$ROOT_DIR/back-end/src/providers/agentTools/workspace.ts" \
  bash scripts/run-deploy-semantic-stack.sh
 grep -Fq 'Run-scoped callback origin must match the owned public tunnel' "$FIXTURE/.context/deploy-smoke.log" || fail 'foreign inherited callback must fail closed'
 [ ! -e "$FIXTURE/.context/tunnel-fixture/producer.log" ] || fail 'foreign override reached tools producer'
 [ ! -e "$FIXTURE/.context/services.json" ] || fail 'foreign override published services'
 grep -q '^cleanup ' "$FIXTURE/.context/tunnel-fixture/actions" || fail 'failed override did not clean owned tunnel'
done
MATCHING=$(callback_for_run aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "https://$FIRST/")
[ "$MATCHING" = "$FIRST" ] || fail 'matching scoped origin with trailing slash must remain valid'
# Native semantic startup must select the existing canonical seed consumer.
# The fake child exits before services start; these cases only inspect the actual
# launch environment and the production cache-selection helper.
cat > "$FIXTURE/scripts/run.sh" <<'SEED_CHILD'
#!/usr/bin/env bash
printf '%s\n%s\n' "${BENCHMARK_SEED_DUMP:-}" "${BENCHMARK_REQUIRE_SEED_DUMP:-}" > "$FAKE_SEED_ENV"
exit 7
SEED_CHILD
for tool in curl sleep; do printf '#!/usr/bin/env bash\nexit 1\n' > "$SHIMS/$tool"; chmod +x "$SHIMS/$tool"; done
. "$ROOT_DIR/scripts/lib/seed-cache.sh"
seed_case() {
    local expected_dump="$1" token="$2" configured="$3" native_flag
    rm -f "$FIXTURE/.context/seed-env"
    expect_exit 1 env -u DEPLOY_SEMANTIC_TOKEN -u DEPLOY_SEMANTIC_ARTIFACT_DIR \
        -u BENCHMARK_SEED_DUMP -u BENCHMARK_REQUIRE_SEED_DUMP \
        CONDUCTOR_PORT=40000 PATH="$SHIMS:$PATH" FAKE_SEED_ENV="$FIXTURE/.context/seed-env" \
        DEPLOY_SEMANTIC_TOKEN="$token" BENCHMARK_SEED_DUMP="$configured" BENCHMARK_REQUIRE_SEED_DUMP=0 \
        bash scripts/run-deploy-semantic-stack.sh
    [ -f "$FIXTURE/.context/seed-env" ] || fail "seed case never reached its fake run.sh"
    mapfile -t seed_env < "$FIXTURE/.context/seed-env"
    [ "${seed_env[0]}" = "$expected_dump" ] || fail "canonical path missing or configured path replaced"
    native_flag=0
    [ -z "$token" ] || native_flag=1
    [ "${seed_env[1]}" = "$native_flag" ] || fail "native canonical requirement not enforced or manual caller changed"
}
seed_case "$FIXTURE_PHYS/.context/seed-cache/semantic-base.dump" native-token ''
seed_case "$FIXTURE_PHYS/configured-seed.dump" native-token "$FIXTURE_PHYS/configured-seed.dump"
seed_case '' '' ''
seed_case "$FIXTURE_PHYS/manual-seed.dump" '' "$FIXTURE_PHYS/manual-seed.dump"
# A missing object must be requested, never silently treated as a valid restore;
# the native child's REQUIRE=1 makes run.sh refuse its existing cold-sync branch.
[ "$(seed_cache_decision "$FIXTURE_PHYS/missing.dump" schema 1 canonical)" = consult-remote ] \
    || fail "missing canonical object must consult remote cache"
require_text "$ROOT_DIR/scripts/run.sh" 'if [ "${BENCHMARK_REQUIRE_SEED_DUMP:-0}" = "1" ] && [ "$_SEED_DECISION" != "restore-local" ]; then' \
    "required unavailable canonical fixture must fail closed before cold-sync"

echo "run-deploy-semantic-stack: all checks passed"
