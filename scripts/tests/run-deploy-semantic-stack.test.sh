#!/usr/bin/env bash
# Regression for scripts/run-deploy-semantic-stack.sh, the versioned Group 4
# semantic lane (the former deploy.md Steps 5, 6b, 6c, kept in
# .claude/commands/DEPRECATED_deploy.md; `run_deploy_pipeline.py plan
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
require_text "$SCRIPT" 'BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES="$SEMANTIC_WORKER_PROCESSES" TRACE_ARCHIVE_ENABLED=0' "stack launch must keep the Step 5 environment (DEPRECATED_deploy.md)"
# The worker count is overridable for memory-bounded hosts, but the Step 5 default (DEPRECATED_deploy.md) stays 8.
require_text "$SCRIPT" 'SEMANTIC_WORKER_PROCESSES="${DEPLOY_SEMANTIC_WORKER_PROCESSES:-8}"' "the stack must default to the Step 5 WORKER_PROCESSES=8"
[ "$(grep -Ec '(^|[[:space:]])WORKER_PROCESSES=' "$SCRIPT")" = 1 ] || fail "only the defaulted override may set the stack's WORKER_PROCESSES"
require_text "$SCRIPT" 'bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1 &' "stack must be the Step 5 run.sh --benchmark launch"
# The no-shared-tunnel invariant remains; code sessions also require a callback.
require_text "$SCRIPT" 'BENCHMARK_SKIP_PUBLIC_TUNNEL=0 NGROK_DOMAIN_SUFFIX=ngrok.app DISABLE_FAST_MODE_PROXY=1 BENCHMARK_BUNDLED_FRONTEND=true' "semantic callbacks must use the owned run-scoped tunnel"
require_text "$SCRIPT" 'semantic_verify_callback || exit 1' "callback identity must precede all semantic agents"
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

# 5. The E2B gate's own verdict (Step 6c, DEPRECATED_deploy.md L2133-2148). PASS needs exit 0, the summary line
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

# BEGIN SEMANTIC CALLBACK CONTRACT
semantic_callback_contract() {
python3 - "$ROOT_DIR" <<'CALLBACK'
import json, os, pathlib, re, subprocess, sys, tempfile
root=pathlib.Path(sys.argv[1]); source=(root/'scripts/run.sh').read_text()
semantic=(root/'scripts/run-deploy-semantic-stack.sh').read_text()
launch=re.search(r'^BENCHMARK_SKIP_PUBLIC_TUNNEL=.*$',semantic,re.M)[0]
disable=re.search(r'(?:^| )DISABLE_FAST_MODE_PROXY=([^ ]+)',launch)
proxy=source[source.index('if [ "${DISABLE_FAST_MODE_PROXY:-}" = "1" ]; then'):source.index('export BACKEND_LOG_FILE=')]
def function(text,name):
    match=re.search(r'^'+re.escape(name)+r'\(\) \{\n.*?^\}',text,re.M|re.S)
    assert match,name
    return match[0]
with tempfile.TemporaryDirectory(prefix='semantic-callback-') as tmp:
    tmp=pathlib.Path(tmp);bin=tmp/'bin';bin.mkdir()
    ngrok=bin/'ngrok'
    ngrok.write_text('#!'+sys.executable+'\n'+'''import json,os,signal,sys
with open(os.environ['FAKE_ARGV'],'w') as f:json.dump(sys.argv[1:],f)
if sys.argv[1:2]!=['http']:sys.exit(93)
print(json.dumps(dict(msg='started tunnel',obj='tunnels',name='command_line',url=os.environ['FAKE_ORIGIN'],addr='http://localhost:12001')),flush=True)
signal.pause()
''');ngrok.chmod(0o755)
    handoff_end=source.index('export_sandbox_backend_base_url\n')+len('export_sandbox_backend_base_url\n')
    handoff_start=source.rfind('if [ -n "${DEPLOY_SEMANTIC_CALLBACK_TOKEN:-}" ]; then',0,handoff_end)
    handoff=source[handoff_start:handoff_end] if handoff_start>=0 else 'export_sandbox_backend_base_url'
    shell='set -euo pipefail\n. '+str(root/'scripts/lib/ngrok-tunnel.sh')+'\n. '+str(root/'scripts/lib/workspace-env.sh')+'\n'+function(source,'ngrok_reported_owned_origin')+'\n'+function(source,'start_ngrok_ephemeral_tunnel')+'''
PIDS=();NAMES=();FRONTEND_PORT=12001;CONDUCTOR_WORKSPACE_NAME=rose
NGROK_AUTHTOKEN=offline;NGROK_API_KEY=offline_present;NGROK_DOMAIN_SUFFIX=ngrok.app;ALLOWED_ORIGINS=http://localhost:12001
RUN_CONTEXT_DIR="$FAKE_DIR";mkdir -p "$RUN_CONTEXT_DIR"
dns_label_from_workspace() { printf rose; }
ngrok_tunnel_edge_is_routing() { [ "$1" = "$FAKE_ORIGIN" ] && [ "$2" = 12001 ]; }
trap 'if [ -n "${NGROK_PID:-}" ]; then kill "$NGROK_PID" 2>/dev/null || true; wait "$NGROK_PID" 2>/dev/null || true; fi' EXIT
start_ngrok_ephemeral_tunnel "$DEPLOY_SEMANTIC_CALLBACK_TOKEN"
public_tunnel_process_is_required ngrok 0
! public_tunnel_process_is_optional ngrok 0
BACKEND_URL=http://localhost:12000
'''+handoff+'\n'+proxy+'''
[ -z "$FAST_MODE_ANTHROPIC_PROXY_URL" ]
[ -z "${FAST_MODE_CODEX_PROXY_URL+x}" ]
printf 'OWNED_CALLBACK=%s\\n' "$ROSE_UI_PUBLISH_BASE_URL"
'''
    origins=[]
    for token in ('a'*32,'b'*32):
        origin='https://rose-semantic-bench-'+token+'-bench.ngrok.app';
        env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'DEPLOY_SEMANTIC_CALLBACK_TOKEN':token,'FAKE_DIR':str(tmp/token),'FAKE_ARGV':str(tmp/(token+'.argv')),'FAKE_ORIGIN':origin,'DISABLE_FAST_MODE_PROXY':disable[1] if disable else '0','FAST_MODE_ANTHROPIC_PROXY_URL':'ambient-proxy-must-clear','FAST_MODE_CODEX_PROXY_URL':'ambient-codex-must-clear'}
        result=subprocess.run(['bash','-c',shell],env=env,text=True,capture_output=True,timeout=15)
        assert result.returncode==0, result.stdout+result.stderr
        assert 'OWNED_CALLBACK='+origin in result.stdout
        origins.append(next(line.split('=',1)[1] for line in result.stdout.splitlines() if line.startswith('OWNED_CALLBACK=')))
        argv=json.loads((tmp/(token+'.argv')).read_text());assert argv[:2]==['http','12001'] and argv[argv.index('--domain')+1]==origin.removeprefix('https://')
    assert origins[0]!=origins[1]
    env['FAKE_ORIGIN']='https://foreign.ngrok.app'
    result=subprocess.run(['bash','-c',shell],env=env,text=True,capture_output=True,timeout=15)
    assert result.returncode!=0 and 'OWNED_CALLBACK=' not in result.stdout
    print('PASS callback endpoint: two run-owned domains, no reservation, foreign publication refused; actual proxy branch remains disabled')
    semantic=(root/'scripts/run-deploy-semantic-stack.sh').read_text()
    program=semantic.split('semantic_verify_callback() {',1)[1].split("<<'NODE'\n",1)[1].split('\nNODE\n',1)[0]
    assert semantic.index('semantic_verify_callback || exit 1')<semantic.index('semantic_report_lane ui\n')
    driver=r'''const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2],program=fs.readFileSync(process.argv[3],'utf8'),token='a'.repeat(32),origin=process.argv[4];
assert.equal(origin,`https://rose-semantic-bench-${token}-bench.ngrok.app`);
const crypto=require('node:crypto'),ts=require(path.join(root,'node_modules/typescript'));
const runtimeEnv={PORT:'12000',BACKEND_URL:'http://localhost:12000',ROSE_UI_PUBLISH_BASE_URL:origin,AGENT_TOOLS_TOKEN_SECRET:'offline-owning-fixture-only'};
const noDB=()=>{throw Error('DB forbidden');},logger={createLogger:()=>({info(){},warn(){},debug(){},error(){throw Error('workspace refused');}})};
function load(rel,deps){const filename=path.join(root,rel),code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,module={exports:{}};vm.runInNewContext(code,{require:id=>Object.hasOwn(deps,id)?deps[id]:['fs/promises','path','fs','crypto'].includes(id)?require(id):noDB(),module,exports:module.exports,process:{env:runtimeEnv},Buffer,URL,__dirname:path.dirname(filename),__filename:filename});return module.exports;}
const ui=load('back-end/src/providers/userUi/workspace.ts',{'../logger':logger,'../../utils/roseDesktop':{isRoseDesktopUser:()=>false},'./publishToken':{mintUserUiPublishToken:noDB},'./seed':{USER_UI_CLI_BIN_DIR:'.rose/bin',USER_UI_CLI_NAME:'rose-ui',userUiToolFiles:noDB},'./store':{findActiveUserUiVersion:noDB}});
const tokenModule=load('back-end/src/providers/agentTools/token.ts',{});
const tools=load('back-end/src/providers/agentTools/workspace.ts',{'../logger':logger,'../../utils/roseDesktop':{isRoseDesktopUser:()=>false},'../userUi/workspace':ui,'./mobbin':{MOBBIN_MCP_TOKEN_ENV:'MOBBIN_MCP_TOKEN',mobbinMcpServerConfig:noDB,mobbinMcpToken:()=>undefined},'./token':tokenModule});
const workspace=tools.withAgentTools(null,{userId:'offline-user',agentId:'offline-agent',taskId:'offline-task',provider:'codex',roseDesktop:false});
assert.equal(workspace.envs.ROSE_TOOLS_URL,origin+'/api/agent-tools/offline-agent');assert.equal(JSON.parse(workspace.files.find(f=>f.path==='.rose/tools.json').content).url,workspace.envs.ROSE_TOOLS_URL);
console.log('PASS actual workspace origin/env/HOME handoff (external network/DB 0)');
const queue='navi-agent-tasks-fixture-deploy-20261110231134-5052';
(async()=>{for(const mutation of ['positive','wrong-stack','foreign-origin','dead-endpoint']){
 const manifest={worktree:root,status:'running',benchmark_mode:true,run_sh_pid:1234,ports:{backend:12000,frontend:12001},urls:{backend:'http://localhost:12000',public:mutation==='foreign-origin'?'https://foreign.ngrok.app':origin},temporal_task_queue:queue,services:[{name:'ngrok',pid:4321}]};
 const proc={env:{},argv:['node','-',root,token,'1234','12000'],exitCode:0,kill:(pid,sig)=>{assert.equal(pid,4321);assert.equal(sig,0);}};const calls=[];const output=[];
 const disk={realpathSync:p=>p,readFileSync:(p)=>{if(p.endsWith('/.context/services.json'))return JSON.stringify(manifest);if(p.endsWith('/back-end/.env'))return 'BACKEND_API_KEY=offline-owning-key';if(p==='/proc/4321/stat')return '4321 (ngrok) S 1234 0 0';if(p==='/proc/4321/cmdline')return Buffer.from(['ngrok','http','12001','--domain',new URL(origin).hostname,''].join('\0'));throw Error('unexpected file '+p);}};
 const fetch=async(url,options)=>{calls.push(url);assert.equal(options.redirect,'error');assert.equal(options.headers['X-Queue-Pointer-Observe'],'1');assert.equal(options.headers['X-API-Key'],'offline-owning-key');if(mutation==='dead-endpoint')throw Error('offline transport refusal');return {status:200,json:async()=>({managedDeploymentProtocol:1,continuationAdmitted:false,managedQueue:false,taskQueue:mutation==='wrong-stack'&&url.startsWith('https:')?'foreign-queue':queue,surfaceHash:null,updatedBy:null,updatedAt:null})};};
 await vm.runInNewContext(program,{require:id=>id==='node:fs'?disk:id.endsWith('/node_modules/dotenv')?require(path.join(root,'node_modules/dotenv')):require(id),process:proc,console:{log:v=>output.push(v),error:v=>output.push(v)},Buffer,URL,AbortSignal,fetch});
 assert.equal(proc.exitCode,mutation==='positive'?0:1,mutation);if(mutation==='positive'){assert.equal(calls.length,2);assert(output.some(s=>s.startsWith('SEMANTIC_CALLBACK_READY')));}if(mutation==='foreign-origin')assert.equal(calls.length,0);assert(!output.join('').includes('offline-owning-key'));
 console.log('PASS callback identity: '+mutation+' (external network/DB 0)');
}})().catch(e=>{console.error(e);process.exitCode=1;});'''
    (tmp/'preflight.js').write_text(program);(tmp/'driver.cjs').write_text(driver)
    subprocess.run(['node',str(tmp/'driver.cjs'),str(root),str(tmp/'preflight.js'),origins[0]],check=True,timeout=15)
CALLBACK
}
# END SEMANTIC CALLBACK CONTRACT
semantic_callback_contract

echo "run-deploy-semantic-stack: all checks passed"
