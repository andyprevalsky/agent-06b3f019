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

require_text "Exactly two planned user-input gates." "/descend must define two planned user gates"
require_text 'Every failed task gets its own read-only triage card' "/descend must triage every failure before clustering"
require_text 'every cluster — a singleton included — enters its own `/RCA` cycle' "/descend must enter RCA once per cluster before benchmark rerunning"
require_text 'No failed task may be rerun until a cluster RCA with causal proof covers it' "/descend must not rerun a failure that no RCA covers"
require_text 'run the unchanged owning-boundary repro red then green' "/descend must require causal fail/pass proof before a benchmark rerun"
require_text 'That exact rerun supplies `/RCA`' "/descend must make the post-approval rerun supply benchmark outcome proof"
require_text "rank the clusters" "/descend must rank clusters after the first infra-clean RCA set"
require_text "member-task count, largest first" "/descend must ask about the cluster that flips the most tasks first"
require_text "Andy sees a lower-ranked cluster only if" "/descend must show a lower-ranked cluster only when higher ones are busy"
require_text "not a prod deploy" "/descend must apply approved fixes on a local snapshot, not a prod deploy"
require_text "keeps its position" "/descend must keep a cluster's rank when its outcome-proof rerun fails"
require_text "Re-rank only when membership changes" "/descend must keep the ask order stable between clusterings"
require_text "Immediately fire a sub-agent" "/descend must start the outcome-proof rerun immediately on approve"
require_text "APPLY_AND_CLOUD_RERUN" "/descend must apply the fix then rerun on the cloud fleet"
require_text "**Default substrate: cloud fleet.**" "/descend must default benchmark runs to the cloud fleet"
require_text "solely when Andy explicitly" "/descend must require an explicit user opt-in before using --local"
require_text 'scripts/run-bench <task>' "/descend outcome-proof must use cloud-fleet run-bench without --local by default"
if grep -Fq 'scripts/run-bench --local <task>' "$DESCEND_COMMAND"; then
  fail "/descend must not hardcode --local for outcome-proof bench reruns"
fi
require_text "fail-closes on a stale/missing infra-canary stamp" "/descend must document infra-canary fail-closed preflight"
require_text "TRIAGE_FAILURES" "/descend must triage every failed task before RCA"
require_text "CLUSTER_FAILURES" "/descend must group failures by shared root cause before RCA"
require_text "RANK_CLUSTERS" "/descend must rank clusters before pipelined fix approval"
require_text "PIPELINE_CLUSTERS" "/descend must pipeline approve, cloud-fleet outcome-proof, and the next ask"
require_text "one fix at one first-bad boundary is expected to flip both" "/descend must define a cluster by its shared fix"
require_text "Never cluster on a shared symptom" "/descend must not cluster failures by symptom"
require_text 'An `inferred` card never joins a cluster with another task' "/descend must cluster only on observed boundary evidence"
require_text "A class says what kind of failure a cluster is; it never decides membership." "/descend must keep the issue-class taxonomy separate from cluster identity"
require_text "rerun every member task of that cluster" "/descend outcome proof must cover every task the fix claims to flip"
require_text "python3 scripts/descend_outcome_runs.py" "/descend must size outcome proofs from recorded outcomes"
require_text "Every required run must pass." "/descend must not confirm a fix from a partial pass"
require_text "Do not rerun a failed proof to look for a pass" "/descend must not retry an outcome proof until it is green"
require_text "Split the failing siblings out" "/descend must split a cluster whose fix did not flip every member"
require_text "A canary fails" "/descend must treat a regressed passing task as a failed outcome proof"
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
require_text "| ID | Kind | Class | Tasks | Issue (≤100 chars) | RCA | Fix | Test | Approval | Real rerun | Deploy |" "/descend must use a cluster-oriented lifecycle table with a pinned issue class and member count"
require_text "Browser agent failed to start because proxy generation returned HTTP 400" "/descend issue rows must state the concrete observed failure"
require_text "The issue is <root cause at the first-bad boundary>" "fix approval must explain the RCA"
require_text "where we measured <measurement>" "fix approval must report the repro measurement"
require_text "The unchanged local repro now" "fix approval must report post-fix proof"
require_text "Approve: <row ID> approve" "fix approval must end with clear decision syntax"
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
grep -Fq '~~~text' <<<"$RESPONSE_CONTRACT" && fail "response examples must not use ~~~ code blocks (approvals use the canonical text block)"
grep -Fq '━' <<<"$RESPONSE_CONTRACT" || fail "response approvals must use the canonical Unicode frame"
grep -Fq '🔐 APPROVAL' <<<"$RESPONSE_CONTRACT" || fail "response approvals must retain the canonical approval header"
RESPONSE_PROSE=$(python3 - "$RESPONSE_CONTRACT" <<'PY'
import sys
outside = []
in_text = False
for line in sys.argv[1].splitlines():
    if not in_text and line.strip() == "```text":
        in_text = True
    elif in_text and line.strip() == "```":
        in_text = False
    elif not in_text:
        outside.append(line)
assert not in_text, "response text examples must have balanced fences"
print("\n".join(outside))
PY
)
grep -Fq '━' <<<"$RESPONSE_PROSE" && fail "response header must not use an ASCII banner outside approved text blocks"
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
for name in ("run-bench", "cloudbench_catalog.py", "cloudbench-production-only-tasks.py"):
    shutil.copyfile(source / "scripts" / name, root / "scripts" / name)
report_contract = root / ".claude/shared/benchmark-report-format.txt"
report_contract.parent.mkdir(parents=True)
shutil.copyfile(source / ".claude/shared/benchmark-report-format.txt", report_contract)
(root / "agents/benchmarks/tasks.json").write_text(json.dumps([
    {"name": "production-route", "status": "ready", "production_only": True}
]))
(root / "agents/benchmarks/polar_tasks.json").write_text(json.dumps([
    {"name": "polar-routing-control", "status": "ready", "bench": "polar-bench"}
]))
interpreter = root / "agents/venv/bin/python"
interpreter.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[1].endswith(('cloudbench_catalog.py', 'cloudbench-production-only-tasks.py')):
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
import argparse
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

    def test_stop_runs_one_bounded_teardown_before_delayed_reap(self):
        spec = importlib.util.spec_from_file_location("campaign_lifecycle", campaign_script)
        campaign = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(campaign)
        handlers = {}
        child = None
        clock = 0
        signals = []

        class DelayedReapProcess:
            pid = 777

            def __init__(self, *_args, **_kwargs):
                nonlocal child
                child = self
                self.killed = False
                self.polls_after_kill = 0
                handlers[signal.SIGTERM](signal.SIGTERM, None)

            def poll(self):
                if not self.killed:
                    return None
                self.polls_after_kill += 1
                return None if self.polls_after_kill == 1 else -signal.SIGKILL

        def killpg(pid, signum):
            self.assertEqual(pid, child.pid)
            signals.append(signum)
            if signum == signal.SIGKILL:
                child.killed = True

        def monotonic():
            nonlocal clock
            clock += 31
            return clock

        args = argparse.Namespace(
            root=self.root, runs=1, concurrency=1, task=["waiting"], forward_arg=[],
            retry_infra=0, e2e_timeout=None, e2e_started_at=None,
            stress_defaults=False, stress_defaults_plan=False,
        )
        with (
            patch.dict(os.environ, self.environment),
            patch.object(campaign, "parse_args", return_value=args),
            patch.object(campaign, "publish_campaign_group", return_value=None),
            patch.object(campaign.subprocess, "Popen", DelayedReapProcess),
            patch.object(campaign.signal, "signal", side_effect=lambda signum, handler: handlers.update({signum: handler})),
            patch.object(campaign.os, "killpg", side_effect=killpg),
            patch.object(campaign.time, "monotonic", side_effect=monotonic),
            patch.object(campaign.time, "sleep"),
            patch.object(campaign, "terminate_owned_children", wraps=campaign.terminate_owned_children) as teardown,
        ):
            self.assertEqual(campaign.main(), 143)
        self.assertEqual(teardown.call_count, 1, "stop repeated its full shutdown window")
        self.assertEqual(signals, [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(self.summary()["jobs"][0]["status"], "cancelled")


unittest.main()
PY
# CAMPAIGN_LIFECYCLE_REGRESSIONS_END

echo "All /descend command checks passed."
