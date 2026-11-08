#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESCEND_COMMAND="$ROOT_DIR/.claude/commands/descend.md"
DESCEND_STEP_LOGGER="$ROOT_DIR/scripts/descend_step_log.py"
DESCEND_OUTCOME_RUNS="$ROOT_DIR/scripts/descend_outcome_runs.py"
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
  [[ "$DESCEND_NORMALIZED" == *"$text"* ]] || fail "$description"
}

[ -f "$DESCEND_COMMAND" ] || fail "/descend command is missing"
DESCEND_NORMALIZED="$(python3 - "$DESCEND_COMMAND" <<'PY'
import re
import sys
from pathlib import Path
print(re.sub(r"\s+", " ", Path(sys.argv[1]).read_text()))
PY
)"
[ -f "$DESCEND_STEP_LOGGER" ] || fail "/descend step logger is missing"
[ -f "$DESCEND_OUTCOME_RUNS" ] || fail "/descend outcome-proof run counter is missing"
[ -f "$DESCEND_STEP_HISTORY" ] || fail "/descend tracked step history is missing"
grep -Fq 'agents/benchmarks/history/descend_steps.jsonl merge=union' "$GIT_ATTRIBUTES" || \
  fail "/descend step history must merge concurrent workspace records with union"
if git -C "$ROOT_DIR" check-ignore -q "$DESCEND_STEP_HISTORY"; then
  fail "/descend step history must not be gitignored"
fi

# /descend runs one loop: cloud-fleet batches, one self-deduplicating /RCA per
# failed task, a 95% full-slice goal and /deploy's approval step as the only
# review. Each pin is an exact phrase of the command's key decisions.
section_text() {
  local start="$1" stop="$2"
  grep -Fxq -- "$start" "$DESCEND_COMMAND" || fail "/descend must keep its '$start' section"
  grep -Fxq -- "$stop" "$DESCEND_COMMAND" || fail "/descend must keep its '$stop' section"
  awk -v start="$start" -v stop="$stop" '
    $0 == start { inside = 1 }
    inside && $0 == stop { exit }
    inside { print }
  ' "$DESCEND_COMMAND" | tr -s '[:space:]' ' '
}

require_section_text() {
  local section="$1" text="$2" description="$3"
  [[ "$section" == *"$text"* ]] || fail "$description"
}

# Done, process and state machine.
require_text 'One full-slice run reaches a 95% pass rate' "/descend must finish when one full-slice run reaches 95%"
require_text 'then start `/deploy`, whose approval step is the only review' "/descend must make /deploy's approval step its only review"
require_text 'never add another gate' "/descend must not add gates beyond the user's acceptance rule"
require_text 'Start the descent with `/goal` on the slice reaching 95%.' "/descend must run as a /goal on the 95% slice target"
require_text 'Read `/benchmark`, `/rca` and `/deploy` first' "/descend must load the commands it orchestrates"
require_text 'python3 scripts/cloudbench_catalog.py resolve agents/benchmarks/tasks.json <slice>' "/descend must resolve its slice through the catalog"
require_text 'freeze its names, count and goal in state' "/descend must freeze the resolved slice"
for state in RESOLVE_SLICE SYNC_CHECKPOINT PLAN_BATCH RUN_BATCH OBSERVE INFRA_REPAIR RCA_FAILURES \
  ITERATION_RETRO NEXT_BATCH_OR_ROTATION RERUN_FULL_SLICE FINAL_CHANGE_REVIEW; do
  require_text "| \`$state\` |" "/descend state machine must include $state"
done
require_text '| `DONE` / `BLOCKED` |' "/descend state machine must end in DONE or BLOCKED"
require_text 'Once the batches have covered every task and pass at 95% or more, run the whole slice as one launch; below 95% returns to 7' \
  "/descend must rerun the whole slice once batches cover it at 95%"
require_text 'Name the slowest step and apply one speedup, or record why none exists' "/descend must retro every iteration for one speedup"
require_text 'an explicit user hold or go-gate overrides automatic batch advance' "/descend must honor user holds over automatic batches"
require_text "never import another run's profile" "/descend must persist the user's own run profile"
require_text 'an unreproduced cause stays open' "/descend must keep unreproduced causes open"

# Running benchmarks: cloud fleet by default, one launch per batch, no proof reruns.
require_text 'scripts/run-bench <tasks...> -k K --concurrency N' "/descend must launch batches through run-bench with -k and --concurrency"
require_text 'Run every batch and rerun on the cloud fleet' "/descend must default benchmark runs to the cloud fleet"
require_text 'use `--local` only when the user asks' "/descend must require an explicit user request before using --local"
if grep -Fq 'scripts/run-bench --local <task>' "$DESCEND_COMMAND"; then
  fail "/descend must not hardcode --local for benchmark reruns"
fi
require_text 'Never split a batch across launches and never launch proof reruns; the next batch run is the outcome proof.' \
  "/descend must launch each batch once and use the next batch as outcome proof"
require_text 'A sharded (>32-copy) run needs a clean pushed commit' "/descend must pin sharded runs to a clean pushed commit"
require_text 'copy its evidence, TERM its exact owner, and wait for its resources to be released before relaunching' \
  "/descend must supersede a live run only through its exact owner"
require_text 'scripts/run-bench monitor <run-dir>' "/descend must observe runs through run-bench monitor"
require_text 'diagnose errors with sub-agents as they arrive' "/descend must diagnose errors while the batch runs"
require_text 'publish the card at start, every 15 minutes, when nothing is left queued and at end' "/descend must publish its card on the fixed cadence"

BATCH_SCHEDULE="$(section_text '## Batch schedule' '## Stopping conditions')"
require_section_text "$BATCH_SCHEDULE" '`-k` sets how many copies of each run (20 tasks at `-k 3` schedule 60 copies)' \
  "/descend must count batch size in tasks and copies with -k"
require_section_text "$BATCH_SCHEDULE" 'Start at 20 tasks; after a batch with at least a 70% pass rate grow by 10 (at most 70), and after one below 70% shrink by 10 (at least 20).' \
  "/descend must start at 20 tasks and grow or shrink by 10 around a 70% pass rate within 20-70"
require_section_text "$BATCH_SCHEDULE" 'Order unvisited tasks by shortest effective timeout first' "/descend must order batches by shortest effective timeout"
require_section_text "$BATCH_SCHEDULE" 'keep a cohort for 5 iterations' "/descend must rotate cohorts every 5 iterations"
require_section_text "$BATCH_SCHEDULE" 'after the last cohort, loop back to the first' "/descend must loop back to the first cohort"
require_section_text "$BATCH_SCHEDULE" 'A batch stopped at 5% infra is rerun after its infra repair and never counts as an iteration' \
  "/descend must not count infra-stopped batches as iterations"
require_section_text "$BATCH_SCHEDULE" 'and the rotation cursor in state' "/descend must persist the batch rotation cursor"

STOPPING="$(section_text '## Stopping conditions' '## RCA per failure')"
require_section_text "$STOPPING" '`scheduled_total > 0 && 20 * infra_failed_jobs >= scheduled_total` (30 of 600; exactly 5% stops)' \
  "/descend must stop at >=5% infra of the fixed scheduled total, equality included"
require_section_text "$STOPPING" 'count each scheduled job once, retries never change either count' "/descend must keep the infra denominator fixed"
require_section_text "$STOPPING" "unknown or cancelled jobs without infra evidence don't count" "/descend must not count unknown jobs as infra"
require_section_text "$STOPPING" 'Fix those infra blockers immediately (ship with `/push` if production needs them), then rerun the same batch until it completes under 5%' \
  "/descend must repair infra autonomously and rerun the same batch"
require_section_text "$STOPPING" 'never auto-launch after NO TERMINAL ATTEMPTS' "/descend must not auto-launch after a run with no terminal attempts"
require_section_text "$STOPPING" 'Preserve the first breach, original clocks and every physical attempt.' "/descend must preserve infra-stop evidence"

RCA_PER_FAILURE="$(section_text '## RCA per failure' '## Fixes')"
require_section_text "$RCA_PER_FAILURE" 'INFRA means the environment failed before a trustworthy verdict; HARNESS means a trustworthy verdict failed real criteria' \
  "/descend must define INFRA and HARNESS"
require_section_text "$RCA_PER_FAILURE" 'As each task fails, start one muted `/RCA` thread for it' "/descend must start one /RCA per failed task"
require_section_text "$RCA_PER_FAILURE" 'a 60-minute time box' "/descend must time-box each RCA at 60 minutes"
require_section_text "$RCA_PER_FAILURE" 'fixing starts while the batch still runs' "/descend must start RCAs before the batch ends"
require_section_text "$RCA_PER_FAILURE" 'RCAs dedupe themselves' "/descend RCAs must deduplicate themselves"
require_section_text "$RCA_PER_FAILURE" 'hands its task to that owner with its evidence (run, attempt and agent IDs, FE link, the matching boundary) and stops' \
  "a duplicate RCA must hand over its evidence to the owner"
require_section_text "$RCA_PER_FAILURE" 'the later of two RCAs naming the same site hands over the same way' "/descend must resolve concurrent RCAs of one defect"
require_section_text "$RCA_PER_FAILURE" 'Never treat a shared symptom (failure string, evaluator, status, timeout, website or issue class) as the same defect.' \
  "/descend must not dedupe RCAs on a shared symptom"
require_section_text "$RCA_PER_FAILURE" 'prove evaluator defects with judge-only replays and count the verdicts they change' "/descend must prove evaluator defects"
require_section_text "$RCA_PER_FAILURE" 'Every RCA names a concrete defect at a code site (does X, should do Y, observed Z); a measurement is not a cause.' \
  "every RCA must name a concrete defect"

FIXES="$(section_text '## Fixes' '## Final change review')"
require_section_text "$FIXES" 'At 50 minutes tell the owner: "10 minutes left: commit what works and hand back your evidence now, or it is lost." At 60 minutes take what it handed back.' \
  "/descend must warn RCA owners at 50 minutes and collect at 60"
require_section_text "$FIXES" "The next batch launches once every RCA's fix is applied or its time box expires" "/descend must not wait past the RCA time box"
require_section_text "$FIXES" 'an expired RCA keeps its evidence, carries over, and never ships a guessed repair' "an expired RCA must carry over without a guessed fix"
require_section_text "$FIXES" 'it never uses a full end-to-end benchmark rerun as proof' "RCA fixes must be proven by isolated repros, not benchmark reruns"
require_section_text "$FIXES" 'lands that regression in the owning suite' "RCA fixes must land a regression"
require_section_text "$FIXES" 'Never run `scripts/setup-db.sh` from a child worktree' "RCA worktrees must not reset shared databases"
require_section_text "$FIXES" 'Workers never contact the user, change the active benchmark snapshot, launch paid runs or deploy' \
  "/descend workers must leave users, runs and deploys to the parent"
require_section_text "$FIXES" 'its own row-tagged commit on the descent branch so it can be ablated' "/descend must apply each fix as an ablatable commit"
require_section_text "$FIXES" 'Never `/deploy` to test a change; infra blockers that production needs ship with `/push`, everything else waits for the end.' \
  "/descend must not deploy to test a change and must ship infra blockers with /push"
require_section_text "$FIXES" 'a task that passes confirms its fix; a task that still fails gets a fresh RCA from its newest run' \
  "/descend must confirm fixes in the next batch run"

require_text 'changes only when a fresh read-only cross-reviewer, independent of the RCA and fix authors' "/descend must cross-review every task-definition change"
require_text 'never loosens criteria, raises a timeout or renames a task' "/descend task edits must not loosen benchmarks"
require_text 'Never weaken a repro, relabel a runtime or product defect as INFRA' "/descend must not relabel defects as INFRA"
require_text 'A missing compute token is not a skip' "/descend must treat compute-token fallback failures as bugs"

FINAL_REVIEW="$(section_text '## Final change review' '## State and timing')"
require_section_text "$FINAL_REVIEW" "\`/deploy\`'s approval step covers the hunks its guards flag (a GROUNDED golden review clears them)" \
  "/descend's final change review must be /deploy's approval step for guarded changes"
require_section_text "$FINAL_REVIEW" 'every task-definition edit goes to the user with its cross-review evidence' "task-definition edits must reach the user"
require_section_text "$FINAL_REVIEW" 'A rejected change is reverted, then its tasks and the full slice are rerun before the deploy freeze' \
  "a rejected change must be reverted and the slice rerun"
require_section_text "$FINAL_REVIEW" 'Quarantined tasks are listed in the same packet with their provider evidence.' "quarantines must be reported in the review"

STATE_TIMING="$(section_text '## State and timing' '## Response contract')"
require_section_text "$STATE_TIMING" '.context/descend/<run-id>/state.json' "/descend must keep durable state"
require_section_text "$STATE_TIMING" 'original slice, task list, count and goal' "/descend state must preserve the original slice denominator"
require_section_text "$STATE_TIMING" "latest subset; each task's latest accepted status" "/descend state must track the latest subset and every task's status"
require_section_text "$STATE_TIMING" 'frozen scheduled total, terminal attempts and infra counts' "/descend state must freeze the scheduled total"
require_section_text "$STATE_TIMING" 'the RCA ledger (task, owner thread, named defect, state, handed-to)' "/descend state must hold the RCA ledger"
require_section_text "$STATE_TIMING" 'the change ledger: row tag to commit SHA, which hunks are guarded, golden-reference verdict and reviewer' \
  "/descend state must hold the change ledger"
require_section_text "$STATE_TIMING" 'After compaction reload state, never rebuild it from memory' "/descend must reload state after compaction"
require_section_text "$STATE_TIMING" 'agents/benchmarks/history/descend_steps.jsonl' "/descend must write step timings to tracked history"
require_section_text "$STATE_TIMING" 'give each RCA lane its own `--lane rca-<ID>` pair' "/descend must time RCA lanes separately"
require_section_text "$STATE_TIMING" 'pass only verified counts with `--detail`' "/descend timing details must be verified counts"
require_section_text "$STATE_TIMING" 'Commit new timing rows alone before every `/sync` and before the final response.' "/descend must commit timing rows alone before syncing"
require_section_text "$STATE_TIMING" '`/sync` before the first batch, before each fix worktree and before every batch' "/descend must define its /sync checkpoints"
require_section_text "$STATE_TIMING" 'before syncing a dirty controller save state and keep in-progress work recoverable' "/descend must preserve dirty work across syncs"
require_section_text "$STATE_TIMING" 'let a failed sync block only its own action' "a failed sync must block only its own action"
require_section_text "$STATE_TIMING" 'Export `FACTORY_METADATA_FILE` per `docs/factory-telemetry.md` before the first timed step' \
  "/descend must export factory metadata before timing"
require_section_text "$STATE_TIMING" 'report model, effort, tier and collection gaps in the final card' "/descend must report factory metadata gaps"
require_text 'python3 scripts/descend_step_log.py start --run-id $RUN_ID --slice $SLICE --lane main --step RESOLVE_SLICE --epoch 1' \
  "/descend must start its first timed step"
require_text 'python3 scripts/descend_step_log.py transition --run-id $RUN_ID --lane main --step <STATE> --epoch $EPOCH' \
  "/descend must time every state transition"
require_text 'finish --status completed --run-terminal --detail scheduled_total=N --detail infra_failed=N' "/descend must close its clock with verified counts"
require_text 'python3 scripts/descend_step_log.py report --slice $SLICE --task-count $N --lane main --window 5' \
  "/descend must analyze iteration-speed trends"

# The documented clock commands must run as written through every process state.
python3 - "$DESCEND_COMMAND" "$DESCEND_STEP_LOGGER" <<'PY'
import re
import subprocess
import sys
import tempfile
from pathlib import Path

command, logger = sys.argv[1], sys.argv[2]
states = re.findall(r"^\| \d+ \| `([A-Z_]+)`", Path(command).read_text(), flags=re.M)
assert states[0] == "RESOLVE_SLICE" and states[-2:] == ["FINAL_CHANGE_REVIEW", "DONE"], states
with tempfile.TemporaryDirectory() as temporary:
    storage = ["--history", f"{temporary}/descend_steps.jsonl", "--state-root", f"{temporary}/state"]

    def run(*args):
        completed = subprocess.run(
            [sys.executable, logger, *args, *storage], capture_output=True, text=True, timeout=30
        )
        assert completed.returncode == 0, (args, completed.stdout, completed.stderr)
        return completed.stdout

    run("start", "--run-id", "descend-fixture", "--slice", "polar-20", "--lane", "main",
        "--step", states[0], "--epoch", "1")
    for state in states[1:]:
        run("transition", "--run-id", "descend-fixture", "--lane", "main", "--step", state, "--epoch", "1")
    run("finish", "--run-id", "descend-fixture", "--lane", "main", "--status", "completed",
        "--run-terminal", "--detail", "scheduled_total=60", "--detail", "infra_failed=0")
    report = run("report", "--slice", "polar-20", "--task-count", "0", "--lane", "main", "--window", "5")
    assert "FINAL_CHANGE_REVIEW" in report, report
PY

RESPONSE_CONTRACT="$(section_text '## Response contract' '## References')"
require_section_text "$RESPONSE_CONTRACT" 'Render every card with `scripts/run-bench scorecard <run-dir> --html <file>` per `scripts/run-bench report-format` and publish it' \
  "/descend must render cards with the shared scorecard command"
require_section_text "$RESPONSE_CONTRACT" 'never a proof or recovery run' "/descend cards must show real batch or slice runs"
require_section_text "$RESPONSE_CONTRACT" 'Show `Overall slice: <passed>/<original total>` and `Latest run: <passed>/<batch total>` with producer-artifact times' \
  "/descend cards must separate Overall slice from Latest run with producer times"
require_section_text "$RESPONSE_CONTRACT" 'never put a batch denominator in the Overall slice field' "/descend must not present a batch as the full slice"
require_section_text "$RESPONSE_CONTRACT" 'List each open RCA in ISSUES / NEXT ACTION with its tasks, named defect, owner and fix state.' \
  "/descend cards must list open RCAs"
require_section_text "$RESPONSE_CONTRACT" "the largest step regression and improvement, and the retro's chosen speedup" "/descend cards must report timing trends"
for forbidden in '~~~text' '| Andy decision |' '| Admin approval |' '| Benchmark |'; do
  [[ "$RESPONSE_CONTRACT" != *"$forbidden"* ]] || fail "/descend response contract must not contain '$forbidden'"
done
require_text '.claude/shared/benchmark-report-format.txt' "/descend must use the shared benchmark scorecard"

# Removed gates and formats must not return.
for removed in 'HARNESS_FIX_DECISION' 'DEPLOY_ADMIN_APPROVAL' 'Exactly two planned user-input gates' \
  'Every /descend response uses real rendered Markdown' 'Only after an infra-clean run.' \
  'while the latest run contains any INFRA result:'; do
  if grep -Fq -- "$removed" "$DESCEND_COMMAND"; then
    fail "/descend retained removed gate or format: $removed"
  fi
done

python3 "$ROOT_DIR/scripts/tests/descend-step-log.test.py"
bash "$ROOT_DIR/scripts/tests/fleet-infra-stability-proof.test.sh"

grep -Fq '`scripts/run-bench` is the one supported entrypoint' "$CLAUDE_RULES" \
  || fail "CLAUDE.md must name the canonical benchmark command"
grep -Fq '`scripts/run-bench <task> -k K --concurrency N`' "$CLAUDE_RULES" \
  || fail "CLAUDE.md must document repeat and concurrency flags"

tmp="$(mktemp -d)"
cleanup() {
  if [ -n "${group_fixture_pid:-}" ]; then kill "$group_fixture_pid" 2>/dev/null || true; wait "$group_fixture_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
mkdir -p "$tmp/captures"
python3 - "$tmp" <<'GROUP_HTTP' &
import gzip,json,sys
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
root=Path(sys.argv[1]); records={}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        data=self.rfile.read(int(self.headers['Content-Length']))
        if self.headers.get('Content-Encoding')=='gzip': data=gzip.decompress(data)
        body=json.loads(data); records[body['run_id']]=body
        self.send_response(201);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'run':body}).encode())
    def do_GET(self):
        record=records.get(self.path.rsplit('/',1)[-1])
        self.send_response(200 if record else 404);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'run':record}).encode())
server=HTTPServer(('127.0.0.1',0),Handler)
(root/'group-http.port').write_text(str(server.server_port));server.serve_forever()
GROUP_HTTP
group_fixture_pid=$!
for _ in {1..100}; do [ -f "$tmp/group-http.port" ] && break; sleep 0.02; done
[ -f "$tmp/group-http.port" ] || fail "group metadata fixture did not start"
export BENCHMARK_HUB_UPLOAD_URL="http://127.0.0.1:$(cat "$tmp/group-http.port")"
export BENCHMARK_HUB_API_KEY="offline-group-fixture"

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
  CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY=0 \
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

python3 - "$ROOT_DIR" "$tmp/wide-names" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
from cloudbench_catalog import load_unified_catalog

names = [task["name"] for task in load_unified_catalog(root / "agents/benchmarks/tasks.json")
         if task.get("status", "ready") == "ready" and not task.get("production_only")][:50]
assert len(names) == len(set(names)) == 50
Path(sys.argv[2]).write_text("\n".join(names) + "\n")
PY
cat >"$tmp/wide-fleet" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
python3 - "$RUN_BENCH_WIDE_CAPTURE" "$@" <<'PY'
import json
import os
import sys
with open(sys.argv[1], "a") as stream:
    stream.write(json.dumps({"args": sys.argv[2:], "backstop": os.environ.get("BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS")}) + "\n")
PY
SH
wide_names=()
while IFS= read -r name; do wide_names+=("$name"); done <"$tmp/wide-names"
# Fifty simultaneous copies exceed one controller's copy bound. With an option
# the sharded operator refuses (--autoscale-max), auto routing keeps the whole
# slice as one ordinary fleet and names the option in one warning.
: >"$tmp/wide-capture"
RUN_BENCH_FLEET_BIN_UNDER_TEST="$tmp/wide-fleet" \
RUN_BENCH_WIDE_CAPTURE="$tmp/wide-capture" \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300 \
  "$RUN_BENCH" "${wide_names[@]}" --timeout 300 --autoscale-max 2 --strict-barrier --foreground \
  >"$tmp/wide-fallback.out" 2>&1 || { cat "$tmp/wide-fallback.out" >&2; echo "FAIL: wide fallback route failed" >&2; exit 1; }
[ "$(grep -c -- "--autoscale-max is not a sharded operator option; using the ordinary fleet path" "$tmp/wide-fallback.out")" -eq 1 ] ||
  { cat "$tmp/wide-fallback.out" >&2; echo "FAIL: fallback must print exactly one warning naming the option" >&2; exit 1; }
! grep -Fq "sharded controller operator:" "$tmp/wide-fallback.out" ||
  { echo "FAIL: a refused option still entered the sharded operator" >&2; exit 1; }
python3 - "$tmp/wide-names" "$tmp/wide-capture" <<'PY'
import json
import sys
from pathlib import Path
names = Path(sys.argv[1]).read_text().splitlines()
calls = [json.loads(line) for line in Path(sys.argv[2]).read_text().splitlines()]
assert len(calls) == 1, calls
assert calls[0]["args"] == names + ["--timeout", "300", "--autoscale-max", "2", "--strict-barrier", "--foreground"]
PY
# RUN_BENCH_SHARDED_ROUTE=always keeps the strict sharded refusal: nothing starts.
: >"$tmp/wide-capture"
wide_status=0
RUN_BENCH_SHARDED_ROUTE=always \
RUN_BENCH_FLEET_BIN_UNDER_TEST="$tmp/wide-fleet" \
RUN_BENCH_WIDE_CAPTURE="$tmp/wide-capture" \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300 \
  "$RUN_BENCH" "${wide_names[@]}" --timeout 300 --autoscale-max 2 --strict-barrier --foreground \
  >"$tmp/wide-sharded.out" 2>&1 || wide_status=$?
[ "$wide_status" -eq 2 ] || { cat "$tmp/wide-sharded.out" >&2; echo "FAIL: strict sharded route exit $wide_status" >&2; exit 1; }
grep -Fq "sharded controller operator: 50 simultaneous copies exceed one controller's" "$tmp/wide-sharded.out"
grep -Fq -- "--autoscale-max is not a sharded operator option" "$tmp/wide-sharded.out"
[ ! -s "$tmp/wide-capture" ] || { echo "FAIL: refused sharded route started an ordinary fleet" >&2; exit 1; }
# A plain wide run with only operator options (70 copies, --timeout) still
# routes to the sharded operator. The operator interpreter is a recorder, so
# nothing can reach a provider even if every local check passes.
python3 - "$ROOT_DIR" "$tmp/wide70-names" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
from cloudbench_catalog import load_unified_catalog
names = [task["name"] for task in load_unified_catalog(root / "agents/benchmarks/tasks.json")
         if task.get("status", "ready") == "ready" and not task.get("production_only")][:70]
assert len(names) == len(set(names)) == 70
Path(sys.argv[2]).write_text("\n".join(names) + "\n")
PY
wide70_names=()
while IFS= read -r name; do wide70_names+=("$name"); done <"$tmp/wide70-names"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$RUN_BENCH_WIDE_CAPTURE.operator"\n' >"$tmp/operator-recorder"
chmod +x "$tmp/operator-recorder"
: >"$tmp/wide-capture"
RUN_BENCH_SHARDED_OPERATOR_UNDER_TEST="$tmp/operator-recorder" \
RUN_BENCH_FLEET_BIN_UNDER_TEST="$tmp/wide-fleet" \
RUN_BENCH_WIDE_CAPTURE="$tmp/wide-capture" \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300 \
  "$RUN_BENCH" "${wide70_names[@]}" --timeout 300 >"$tmp/wide70.out" 2>&1 || true
grep -Fq "sharded controller operator: 70 simultaneous copies exceed one controller's" "$tmp/wide70.out" ||
  { cat "$tmp/wide70.out" >&2; echo "FAIL: a plain 70-copy run did not route to the sharded operator" >&2; exit 1; }
! grep -Fq "using the ordinary fleet path" "$tmp/wide70.out" ||
  { echo "FAIL: operator-only options must not fall back" >&2; exit 1; }
[ ! -s "$tmp/wide-capture" ] || { echo "FAIL: a sharded route started an ordinary fleet" >&2; exit 1; }
: >"$tmp/wide-capture"
# The explicit ordinary fleet path keeps the whole wide slice in one fleet.
RUN_BENCH_SHARDED_ROUTE=never \
RUN_BENCH_FLEET_BIN_UNDER_TEST="$tmp/wide-fleet" \
RUN_BENCH_WIDE_CAPTURE="$tmp/wide-capture" \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300 \
  "$RUN_BENCH" "${wide_names[@]}" --timeout 300 --autoscale-max 2 --strict-barrier --foreground
python3 - "$tmp/wide-names" "$tmp/wide-capture" <<'PY'
import json
import sys
from pathlib import Path
names = Path(sys.argv[1]).read_text().splitlines()
calls = [json.loads(line) for line in Path(sys.argv[2]).read_text().splitlines()]
assert len(calls) == 1, "a wide slice must remain one fleet, not smaller campaigns"
assert calls[0]["args"] == names + ["--timeout", "300", "--autoscale-max", "2", "--strict-barrier", "--foreground"]
assert calls[0]["backstop"] == "300"
PY

python3 - "$ROOT_DIR" "$tmp" <<'PY'
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

source, temporary = map(Path, sys.argv[1:])
root = temporary / "production-routing"
(root / "scripts").mkdir(parents=True)
(root / "agents/benchmarks").mkdir(parents=True)
(root / "agents/venv/bin").mkdir(parents=True)
(root / ".claude/shared").mkdir(parents=True)
shutil.copyfile(
    source / ".claude/shared/benchmark-report-format.txt",
    root / ".claude/shared/benchmark-report-format.txt",
)
for name in ("run-bench", "cloudbench_catalog.py", "cloudbench-production-only-tasks.py",
             "cloudbench-shard-coordinator.py", "cloudbench-timeout-policy.py"):
    shutil.copyfile(source / "scripts" / name, root / "scripts" / name)
# run-bench resolves every launch's timeout from the catalog's caps and floors.
for name in ("__init__.py", "benchmark_tasks.py", "fixtures.py", "live_fixtures.py",
             "polar_catalog.py", "timeout_history.py"):
    shutil.copyfile(source / "agents/benchmarks" / name, root / "agents/benchmarks" / name)
(root / "agents/benchmarks/tasks.json").write_text(json.dumps([
    {"name": "production-route", "status": "ready", "production_only": True, "timeout_seconds": 600}
]))
(root / "agents/benchmarks/polar_tasks.json").write_text(json.dumps([
    {"name": "polar-routing-control", "status": "ready", "bench": "polar-bench", "timeout_seconds": 0}
]))
interpreter = root / "agents/venv/bin/python"
interpreter.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[1].endswith(('cloudbench_catalog.py', 'cloudbench-production-only-tasks.py')) or (
    args[0] == '-c' and args[-1].endswith('/scripts/cloudbench-shard-coordinator.py')
) or args[0].endswith('/scripts/cloudbench-timeout-policy.py'):
    # Catalog, production classifier, timeout policy and the sharded copy-bound read are real.
    os.execv(os.environ['ROUTING_REAL_PYTHON'], [os.environ['ROUTING_REAL_PYTHON'], *args])
assert args[1] == 'benchmarks/run_benchmark.py', args
with open(os.environ['ROUTING_CAPTURE'], 'a') as stream:
    stream.write(json.dumps(args) + '\\n')
""")
interpreter.chmod(0o755)
fleet = root / "scripts/forbidden-fleet"
fleet.write_text('#!/usr/bin/env bash\nexit 98\n')
capture = root / "production-argv.jsonl"
completed = subprocess.run(
    ["bash", str(root / "scripts/run-bench"), "production-route"],
    env={**os.environ, "ROUTING_REAL_PYTHON": sys.executable,
         "ROUTING_CAPTURE": str(capture), "RUN_BENCH_FLEET_BIN_UNDER_TEST": str(fleet)},
    capture_output=True, text=True, timeout=15,
)
assert completed.returncode == 0, completed.stdout + completed.stderr
assert [json.loads(line) for line in capture.read_text().splitlines()] == [
    ["-u", "benchmarks/run_benchmark.py", "--task", "production-route", "--prod", "--ci", "--bootstrap"]
], "production deploy must use the canonical CLI without allocating a fleet"
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
  {"name":"slice-smoke","status":"ready","tags":["smoke"],"timeout_seconds":300},
  {"name":"slice-daily","status":"ready","bench":"pipeline-e2e","timeout_seconds":600}
]
JSON
cat >"$tmp/catalog/polar_tasks.json" <<'JSON'
[
  {"name":"slice-polar","status":"ready","group":"polar-bench","tags":["polar-bench"],"timeout_seconds":0}
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

# OUTCOME_PROOF_RUN_COUNT_BEGIN
python3 - "$DESCEND_OUTCOME_RUNS" "$tmp" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

script, temporary = sys.argv[1], Path(sys.argv[2])
ledger = temporary / "attempts.jsonl"


def row(task, passed, minute):
    return json.dumps(
        {"task": task, "passed": passed, "timestamp": f"2026-10-01T00:{minute:02d}:00+00:00"}
    )


lines = [row("never-passes", False, minute) for minute in range(3)]
lines += [row("sometimes-passes", minute in (1, 6), minute) for minute in range(10)]
lines += [row("usually-passes", minute != 4, minute) for minute in range(10)]
lines += [row("half-passes", minute < 2, minute) for minute in range(4)]
lines += [row("stable", True, minute) for minute in range(6)]
# The ledger merges branches with union, so file order is not time order: these
# two oldest attempts are written last and must still fall outside the window.
lines += [row("stopped-passing", False, minute) for minute in range(10, 20)]
lines += [row("stopped-passing", True, minute) for minute in range(2)]
lines.insert(5, "{not json")
ledger.write_text("\n".join(lines) + "\n")

tasks = [
    "never-passes", "sometimes-passes", "usually-passes", "half-passes",
    "stable", "stopped-passing", "unrecorded",
]
completed = subprocess.run(
    [sys.executable, script, "--attempts", str(ledger), *tasks],
    capture_output=True, text=True, timeout=15,
)
assert completed.returncode == 0, completed.stdout + completed.stderr
reported = [json.loads(line) for line in completed.stdout.splitlines()]
assert reported == [
    {"task": "never-passes", "attempts": 3, "passes": 0, "runs": 1},
    {"task": "sometimes-passes", "attempts": 10, "passes": 2, "runs": 3},
    {"task": "usually-passes", "attempts": 10, "passes": 9, "runs": 5},
    {"task": "half-passes", "attempts": 4, "passes": 2, "runs": 5},
    {"task": "stable", "attempts": 6, "passes": 6, "runs": 5},
    {"task": "stopped-passing", "attempts": 10, "passes": 0, "runs": 1},
    {"task": "unrecorded", "attempts": 0, "passes": 0, "runs": 1},
], reported

missing = subprocess.run(
    [sys.executable, script, "--attempts", str(temporary / "absent.jsonl"), "never-passes"],
    capture_output=True, text=True, timeout=15,
)
assert missing.returncode != 0, (
    "a missing attempts ledger must not be reported as a task that never passes"
)
assert missing.stdout == "", missing.stdout
PY
# OUTCOME_PROOF_RUN_COUNT_END

# CAMPAIGN_LIFECYCLE_REGRESSIONS_BEGIN
python3 - "$ROOT_DIR" <<'PY'
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

campaign_script = Path(sys.argv.pop()) / "scripts" / "run-bench-campaign.py"


class CampaignLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        (self.root / "scripts" / "run-bench").write_text('''#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  signalled) kill -TERM "$$" ;;
  waiting)
    trap 'exit 0' TERM
    touch "$RUN_BENCH_CAMPAIGN_ROOT/child-ready"
    # The campaign signals the whole group. If TERM reaches this sleep before
    # the shell, errexit must not end the shell ahead of its own TERM trap.
    while :; do sleep 0.1 || true; done
    ;;
  draining)
    # Mirrors run-bench-fleet: TERM announces itself and exits through an EXIT
    # cleanup that ignores further signals, spends its full guest
    # acknowledgement window and only then releases the exact guest.
    release() {
      trap '' HUP INT TERM
      touch "$RUN_BENCH_CAMPAIGN_ROOT/cleanup-started"
      sleep $(( ${CLOUDBENCH_CHILD_TERM_SECONDS:-30} + 2 ))
      touch "$RUN_BENCH_CAMPAIGN_ROOT/guest-released"
    }
    trap release EXIT
    trap 'echo "controller received TERM"; exit 143' TERM
    touch "$RUN_BENCH_CAMPAIGN_ROOT/child-ready"
    while :; do sleep 0.1 || true; done
    ;;
  passed|queued) exit 0 ;;
  *) exit 99 ;;
esac
''')
        self.environment = {
            **os.environ,
            "RUN_BENCH_CAMPAIGN_ROOT": str(self.root),
            "RUN_BENCH_CAMPAIGN_ID": "lifecycle",
        }

    def command(self, *tasks):
        return [
            sys.executable, str(campaign_script), "--root", str(self.root),
            "--runs", "1", "--concurrency", "1",
            *[argument for task in tasks for argument in ("--task", task)],
        ]

    def summary(self):
        return json.loads((self.root / "lifecycle" / "summary.json").read_text())

    def test_child_signal_has_shell_exit_status(self):
        completed = subprocess.run(
            self.command("signalled"), env=self.environment,
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(completed.returncode, 143, completed.stdout + completed.stderr)
        summary = self.summary()
        self.assertEqual(summary["status"], "failed")
        self.assertEqual(summary["jobs"][0]["controller_exit_code"], 143)
        self.assertEqual(summary["jobs"][0]["status"], "failed")

    def test_campaign_cancel_marks_active_and_queued_jobs(self):
        process = subprocess.Popen(
            self.command("passed", "waiting", "queued"), env=self.environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not (self.root / "child-ready").exists():
                self.assertIsNone(process.poll(), "campaign exited before its child was ready")
                self.assertLess(time.monotonic(), deadline, "child never became ready")
                time.sleep(0.02)
            process.send_signal(signal.SIGTERM)
            output, _ = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, output)
            summary = self.summary()
            self.assertEqual(summary["status"], "cancelled")
            self.assertEqual(
                [job["status"] for job in summary["jobs"]],
                ["passed", "cancelled", "cancelled"],
            )
            # A cooperative active child exits cleanly after TERM; its actual
            # exit code must not erase the campaign's cancellation disposition.
            self.assertEqual(summary["jobs"][1]["controller_exit_code"], 0)
            self.assertNotIn("_terminated_by_campaign", json.dumps(summary))
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=35)

    def test_cancel_joins_controller_cleanup_past_former_kill_deadline(self):
        # 2026-10-18 diag100: the campaign SIGKILLed every cancelled fleet 30 s
        # after its group TERM. Fleets whose guests had accepted the stop were
        # still inside their own CLOUDBENCH_CHILD_TERM_SECONDS acknowledgement
        # window, so no native stop or release ran and 17 guests stayed started.
        environment = {**self.environment, "CLOUDBENCH_CHILD_TERM_SECONDS": "30"}
        process = subprocess.Popen(
            self.command("draining"), env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not (self.root / "child-ready").exists():
                self.assertIsNone(process.poll(), "campaign exited before its child was ready")
                self.assertLess(time.monotonic(), deadline, "child never became ready")
                time.sleep(0.02)
            process.send_signal(signal.SIGTERM)
            output, _ = process.communicate(timeout=120)
            self.assertEqual(process.returncode, 143, output)
            self.assertTrue((self.root / "cleanup-started").exists(), output)
            job = self.summary()["jobs"][0]
            self.assertTrue(
                (self.root / "guest-released").exists(),
                f"campaign ended the controller (exit {job['controller_exit_code']}) "
                "before its owned EXIT cleanup released the guest",
            )
            self.assertEqual(job["status"], "cancelled")
            self.assertEqual(job["controller_exit_code"], 143)
            log = Path(job["log"]).read_text()
            self.assertIn("controller received TERM", log)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=120)

    def test_stop_signals_once_and_joins_delayed_controller_cleanup(self):
        spec = importlib.util.spec_from_file_location("campaign_lifecycle", campaign_script)
        campaign = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(campaign)
        handlers = {}
        child = None
        clock = 0
        signals = []

        class DelayedCleanupProcess:
            pid = 777

            def __init__(self, *_args, **_kwargs):
                nonlocal child
                child = self
                self.terminated = False
                self.polls_after_term = 0
                handlers[signal.SIGTERM](signal.SIGTERM, None)

            def poll(self):
                if not self.terminated:
                    return None
                self.polls_after_term += 1
                # Its owned EXIT cleanup outlives several 31 s clock steps.
                return None if self.polls_after_term < 5 else 143

        def killpg(pid, signum):
            self.assertEqual(pid, child.pid)
            signals.append(signum)
            if signum == signal.SIGTERM:
                child.terminated = True

        def monotonic():
            nonlocal clock
            clock += 31
            return clock

        argv = [
            str(campaign_script), "--root", str(self.root),
            "--runs", "1", "--concurrency", "1", "--task", "waiting",
        ]
        with (
            patch.dict(os.environ, self.environment),
            patch.object(campaign.sys, "argv", argv),
            patch.object(campaign, "publish_campaign_group", return_value=None),
            patch.object(campaign.subprocess, "Popen", DelayedCleanupProcess),
            patch.object(campaign.signal, "signal", side_effect=lambda signum, handler: handlers.update({signum: handler})),
            patch.object(campaign.os, "killpg", side_effect=killpg),
            patch.object(campaign.time, "monotonic", side_effect=monotonic),
            patch.object(campaign.time, "sleep"),
            patch.object(campaign, "terminate_owned_children", wraps=campaign.terminate_owned_children) as teardown,
        ):
            self.assertEqual(campaign.main(), 143)
        self.assertEqual(teardown.call_count, 1, "stop repeated its cancellation signal")
        self.assertEqual(signals, [signal.SIGTERM], "a controller's owned cleanup must never be SIGKILLed")
        job = self.summary()["jobs"][0]
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(job["controller_exit_code"], 143)


unittest.main()
PY
# CAMPAIGN_LIFECYCLE_REGRESSIONS_END

echo "All /descend command checks passed."
