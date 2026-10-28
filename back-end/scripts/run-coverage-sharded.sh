#!/usr/bin/env bash
set -euo pipefail

# Sharded backend coverage: N independent run-coverage.sh shards (own
# instrumented backend, own local database, own port and raw V8 directory),
# then one merged c8 report that enforces back-end/.c8rc.json thresholds.
#
# Usage: bash scripts/run-coverage-sharded.sh [shard-count]   (default 2)
#        BACKEND_COVERAGE_SHARD_DURATIONS=<summary.json> balances by duration.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARDS="${1:-${BACKEND_COVERAGE_SHARDS:-2}}"
if ! [[ "$SHARDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "❌ shard count must be a positive integer" >&2
  exit 2
fi
cd "$BACKEND_DIR"

MERGED_TMP="$BACKEND_DIR/coverage/tmp-merged"
if [[ -d "$MERGED_TMP" ]] && [[ -n "$(find "$MERGED_TMP" -mindepth 1 -print -quit)" ]]; then
  echo "❌ Unrecovered merged raw coverage remains at $MERGED_TMP; archive it first." >&2
  exit 1
fi
mkdir -p "$MERGED_TMP"

BASE_PORT="${CONDUCTOR_PORT:-55000}"
DURATIONS="${BACKEND_COVERAGE_SHARD_DURATIONS:-}"
declare -a PIDS=()
for ((i = 1; i <= SHARDS; i++)); do
  # Each shard gets a disjoint two-port range above the unsharded one.
  start=$((BASE_PORT + 20 + 2 * i))
  env BACKEND_COVERAGE_SHARD="$i/$SHARDS" \
    BACKEND_COVERAGE_SHARD_DURATIONS="$DURATIONS" \
    BACKEND_COVERAGE_MERGE_DIR="$MERGED_TMP" \
    BACKEND_COVERAGE_START_PORT="$start" BACKEND_COVERAGE_END_PORT="$((start + 1))" \
    bash "$SCRIPT_DIR/run-coverage.sh" >"$BACKEND_DIR/coverage/shard-$i.log" 2>&1 &
  PIDS+=("$!")
  echo "Started coverage shard $i/$SHARDS (pid ${PIDS[-1]}, log coverage/shard-$i.log)"
done

terminate_shards() {
  for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap 'terminate_shards; exit 130' INT TERM

FAILED=0
for ((i = 1; i <= SHARDS; i++)); do
  rc=0
  wait "${PIDS[$((i - 1))]}" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "❌ Coverage shard $i/$SHARDS failed (exit $rc); see coverage/shard-$i.log"
    grep -E '^\s+FAIL\s' "$BACKEND_DIR/coverage/shard-$i.log" || true
    FAILED=1
  else
    echo "✅ Coverage shard $i/$SHARDS passed"
  fi
done
trap - INT TERM
if [[ "$FAILED" -ne 0 ]]; then
  echo "Raw shard coverage kept at $MERGED_TMP for diagnosis; remove it before the next run."
  exit 1
fi

echo ""
echo "=== Merged Coverage Report ($SHARDS shards) ==="
COV_EXIT=0
npx c8 report --temp-directory="$MERGED_TMP" --reporter=text --reporter=text-summary --reporter=json-summary \
  --check-coverage || COV_EXIT=$?
rm -rf "$MERGED_TMP"
exit "$COV_EXIT"
