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

echo "run-cloud-benchmark-workers: OK"
