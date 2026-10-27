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

require_text 'Every failed task gets its own read-only triage card' "triage every failure"
require_text 'every cluster — a singleton included — enters its own `/RCA` cycle' "RCA each cluster"
require_text 'Require the unchanged owning-boundary repro red then green' "causal red/green proof"
require_text 'Every required run must pass.' "complete outcome proof"
require_text 'Do not rerun a failed proof to look for a pass' "no pass shopping"
require_text 'Split the failing siblings out' "split over-wide clusters"
require_text '**Default substrate: cloud fleet.**' "default cloud fleet"
require_text '20 * infra_failed_jobs >= scheduled_total' "original-denominator infra stop"
require_text '## One benchmark command' "one benchmark entrypoint"
require_text 'scripts/descend_step_log.py report' "iteration timing report"
require_text 'FINAL_CHANGE_REVIEW' "one final change review"
require_text 'TASK_DEFINITION_DEFECT' "independent task-definition gate"
require_text 'GROUNDED' "strong grounding gate"
require_text 'at most 8' "eight fixes per iteration"
require_text 'distinct benchmark task names in one CLI launch' "batch counts tasks, not copies"
require_text 'increase the next batch size by 10 tasks up to' "size ramp"
require_text 'Rotate to the next task set every 5 iterations' "rotation schedule"
require_text 'shortest effective timeout first' "shortest timeout first"
require_text 'cap `--concurrency` to the verified provider limit' "provider-safe queued copies"
require_text 'Read `/benchmark` before **every** benchmark launch' "benchmark skill before each launch"
require_text 'Start `/goal` yourself' "agent starts goal"
require_text 'Run `/deploy` only if a change directly affects production' "no routine deploy"
require_text 'At `ITERATION_RETRO` after every run' "iteration speed reflection"
require_text 'Bench run times come from producer artifacts' "producer benchmark times"
require_text 'Overall slice: <passed_original>/<total_original> passed' "fixed original denominator"
require_text 'Latest run: <passed_run>/<total_run> passed' "separate subset denominator"
require_text 'agents/benchmarks/history/descend_steps.jsonl' "tracked timing history"
if grep -Fq 'while the latest run contains any INFRA result:' "$DESCEND_COMMAND"; then
  fail "obsolete global zero-infra gate"
fi

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
