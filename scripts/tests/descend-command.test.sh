#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESCEND_COMMAND="$ROOT_DIR/.claude/commands/descend.md"
DESCEND_STEP_LOGGER="$ROOT_DIR/scripts/descend_step_log.py"
DESCEND_STEP_HISTORY="$ROOT_DIR/agents/benchmarks/history/descend_steps.jsonl"
GIT_ATTRIBUTES="$ROOT_DIR/.gitattributes"
RUN_BENCH="$ROOT_DIR/scripts/run-bench"
CLAUDE_RULES="$ROOT_DIR/CLAUDE.md"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local text="$1"
  local description="$2"
  grep -Fq -- "$text" "$DESCEND_COMMAND" || fail "$description"
}

[ -f "$DESCEND_COMMAND" ] || fail "/descend command is missing"
[ -f "$DESCEND_STEP_LOGGER" ] || fail "/descend step logger is missing"
[ -f "$DESCEND_STEP_HISTORY" ] || fail "/descend tracked step history is missing"
grep -Fq 'agents/benchmarks/history/descend_steps.jsonl merge=union' "$GIT_ATTRIBUTES" || \
  fail "/descend step history must merge concurrent workspace records with union"
if git -C "$ROOT_DIR" check-ignore -q "$DESCEND_STEP_HISTORY"; then
  fail "/descend step history must not be gitignored"
fi

require_text "Exactly two planned user-input gates." "/descend must define two planned user gates"
require_text 'Every failed task must enter its own `/RCA`' "/descend must enter RCA before benchmark rerunning"
require_text 'run the unchanged owning-boundary repro red then green' "/descend must require causal fail/pass proof before a benchmark rerun"
require_text 'That exact rerun supplies `/RCA`' "/descend must make the post-approval rerun supply benchmark outcome proof"
require_text "freeze a min-heap" "/descend must freeze a min-heap after the first infra-clean RCA set"
require_text "Andy sees a deeper" "/descend must show a deeper bench only when easier benches are busy"
require_text "not a prod deploy" "/descend must apply approved fixes on a local code snapshot, not a prod deploy"
require_text "original frozen rank" "/descend must reinsert a failed outcome-proof rerun at its original frozen rank"
require_text "Immediately fire a sub-agent" "/descend must start the outcome-proof rerun immediately on approve"
require_text "APPLY_AND_CLOUD_RERUN" "/descend must apply the fix then rerun on the cloud fleet"
require_text "PIPELINE_HEAP" "/descend must pipeline approve, cloud-fleet outcome-proof, and the next ask"
require_text "**Default substrate: cloud fleet.**" "/descend must default benchmark runs to the cloud fleet"
require_text "solely when Andy explicitly" "/descend must require an explicit user opt-in before using --local"
require_text 'scripts/run-bench <task>' "/descend outcome-proof must use cloud-fleet run-bench without --local by default"
if grep -Fq 'scripts/run-bench --local <task>' "$DESCEND_COMMAND"; then
  fail "/descend must not hardcode --local for outcome-proof bench reruns"
fi
require_text "RANK_HEAP" "/descend must rank failing tasks before pipelined fix approval"
require_text "fail-closes on a stale/missing infra-canary stamp" "/descend must document infra-canary fail-closed preflight"
require_text "## One benchmark command" "/descend must define one benchmark entrypoint"
require_text "--concurrency N" "/descend must document bounded benchmark concurrency"
require_text "-k K" "/descend must document repeated isolated benchmark runs"
require_text "scripts/run-bench stability-proof -k K --concurrency N --seed S" \
  "/descend must document the full-catalog no-INFRA command"
require_text "terminal _batch/run.json classification" \
  "/descend must classify capability versus INFRA from the terminal batch"
require_text "distinct controller lock + run ID + machine/volume/queue per instance" \
  "/descend must preserve per-copy isolation"
require_text 'existing always-run `Descend Command` deploy gate' \
  "/descend must keep command proof in the existing zero-cost deploy gate"
# Soft until command-wiring PR lands: runtime preflight in run-bench-fleet is the
# durable substrate guarantee. When the docs are present, pin them strictly.
if grep -Fq 'FLEET_INFRA_CANARY' "$DESCEND_COMMAND"; then
  require_text "bash scripts/run-fleet-infra-canary" "/descend must run the fleet infra canary before the first capability slice"
  require_text "FLEET_INFRA_CANARY" "/descend state machine must include the fleet infra canary step"
  require_text "Cloud Fleet concurrency shapes" "/descend must document sequential/lane/parallel fleet shapes"
  require_text "campaign_cap=1" "/descend must define sequential as campaign_cap=1"
  require_text "campaign_cap=N" "/descend must define lane as campaign_cap=N"
  require_text "CLOUDBENCH_CONTROLLER_LOCK_NAME" "/descend lane mode must require distinct controller locks"
  require_text "run-fleet-concurrency-modes" "/descend must point at the DEMO concurrency e2e that /deploy cements"
  require_text "local_lock_busy" "/descend must treat lane lock serialization as INFRA false-pass"
else
  echo "SKIP: /descend fleet concurrency docs not wired in this tree (runtime preflight covers substrate)"
fi
require_text "HARNESS_FIX_DECISION" "/descend must stop for harness-fix approval"
require_text "DEPLOY_ADMIN_APPROVAL" "/descend must stop for required deploy approval"
require_text "every HARNESS failure has complete causal RCA proof" "/descend must require causal RCA proof before stopping for approval"
require_text "Causal proof; outcome pending" "/descend must distinguish causal RCA proof from exact benchmark outcome proof"
require_text "Never enter HARNESS_FIX_DECISION with an open observability gap." "/descend must keep investigating open observability gaps instead of stopping"  # pragma: allowlist secret
require_text '## `/sync` checkpoints' "/descend must define durable sync checkpoints"
require_text 'including each RCA' "/descend must sync every parallel RCA worker"
require_text 'Run `/sync` before every subset or full-slice rerun.' "/descend must sync before benchmark reruns"
require_text 'Before syncing a dirty controller workspace' "/descend must preserve dirty work across sync checkpoints"
require_text 'before preparing each isolated deploy-unit worktree' "/descend must sync before deploy handoff"
require_text "pause only" "deploy approval must not freeze independent RCA work"
require_text "Prepare a clean" "/descend must use a fix-only isolated deploy worktree"
require_text 'bash scripts/prepare-deploy-worktree.sh' "/descend must provision isolated deploy worktrees before /deploy"
require_text "Bench run:" "/descend header must show benchmark timing"
require_text 'Overall slice: **<passed_original>/<total_original> passed**' "/descend header must report progress against the complete original slice"
require_text 'Latest run: **<passed_run>/<total_run> passed**' "/descend header must label subset-run results separately"
require_text 'Never put the latest subset denominator in the Overall slice field.' "/descend must not present a subset as the full slice"
require_text 'original resolved slice name, exact task list, and total task count;' "/descend state must preserve the original slice denominator"
require_text 'latest executed subset and its exact task list;' "/descend state must distinguish the latest rerun subset"
require_text 'cumulative latest accepted status for every original task;' "/descend state must track overall progress task by task"
require_text "Rows with ⏳ Deploy approval first" "deploy approvals must sort first"
require_text "Rows with ✅ Deployed #<PR> last" "deployed rows must sort last"
require_text "**INFRA:**" "/descend must classify infrastructure failures"
require_text "**HARNESS:**" "/descend must classify trustworthy benchmark failures as harness"
require_text "| ID | Kind | Cluster | Issue (≤100 chars) | RCA | Fix | Test | Approval | Real rerun | Deploy |" "/descend must use an issue-oriented lifecycle table with a pinned issue cluster"
require_text "Browser agent failed to start because proxy generation returned HTTP 400" "/descend issue rows must state the concrete observed failure"
require_text "The issue is **<root cause at the first-bad boundary>**" "fix approval must explain the RCA"
require_text "where we measured **<measurement>**" "fix approval must report the repro measurement"
require_text "The unchanged local repro now" "fix approval must report post-fix proof"
require_text "**Is this fix approved?**" "fix approval must ask a clear decision question"
require_text "agents/benchmarks/history/descend_steps.jsonl" "/descend must write step timings to tracked history"
require_text "scripts/descend_step_log.py start" "/descend must start its first timed step"
require_text "scripts/descend_step_log.py transition" "/descend must time every state transition"
require_text "scripts/descend_step_log.py finish" "/descend must close terminal and parallel timing lanes"
require_text "scripts/descend_step_log.py report" "/descend must analyze iteration-speed trends"
require_text 'standard factory telemetry envelope' "/descend timings must use the factory telemetry standard"
require_text '`stage-start` and `stage-finish`' "/descend timings must record paired stage boundaries"
require_text 'terminal `outcome`' "/descend timings must record the terminal outcome"
require_text '`FACTORY_EVENT`' "/descend timing commands must expose factory events"
require_text '`scripts/factory_review.py` consumes' "/descend timing history must feed factory review"

RESPONSE_CONTRACT=$(sed -n '/^## Response contract/,$p' "$DESCEND_COMMAND")
STOP_ONE_CONTRACT=$(sed -n '/^## Stop 1 — HARNESS_FIX_DECISION/,/^## Rerun and parallel deploy/p' "$DESCEND_COMMAND")
SYNC_CONTRACT=$(sed -n '/^## `\/sync` checkpoints/,/^## State machine/p' "$DESCEND_COMMAND")
INFRA_LOOP=$(sed -n '/^The infra loop is strict:/,/^Do not stop for Andy/p' "$DESCEND_COMMAND")
HARNESS_RCA=$(sed -n '/^## HARNESS RCA/,/^## Stop 1/p' "$DESCEND_COMMAND")
grep -Fq 'each distinct `/RCA` invocation' <<<"$SYNC_CONTRACT" || fail "sync checkpoints must run before each distinct RCA"
grep -Fq 'run /sync immediately before each distinct /RCA' <<<"$INFRA_LOOP" || fail "infra RCA loop must sync before every RCA"
grep -Fq 'Run `/sync` immediately before every distinct `/RCA`' <<<"$HARNESS_RCA" || fail "harness RCA loop must sync before every RCA"
grep -Fq 'or an honest open observability gap' <<<"$STOP_ONE_CONTRACT" && fail "open observability gaps must not qualify for the harness-fix decision stop"  # pragma: allowlist secret
grep -Fq '~~~text' <<<"$RESPONSE_CONTRACT" && fail "response examples must not use code blocks"
grep -Fq '━' <<<"$RESPONSE_CONTRACT" && fail "response header must not use an ASCII banner"
grep -Fq '| Andy decision |' <<<"$RESPONSE_CONTRACT" && fail "Andy and Admin must not be separate columns"
grep -Fq '| Admin approval |' <<<"$RESPONSE_CONTRACT" && fail "Andy and Admin must not be separate columns"
grep -Fq '| Benchmark |' <<<"$RESPONSE_CONTRACT" && fail "real rerun must replace the ambiguous Benchmark column"

python3 "$ROOT_DIR/scripts/tests/descend-step-log.test.py"
bash "$ROOT_DIR/scripts/tests/fleet-infra-stability-proof.test.sh"

grep -Fq '`scripts/run-bench` is the one supported entrypoint' "$CLAUDE_RULES" \
  || fail "CLAUDE.md must name the canonical benchmark command"
grep -Fq '`scripts/run-bench <task> -k K --concurrency N`' "$CLAUDE_RULES" \
  || fail "CLAUDE.md must document repeat and concurrency flags"

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT
mkdir -p "$tmp/captures"
cat >"$tmp/fake-fleet" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
capture="$RUN_BENCH_FAKE_CAPTURE_ROOT/$RUN_BENCH_CAMPAIGN_ID/$RUN_BENCH_CAMPAIGN_JOB_ID"
mkdir -p "$(dirname "$capture")"
{
  printf 'task=%s\n' "$RUN_BENCH_CAMPAIGN_TASK"
  printf 'run=%s\n' "$RUN_BENCH_CAMPAIGN_RUN"
  printf 'lock=%s\n' "$CLOUDBENCH_CONTROLLER_LOCK_NAME"
  printf 'parent=%s\n' "${BENCHMARK_HUB_PARENT_RUN_ID:-}"
  printf 'args='
  printf '<%s>' "$@"
  printf '\n'
} >"$capture"
sleep 0.02
if [ "${RUN_BENCH_FAKE_FAIL_RUN:-}" = "$RUN_BENCH_CAMPAIGN_RUN" ]; then
  exit 17
fi
SH
chmod +x "$tmp/fake-fleet"

run_campaign() {
  local campaign_id="$1"
  shift
  RUN_BENCH_CAMPAIGN_ID="$campaign_id" \
  RUN_BENCH_CAMPAIGN_ROOT="$tmp/campaigns" \
  RUN_BENCH_FAKE_CAPTURE_ROOT="$tmp/captures" \
  RUN_BENCH_FLEET_BIN_UNDER_TEST="$tmp/fake-fleet" \
    "$RUN_BENCH" "$@"
}

run_campaign repeat-short demo-fleet-alpha -k=4 --concurrency=2 --timeout 7
python3 - "$tmp/campaigns/repeat-short/summary.json" "$tmp/captures/repeat-short" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text())
captures = sorted(Path(sys.argv[2]).iterdir())
assert summary["status"] == "passed"
assert summary["runs"] == 4
assert summary["concurrency"] == 2
assert summary["total_jobs"] == 4
assert summary["peak_concurrency"] == 2
assert [job["run"] for job in summary["jobs"]] == [1, 2, 3, 4]
assert len({job["controller_lock"] for job in summary["jobs"]}) == 4
assert len(captures) == 4
for capture in captures:
    text = capture.read_text()
    assert "task=demo-fleet-alpha" in text
    assert "parent=\n" in text, (
        "campaign child inherited a parent Hub run that the campaign never registered"
    )
    assert "<demo-fleet-alpha><--timeout><7><--foreground>" in text
PY

set +e
RUN_BENCH_FAKE_FAIL_RUN=2 run_campaign repeat-long \
  demo-fleet-alpha --runs 3 --concurrency 2
campaign_status=$?
set -e
[ "$campaign_status" -eq 17 ] \
  || fail "campaign must propagate the first child exit exactly (got $campaign_status)"
python3 - "$tmp/campaigns/repeat-long/summary.json" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text())
assert summary["status"] == "failed"
assert summary["total_jobs"] == 3
assert [job["controller_exit_code"] for job in summary["jobs"]] == [0, 17, 0]
PY

mkdir -p "$tmp/catalog"
cat >"$tmp/catalog/tasks.json" <<'JSON'
[
  {"name":"slice-smoke","status":"ready","tags":["smoke"]},
  {"name":"slice-daily","status":"ready","bench":"pipeline-e2e"}
]
JSON
cat >"$tmp/catalog/polar_tasks.json" <<'JSON'
[
  {"name":"slice-polar","status":"ready","group":"polar-bench","tags":["polar-bench"]}
]
JSON
RUN_BENCH_CATALOG_UNDER_TEST="$tmp/catalog/tasks.json" \
  run_campaign named-slices pre-deploy daily --concurrency=2
python3 - "$tmp/campaigns/named-slices/summary.json" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text())
assert summary["task_count"] == 2
assert summary["total_jobs"] == 2
assert summary["peak_concurrency"] == 2
assert [job["task"] for job in summary["jobs"]] == ["slice-smoke", "slice-daily"]
PY

for invalid in '-k=0' '--runs=bad' '--concurrency=0'; do
  if run_campaign "invalid-${invalid//[^a-zA-Z0-9]/-}" demo-fleet-alpha "$invalid" \
      >"$tmp/invalid.out" 2>&1; then
    fail "$invalid must fail closed"
  fi
  grep -Fq 'must be positive integers' "$tmp/invalid.out" \
    || fail "$invalid must explain its positive-integer contract"
done

echo "All /descend command checks passed."
