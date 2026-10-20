#!/usr/bin/env bash
# Cloud `run.sh --benchmark` must export WORKER_PROCESSES. Skipping that (the
# old `if ! $IS_CLOUD` wrapper) left run_local_worker.sh at its default of 1
# process while the ports line printed the `:-8` echo fallback. One event loop
# cannot drain a 51-agent Fast Mode tree inside the 600s bootstrap cap.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_SH="$ROOT/scripts/run.sh"

grep -q 'if \$BENCHMARK_MODE; then' "$RUN_SH" \
  || { echo "FAIL: benchmark worker default must run on Cloud too" >&2; exit 1; }

# The Cloud default of 8 must not live only inside `if ! $IS_CLOUD`.
python3 - <<'PY' "$RUN_SH"
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
needle = 'export WORKER_PROCESSES="${WORKER_PROCESSES:-${BENCHMARK_AGENT_WORKERS:-8}}"'
idx = text.find(needle)
if idx < 0:
    sys.exit("FAIL: cloud benchmark default WORKER_PROCESSES=8 is missing")
before = text[:idx]
# The assignment must appear after `if $BENCHMARK_MODE` and not exclusively
# inside the non-cloud slot-tuning block that follows.
if "if $BENCHMARK_MODE; then" not in before[-800:]:
    sys.exit("FAIL: WORKER_PROCESSES=8 default is not under BENCHMARK_MODE")
# The non-cloud activity-slot block must come AFTER this export.
after = text[idx:]
if "if ! $IS_CLOUD; then" not in after[:1200]:
    sys.exit("FAIL: expected non-cloud slot defaults to follow WORKER_PROCESSES export")
print("structural: OK")
PY

# Behavioral probe: same assignment Cloud run.sh now uses.
WORKER_PROCESSES=""
BENCHMARK_AGENT_WORKERS=""
IS_CLOUD=true
if $IS_CLOUD; then
    WORKER_PROCESSES="${WORKER_PROCESSES:-${BENCHMARK_AGENT_WORKERS:-8}}"
fi
[ "$WORKER_PROCESSES" = "8" ] || {
    echo "FAIL: cloud default produced WORKER_PROCESSES=$WORKER_PROCESSES" >&2
    exit 1
}

WORKER_PROCESSES=3
if $IS_CLOUD; then
    WORKER_PROCESSES="${WORKER_PROCESSES:-${BENCHMARK_AGENT_WORKERS:-8}}"
fi
[ "$WORKER_PROCESSES" = "3" ] || {
    echo "FAIL: explicit WORKER_PROCESSES was overwritten ($WORKER_PROCESSES)" >&2
    exit 1
}

# Isolated --benchmark stacks share system Postgres with the Step 5 stack.
# A 50-conn Prisma pool is exactly the mass-agent for_each fan-out, so
# concurrent post_agent_message interactive txs P2028 ("Unable to start a
# transaction") and the tree stalls. Benchmark default must sit above 50
# children + parent + overlapping status/tool-usage txs. Non-benchmark
# (Step 5) keeps the smaller default so two stacks stay under max_connections.
python3 - <<'PY' "$RUN_SH"
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
if "LOCAL_DB_CONNECTION_LIMIT" not in text:
    sys.exit("FAIL: run.sh must name LOCAL_DB_CONNECTION_LIMIT so bench/dev pools cannot silently drift")
if 'export LOCAL_DB_CONNECTION_LIMIT="${LOCAL_DB_CONNECTION_LIMIT:-80}"' not in text:
    sys.exit("FAIL: --benchmark default LOCAL_DB_CONNECTION_LIMIT must be 80 (above 50-child mass-agent fan-out)")
if 'export LOCAL_DB_CONNECTION_LIMIT="${LOCAL_DB_CONNECTION_LIMIT:-50}"' not in text:
    sys.exit("FAIL: non-benchmark LOCAL_DB_CONNECTION_LIMIT default must stay 50")
if "if $BENCHMARK_MODE; then" not in text.split('LOCAL_DB_CONNECTION_LIMIT:-80')[0][-200:]:
    sys.exit("FAIL: 80-conn default must be under BENCHMARK_MODE")
if 'connection_limit=${LOCAL_DB_CONNECTION_LIMIT}' not in text:
    sys.exit("FAIL: DATABASE_URL must use LOCAL_DB_CONNECTION_LIMIT")
print("structural pool: OK")
PY

# run600c (2026-10-18): 600 guests each ran the worker's 1 Hz queue observation
# (CountWorkflowExecutions + 2 DescribeTaskQueue, all Temporal Cloud Visibility
# API calls) on the production namespace. ~90% of guest AND prod autoscaler
# cycles were rejected with "namespace rate limit exceeded" for 35 minutes.
# Guests must share one fleet-wide visibility budget; clones must not observe.
(
  set -euo pipefail
  # shellcheck source=/dev/null
  . "$ROOT/scripts/lib/cloudbench-env.sh"
  unset CLOUDBENCH_TEMPORAL_VISIBILITY_CALLS_PER_SECOND
  check() {  # <expected> <guests> [budget] [floor]
    local got; got="$(cloudbench_guest_autoscaler_poll_seconds "${@:2}")"
    [ "$got" = "$1" ] || { echo "FAIL: guest poll seconds($*) = $got" >&2; exit 1; }
  }
  check 90 600 "" 10      # unsharded 600-wide campaign within the 20 calls/s default
  check 90 30 1.0 10      # one of 20 shard hosts: 30 guests within 1/20 of the budget
  check 10 1 "" 10        # never faster than the controller's 10 s read cadence
  check 10 50 "" 10       # width fifty: 7.5 s rounds up to the read cadence
  check 90 600 abc 10     # malformed budget falls back to the default
  check 10 "" "" 10       # malformed width counts as one guest
  CLOUDBENCH_TEMPORAL_VISIBILITY_CALLS_PER_SECOND=60 check 30 600 "" 10
  for guests in 1 2 7 29 30 31 50 99 300 600 601 1000; do
    for budget in 0.5 1.0 1.5 20 60; do
      seconds="$(cloudbench_guest_autoscaler_poll_seconds "$guests" "$budget" 10)"
      awk -v g="$guests" -v b="$budget" -v s="$seconds" 'BEGIN { exit !(3 * g / s <= b + 1e-9) }' \
        || { echo "FAIL: $guests guests every ${seconds}s exceed $budget visibility calls/s" >&2; exit 1; }
    done
  done
)

python3 - <<'PY' "$ROOT"
import pathlib, re, subprocess, sys
root = pathlib.Path(sys.argv[1])
def read(rel): return (root / rel).read_text()
fleet = read("scripts/run-bench-fleet")
call = ('CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS="$(cloudbench_guest_autoscaler_poll_seconds \\\n'
        '    "${CLOUDBENCH_CAMPAIGN_CONCURRENT_GUESTS:-${#BENCHES[@]}}" "" "$AUTOSCALE_POLL")" || exit 1\n'
        'export CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS\n')
if call not in fleet:
    sys.exit("FAIL: run-bench-fleet must budget guest observation by campaign width and export it")
if '"CLOUDBENCH_CAMPAIGN_CONCURRENT_GUESTS": str(args.concurrency)' not in read("scripts/run-bench-campaign.py"):
    sys.exit("FAIL: campaign children must report the campaign's concurrent guest count")
cloud = read("scripts/run-bench-cloud")
for needle in ('--env "CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS=${CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS:-}"',
               'echo "export CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS=$(printf \'%q\' "${CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS:-}")"'):
    if needle not in cloud:
        sys.exit(f"FAIL: run-bench-cloud must forward the guest cadence on both launch paths: {needle}")
worker = read("scripts/cloudbench-worker.sh")
if "export AUTOSCALER_QUEUE_METRICS=0" not in worker or "    AUTOSCALER_QUEUE_METRICS=0 \\\n" not in worker:
    sys.exit("FAIL: worker-only clones must disable unread queue observation in env and exec env")
if '${WMH_BASE_URL:+${WMH_EXECUTION_POLICY:+WMH_EXECUTION_POLICY="$WMH_EXECUTION_POLICY"}}' not in worker:
    sys.exit("FAIL: autoscaled workers must run with the primary's WMH execution policy (fast-cache partition)")
if 'echo "export WMH_EXECUTION_POLICY=$(printf \'%q\' "$WMH_EXECUTION_POLICY")"' not in read("scripts/run-bench-fleet"):
    sys.exit("FAIL: the fleet must hand autoscaled workers its WMH execution policy")
run = read("scripts/cloudbench-run.sh")
block = re.search(r'case "\$\{CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS:-\}" in\n.*?\nesac\n', run, re.S)
probe = 'if [ "${CLOUDBENCH_INFRA_PROBE:-0}" = "1" ]; then\n    # The probe executes'
if not block or run.index(block.group(0)) > run.index(probe) or run.index("STACK_ENV=(") > run.index(block.group(0)):
    sys.exit("FAIL: cloudbench-run.sh must pass the budgeted cadence into the isolated stack env")
for value, expected in (("90", "AUTOSCALER_POLL_INTERVAL_SECONDS=90"), ("", ""), ("0", ""), ("9x", "")):
    out = subprocess.run(["bash", "-c", 'STACK_ENV=(); ' + block.group(0) + 'printf "%s" "${STACK_ENV[*]:-}"'],
                         env={"CLOUDBENCH_GUEST_AUTOSCALER_POLL_SECONDS": value, "PATH": "/usr/bin:/bin"},
                         capture_output=True, text=True, check=True).stdout
    if out != expected:
        sys.exit(f"FAIL: guest cadence {value!r} produced stack env {out!r}")
print("guest temporal visibility budget: OK")
PY

echo "run-cloud-benchmark-workers: OK"
