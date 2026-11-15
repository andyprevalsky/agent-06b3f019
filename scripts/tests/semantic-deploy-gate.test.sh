#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${SEMANTIC_RUNNER_OVERRIDE:-$ROOT_DIR/front-end/scripts/run-semantic-tests.sh}"
RUN_SH="$ROOT_DIR/scripts/run.sh"
HELPERS="$ROOT_DIR/front-end/tests-e2e/helpers.ts"
LIFECYCLE_SPEC="$ROOT_DIR/front-end/tests-e2e/chat-lifecycle-latency.spec.ts"
WORKFLOW="$ROOT_DIR/.github/workflows/chat-lifecycle-ratchet.yml"
FRONTEND_LOCK="$ROOT_DIR/front-end/package-lock.json"
PROD_SESSION_GENERATOR="$ROOT_DIR/front-end/scripts/generate-prod-test-session.mjs"
PROD_SESSION_TEST="$ROOT_DIR/scripts/tests/prod-semantic-session.test.mjs"
DEPLOY_COMMAND="${DEPLOY_COMMAND_OVERRIDE:-$ROOT_DIR/.claude/commands/deploy.md}"
# deploy.md is a short command doc: one `scripts/deploy ...` command per step, no inline
# scripts and no gate list. The behavior below is asserted on the sources that execute
# it (the planner, registry, lane runner, CLI and semantic-stack script); deploy.md is
# asserted only for the rules it states.
PROD="$ROOT_DIR/scripts/deploy_prod.py"
PIPELINE="$ROOT_DIR/scripts/run_deploy_pipeline.py"
DEPLOY_CLI="$ROOT_DIR/scripts/deploy_cli.py"
DEPLOY_GATES="$ROOT_DIR/scripts/deploy_gates.py"
SEMANTIC_STACK="$ROOT_DIR/scripts/run-deploy-semantic-stack.sh"
STACK_DB_RESOLVER="$ROOT_DIR/scripts/resolve-deploy-stack-db.sh"
CODERABBIT_CONFIG="$ROOT_DIR/.coderabbit.yaml"
REVIEW_WAITER="$ROOT_DIR/scripts/wait_for_code_review.py"
REVIEW_CYCLES="$ROOT_DIR/scripts/deploy_review_cycle.py"
DEPLOY_ENV="$ROOT_DIR/scripts/lib/deploy-local-env.sh"
DEPLOY_STRUCTURAL_RUNNER="$ROOT_DIR/scripts/run-deploy-structural-gates.py"
DEPLOY_STRUCTURAL_RUNNER_TEST="$ROOT_DIR/scripts/tests/run-deploy-structural-gates.test.py"
DEPLOY_LIVE_PROBE_RUNNER="$ROOT_DIR/scripts/run_deploy_live_probes.py"
RUN_PREDEPLOY_LOCAL="$ROOT_DIR/scripts/run-predeploy-local"
RUN_PREDEPLOY_CLOUD="$ROOT_DIR/scripts/run-predeploy-cloud"
RUN_BENCH_CLOUD="$ROOT_DIR/scripts/run-bench-cloud"
CLOUDBENCH_RUN="$ROOT_DIR/scripts/cloudbench-run.sh"
DESCEND_COMMAND_TEST="$ROOT_DIR/scripts/tests/descend-command.test.sh"
AGENTCARD_LIFECYCLE_SCRIPT="$ROOT_DIR/scripts/run-agentcard-lifecycle-task.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1"
  local text="$2"
  local description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

require_count() {
  local file="$1"
  local text="$2"
  local expected="$3"
  local description="$4"
  local actual
  actual=$(grep -Fc -- "$text" "$file" || true)
  [ "$actual" = "$expected" ] || fail "$description (expected $expected, found $actual)"
}

for file in "$RUNNER" "$RUN_SH" "$HELPERS" "$LIFECYCLE_SPEC" "$WORKFLOW" "$FRONTEND_LOCK" "$PROD_SESSION_GENERATOR" "$PROD_SESSION_TEST" "$DEPLOY_COMMAND" "$PROD" "$PIPELINE" "$DEPLOY_CLI" "$DEPLOY_GATES" "$SEMANTIC_STACK" "$STACK_DB_RESOLVER" "$CODERABBIT_CONFIG" "$REVIEW_WAITER" "$REVIEW_CYCLES" "$DEPLOY_ENV" "$DEPLOY_STRUCTURAL_RUNNER" "$DEPLOY_STRUCTURAL_RUNNER_TEST" "$DEPLOY_LIVE_PROBE_RUNNER" "$RUN_PREDEPLOY_LOCAL" "$RUN_PREDEPLOY_CLOUD" "$RUN_BENCH_CLOUD" "$CLOUDBENCH_RUN" "$DESCEND_COMMAND_TEST" "$AGENTCARD_LIFECYCLE_SCRIPT"; do
  [ -f "$file" ] || fail "required semantic deploy gate file is missing: $file"
done

# Parse every semantic spec before launching the full browser stack. The
# frontend type-check and unit coverage gates do not load tests-e2e/*.spec.ts.
PLAYWRIGHT_BIN="$ROOT_DIR/front-end/node_modules/.bin/playwright"
if [ ! -x "$PLAYWRIGHT_BIN" ]; then
  PLAYWRIGHT_BIN="$ROOT_DIR/node_modules/.bin/playwright"
fi
[ -x "$PLAYWRIGHT_BIN" ] || fail "Playwright binary is missing for semantic spec validation"
(cd "$ROOT_DIR/front-end" && "$PLAYWRIGHT_BIN" test --list >/dev/null) ||
  fail "semantic specs must load before browser tests start"

# Discovery never executes hooks or test bodies. Its synthetic context below
# checks collection only; it is not a finished benchmark root or render proof.
python3 - "$ROOT_DIR" "$PLAYWRIGHT_BIN" <<'PY_SEMANTIC_COLLECTION'
import json
import os
from pathlib import Path
import subprocess
import sys

root, playwright = Path(sys.argv[1]), sys.argv[2]
benchmark = 'code-agent-render-check.spec.ts'

def collect(context):
    env = dict(os.environ)
    env.pop('CODE_AGENT_CHECK_ROOT_ID', None)
    if context is not None:
        env['CODE_AGENT_CHECK_ROOT_ID'] = context
    result = subprocess.run([playwright, 'test', '--list', '--reporter=json'],
                            cwd=root / 'front-end', env=env, check=True,
                            capture_output=True, text=True)
    report = json.loads(result.stdout)
    def specs(suites):
        for suite in suites:
            for spec in suite.get('specs', []):
                yield (spec['file'], spec['id'])
            yield from specs(suite.get('suites', []))
    return set(specs(report['suites']))

ordinary = collect(None)
assert ordinary and not any(file == benchmark for file, _ in ordinary), ordinary
for absent in ('', '   '):
    assert collect(absent) == ordinary, 'blank benchmark context must keep ordinary selection'
dedicated = collect('collection-only-no-execution')
extra = dedicated - ordinary
assert extra and {file for file, _ in extra} == {benchmark}, extra
assert ordinary <= dedicated, 'dedicated benchmark context must not remove ordinary specs'
print('PASS: ordinary collection omits only the finished-run benchmark; dedicated context retains it')
PY_SEMANTIC_COLLECTION

# One session is generated by the runner and shared by every Playwright worker.
require_text "$RUNNER" "export SEMANTIC_SESSION" "semantic runner must export one shared session"
require_text "$RUNNER" 'export SEMANTIC_DATABASE_URL="postgresql://postgres:postgres@localhost:${LOCAL_DB_PORT}/' "semantic runner must seed take-control into the running backend's isolated Postgres"
require_text "$RUNNER" 'apply_local_semantic_db_urls() {' "semantic runner must isolate LOCAL_DB_PORT fallbacks so they can be tested"
require_text "$RUNNER" 'if [[ -z "${SEMANTIC_DIRECT_URL:-}" ]]; then' "semantic runner must preserve a caller-provided SEMANTIC_DIRECT_URL when LOCAL_DB_PORT is set"
require_text "$RUNNER" '"$FRONTEND_DIR/node_modules/.bin/playwright"' "semantic runner must prefer the frontend package's Playwright singleton"
require_text "$RUNNER" '"$REPO_DIR/node_modules/.bin/playwright"' "semantic runner must fall back to the workspace-hoisted Playwright binary"
require_text "$RUNNER" 'run_playwright() {' "semantic runner must centralize Playwright invocation"
require_text "$RUNNER" 'exec "$PLAYWRIGHT_BIN" "$@"' "semantic runner must exec the frontend-local Playwright binary when present"
require_count "$RUNNER" 'run_playwright test' "2" "all semantic runner paths must use the shared run_playwright helper"

# Optional native output must preserve argv without expanding an unset array on
# pre-4.4 Bash. Execute only the actual argument-building tail, never auth or UI.
python3 - "$RUNNER" <<'PY_SEMANTIC_ARGS'
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

source = Path(sys.argv[1]).read_text()
guarded = '${SEMANTIC_OUTPUT_ARGS[@]+"${SEMANTIC_OUTPUT_ARGS[@]}"}'
assert source.count(guarded) == 2, 'both semantic paths must guard empty native-output arrays for older Bash'
tail = source[source.index('# Optional native evidence output;'):]
for selected in (False, True):
    for native in (False, True):
        with tempfile.TemporaryDirectory(prefix='semantic-args-') as directory:
            root = Path(directory)
            (root / 'tests-e2e').mkdir()
            (root / 'tests-e2e' / 'selected.spec.ts').touch()
            prefix = str(root / 'native output with spaces')
            script = root / 'runner.sh'
            script.write_text('set -euo pipefail\nREPO_DIR=' + shlex.quote(directory) + '\n'
                              'SEMANTIC_WORKERS=3\n'
                              'run_playwright() { python3 -c '\
                              + shlex.quote('import json,sys; print(json.dumps(sys.argv[1:]))')
                              + ' "$@"; exit; }\n' + tail)
            env = dict(os.environ, SEMANTIC_GREP_INVERT='deferred')
            env.pop('SEMANTIC_NATIVE_REPORT_PREFIX', None)
            env.pop('DEPLOY_GATE_PROGRESS', None)
            if native:
                env['SEMANTIC_NATIVE_REPORT_PREFIX'] = prefix
            result = subprocess.run(['bash', str(script), *(['selected'] if selected else [])],
                                    cwd=root, env=env, check=True, capture_output=True, text=True)
            expected = ['test', *(['tests-e2e/selected.spec.ts'] if selected else []),
                        '--reporter=' + ('list,json,' + directory + '/scripts/deploy-semantic-reporter.cjs' if native else 'list'),
                        '--workers=3', *(['--output=' + prefix + '-artifacts'] if native else []),
                        *(['--grep-invert=deferred'] if not selected else [])]
            assert json.loads(result.stdout) == expected, result.stdout
            if native:
                artifacts = Path(prefix + '-artifacts')
                artifacts.mkdir()
                evidence = artifacts / 'prior-evidence.txt'
                evidence.write_text('retain prior evidence')
                rejected = subprocess.run(['bash', str(script), *(['selected'] if selected else [])],
                                          cwd=root, env=env, capture_output=True, text=True)
                assert rejected.returncode == 2, 'existing artifacts must reject before Playwright starts'
                assert not rejected.stdout, 'Playwright must not start against prior artifacts'
                assert evidence.read_text() == 'retain prior evidence'
print('PASS: all/named semantic argv, native output absent/present, spaces preserved (installed Bash)')
PY_SEMANTIC_ARGS

# Compose live progress and native evidence without inheriting the deploy worker's
# own progress file into a fixture that captures, rather than runs, Playwright.
python3 - "$RUNNER" <<'PY_SEMANTIC_REPORTERS'
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

source = Path(sys.argv[1]).read_text()
tail = source[source.index('# Optional native evidence output;'):]
for selected in (False, True):
    for native in (False, True):
        for progress in (False, True):
            with tempfile.TemporaryDirectory(prefix='semantic-reporters-') as directory:
                root = Path(directory)
                (root / 'tests-e2e').mkdir()
                (root / 'tests-e2e/selected.spec.ts').touch()
                prefix = str(root / 'native output with spaces')
                script = root / 'runner.sh'
                script.write_text('set -euo pipefail\nREPO_DIR=' + shlex.quote(directory) + '\n'
                                  'SEMANTIC_WORKERS=3\n'
                                  'run_playwright() { python3 -c '
                                  + shlex.quote('import json,sys; print(json.dumps(sys.argv[1:]))')
                                  + ' "$@"; exit; }\n' + tail)
                env = {k: v for k, v in os.environ.items()
                       if k not in {'SEMANTIC_NATIVE_REPORT_PREFIX', 'DEPLOY_GATE_PROGRESS',
                                    'SEMANTIC_GREP_INVERT'}}
                if native:
                    env['SEMANTIC_NATIVE_REPORT_PREFIX'] = prefix
                if progress:
                    env['DEPLOY_GATE_PROGRESS'] = str(root / 'progress.jsonl')
                result = subprocess.run(['bash', str(script), *(['selected'] if selected else [])],
                                        cwd=root, env=env, check=True, capture_output=True, text=True)
                argv = json.loads(result.stdout)
                reporters = next(arg.split('=', 1)[1].split(',') for arg in argv
                                 if arg.startswith('--reporter='))
                expected = ['list']
                if progress:
                    expected.append('./src/tests/gate-progress/playwrightReporter.ts')
                if native:
                    expected.extend(['json', directory + '/scripts/deploy-semantic-reporter.cjs'])
                assert reporters == expected, argv
                assert argv[:2 if selected else 1] == (
                    ['test', 'tests-e2e/selected.spec.ts'] if selected else ['test']), argv
                assert ('--output=' + prefix + '-artifacts' in argv) is native, argv
                assert '--workers=3' in argv, argv
                assert not (root / 'progress.jsonl').exists(), 'capture fixture must not run a reporter'
print('PASS: all eight all/named, native-evidence and live-progress reporter combinations')
PY_SEMANTIC_REPORTERS
require_text "$HELPERS" "HAS_INJECTED_SESSION" "semantic helpers must expose injected-session auth"
require_text "$HELPERS" "expectInjectedSessionRecognized" "semantic helpers must verify the shared session"
require_text "$RUN_SH" 'resolve_temporal_task_queue "$CONDUCTOR_WORKSPACE_NAME"' "run.sh must derive its queue through the tested isolation boundary"
require_text "$RUN_SH" 'export BACKEND_LOG_FILE="${BACKEND_LOG_FILE:-$PWD/back-end/backend-logs.log}"' "semantic stack must retain backend evidence"
require_text "$RUN_SH" 'export FRONTEND_LOG_FILE="${FRONTEND_LOG_FILE:-$PWD/front-end/frontend-logs.log}"' "semantic stack must retain frontend evidence"
require_text "$RUN_SH" 'Building bundled frontend before starting runtime services' "bundled frontend must build before memory-heavy runtime services start"
require_text "$RUN_SH" 'npx vite build --outDir "$FRONTEND_DIST_DIR" --emptyOutDir' "each bundled frontend build must own its output directory"
require_text "$RUN_SH" 'NODE_OPTIONS="$FRONTEND_BUILD_NODE_OPTIONS" VITE_BACKEND_SAME_ORIGIN=true \' "bundled frontends must call the backend through the origin that served them"
require_count "$RUN_SH" 'VITE_BACKEND_API_URL="$PUBLIC_BASE_URL"' "0" "bundled frontends must not bake the public tunnel in as their backend origin"
require_text "$RUN_SH" 'npx vite preview --outDir "$FRONTEND_DIST_DIR" --host 0.0.0.0 --port $FRONTEND_PORT --strictPort >> "$FRONTEND_LOG_FILE"' "bundled frontend service must only serve its completed production build"
require_text "$RUN_SH" 'for _ in $(seq 1 25); do' "Docker health detection must tolerate a busy Desktop daemon before falling back to the shared system database"
require_text "$RUN_SH" 'docker ps --filter "name=^${DB_CONTAINER}$"' "deploy-prestarted workspace database must bypass a slow broad Docker health probe"
require_text "$RUN_SH" 'workspace_db_container_owns_port &&' "deploy-prestarted database reuse must verify the exact workspace container owns the configured port"

BUNDLED_BUILD_LINE=$(grep -n 'Building bundled frontend before starting runtime services' "$RUN_SH" | head -1 | cut -d: -f1)
BACKEND_LAUNCH_LINE=$(grep -n '^launch_backend_service$' "$RUN_SH" | head -1 | cut -d: -f1)
[ "$BUNDLED_BUILD_LINE" -lt "$BACKEND_LAUNCH_LINE" ] || fail "bundled frontend build must finish before backend and worker launch"

# The lifecycle ratchet is a browser blackbox over every chat route.
require_text "$LIFECYCLE_SPEC" "const SAMPLE_COUNT = 5;" "lifecycle ratchet must take five samples per path"
require_text "$LIFECYCLE_SPEC" "const FULL_LIFECYCLE_TARGET_MS = 6_000;" "lifecycle reporting target must remain six seconds"
require_text "$LIFECYCLE_SPEC" "mode: 'parallel'" "chat paths must run concurrently"
require_text "$LIFECYCLE_SPEC" "test.use({ trace: 'off', video: 'off' });" "latency measurements must exclude Playwright recording overhead"
require_text "$ROOT_DIR/front-end/tests-e2e/helpers.ts" "waitForTemporalWorkflow" "agent lifecycle ratchet must expose an authoritative Temporal-start helper"
# Per-request poll bound must cover documented prod edge stalls (~2.5s) so a
# saturated GH Actions→Render path can still observe an already-persisted
# temporal_workflow_id. Do NOT ratchet this down toward the 6s lifecycle SLA —
# that reporting target lives on FULL_LIFECYCLE_TARGET_MS; starving the poll recreates
# the July 18 false-negative (RCA 2026-07-18, recurred 2026-08-31 after 500ms).
require_text "$HELPERS" "const PER_REQUEST_TIMEOUT_MS = 2_500;" "temporal-workflow poll per-request timeout must stay at 2500ms to cover prod edge stalls"
require_text "$HELPERS" "res.status === 404 || res.status === 503" "temporal-workflow poll must retry transient live-row misses and archive-index warming responses"
require_text "$LIFECYCLE_SPEC" "waitForTemporalWorkflow" "agent lifecycle terminal must wait for persisted Temporal startup"

# Completed target misses warn; actual browser-validation functional failures still fail.
node - "$LIFECYCLE_SPEC" "$ROOT_DIR/back-end/package.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = createRequire(process.argv[3])('typescript');
const source = ts.createSourceFile(process.argv[2], fs.readFileSync(process.argv[2], 'utf8'), ts.ScriptTarget.Latest, true);
let validation;
function visit(node) {
  if (ts.isBlock(node)) {
    const first = node.statements.findIndex(statement => ts.isExpressionStatement(statement) && statement.getText(source).includes('all five lifecycle samples must finish'));
    if (first >= 0) validation = node.statements.slice(first).map(statement => statement.getText(source)).join('\n');
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(validation && validation.includes('hasUncaughtErrors(recorder)'), 'actual sample/end-state validation must be found');
const code = ts.transpileModule(validation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const samples = () => Array.from({ length: 5 }, (_, index) => ({ sample: index + 1, lifecycleMs: index === 2 ? 12461 : 2329, failures: [] }));
function verify(results, errors = []) {
  const warnings = [];
  vm.runInNewContext(code, {
    path: { id: 'web_search' }, results, SAMPLE_COUNT: 5,
    FULL_LIFECYCLE_TARGET_MS: 6000, FULL_LIFECYCLE_RATCHET_MS: 6000,
    recorder: {}, hasUncaughtErrors: () => errors,
    console: { warn: value => warnings.push(value) },
    expect: (actual, message) => ({
      toHaveLength: expected => assert.equal(actual.length, expected, message),
      toEqual: expected => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message),
      toBeLessThan: expected => assert.ok(actual < expected, message),
    }),
  });
  return warnings;
}
let failed = 0;
for (const [name, control] of [
  ['completed slow sample warns', () => { const warnings = verify(samples()); assert.equal(warnings.length, 1); assert.match(warnings[0], /12461ms.*6000ms/); }],
  ['missing sample fails', () => assert.throws(() => verify(samples().slice(1)), /must finish/)],
  ['missing milestone fails', () => { const results = samples(); results[0].failures.push('terminal missed'); assert.throws(() => verify(results), /missed milestones/); }],
  ['uncaught error fails', () => assert.throws(() => verify(samples().map(result => ({ ...result, lifecycleMs: 2329 })), ['runtime exception']), /uncaught errors/)],
]) {
  try { control(); console.log(`PASS: ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL: ${name}: ${error.message}`); }
}
if (failed) process.exitCode = 1;
NODE
# CI runs UI semantics and the latency ratchet as concurrent jobs. The ratchet
# owns a runner and executes samples sequentially so renderer contention cannot
# become part of the product latency measurement.
require_text "$WORKFLOW" "workflow_dispatch:" "production semantic gate must support /deploy dispatch"
require_text "$WORKFLOW" "github.event.deployment.production_environment == true" "automatic semantic runs must be gated to production Vercel deploys"
require_text "$WORKFLOW" "hashFiles('front-end/package-lock.json')" "semantic workflow cache must follow the committed frontend lockfile"
require_count "$WORKFLOW" "working-directory: front-end" "4" "semantic workflow dependency and browser steps must run from the frontend package"
require_text "$WORKFLOW" "npm ci --ignore-scripts --workspaces=false" "semantic workflow must install locked frontend dependencies without resolving the root workspace"
require_text "$WORKFLOW" "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830" "semantic workflow must pin npm caching to an immutable action SHA"
LOCK_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/semantic-lock.XXXXXX")
trap 'rm -rf "$LOCK_TEST_DIR"' EXIT
cp "$ROOT_DIR/front-end/package.json" "$FRONTEND_LOCK" "$LOCK_TEST_DIR/"
# Match the workflow's working-directory install; npm --prefix can substitute the
# temporary directory basename as the isolated root package identity.
(cd "$LOCK_TEST_DIR" && npm ci --dry-run --ignore-scripts --no-audit --no-fund >/dev/null) ||
  fail "frontend lockfile must support a standalone clean install"
if grep -Fq -- "--no-package-lock" "$WORKFLOW"; then
  fail "production semantic installs must not bypass the workspace lockfile"
fi
require_text "$RUNNER" 'node scripts/generate-prod-test-session.mjs' "production semantics must not install backend dependencies only to generate auth"
require_text "$WORKFLOW" "SEMANTIC_WORKERS: 4" "production semantic gate must request four concurrent workers as its ceiling"
# RCA 2026-10-31-production-semantic-gate-oversubscribed-two-vcpu-runner: the
# runner must cap that ceiling at the runner's CPUs in production mode too.
# Four Chromium workers on the private-repository runner's two vCPUs scaled every
# UI case 1.5-1.9x between runs of identical source and pushed the longest case
# past its unchanged 90s deadline.
require_text "$RUNNER" 'if [[ "$PROD_MODE" -eq 1 ]]; then
  SIZING_LOAD1=""' "production semantic sizing must ignore the transient post-install load and cap on CPU count"
# The folder-controls profiling fixture is opt-in: its browser-wide CDP CPU
# profiler added ~10s to the 1280px body on one core (35.5s vs 25.3s), a third
# of the unchanged 90s deadline. Neither the fixture nor the workflow may turn
# it on by default.
FOLDER_PROFILE_FIXTURE="$ROOT_DIR/front-end/tests-e2e/folder-profile.ts"
require_text "$FOLDER_PROFILE_FIXTURE" "const enabled = process.env.SEMANTIC_FOLDER_PROFILE ?? '0';" "folder-controls profiling must be opt-in, never a CI default"
if grep -q "SEMANTIC_FOLDER_PROFILE" "$WORKFLOW"; then
  fail "the production semantic workflow must not enable the folder-controls profiler"
fi
require_text "$WORKFLOW" "bash front-end/scripts/run-semantic-tests.sh --prod" "production gate must run every semantic spec"
require_text "$RUNNER" 'FRONTEND_URL="${FRONTEND_URL:-https://www.roselabs.ai}"' "prod semantic default frontend must be www (apex 307s and flakes on some runners)"
require_text "$RUNNER" 'is_loopback_url()' "prod semantic must detect loopback URLs via host parse"
require_text "$RUNNER" 'if is_loopback_url "${BACKEND_URL:-}"; then' "prod semantic must ignore cloud-injected loopback BACKEND_URL"
require_text "$RUNNER" 'if is_loopback_url "${FRONTEND_URL:-}"; then' "prod semantic must ignore cloud-injected loopback FRONTEND_URL"
require_text "$RUNNER" '127\.([0-9]{1,3}\.){2}[0-9]{1,3}' "prod semantic loopback check must cover 127.0.0.0/8"
require_text "$RUNNER" 'localhost|*.localhost|::1' "prod semantic loopback check must cover localhost and IPv6 ::1"
require_text "$RUNNER" 'curl -4 -sfL --max-time 20 -o /dev/null "$FRONTEND_URL"' "prod frontend probe must force IPv4, follow redirects, and bound wait"
require_text "$WORKFLOW" "default: https://www.roselabs.ai" "workflow_dispatch frontend default must match the hardened www probe"
require_text "$PROD" "FRONTEND_URL = 'https://www.roselabs.ai'" "/deploy production semantic dispatch must target www"
require_text "$PROD" "'--frontend-url', FRONTEND_URL" "/deploy production semantic dispatch must pass the www frontend URL"
require_text "$WORKFLOW" "source_sha:" "production semantic gate must accept the exact merged commit (source_sha)"
require_count "$WORKFLOW" 'ref: ${{ inputs.source_sha || (github.event_name == '"'"'workflow_dispatch'"'"' && github.sha) || github.event.repository.default_branch }}' "2" "both semantic checkouts must check out source_sha on dispatch and the trusted default branch on deployment events"
require_text "$WORKFLOW" "SEMANTIC_GREP_INVERT: chat full-lifecycle latency" "UI semantic job must exclude the separately gated latency spec"
require_text "$WORKFLOW" "SEMANTIC_WORKERS: 1" "latency ratchet must avoid renderer contention"
require_text "$WORKFLOW" "--prod chat-lifecycle-latency" "production gate must run the lifecycle ratchet"
# The lifecycle ratchet shards one chat path per runner (one browser, one worker
# each). The shard list must cover every path the spec defines, exactly once, and
# each shard must select its path; the UI job stays one four-worker session.
LIFECYCLE_SPEC_PATHS=$(sed -nE "s/^    id: '([a-z_]+)',$/\1/p" "$LIFECYCLE_SPEC" | sort | tr '\n' ' ')
WORKFLOW_MATRIX_PATHS=$(sed -nE 's/^        path: \[(.*)\]$/\1/p' "$WORKFLOW" | tr -d ' ' | tr ',' '\n' | sort | tr '\n' ' ')
[ -n "$LIFECYCLE_SPEC_PATHS" ] || fail "could not read CHAT_PATHS ids from the lifecycle spec"
[ "$LIFECYCLE_SPEC_PATHS" = "$WORKFLOW_MATRIX_PATHS" ] ||
  fail "lifecycle shard matrix ($WORKFLOW_MATRIX_PATHS) must equal the spec's chat paths ($LIFECYCLE_SPEC_PATHS)"
require_count "$WORKFLOW" "matrix:" "1" "only the lifecycle ratchet may shard; the UI semantic job keeps one shared session"
require_text "$WORKFLOW" 'CHAT_LIFECYCLE_PATH: ${{ matrix.path }}' "each lifecycle shard must run exactly its own chat path"
require_text "$WORKFLOW" "fail-fast: false" "one failing lifecycle shard must not cancel the evidence of the others"
require_count "$WORKFLOW" "filter: blob:none" "2" "both semantic jobs must use the blob-filtered checkout"
require_text "$WORKFLOW" "/agents/benchmarks/tasks.json" "sparse semantic checkout must keep the benchmark task catalog the specs read"
if grep -Fq 'npm run dev > frontend-logs.log' "$DEPLOY_COMMAND" "$SEMANTIC_STACK" "$DEPLOY_GATES"; then
  fail "/deploy must not start a second frontend; run.sh --benchmark already owns it"
fi
if grep -Fq 'SMOKE_RESEARCH_URL' "$DEPLOY_COMMAND" "$SEMANTIC_STACK" "$DEPLOY_GATES" "$DEPLOY_ENV"; then
  fail "/deploy must not wait on the retired research service"
fi

# deploy.md keeps the explicit-override rule and its disclosure (Guidelines and
# Skippable tests). Retired with the inline skill: the "highest-precedence deploy
# rule" heading, `TEST_REPORT` wording and the DEPLOY_GATE_OVERRIDES=credential-
# health:anthropic example; the back-end credential-health code still honors that
# channel and is pinned by back-end/src/tests/unit/integration-health.test.ts.
require_text "$DEPLOY_COMMAND" "An override must name the gate explicitly; never infer one" "/deploy must require explicit, gate-named user overrides"
require_text "$DEPLOY_COMMAND" '| Any gate | The user explicitly overrides that named gate | Record `⚠️ Overridden` |' "/deploy must allow explicit user overrides for every gate and record them as overridden"
require_text "$DEPLOY_COMMAND" "A skip, waiver, exception or override is never PASS" "/deploy must disclose overridden gates instead of reporting them as passing"
require_text "$DEPLOY_COMMAND" '| Credential health: Anthropic, Parallel.ai | Any failure (warn-only) |' "/deploy must keep the Anthropic and Parallel.ai credential probes warn-only"
require_text "$DEPLOY_COMMAND" '| Production semantics | always, after the Render, Vercel and Fly lanes it exercises |' "/deploy must retain production semantic verification"
require_text "$PROD" "'semantic': Lane('semantic', True, 'always runs (Step 13b)')," "production semantic verification must run for every merge"
# Retired with the inline skill: the Conductor PR-title lock step (and its path+branch
# versus basename SQL rule); nothing in the deploy path touches the Conductor database.
# The local semantic lane is `scripts/run-deploy-semantic-stack.sh` (the planner's
# semantic-stack gate): four UI workers with the latency ratchet excluded, then
# the ratchet alone on one worker, on a normalized workspace identity.
require_text "$SEMANTIC_STACK" "SEMANTIC_WORKERS=4" "/deploy local semantic gate must use four workers"
require_text "$SEMANTIC_STACK" 'SEMANTIC_GREP_INVERT="chat full-lifecycle latency"' "/deploy local UI semantic job must exclude the separately gated latency spec"
require_text "$SEMANTIC_STACK" "SEMANTIC_WORKERS=1" "/deploy local latency ratchet must avoid renderer contention"
require_text "$SEMANTIC_STACK" "chat-lifecycle-latency" "/deploy local gate must run the lifecycle ratchet separately"
require_text "$SEMANTIC_STACK" '. scripts/lib/workspace-env.sh' "/deploy must load canonical workspace identity normalization"
require_text "$SEMANTIC_STACK" '. scripts/lib/deploy-local-env.sh' "/deploy must load the tested local environment boundary"
require_text "$SEMANTIC_STACK" 'configure_deploy_local_env' "/deploy must normalize identity before resolving local resources"
# The doc has no gate list: every behavior owner is a registered structural gate
# (one registration each, exact command) and the planner runs the registry.
python3 -B - "$ROOT_DIR" <<'PY_DEPLOY_WIRING' || fail "deploy planner, registry and lane wiring must hold"
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
import deploy_prod as prod
import deploy_test_plan as plan
import run_deploy_pipeline as pipeline


def fail(message):
    raise SystemExit(f"FAIL: {message}")


spec = importlib.util.spec_from_file_location("deploy_registry_wiring", root / "scripts/run-deploy-structural-gates.py")
registry = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = registry
spec.loader.exec_module(registry)
owners_expected = {
    "workspace-env": ("bash", "scripts/tests/workspace-env.test.sh"),
    "kill-services": ("bash", "scripts/tests/kill-services.test.sh"),
    "deploy-worktree-preflight": ("bash", "scripts/tests/deploy-worktree-preflight.test.sh"),
    "semantic-deploy": ("bash", "scripts/tests/semantic-deploy-gate.test.sh"),
    "factory-review": ("python3", "scripts/tests/factory-review.test.py"),
    "wait-for-code-review": ("python3", "scripts/tests/wait-for-code-review.test.py"),
    "deploy-review-cycle": ("python3", "scripts/tests/deploy-review-cycle.test.py"),
    "deploy-stage": ("bash", "scripts/tests/run-deploy-stage.test.sh"),
    "deploy-live-probes": ("python3", "scripts/tests/deploy-live-probes.test.py"),
}
for name, command in owners_expected.items():
    owners = [gate for gate in registry.GATES if gate.name == name or gate.command == command]
    if len(owners) != 1 or owners[0].name != name or owners[0].command != command:
        fail(f"{name} must have exactly one registered behavior owner running {' '.join(command)}")
    if not (root / command[1]).is_file():
        fail(f"{name}: {command[1]} is missing")

template = plan.standard_template()
gates = {gate["name"]: gate for gate in template["gates"]}
result = {"all": False, "reasons": [], "lanes": {lane: [] for lanes in plan.GRAPH_LANES.values() for lane in lanes}}


def selected(changed):
    return {gate["name"] for gate in plan.select(template, changed, result, None)["gates"]}


# When selected, the complete semantic suite runs (no case filter on the command).
if gates["semantic-stack"]["command"] != ["bash", "scripts/run-deploy-semantic-stack.sh"]:
    fail("the semantic-stack gate must run the complete semantic suite")
for changed in (["front-end/src/App.tsx"], ["back-end/src/server.ts"], ["agents/helpers/messages.py"], ["scripts/run.sh"]):
    if "semantic-stack" not in selected(changed):
        fail(f"semantic-stack must be selected for {changed}")
# The command-structural runner and the full back-end structural suite are planner gates.
if gates["deploy-command-structural"]["command"][:2] != ["python3", "scripts/run-deploy-structural-gates.py"]:
    fail("/deploy must schedule independent command-structural suites through the registry runner")
if gates["backend-structural"]["command"] != ["npm", "run", "test:structural"] or gates["backend-structural"]["cwd"] != "back-end":
    fail("/deploy must run the full back-end structural suite")
# Five enforced cold-seed measurements.
if gates["seed-memory-ratchet"]["command"] != ["bash", "scripts/measure-seed-memory.sh", "5", "0", "0", "--enforce-budget"]:
    fail("/deploy must run five enforced cold-seed measurements")
# Coverage and blackbox run once, in one combined gate per repo.
for name in ("backend-coverage-blackbox", "frontend-coverage-blackbox", "agents-coverage-blackbox", "mac-app-coverage-blackbox"):
    if name not in gates:
        fail(f"/deploy must run {name} as one combined coverage and blackbox gate")
rerun = {"backend-blackbox", "mac-blackbox", "mac-app-blackbox"} & set(gates)
if rerun:
    fail(f"/deploy must not rerun blackbox after coverage already ran it: {sorted(rerun)}")
if "BLACKBOX_TEST_REPLAY_OUTBOUND" in json.dumps(template):
    fail("/deploy gates must not retain replay config used only by the removed duplicate backend blackbox run")
# AgentCard has no separate lane: its four sandbox lifecycle tasks are cloud smoke
# tasks, selected only when this checkout's diff touches AgentCard infrastructure.
if "agentcard-lifecycle" in gates:
    fail("AgentCard sandbox lifecycle tasks must not form a separate deploy gate")
if tuple(pipeline.AGENTCARD_TASKS) != ("agent-payment-test-shop", "agent-payment-setup-resume",
                                      "agent-payment-idempotent-abandonment", "agent-payment-abandonment"):
    fail("the four AgentCard lifecycle tasks must stay one set")
selector = prod._SELECTOR
agentcard_changed = selector.agentcard_infra_paths(selector.discover_changed_files(root))
in_smoke = set(pipeline.AGENTCARD_TASKS) & set(gates["smoke"]["checks"])
if agentcard_changed and in_smoke != set(pipeline.AGENTCARD_TASKS):
    fail(f"AgentCard infra changed ({agentcard_changed}): the cloud smoke gate must run every AgentCard lifecycle task, "
         f"missing {sorted(set(pipeline.AGENTCARD_TASKS) - in_smoke)}")
if not agentcard_changed and in_smoke:
    fail(f"no AgentCard infra changed: the cloud smoke gate must not run AgentCard lifecycle tasks {sorted(in_smoke)}")

mac = {"ship": "false", "reason": "test", "label": "false"}
# Benchmark history-ledger rows never start the production AgentCard lane.
if prod.plan_lanes(["agents/benchmarks/history/task_attempts.jsonl"], [], mac)["agentcard"].applicable:
    fail("/deploy must not start the AgentCard lane for benchmark history-ledger rows")
if not prod.plan_lanes(["back-end/src/domains/agentcard/service.ts"], [], mac)["agentcard"].applicable:
    fail("an AgentCard payment path must start the AgentCard lane")
# Poller-only changes reach backend coverage; the worktree patch controller reaches cloudbench coverage.
selector = plan.Selector()
poller = selector.select(["scripts/run-bench-hub-poller"]).selected
if not (poller.get("backend-blackbox") or poller.get("backend-unit")):
    fail("/deploy must classify poller-only changes into backend coverage")
if not plan.Selector().select(["scripts/create-worktree-patch.sh"]).selected.get("cloudbench-controller"):
    fail("/deploy must classify worktree patch controller changes into cloudbench coverage")
# Production lanes: the independent Mac release never delays semantics; the
# applicable Mac release remains a required lane that must pass.
if "mac-release" in prod.DEPENDS["semantic"]:
    fail("production semantics must overlap the independent Mac release lane")
shipping = prod.plan_lanes(["front-end/src/App.tsx"], [], {"ship": "true", "reason": "shipped surface", "label": "false"})
if not shipping["mac-release"].applicable or "mac-release" not in prod.LANES:
    fail("the applicable Mac release must remain a production lane")
unknown = prod.plan_lanes(["front-end/src/App.tsx"], [], None, mac_error="no decision")["mac-release"]
if not unknown.applicable or not unknown.error:
    fail("an unknown Mac release decision must block, never pass")
PY_DEPLOY_WIRING
require_text "$DEPLOY_STRUCTURAL_RUNNER" 'DEFAULT_MAX_WORKERS = 8' "command-structural runner must bound default host admission"
# Exercise the default CLI branch; source spelling is not admission behavior.
python3 - "$DEPLOY_STRUCTURAL_RUNNER" <<'PY_ADMISSION'
import importlib.util
import sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('structural_admission_contract', sys.argv[1])
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)
assert runner.DEFAULT_MAX_WORKERS == 8
for cpus, expected in ((None, 1), (1, 1), (8, 4), (14, 8), (128, 8)):
    with patch.object(runner.os, 'cpu_count', return_value=cpus):
        assert runner.default_max_workers() == expected
        for status in (0, 1):
            with patch.object(sys, 'argv', [str(runner.__file__)]), patch.object(runner.shutil, 'which', return_value='/fixture/tool'), patch.object(runner, 'load_durations', return_value={}), patch.object(runner, 'run_gates', return_value=status) as run:
                assert runner.main() == status
                run.assert_called_once_with(list(runner.GATES), max_workers=expected, failure_state=runner.ROOT / runner.FAILURE_STATE, durations_state=runner.ROOT / runner.DURATIONS_STATE)
with patch.object(sys, 'argv', [str(runner.__file__), '--max-workers', '3']), patch.object(runner.shutil, 'which', return_value='/fixture/tool'), patch.object(runner, 'load_durations', return_value={}), patch.object(runner, 'run_gates', return_value=1) as run:
    assert runner.main() == 1
    run.assert_called_once_with(list(runner.GATES), max_workers=3, failure_state=runner.ROOT / runner.FAILURE_STATE, durations_state=runner.ROOT / runner.DURATIONS_STATE)
print('PASS: scaled bounded defaults, explicit override, full registry, failure propagation')
PY_ADMISSION
require_text "$DEPLOY_STRUCTURAL_RUNNER" '"kill-services"' "command-structural runner must retain the benchmark-controller cleanup regression"
require_text "$DEPLOY_STRUCTURAL_RUNNER" '"deploy-structural-runner"' "command-structural runner must retain its signal-handling regression"
require_text "$DEPLOY_STRUCTURAL_RUNNER" '"seed-memory-ratchet"' "command-structural runner must protect the seed-memory deploy wiring"
require_text "$CODERABBIT_CONFIG" 'auto_incremental_review: false' "CodeRabbit must not review every intermediate deploy push"
require_text "$CODERABBIT_CONFIG" 'auto_pause_after_reviewed_commits: 2' "CodeRabbit must retain a defensive automatic review cap"
# Review and approval commands are executed by `scripts/deploy` (deploy_cli.py).
require_text "$DEPLOY_CLI" "'bash', 'scripts/wait-for-code-review', '--pr', str(pr), '--head', review_head," "/deploy must wait for CodeRabbit on one exact HEAD"
require_text "$DEPLOY_CLI" "'scripts/deploy_approval_batch.py', 'freeze', '--head', head(), '--base', args.base" "/deploy must batch approval-scoped hunks at the source freeze"
require_text "$DEPLOY_CLI" "'scripts/deploy_approval_batch.py', 'check'" "/deploy must prove the approval still covers the merged bytes"
require_text "$ROOT_DIR/scripts/deploy_test_backend.py" "RUNNER = ['npm', 'run', 'test:coverage:sharded']" "/deploy backend coverage must run as merged-threshold shards"
require_text "$ROOT_DIR/scripts/deploy_test_backend.py" "FAILED_FIRST = ['bash', 'scripts/run-coverage-sharded.sh', '--failed-first']" "/deploy backend coverage retries must be failed-first full sweeps"
require_text "$PIPELINE" 'retry_env={"BACKEND_COVERAGE_FAILED_FIRST": "1"}' "the pipeline backend coverage retry must be a failed-first full sweep"
require_text "$ROOT_DIR/back-end/package.json" '"test:coverage:sharded": "bash scripts/run-coverage-sharded.sh 2 &&' "backend sharded coverage must keep two shards and the teardown check"
require_text "$ROOT_DIR/back-end/scripts/run-coverage-sharded.sh" '--check-coverage' "sharded backend coverage must enforce thresholds on the merged report"
require_text "$PIPELINE" 'deploy_stage_wait.wait_for_stages(' "/deploy gate waits must wake on stage receipts, not fixed polls"
# Mac release: the applicable lane is required (asserted on the lane plan above); deploy.md states the merge rule.
require_text "$DEPLOY_COMMAND" '| Mac release | `scripts/mac-app-release-decision` ships' "/deploy must retain required applicable Mac release completion"
require_text "$DEPLOY_COMMAND" "Never merge an unwaived blocking failure, and never invent a PASS." "a failed required production lane must block the deploy"
# The disabled Claude fallback never waives CodeRabbit: it is the only review gate and a green check is not a review.
require_text "$DEPLOY_COMMAND" "The Claude fallback review is disabled." "the Claude fallback must stay disabled"
require_text "$DEPLOY_COMMAND" "CodeRabbit is the only review gate" "disabled fallback must not waive substantive CodeRabbit review"
require_text "$DEPLOY_COMMAND" "a green check is not a review" "a green check must not stand in for a CodeRabbit review"
require_text "$ROOT_DIR/CLAUDE.md" 'Format, ESLint, TypeScript and application structural checks always' "the quick categories must always run"
require_text "$ROOT_DIR/CLAUDE.md" 'Coverage thresholds inside a selected full gate remain' "selected categories must preserve full coverage thresholds"
require_text "$ROOT_DIR/CLAUDE.md" 'a focused subset cannot masquerade as a full coverage pass' "focused subsets must not replace full selected coverage"
require_text "$ROOT_DIR/scripts/deploy-agents-cooperative-cutover.sh" 'Promoting prebuilt worker image' "the worker cutover must log prebuilt worker-image promotion"
require_text "$DEPLOY_CLI" "'scripts/deploy_review_cycle.py', 'start', '--reset', '--kind', 'initial'" "/deploy must initialize a bounded review ledger"
require_text "$DEPLOY_CLI" "'scripts/deploy_review_cycle.py', 'require-mergeable', '--head', sha]" "/deploy must reject an unreviewed merge HEAD"
require_text "$DEPLOY_COMMAND" 'deploy_review_cycle.py inherit-sync --head' "/deploy must record main-sync-only HEADs through the audited ledger path"
require_text "$REVIEW_CYCLES" 'MAX_REVIEW_CYCLES = 3' "review cycle enforcement must hard-cap each deploy at three"
require_text "$REVIEW_WAITER" 'actual_head != expected_head' "review waiter must reject stale or changed PR heads"
if grep -Eq 'gh pr checks.*--watch' "$DEPLOY_COMMAND" "$DEPLOY_CLI"; then
  fail "/deploy must not wait on every PR check"
fi
if grep -Fq 'gh api "repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>"' "$DEPLOY_COMMAND" "$DEPLOY_CLI"; then
  fail "/deploy must not request GraphQL-only statusCheckRollup from the REST PR endpoint"
fi
require_text "$REVIEW_WAITER" 'command.extend(["--json", "headRefOid,statusCheckRollup"])' "the review waiter must read statusCheckRollup through gh pr view, not the REST PR endpoint"
require_text "$DEPLOY_ENV" 'normalize_conductor_workspace_env' "/deploy environment must normalize stale workspace identity"
require_text "$DEPLOY_ENV" 'export TEMPORAL_TASK_QUEUE="navi-agent-tasks-${SEMANTIC_QUEUE_WORKSPACE}-deploy-' "/deploy must mint a unique Temporal queue from normalized identity"
require_text "$DEPLOY_ENV" 'export DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}"' "/deploy DB container must use normalized identity"
require_text "$DEPLOY_ENV" 'export DB_VOLUME="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME:-local}"' "/deploy DB volume must use normalized identity"
require_text "$DEPLOY_ENV" 'export LOCAL_DB_PORT=$((conductor_port + 5))' "/deploy DB preflight must use the validated run.sh database port"
require_text "$DEPLOY_ENV" 'if [ "${ROSE_USE_SYSTEM_PG:-false}" = "true" ]; then' "/deploy must point LOCAL_DB_PORT at system Postgres 5432 when ROSE_USE_SYSTEM_PG=true"
DDL_APPLY="$(git rev-parse --show-toplevel)/back-end/scripts/apply-local-workflow-ddl.sh"
require_text "$DDL_APPLY" 'ROSE_USE_SYSTEM_PG' "apply-local-workflow-ddl must honor ROSE_USE_SYSTEM_PG so a leftover empty Docker DB cannot steal DDL"
require_text "$DDL_APPLY" 'if [[ "${ROSE_USE_SYSTEM_PG:-false}" != "true" ]] &&' "apply-local-workflow-ddl must skip docker exec when ROSE_USE_SYSTEM_PG=true"
require_text "$RUN_SH" 'if $USE_SYSTEM_PG; then' "run.sh must apply workflow DDL via host psql under system Postgres"

require_text "$DEPLOY_ENV" 'export LOCAL_DB_PORT=5432' "/deploy system-Postgres path must advertise localhost:5432 to semantic seeders"
require_text "$DEPLOY_ENV" 'export RUN_SH_STRICT_CONDUCTOR_PORT=1' "/deploy must reject silent runtime port reassignment"
require_text "$RUN_SH" 'if ! port_range_can_reassign; then' "run.sh must honor strict deploy port mode"
require_text "$RUN_SH" '[ "${RUN_SH_STRICT_CONDUCTOR_PORT:-0}" = "1" ] || { $BENCHMARK_MODE && [ "${BENCHMARK_BUNDLED_FRONTEND:-false}" = "true" ]' "bundled deploy stacks must preserve strict ports across shell boundaries"
require_text "$RUN_SH" 'if ! $BENCHMARK_MODE && $IS_MAC; then' "benchmark stacks must not install unused mac-app dependencies"
require_text "$RUN_SH" 'VITE_REALTIME_PRIVATE=false \' "bundled local frontends must not request production-only private realtime authorization"
require_text "$RUN_SH" 'ROSE_E2E_FIXTURES=true npx vite build' "bundled semantic stacks must build the dev-only overlay-layers fixture page into the preview"
require_text "$ROOT_DIR/front-end/vite.config.ts" "process.env.ROSE_E2E_FIXTURES === 'true'" "only the opt-in fixture build adds semantic fixture pages"
require_text "$SEMANTIC_STACK" 'BENCHMARK_BUNDLED_FRONTEND=true' "/deploy launch must carry strict-port mode across shell boundaries"
require_text "$SEMANTIC_STACK" 'SEMANTIC_WORKER_PROCESSES="${DEPLOY_SEMANTIC_WORKER_PROCESSES:-8}"' "/deploy semantic stack must default to enough workers for concurrent lifecycle checks"
require_text "$SEMANTIC_STACK" 'BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES="$SEMANTIC_WORKER_PROCESSES"' "/deploy semantic stack must pass its worker count to run.sh"
require_text "$SEMANTIC_STACK" 'TRACE_ARCHIVE_ENABLED=0' "/deploy lifecycle measurements must disable the out-of-band trace recorder"
require_text "$DEPLOY_GATES" "factory_event(root, 'stage-start', 'runtime-blackbox')" "/deploy must record the shared runtime-blackbox start boundary"
require_text "$DEPLOY_GATES" "factory_event(root, 'stage-finish', 'runtime-blackbox')" "/deploy must record the shared runtime-blackbox finish boundary"
# The Claude Code cache-ratchet warn-only wording left deploy.md; its wiring is pinned below
# (run-predeploy-local/cloud, run-bench-cloud, cloudbench-run.sh) and the doc keeps the
# rule that Claude Code task failures still block (Skippable tests).
require_text "$DEPLOY_COMMAND" '| Claude Code smoke | Preflight proves no synced Claude credential and no pool token | Task failures still block |' "/deploy must keep Claude Code task correctness hard-gated"
require_text "$RUN_PREDEPLOY_LOCAL" 'BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY=1' "local predeploy smoke must wire the narrow Claude Code cache-ratchet skip"
require_text "$RUN_PREDEPLOY_LOCAL" 'BENCHMARK_ALLOW_CLAUDE_CODE_CREDENTIAL_SKIP=1' "local predeploy smoke must allow Claude Code credential SKIP when the pool is rate-limited (infra-fix deploys)"
require_text "$ROOT_DIR/agents/benchmarks/run_benchmark.py" 'resolve_hub_upload_url(base_url)' "local smoke must register Hub against the local stack, not hard-default to prod (prod-outage deadlock)"
require_text "$ROOT_DIR/agents/benchmarks/hub_upload.py" 'def resolve_hub_upload_url(' "hub_upload must expose localhost-aware Hub URL resolution"
require_text "$RUN_PREDEPLOY_LOCAL" 'BENCHMARK_COMPUTE_TOKEN_TYPE=claude' "local predeploy smoke must pin one provider for repeatable cache measurement"
require_text "$RUN_PREDEPLOY_LOCAL" 'unset FAST_MODE_CACHE_DATABASE_URL' "local predeploy smoke must reject an inherited remote demo-cache database"
require_text "$RUN_PREDEPLOY_LOCAL" 'grep -E '\''^DATABASE_URL='\''' "local predeploy must derive the shared July cache from prod DATABASE_URL when FAST_MODE_CACHE_DATABASE_URL is missing"
require_text "$RUN_PREDEPLOY_LOCAL" 'FAST_MODE_CACHE_USE_LOCAL=1 \' "local predeploy smoke must isolate demo-cache schema startup from the production pooler"
require_text "$RUN_PREDEPLOY_LOCAL" 'BENCHMARK_FAST_MODE_CACHE=0 \' "local-cache predeploy smoke must force Fast Mode off so seeded users cannot omit the create-body flag"
require_text "$RUN_PREDEPLOY_LOCAL" 'FAST_MODE_CACHE_DISABLE_WRITE_THROUGH=1' "local predeploy must disable Andy write-through when the July cache is shared"
require_text "$RUN_PREDEPLOY_LOCAL" 'run_smoke_batch shared' "local predeploy must isolate demo_cache:on smoke onto the shared July cache batch"
require_text "$ROOT_DIR/agents/benchmarks/tasks.json" '"name": "test-mass-agent-run-0"' "OAi mass-agent bench must remain in the catalog"
MASS_AGENT_SMOKE="$(
  python3 - "$ROOT_DIR/agents/benchmarks/tasks.json" <<'PY'
import json
import sys

tasks = json.load(open(sys.argv[1]))
for task in tasks:
    if task.get("name") == "test-mass-agent-run-0":
        tags = task.get("tags") or []
        print("1" if "smoke" in tags and task.get("group") == "pre-deploy" else "0")
        break
else:
    print("0")
PY
)"
[ "$MASS_AGENT_SMOKE" = "1" ] || fail "test-mass-agent-run-0 must stay tagged smoke + group pre-deploy so /deploy runs it"
require_text "$RUN_PREDEPLOY_CLOUD" 'BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY=1' "cloud predeploy smoke must request the narrow Claude Code cache-ratchet skip"
require_text "$RUN_BENCH_CLOUD" 'BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY=${BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY:-}' "cloud benchmark controller must pass the Claude Code cache-ratchet skip into benchmark machines"
require_text "$CLOUDBENCH_RUN" 'STACK_ENV+=("BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY=$BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY")' "cloud benchmark stack must inherit the Claude Code cache-ratchet skip"
require_text "$CLOUDBENCH_RUN" "export BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY='\$BENCHMARK_CLAUDE_CODE_CACHE_RATCHET_WARN_ONLY'" "cloud benchmark driver must pass the Claude Code cache-ratchet skip into run_benchmark.py"
# Worker widths are host-scaled ceilings in the pipeline planner (the fixed
# BACKEND_BLACKBOX_WORKERS=4/5, BACKEND_UNIT_WORKERS=2, AGENTS_COVERAGE_WORKERS=3,
# FRONTEND_COVERAGE_WORKERS=2 and MAC_COVERAGE_WORKERS=1 values of the retired inline
# skill are gone) and applied through each gate's own concurrency settings.
require_text "$PIPELINE" '"backend_blackbox": scale_workers(min(4, args.backend_blackbox_workers), host),' "/deploy must cap backend blackbox workers by host capacity"
require_text "$PIPELINE" '"backend_unit": scale_workers(min(6, args.backend_unit_workers), host),' "/deploy must cap backend unit workers by host capacity"
require_text "$PIPELINE" '"agents": scale_workers(min(6, args.agents_workers), host),' "/deploy must cap agents workers by host capacity"
require_text "$PIPELINE" '"frontend": scale_workers(min(4, args.frontend_workers), host),' "/deploy must cap frontend workers by host capacity"
require_text "$PIPELINE" '"BLACKBOX_TEST_CONCURRENCY": str(workers["backend_blackbox"]),' "/deploy must apply the computed backend worker budget"
require_text "$PIPELINE" 'env={"AGENTS_COVERAGE_CONCURRENCY": str(workers["agents"])},' "/deploy must apply the computed agents worker budget"
require_text "$PIPELINE" "f\"--maxWorkers={workers['frontend']}\"" "/deploy must apply the computed frontend worker budget"
require_text "$DEPLOY_LIVE_PROBE_RUNNER" '"amplitude-live"' "/deploy must retain the focused live Amplitude probe"
require_text "$DEPLOY_LIVE_PROBE_RUNNER" '"chat-router-failover-live"' "/deploy must replay the e8f2279b chat follow-up through the real OpenRouter failover"
require_text "$DEPLOY_LIVE_PROBE_RUNNER" '"CHAT_ROUTER_FAILOVER_LIVE=1"' "/deploy chat router failover probe must run the live case"
require_text "$DEPLOY_LIVE_PROBE_RUNNER" '"scripts/migration-preflight.ts"' "/deploy must preflight new migrations read-only against production data"
require_text "$DEPLOY_LIVE_PROBE_RUNNER" '"ADMIN_HEALTH_LIVE_ONLY=1"' "/deploy live Amplitude probe must run only the strict weekly endpoint case"
# Fail-closed live Amplitude credentials are exercised directly below.
require_text "$PROD" "BACKEND_RE = re.compile(r'^(back-end/|scripts/run-bench-hub-poller\$)')" "/deploy must classify poller-only changes into backend lanes"
require_text "$ROOT_DIR/back-end/scripts/run-coverage.sh" 'integration-health"' "backend coverage must isolate live credential health from deterministic coverage"
require_text "$ROOT_DIR/agents/scripts/run-coverage.sh" 'playwright install chromium' "agents coverage must install the venv Playwright chromium revision before real-browser blackboxes"
require_text "$ROOT_DIR/back-end/scripts/run-coverage.sh" '  export BACKEND_UNIT_DATABASE_URL="$LOCAL_DB_URL"' "backend coverage must hand unit tests the schema-synced coverage database"
if grep -Fq 'if [[ -n "${BACKEND_COVERAGE_DATABASE_URL:-}" ]]; then' "$ROOT_DIR/back-end/scripts/run-coverage.sh" &&
  grep -A1 -F 'if [[ -n "${BACKEND_COVERAGE_DATABASE_URL:-}" ]]; then' "$ROOT_DIR/back-end/scripts/run-coverage.sh" | grep -Fq 'BACKEND_UNIT_DATABASE_URL'; then
  fail "backend coverage must not gate the unit-test database on BACKEND_COVERAGE_DATABASE_URL (unit tests fall back to a stale shared DB)"
fi
require_text "$ROOT_DIR/back-end/scripts/run-coverage.sh" 'playwright install chromium' "backend coverage must install Node Playwright Chromium before captcha-solve-indicator"
require_text "$DEPLOY_COMMAND" '| Credential health: Anthropic, Parallel.ai | Any failure (warn-only) | Other providers'"'"' auth rejections block |' "/deploy must retain one focused credential probe, blocking every other provider's rejection"
require_text "$DEPLOY_LIVE_PROBE_RUNNER" '"credential-health"' "/deploy must record the focused credential probe"
require_text "$ROOT_DIR/scripts/run-cloudbench-controller-local.py" 'cloud_patch_includes_tracked_and_untracked_changes' "/deploy must gate the cloud patch base-ref contract"
require_text "$ROOT_DIR/scripts/run-cloudbench-controller-local.py" 'worktree_patch_ignores_append_only_history_ledgers' "/deploy must gate the append-only history ledger cloud patch RCA regression"
if grep -Fq 'credential-health blackbox only when Step 4a is skipped' "$DEPLOY_COMMAND" "$DEPLOY_LIVE_PROBE_RUNNER"; then
  fail "/deploy must not retain the retired conditional credential-health wiring"
fi
set +e
# This asserts the Amplitude credential contract, so it invokes the suite
# directly rather than through the runner. The suite's assertLocalDatabase guard
# refuses a non-local DATABASE_URL and back-end/.env points at prod, so pin a
# localhost DSN here. That keeps the guard strict (rather than handing this gate
# the BLACKBOX_TEST_ALLOW_REMOTE_DATABASE escape hatch) and makes it impossible
# for the probe to reach production even if the credential check ever passed.
# Use the workspace tsx binary. The Cloud VM's /exec-daemon/npx (npm 11)
# crashes with "Class extends value undefined is not a constructor or null"
# before tsx starts, which drops the fail-closed credential message and
# fails this gate (docs/rca/cases/2026-10-06-semantic-deploy-amplitude-probe-failure-dropped-its-output.md).
TSX_BIN=""
for tsx_cand in \
  "$ROOT_DIR/node_modules/.bin/tsx" \
  "$ROOT_DIR/back-end/node_modules/.bin/tsx"
do
  if [ -x "$tsx_cand" ]; then
    TSX_BIN="$tsx_cand"
    break
  fi
done
if [ -z "$TSX_BIN" ]; then
  fail "/deploy live Amplitude probe could not start (install back-end workspace deps before this gate)"
fi
LIVE_AMPLITUDE_OUTPUT=$(
  cd "$ROOT_DIR/back-end" &&
    DATABASE_URL='postgresql://postgres:postgres@localhost:1/deploy-gate-unused' \
      DIRECT_URL='postgresql://postgres:postgres@localhost:1/deploy-gate-unused' \
      AMPLITUDE_API_KEY='' AMPLITUDE_SECRET_KEY='' ADMIN_HEALTH_LIVE_ONLY=1 \
      "$TSX_BIN" src/tests/blackbox/admin-health.blackbox.ts 2>&1
)
LIVE_AMPLITUDE_RC=$?
set -e
[ "$LIVE_AMPLITUDE_RC" -ne 0 ] || fail "/deploy live Amplitude probe must reject missing credentials"
# Match from a here-string, not a pipe: under `pipefail`, `printf | grep -q`
# reports 141 when grep exits on its match while printf is still writing later
# lines, so a loaded host failed this check with the message present.
if grep -Fq 'Cannot find module' <<<"$LIVE_AMPLITUDE_OUTPUT"; then
  fail "/deploy live Amplitude probe could not start (install back-end workspace deps before this gate)"
fi
grep -Fq 'ADMIN_HEALTH_LIVE_ONLY=1 requires AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY' \
  <<<"$LIVE_AMPLITUDE_OUTPUT" || {
  printf '%s\n' "$LIVE_AMPLITUDE_OUTPUT" | tail -n 40 >&2
  fail "/deploy live Amplitude probe must explain its fail-closed credential contract"
}
# Retired with the inline skill: the Group 3/Group 4 worker-pool exclusion text, the
# `run-deploy-stage <stage>` fenced AgentCard lane (its env, task list and
# --max-concurrency flags) and the standing production release-stall waiver wording.
# The planner now runs every gate on its own Blacksmith VM (or `--executor local`
# under host admission and memory sampling) and the sandbox AgentCard lifecycle
# tasks are ordinary cloud smoke tasks (asserted in the wiring block above).
# deploy.md states the replacement AgentCard rules.
require_text "$DEPLOY_COMMAND" 'run only when the diff touches AgentCard infrastructure (`AGENTCARD_INFRA_PATH_RE`' "/deploy must run AgentCard tasks only on AgentCard infrastructure changes"
require_text "$DEPLOY_COMMAND" 'then every eligible one runs on the fleet, with no separate AgentCard gate or election.' "/deploy must keep AgentCard tasks inside the smoke lane when they run"
require_text "$DEPLOY_COMMAND" '`releasedCents=0`' "the AgentCard release stall must keep its exact signature"
require_text "$DEPLOY_COMMAND" "agentcard_release_stall" "the AgentCard release stall must be triaged as a resource skip"
require_text "$ROOT_DIR/scripts/deploy_test_cycle.py" 'AGENTCARD_RELEASE_STALL_CODE = "agentcard_release_stall"' "the staged runner must classify the AgentCard release stall"
if grep -Fq 'bash scripts/run-agentcard-lifecycle-task.sh' "$DEPLOY_COMMAND" "$DEPLOY_CLI" "$DEPLOY_GATES"; then
  fail "/deploy must not tear down and rebuild the shared stack for each AgentCard task"
fi
if grep -Fq 'production abandonment stays strict' "$DEPLOY_COMMAND"; then
  fail "/deploy must not contradict the AgentCard release-stall rules"
fi
# The production semantic gate is dispatched by the versioned CLI on the exact merged SHA.
require_text "$PROD" "[PY, 'scripts/run_deploy_pipeline.py', 'production-semantic', '--merged-sha', sha, '--state-dir'," "/deploy must dispatch the production semantic gate through the versioned CLI on the exact merged SHA"
if grep -Fq "gh workflow run chat-lifecycle-ratchet.yml" "$DEPLOY_COMMAND" "$DEPLOY_CLI" "$PROD"; then
  fail "/deploy must not dispatch the production semantic workflow by hand: the raw dispatch tests main's later head, not the merged SHA (#1646)"
fi
require_text "$PROD" "DEVBOX_GH = Path('/opt/devbox-tools/gh/current/bin/gh')" "/deploy must hand the CLI the workflow-scoped gh binary on boxes.dev"
require_text "$PROD" "overrides = {'DEPLOY_GH_BIN': str(DEVBOX_GH)}" "/deploy must export DEPLOY_GH_BIN to the production children"
# The E2B smoke resolves the running stack (or the explicit port) and names the isolated workspace database.
require_text "$SEMANTIC_STACK" 'if stack_ports=$(bash scripts/resolve-deploy-stack-db.sh 2>/dev/null); then' "/deploy E2B smoke must resolve the running stack's ports"
require_text "$SEMANTIC_STACK" 'echo "E2B smoke: invalid Postgres port' "/deploy E2B smoke must reject an invalid database port"
require_text "$SEMANTIC_STACK" 'db_name="victoria_$CONDUCTOR_WORKSPACE_NAME"' "/deploy E2B smoke must name the isolated workspace test database"
require_text "$SEMANTIC_STACK" 'db_url="postgresql://postgres:postgres@localhost:$db_port/$db_name"' "/deploy E2B smoke must target the isolated workspace test database"
# Production lanes: a failed required lane (semantics included) fails the deploy; the single
# failed-jobs retry and concurrent provider lanes are CLI behavior.
require_text "$PROD" "passed = all(records[n]['status'] in SATISFIED for n in applicable)" "/deploy must block on production semantic success"
require_text "$PIPELINE" 'semantic_parser.add_argument("--retry-failed-once", metavar="JUSTIFICATION"' "/deploy must keep the single failed-jobs retry"
require_text "$DEPLOY_COMMAND" 'runs every applicable lane concurrently' "/deploy must not serialize independent production providers"
require_text "$AGENTCARD_LIFECYCLE_SCRIPT" 'export BENCHMARK_SKIP_WMH_BUILD=1' "AgentCard lifecycle stacks must skip unrelated WMH build/refresh before readiness"
require_text "$AGENTCARD_LIFECYCLE_SCRIPT" 'export ROSE_EXCLUDE_ANTHROPIC_FAMILY=1' "AgentCard lifecycle helper must not block on Claude credentials"
require_text "$AGENTCARD_LIFECYCLE_SCRIPT" 'export SEED_REQUIRE_COMPUTE_TOKEN_TYPES=gpt' "AgentCard lifecycle helper must pass GPT-only seed policy into run.sh"

# /descend is part of the deploy orchestration surface. Its behavior has an
# independent owner; the registry check below pins its wiring (deploy.md carries
# no gate list, so the doc-wording check for it is retired).
python3 - "$DEPLOY_STRUCTURAL_RUNNER" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("deploy_workflow_owners", sys.argv[1])
registry = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = registry
spec.loader.exec_module(registry)
for name, command in (
    ("descend-command", ("bash", "scripts/tests/descend-command.test.sh")),
):
    owners = [gate for gate in registry.GATES if gate.name == name or gate.command == command]
    if len(owners) != 1 or owners[0].name != name or owners[0].command != command:
        raise SystemExit(f"FAIL: {name} must have exactly one registered behavior owner")
PY
node --test "$PROD_SESSION_TEST"

# Local semantic workers follow measured host capacity (RCA
# 2026-10-02-semantic-renderer-stall-consumed-chip-poll-budget): at load ~56 on
# 14 cores, four Chromium workers left one renderer frozen for 34s and a 30s
# chip poll failed without ever observing a value. Other workspaces' load may
# never drop, so the runner sizes concurrency (floor 1) instead of waiting.
# gawk >= 5.3 (ubuntu-latest) rejects `-v load=`: "cannot use gawk builtin `load' as variable name" took every
# production semantic job down with exit 2 once prod-mode sizing called this function (run 41250037375).
if grep -nE '^[^#]*-v (load|and|or|xor|lshift|rshift|compl|strtonum|mktime|strftime|systime|gensub|patsplit|asort|asorti|isarray|typeof)=' "$RUNNER"; then
  fail "semantic_workers_for_capacity must not name an awk variable after a gawk builtin (load, and, or, xor, ...)"
fi
if command -v gawk >/dev/null 2>&1; then
  gawk -v load1=1 'BEGIN { exit (load1 == 1 ? 0 : 1) }' || fail "gawk must accept the renamed load1 variable"
fi
eval "$(sed -n '/^semantic_workers_for_capacity() {/,/^}/p' "$RUNNER")"
[ "$(semantic_workers_for_capacity 4 14 56.20 44)" = 1 ] || fail "an overloaded host must drop semantic workers to one"
[ "$(semantic_workers_for_capacity 4 14 1.50 60)" = 4 ] || fail "an idle host must keep the requested semantic workers"
[ "$(semantic_workers_for_capacity 4 14 11.50 60)" = 2 ] || fail "partial headroom must cap semantic workers at whole idle cores"
[ "$(semantic_workers_for_capacity 4 14 1.50 10)" = 1 ] || fail "low free memory must drop semantic workers to one"
[ "$(semantic_workers_for_capacity 1 14 0.10 90)" = 1 ] || fail "host capacity must never raise semantic workers above the request"
[ "$(semantic_workers_for_capacity 4 '' '' '')" = 4 ] || fail "unknown host capacity must not cap semantic workers"
# Production mode passes no load: the dedicated two-vCPU GitHub runner caps on
# CPU count alone (RCA 2026-10-31-production-semantic-gate-oversubscribed-two-vcpu-runner).
[ "$(semantic_workers_for_capacity 4 2 '' 60)" = 2 ] || fail "a two-vCPU dedicated runner must cap semantic workers at two"
[ "$(semantic_workers_for_capacity 4 4 '' 60)" = 4 ] || fail "a four-vCPU dedicated runner must keep the requested four workers"
[ "$(semantic_workers_for_capacity 4 1 '' 60)" = 1 ] || fail "a one-vCPU dedicated runner must serialize semantic workers"
[ "$(semantic_workers_for_capacity 4 2 '' 10)" = 1 ] || fail "low free memory must still drop a dedicated runner to one worker"
eval "$(sed -n '/^probe_semantic_host_capacity() {/,/^}/p' "$RUNNER")"
IFS='|' read -r probe_cpus probe_load probe_mem <<< "$(probe_semantic_host_capacity)"
[[ "$probe_cpus" =~ ^[1-9][0-9]*$ ]] || fail "host capacity probe must report the CPU count"
[[ -z "$probe_load" || "$probe_load" =~ ^[0-9]+\.[0-9]{2}$ ]] || fail "host capacity probe must report the 1-minute load average as a two-decimal number or leave it empty"
[[ -z "$probe_mem" || "$probe_mem" =~ ^[0-9]+$ ]] || fail "host capacity probe must report free memory as a whole percentage"
# The probe caps the affinity count at the CFS bandwidth quota (a quota limits
# CPU time without hiding cores) and withholds the host-wide load whenever the
# allowed CPU count is narrower than the host, because that load mostly
# measures work outside the mask. Exercised against a fake cgroup tree.
PROBE_HOST_CPUS=$(python3 -c 'import os; print(os.cpu_count() or 0)')
PROBE_AFFINITY=$(python3 -c 'import os; print(len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 0))')
FAKE_CGROUP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/semantic-cgroup.XXXXXX")
trap 'rm -rf "$LOCK_TEST_DIR" "$FAKE_CGROUP_ROOT"' EXIT
printf '0::/\n' > "$FAKE_CGROUP_ROOT/proc-cgroup-v2"
printf '200000 100000\n' > "$FAKE_CGROUP_ROOT/cpu.max"
IFS='|' read -r quota_cpus quota_load _ <<< "$(SEMANTIC_CGROUP_ROOT="$FAKE_CGROUP_ROOT" SEMANTIC_PROC_CGROUP="$FAKE_CGROUP_ROOT/proc-cgroup-v2" probe_semantic_host_capacity)"
expected_quota_cpus=$(( PROBE_AFFINITY < 2 ? PROBE_AFFINITY : 2 ))
[ "$quota_cpus" = "$expected_quota_cpus" ] || fail "a cgroup v2 cpu.max of 200000/100000 must cap the probe at two CPUs (got '$quota_cpus', affinity $PROBE_AFFINITY)"
if [ "$PROBE_HOST_CPUS" -gt 2 ]; then
  [ -z "$quota_load" ] || fail "a quota narrower than the host must withhold the host-wide load (got '$quota_load')"
fi
printf '250000 100000\n' > "$FAKE_CGROUP_ROOT/cpu.max"
IFS='|' read -r quota_cpus _ _ <<< "$(SEMANTIC_CGROUP_ROOT="$FAKE_CGROUP_ROOT" SEMANTIC_PROC_CGROUP="$FAKE_CGROUP_ROOT/proc-cgroup-v2" probe_semantic_host_capacity)"
[ "$quota_cpus" = "$(( PROBE_AFFINITY < 3 ? PROBE_AFFINITY : 3 ))" ] || fail "a fractional CFS quota must round up to whole CPUs (got '$quota_cpus')"
printf 'max 100000\n' > "$FAKE_CGROUP_ROOT/cpu.max"
IFS='|' read -r quota_cpus quota_load _ <<< "$(SEMANTIC_CGROUP_ROOT="$FAKE_CGROUP_ROOT" SEMANTIC_PROC_CGROUP="$FAKE_CGROUP_ROOT/proc-cgroup-v2" probe_semantic_host_capacity)"
[ "$quota_cpus" = "$PROBE_AFFINITY" ] || fail "an unlimited cpu.max must leave the affinity count (got '$quota_cpus', affinity $PROBE_AFFINITY)"
if [ "$PROBE_AFFINITY" = "$PROBE_HOST_CPUS" ]; then
  [[ "$quota_load" =~ ^[0-9]+\.[0-9]{2}$ ]] || fail "an unrestricted host must keep subtracting the 1-minute load (got '$quota_load')"
fi
mkdir -p "$FAKE_CGROUP_ROOT/cpu/lane"
printf '4:cpu,cpuacct:/lane\n' > "$FAKE_CGROUP_ROOT/proc-cgroup-v1"
printf '%s\n' 100000 > "$FAKE_CGROUP_ROOT/cpu/lane/cpu.cfs_quota_us"
printf '%s\n' 100000 > "$FAKE_CGROUP_ROOT/cpu/lane/cpu.cfs_period_us"
IFS='|' read -r quota_cpus quota_load _ <<< "$(SEMANTIC_CGROUP_ROOT="$FAKE_CGROUP_ROOT" SEMANTIC_PROC_CGROUP="$FAKE_CGROUP_ROOT/proc-cgroup-v1" probe_semantic_host_capacity)"
[ "$quota_cpus" = 1 ] || fail "a cgroup v1 cfs quota of one period must cap the probe at one CPU (got '$quota_cpus')"
if [ "$PROBE_HOST_CPUS" -gt 1 ]; then
  [ -z "$quota_load" ] || fail "a v1 quota narrower than the host must withhold the host-wide load (got '$quota_load')"
fi
printf '%s\n' -1 > "$FAKE_CGROUP_ROOT/cpu/lane/cpu.cfs_quota_us"
IFS='|' read -r quota_cpus _ _ <<< "$(SEMANTIC_CGROUP_ROOT="$FAKE_CGROUP_ROOT" SEMANTIC_PROC_CGROUP="$FAKE_CGROUP_ROOT/proc-cgroup-v1" probe_semantic_host_capacity)"
[ "$quota_cpus" = "$PROBE_AFFINITY" ] || fail "a cgroup v1 quota of -1 must leave the affinity count (got '$quota_cpus')"
if command -v taskset >/dev/null 2>&1 && [ "$PROBE_HOST_CPUS" -gt 1 ]; then
  first_cpu=$(python3 -c 'import os; print(sorted(os.sched_getaffinity(0))[0])')
  IFS='|' read -r mask_cpus mask_load _ <<< "$(SEMANTIC_CGROUP_ROOT="$FAKE_CGROUP_ROOT" SEMANTIC_PROC_CGROUP="$FAKE_CGROUP_ROOT/proc-cgroup-v2" taskset -c "$first_cpu" bash -c "$(declare -f probe_semantic_host_capacity); probe_semantic_host_capacity")"
  [ "$mask_cpus" = 1 ] || fail "a one-CPU affinity mask must report one CPU (got '$mask_cpus')"
  [ -z "$mask_load" ] || fail "an affinity mask narrower than the host must withhold the host-wide load (got '$mask_load')"
fi
require_text "$RUNNER" 'SEMANTIC_WORKERS=$(semantic_workers_for_capacity "$REQUESTED_SEMANTIC_WORKERS"' "semantic runs must size Playwright workers to measured host capacity"
require_text "$RUNNER" 'echo "  Semantic workers: requested=$REQUESTED_SEMANTIC_WORKERS effective=$SEMANTIC_WORKERS' "semantic runner must log the capacity inputs behind its worker count"
validate_line=$(grep -n 'SEMANTIC_WORKERS must be a positive integer' "$RUNNER" | head -1 | cut -d: -f1)
capacity_line=$(grep -n 'SEMANTIC_WORKERS=$(semantic_workers_for_capacity' "$RUNNER" | head -1 | cut -d: -f1)
first_launch_line=$(grep -n 'run_playwright test' "$RUNNER" | head -1 | cut -d: -f1)
[ -n "$capacity_line" ] && [ "$validate_line" -lt "$capacity_line" ] && [ "$capacity_line" -lt "$first_launch_line" ] \
  || fail "semantic worker sizing must run after request validation and before Playwright launches"
# The sizing block must not be fenced to local mode again: the production gate
# is where four workers met two vCPUs.
if sed -n "${validate_line},${capacity_line}p" "$RUNNER" | grep -q 'PROD_MODE" -eq 0'; then
  fail "semantic worker sizing must apply in production mode as well as local mode"
fi

# LOCAL_DB_PORT + unset DATABASE + set DIRECT must not clobber the caller URL.
REPO_DIR="$LOCK_TEST_DIR"
eval "$(sed -n '/^apply_local_semantic_db_urls() {/,/^}/p' "$RUNNER")"
LOCAL_DB_PORT=4205
unset SEMANTIC_DATABASE_URL
export SEMANTIC_DIRECT_URL='postgresql://custom/direct'
apply_local_semantic_db_urls
[ "$SEMANTIC_DIRECT_URL" = 'postgresql://custom/direct' ] || fail "LOCAL_DB_PORT fallback must preserve caller SEMANTIC_DIRECT_URL"
[[ "$SEMANTIC_DATABASE_URL" == *":4205/"* ]] || fail "LOCAL_DB_PORT fallback must still set SEMANTIC_DATABASE_URL"

# A fresh semantic shell must seed the DB named by the active run.sh stack,
# even when LOCAL_DB_PORT was only present in the stack launcher.
REPO_DIR="$LOCK_TEST_DIR"
mkdir -p "$REPO_DIR/.context"
jq -n --arg worktree "$ROOT_DIR" '{status:"running",worktree:$worktree,urls:{backend:"http://localhost:55170"},ports:{backend:55170},database:{runtime_port:55175,name:"victoria_bench_semantic_fixture"}}' > "$REPO_DIR/.context/services.json"
unset LOCAL_DB_PORT SEMANTIC_DATABASE_URL SEMANTIC_DIRECT_URL
BACKEND_URL='http://localhost:55170'
apply_local_semantic_db_urls
[ "${LOCAL_DB_PORT:-}" = '55175' ] || fail "semantic runner must read the active stack database port"
[[ "$SEMANTIC_DATABASE_URL" == *":55175/"* ]] || fail "semantic runner must seed the active stack database"
[[ "$SEMANTIC_DATABASE_URL" == *"/victoria_bench_semantic_fixture?"* ]] || fail "semantic runner must preserve the active stack database name"
# /deploy also supplies LOCAL_DB_PORT: the manifest must still supply DB name.
unset SEMANTIC_DATABASE_URL SEMANTIC_DIRECT_URL
LOCAL_DB_PORT=55175
apply_local_semantic_db_urls
[[ "$SEMANTIC_DATABASE_URL" == *"/victoria_bench_semantic_fixture?"* ]] || fail "an explicit runtime port must not erase the isolated database identity"
[ "$SEMANTIC_DIRECT_URL" = "$SEMANTIC_DATABASE_URL" ] || fail "semantic direct URL must use the same isolated database identity"
unset SEMANTIC_DATABASE_URL SEMANTIC_DIRECT_URL
LOCAL_DB_PORT=55176
if apply_local_semantic_db_urls 2>/dev/null; then
  fail "semantic runner must reject a caller port that differs from the stack"
fi
[ "$(bash "$STACK_DB_RESOLVER" "$REPO_DIR/.context/services.json")" = $'55170\t55175' ] || fail "/deploy E2B smoke must resolve the Docker stack ports"

unset LOCAL_DB_PORT SEMANTIC_DATABASE_URL SEMANTIC_DIRECT_URL
BACKEND_URL='http://localhost:55180'
if apply_local_semantic_db_urls 2>/dev/null; then
  fail "semantic runner must reject a different stack's database manifest"
fi
LOCAL_DB_PORT=55175
if apply_local_semantic_db_urls 2>/dev/null; then
  fail "an explicit port must not bypass a different stack's database manifest"
fi

# The manifest's runtime port is authoritative for system Postgres too. Its
# allocated Docker port may be unrelated to the database actually in use.
jq -n --arg worktree "$ROOT_DIR" '{status:"running",worktree:$worktree,urls:{backend:"http://localhost:55170"},ports:{backend:55170,local_db:55175},database:{runtime_port:5432,name:"victoria_bench_semantic_fixture"}}' > "$REPO_DIR/.context/services.json"
unset LOCAL_DB_PORT SEMANTIC_DATABASE_URL SEMANTIC_DIRECT_URL
BACKEND_URL='http://localhost:55170'
apply_local_semantic_db_urls
[ "$LOCAL_DB_PORT" = '5432' ] || fail "semantic runner must use the system Postgres runtime port"
[[ "$SEMANTIC_DATABASE_URL" == *":5432/"* ]] || fail "semantic runner must seed the system Postgres runtime"
[[ "$SEMANTIC_DATABASE_URL" == *"/victoria_bench_semantic_fixture?"* ]] || fail "system Postgres must preserve the isolated database name"
[ "$(bash "$STACK_DB_RESOLVER" "$REPO_DIR/.context/services.json")" = $'55170\t5432' ] || fail "/deploy E2B smoke must use system Postgres runtime port"

# A stopped, incomplete, or malformed stack manifest cannot identify the DB.
for manifest in \
  '{"status":"stopped","urls":{"backend":"http://localhost:55170"},"database":{"runtime_port":55175,"name":"victoria_bench_semantic_fixture"}}' \
  '{"status":"running","urls":{"backend":"http://localhost:55170"},"database":{}}' \
  '{'; do
  printf '%s\n' "$manifest" > "$REPO_DIR/.context/services.json"
  unset LOCAL_DB_PORT SEMANTIC_DATABASE_URL SEMANTIC_DIRECT_URL
  if apply_local_semantic_db_urls 2>/dev/null; then
    fail "semantic runner must reject an unusable stack manifest"
  fi
  if bash "$STACK_DB_RESOLVER" "$REPO_DIR/.context/services.json" >/dev/null 2>&1; then
    fail "/deploy E2B smoke must reject an unusable stack manifest"
  fi
done

# Port-only manifests cannot preserve database identity; reject before seeding.
for database in \
  '{"runtime_port":55175}' \
  '{"runtime_port":55175,"name":"unsafe/db"}'; do
  jq -n --argjson database "$database" '{status:"running",urls:{backend:"http://localhost:55170"},database:$database}' > "$REPO_DIR/.context/services.json"
  unset SEMANTIC_DATABASE_URL SEMANTIC_DIRECT_URL
  LOCAL_DB_PORT=55175
  if apply_local_semantic_db_urls 2>/dev/null; then
    fail "semantic runner must reject a missing or malformed manifest database name"
  fi
done

# A caller can supply the database explicitly, even when services.json is bad.
export SEMANTIC_DATABASE_URL='postgresql://custom/semantic'
export SEMANTIC_DIRECT_URL='postgresql://custom/direct'
apply_local_semantic_db_urls
[ "$SEMANTIC_DATABASE_URL" = 'postgresql://custom/semantic' ] || fail "semantic runner must preserve caller SEMANTIC_DATABASE_URL"
[ "$SEMANTIC_DIRECT_URL" = 'postgresql://custom/direct' ] || fail "semantic runner must preserve caller SEMANTIC_DIRECT_URL"

# The /deploy smoke and AgentCard lanes run beside the local latency ratchet and
# drain the shared Cerebras quota: on 2026-10-01 their 429s pushed an
# agent_execute router decision to 5.1s and failed the 5s ratchet. The ratchet
# must wait for every live isolated benchmark run in the worktree.
ISOLATED_BENCHMARKS_LIB="$ROOT_DIR/scripts/lib/isolated-benchmarks.sh"
[ -f "$ISOLATED_BENCHMARKS_LIB" ] || fail "isolated benchmark liveness helper is missing"
require_text "$RUNNER" 'if [[ "${1:-}" == "chat-lifecycle-latency" ]]; then' "local latency ratchet must gate on live isolated benchmark runs"
require_text "$RUNNER" 'wait_for_isolated_benchmarks "$REPO_DIR" "${SEMANTIC_LATENCY_BENCH_WAIT_S:-900}" 30' "local latency ratchet must wait for isolated benchmark runs before measuring"
wait_line=$(grep -n 'wait_for_isolated_benchmarks "$REPO_DIR"' "$RUNNER" | head -1 | cut -d: -f1)
session_line=$(grep -n 'SEMANTIC_SESSION=$(cd "$REPO_DIR/back-end"' "$RUNNER" | head -1 | cut -d: -f1)
[ -n "$wait_line" ] && [ -n "$session_line" ] && [ "$wait_line" -lt "$session_line" ] \
  || fail "latency ratchet must finish waiting before it generates its session"
# The checkout-local wait cannot see other devboxes' deploys or production on
# the shared Cerebras org; the ratchet must also wait on the provider's own
# per-minute headers (cloudbench_provider_headroom.py; unit-tested in
# scripts/tests/deploy-test-worker.test.py CerebrasRatchetHeadroom).
require_text "$RUNNER" 'python3 "$REPO_DIR/scripts/cloudbench_provider_headroom.py" cerebras-wait' "local latency ratchet must wait for the shared Cerebras quota every deploy spends"
quota_line=$(grep -n 'cloudbench_provider_headroom.py" cerebras-wait' "$RUNNER" | head -1 | cut -d: -f1)
[ -n "$quota_line" ] && [ "$wait_line" -lt "$quota_line" ] && [ "$quota_line" -lt "$session_line" ] \
  || fail "shared Cerebras quota wait must run after the local benchmark wait and before the session"
# 2026-11-08: a fail-closed hour-long quota wait held PR1784's semantic gate 70+ min.
# The quota wait is bounded inside the 30 min gate deadline and advisory.
require_text "$RUNNER" '--timeout-seconds "${SEMANTIC_CEREBRAS_WAIT_S:-300}" \' "the shared Cerebras quota wait must stay well inside the semantic gate deadline"
require_text "$RUNNER" 'measuring the latency ratchet anyway' "a short or unreadable Cerebras quota must not fail the gate before the ratchet measures"

. "$ISOLATED_BENCHMARKS_LIB"
bench_repo="$(mktemp -d)"
bench_pids=()
cleanup_bench_fixtures() {
  local pid
  for pid in "${bench_pids[@]:-}"; do
    # The fake run.sh is a bash wrapper around `sleep 30`. End its child first,
    # or the sleeper is orphaned past the suite and flags the staged deploy
    # cycle's structural gate as lingering whenever this suite finishes last.
    [ -n "$pid" ] && pkill -P "$pid" 2>/dev/null || true
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
  rm -rf "$bench_repo" "$LOCK_TEST_DIR"
}
trap cleanup_bench_fixtures EXIT
mkdir -p "$bench_repo/.context/benchmarks/seed-cache" "$bench_repo/scripts"
printf 'sleep 30\n' > "$bench_repo/scripts/run.sh"

wait_for_isolated_benchmarks "$bench_repo" 0 1 >/dev/null \
  || fail "no live isolated benchmark run must not delay the latency ratchet"

python3 -c 'import time; time.sleep(30)' benchmarks/local.py &
controller_pid=$!
bench_pids+=("$controller_pid")
mkdir -p "$bench_repo/.context/benchmarks/1790000000-$controller_pid-12345"
if wait_for_isolated_benchmarks "$bench_repo" 1 1 > "$bench_repo/wait.log" 2>&1; then
  fail "a live benchmarks/local.py controller without a manifest yet must hold the latency ratchet"
fi
grep -Fq "controller PID $controller_pid" "$bench_repo/wait.log" \
  || fail "the latency ratchet wait must name the live benchmark run"

( sleep 2 ) &
short_pid=$!
mkdir -p "$bench_repo/.context/benchmarks/1790000001-$short_pid-12345"
kill "$controller_pid" 2>/dev/null || true
wait "$controller_pid" 2>/dev/null || true
wait_for_isolated_benchmarks "$bench_repo" 20 1 >/dev/null \
  || fail "a run whose PID is not a benchmarks/local.py controller must not hold the latency ratchet"

python3 -c 'import time; time.sleep(2)' benchmarks/local.py &
ending_pid=$!
bench_pids+=("$ending_pid")
mkdir -p "$bench_repo/.context/benchmarks/1790000002-$ending_pid-12345"
wait_for_isolated_benchmarks "$bench_repo" 20 1 >/dev/null \
  || fail "the latency ratchet must start once the benchmark controller exits"

bash "$bench_repo/scripts/run.sh" &
run_sh_pid=$!
bench_pids+=("$run_sh_pid")
run_sh_child_pid=""
for _ in $(seq 1 50); do
  run_sh_child_pid="$(pgrep -P "$run_sh_pid" | head -n 1 || true)"
  [ -n "$run_sh_child_pid" ] && break
  sleep 0.1
done
[ -n "$run_sh_child_pid" ] || fail "the fake run.sh must have started its sleeper"
mkdir -p "$bench_repo/.context/benchmarks/custom-run"
printf '{"status": "running", "run_sh_pid": %s}\n' "$run_sh_pid" > "$bench_repo/.context/benchmarks/custom-run/services.json"
if wait_for_isolated_benchmarks "$bench_repo" 1 1 >/dev/null 2>&1; then
  fail "a running custom-id manifest with a live run.sh must hold the latency ratchet"
fi

# A failed owned cleanup retains run.sh (manifest still "running") so the
# backend reconciler keeps its financial recovery authority, possibly for hours
# while AgentCard withholds a release. Once the recorded benchmark child has
# exited, nothing in that stack is running agents. On 2026-10-07 such a stack
# held the latency ratchet toward its 3600s failure.
retained_owner="$bench_repo/.context/benchmarks/custom-run/local-benchmark-owner.json"
python3 -c 'import time; time.sleep(30)' run_benchmark.py &
retained_child_pid=$!
bench_pids+=("$retained_child_pid")
printf '{"version": 1, "state": "failed_retained", "pid": %s}\n' "$retained_child_pid" > "$retained_owner"
if wait_for_isolated_benchmarks "$bench_repo" 1 1 >/dev/null 2>&1; then
  fail "a retained stack whose benchmark child is still running must hold the latency ratchet"
fi
kill "$retained_child_pid" 2>/dev/null || true
wait "$retained_child_pid" 2>/dev/null || true
printf '{"version": 1, "state": "running", "pid": %s}\n' "$retained_child_pid" > "$retained_owner"
if wait_for_isolated_benchmarks "$bench_repo" 1 1 >/dev/null 2>&1; then
  fail "only a failed_retained owner record may release a running manifest with a live run.sh"
fi
printf '{"version": 1, "state": "failed_retained", "pid": %s}\n' "$retained_child_pid" > "$retained_owner"
wait_for_isolated_benchmarks "$bench_repo" 0 1 >/dev/null \
  || fail "a retained recovery stack whose benchmark child exited must not hold the latency ratchet"
printf '{"version": 1, "state": "failed_retained", "pid": true}\n' > "$retained_owner"
if wait_for_isolated_benchmarks "$bench_repo" 1 1 >/dev/null 2>&1; then
  fail "a retained owner record without an integer benchmark PID must hold the latency ratchet"
fi
rm -f "$retained_owner"

printf '{"status": "stopped", "run_sh_pid": %s}\n' "$run_sh_pid" > "$bench_repo/.context/benchmarks/custom-run/services.json"
wait_for_isolated_benchmarks "$bench_repo" 0 1 >/dev/null \
  || fail "a stopped manifest must not hold the latency ratchet"

if wait_for_isolated_benchmarks "$bench_repo" "10m" 1 >/dev/null 2>&1; then
  fail "a non-integer wait budget must fail closed"
fi

# The fixtures must not outlive the suite: a leaked child kept the staged
# deploy cycle's structural gate from completing on an otherwise idle host.
cleanup_bench_fixtures
if kill -0 "$run_sh_child_pid" 2>/dev/null; then
  fail "fixture cleanup left the fake run.sh child running"
fi

# Every back-end structural suite must be reachable from /deploy: Step 4 runs
# `npm run test:structural`, and that script must list every *.test.ts file.
# `npm run test:structural` is the planner's backend-structural gate (asserted in the
# wiring block above); that script must list every *.test.ts file.
structural_script=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["scripts"]["test:structural"])' "$ROOT_DIR/back-end/package.json")
for structural_test in "$ROOT_DIR"/back-end/src/tests/structural/*.test.ts; do
  case "$structural_script" in
    *"src/tests/structural/$(basename "$structural_test")"*) ;;
    *) fail "back-end structural test $(basename "$structural_test") is not in npm run test:structural, so no gate runs it" ;;
  esac
done

# agents coverage skips the host-wide locked `playwright install` only when
# every dry-run install location is complete; anything else must install.
eval "$(sed -n '/^playwright_chromium_installed() {/,/^}/p' "$ROOT_DIR/agents/scripts/run-coverage.sh")"
pw_dir="$(mktemp -d "${TMPDIR:-/tmp}/pw-installed.XXXXXX")"
mkdir -p "$pw_dir/chromium-1" "$pw_dir/chromium_headless_shell-1"
: >"$pw_dir/chromium-1/INSTALLATION_COMPLETE"
cat >"$pw_dir/fake-python" <<FAKE
#!/usr/bin/env bash
[ "\$FAKE_PLAN" = unreadable ] && exit 1
printf 'Chromium\\n  Install location:    %s/chromium-1\\n\\nHeadless\\n  Install location:    %s/chromium_headless_shell-1\\n' "$pw_dir" "$pw_dir"
FAKE
chmod +x "$pw_dir/fake-python"
if PYTHON_BIN="$pw_dir/fake-python" playwright_chromium_installed; then
  fail "a missing browser revision must not skip the real install"
fi
: >"$pw_dir/chromium_headless_shell-1/INSTALLATION_COMPLETE"
PYTHON_BIN="$pw_dir/fake-python" playwright_chromium_installed ||
  fail "complete browser revisions must skip the host-wide locked install"
if FAKE_PLAN=unreadable PYTHON_BIN="$pw_dir/fake-python" playwright_chromium_installed; then
  fail "an unreadable dry-run plan must fall back to the real install"
fi
rm -rf "$pw_dir"

echo "All semantic deploy gate checks passed."
