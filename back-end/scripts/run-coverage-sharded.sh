#!/usr/bin/env bash
set -euo pipefail

# Sharded backend coverage: N independent blackbox run-coverage.sh shards (own
# instrumented backend, own local database, own port and raw V8 directory),
# then the unit suite once, alone (BACKEND_COVERAGE_UNIT_PASS=1, after every
# shard has finished), then one merged c8 report that enforces
# back-end/.c8rc.json thresholds. The unit phase never overlaps a blackbox
# stream: its headless-browser perf probe (rose-ui-cli-browser, fps-p50) is
# host-load dependent and failed 4/4 sharded runs while passing unsharded
# when every shard also ran its own unit slice beside its blackbox phase.
#
# Usage: bash scripts/run-coverage-sharded.sh [--failed-first] [shard-count]   (default 2)
#        BACKEND_COVERAGE_SHARD_DURATIONS=<summary.json> balances by duration.
#
# --failed-first (also BACKEND_COVERAGE_FAILED_FIRST=1) is still a FULL sweep:
# blackbox domains that failed in the previous sharded run (read from each
# shard's retained coverage/blackbox-run-shard<i>/summary.json) are scheduled
# first in their shard, and as soon as any shard fails the others are stopped.
# When they pass, every domain and unit file still runs and the merged
# threshold check is enforced, so it remains the gate.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
FAILED_FIRST="${BACKEND_COVERAGE_FAILED_FIRST:-0}"
SHARDS="${BACKEND_COVERAGE_SHARDS:-2}"
for arg in "$@"; do
  case "$arg" in
    --failed-first) FAILED_FIRST=1 ;;
    --*)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
    *) SHARDS="$arg" ;;
  esac
done
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

archive_merged_coverage() {
  local reason="$1"
  local archive="$ROOT_DIR/.context/test-runs/backend-coverage-merged-${reason}-$(date -u +%Y%m%d-%H%M%S)-$$"
  if [[ -d "$MERGED_TMP" ]]; then
    mkdir -p "$archive"
    mv "$MERGED_TMP" "$archive/raw-v8"
    echo "Merged raw coverage archived at $archive/raw-v8."
  fi
}


if [[ "$FAILED_FIRST" == "1" ]]; then
  # Read the previous run's failures before the shards wipe their artifact dirs.
  PRIORITY_DOMAINS="$(
    node -e '
      const fs = require("node:fs");
      const failed = new Set();
      for (const path of process.argv.slice(1)) {
        let summary;
        try { summary = JSON.parse(fs.readFileSync(path, "utf8")); } catch { continue; }
        for (const r of summary.results ?? []) if (!r.passed && !r.aborted) failed.add(r.domain);
      }
      process.stdout.write([...failed].sort().join(","));
    ' "$BACKEND_DIR"/coverage/blackbox-run-shard*/summary.json
  )"
  if [[ -n "$PRIORITY_DOMAINS" ]]; then
    echo "Failed-first full sweep; previously failed domains first: $PRIORITY_DOMAINS"
    export BLACKBOX_TEST_PRIORITY_DOMAINS="$PRIORITY_DOMAINS"
    export BLACKBOX_TEST_ABORT_ON_PRIORITY_FAILURE=1
  else
    echo "Failed-first: no previous shard failures recorded; plain full sweep."
  fi
fi

# Retained summaries from an earlier run were read above (failed-first); drop
# them now so a shard that exits before its own preflight cannot hand the
# duration recorder stale, positive observations.
rm -f "$BACKEND_DIR"/coverage/blackbox-run-shard*/summary.json
# A shard killed mid-run (a superseded pipeline attempt sends SIGTERM) leaves
# its raw coverage under coverage/tmp-shard<i>, and run-coverage.sh refuses to
# start a new collection over unrecovered raw coverage. Keep that evidence,
# out of the way, so the next attempt can run (2026-10-30: attempt 2 of the
# PR #1637 proof run was refused by attempt 1's interrupted shards).
for leftover in "$BACKEND_DIR"/coverage/tmp-shard* "$BACKEND_DIR"/coverage/tmp-units; do
  [[ -d "$leftover" ]] && [[ -n "$(find "$leftover" -mindepth 1 -print -quit)" ]] || continue
  archive="$ROOT_DIR/.context/test-runs/backend-coverage-unrecovered-$(date -u +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$archive"
  mv "$leftover" "$archive/"
  echo "Archived unrecovered raw coverage from an interrupted shard: $leftover -> $archive/$(basename "$leftover")"
done
BASE_PORT="${CONDUCTOR_PORT:-55000}"
DURATIONS="${BACKEND_COVERAGE_SHARD_DURATIONS:-}"
# Timing-balanced shards: without an explicit durations file, reuse the
# per-worktree ledger of recorded blackbox domain durations (written by
# record_domain_durations after every sharded run, pass or fail) so the shard
# plan packs by observed cost instead of by name. The ledger only changes
# which shard runs a domain; every domain still runs exactly once.
DURATIONS_LEDGER="$ROOT_DIR/.context/deploy-durations/backend-blackbox.json"
if [[ -z "$DURATIONS" && -s "$DURATIONS_LEDGER" ]]; then
  DURATIONS="$DURATIONS_LEDGER"
  echo "Shard balancing: recorded domain durations from $DURATIONS_LEDGER"
fi

record_domain_durations() {
  node "$SCRIPT_DIR/coverage-shard-durations.mjs" "$DURATIONS_LEDGER" \
    "$BACKEND_DIR"/coverage/blackbox-run-shard*/summary.json || true
}
declare -a PIDS=()
for ((i = 1; i <= SHARDS; i++)); do
  # Each shard gets a disjoint two-port range above the unsharded one.
  start=$((BASE_PORT + 20 + 2 * i))
  env -u BACKEND_UNIT_TEST_FILES BACKEND_COVERAGE_SHARD="$i/$SHARDS" \
    BACKEND_COVERAGE_SKIP_UNITS=1 \
    BACKEND_COVERAGE_SHARD_DURATIONS="$DURATIONS" \
    BACKEND_COVERAGE_MERGE_DIR="$MERGED_TMP" \
    BACKEND_COVERAGE_START_PORT="$start" BACKEND_COVERAGE_END_PORT="$((start + 1))" \
    bash "$SCRIPT_DIR/run-coverage.sh" >"$BACKEND_DIR/coverage/shard-$i.log" 2>&1 &
  PIDS+=("$!")
  echo "Started coverage shard $i/$SHARDS (pid ${PIDS[$((i - 1))]}, log coverage/shard-$i.log)"
done

terminate_shards() {
  for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap 'terminate_shards; archive_merged_coverage interrupted; exit 130' INT TERM

# Reap shards in completion order so a failure is reported (and, in
# failed-first mode, stops the sibling shards) as soon as it happens.
FAILED=0
ABORTED=0
DONE_COUNT=0
declare -a DONE=()
while ((DONE_COUNT < SHARDS)); do
  for ((i = 1; i <= SHARDS && DONE_COUNT < SHARDS; i++)); do
    [[ -z "${DONE[$i]:-}" ]] || continue
    pid="${PIDS[$((i - 1))]}"
    kill -0 "$pid" 2>/dev/null && continue
    rc=0
    wait "$pid" || rc=$?
    DONE[$i]=1
    DONE_COUNT=$((DONE_COUNT + 1))
    if [[ "$rc" -ne 0 ]]; then
      echo "❌ Coverage shard $i/$SHARDS failed (exit $rc); see coverage/shard-$i.log"
      grep -E '^\s+FAIL\s' "$BACKEND_DIR/coverage/shard-$i.log" || true
      FAILED=1
      if [[ "$FAILED_FIRST" == "1" ]]; then
        echo "Failed-first: stopping the remaining shards."
        terminate_shards
        ABORTED=1
        DONE_COUNT=$SHARDS
      fi
    else
      echo "✅ Coverage shard $i/$SHARDS passed"
    fi
  done
  if ((DONE_COUNT < SHARDS)); then sleep 1; fi
done
trap - INT TERM
record_domain_durations

# The unit suite runs once, alone, after the blackbox shards (see the header).
# Like run-coverage.sh's own test phase it still runs after a failed shard so
# one sweep reports every failure; only a failed-first abort skips it.
UNIT_PASS_PID=""
terminate_unit_pass() {
  [[ -n "$UNIT_PASS_PID" ]] || return 0
  kill -TERM "$UNIT_PASS_PID" 2>/dev/null || true
  wait "$UNIT_PASS_PID" 2>/dev/null || true
}
if [[ "$ABORTED" -eq 0 ]]; then
  echo "Blackbox shards finished; running the unit suite once, alone (log coverage/units.log)"
  trap 'terminate_unit_pass; archive_merged_coverage interrupted; exit 130' INT TERM
  env -u BACKEND_UNIT_TEST_FILES BACKEND_COVERAGE_UNIT_PASS=1 \
    BACKEND_COVERAGE_MERGE_DIR="$MERGED_TMP" \
    BACKEND_COVERAGE_START_PORT="$((BASE_PORT + 20))" BACKEND_COVERAGE_END_PORT="$((BASE_PORT + 21))" \
    bash "$SCRIPT_DIR/run-coverage.sh" >"$BACKEND_DIR/coverage/units.log" 2>&1 &
  UNIT_PASS_PID="$!"
  UNIT_RC=0
  wait "$UNIT_PASS_PID" || UNIT_RC=$?
  UNIT_PASS_PID=""
  trap - INT TERM
  if [[ "$UNIT_RC" -ne 0 ]]; then
    echo "❌ Unit pass failed (exit $UNIT_RC); see coverage/units.log"
    grep -E '^\s+FAIL\s' "$BACKEND_DIR/coverage/units.log" || true
    FAILED=1
  else
    echo "✅ Unit pass passed"
  fi
else
  echo "Failed-first abort: the unit pass is skipped until the blackbox failure is fixed."
fi
if [[ "$FAILED" -ne 0 ]]; then
  # Archive the passing shards' raw coverage so the next run is not blocked.
  ARCHIVE="$ROOT_DIR/.context/test-runs/backend-coverage-merged-failed-$(date -u +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$ARCHIVE"
  mv "$MERGED_TMP" "$ARCHIVE/raw-v8"
  echo "Passing phases' raw coverage archived at $ARCHIVE/raw-v8."
  echo "Retry: bash scripts/run-coverage-sharded.sh --failed-first $SHARDS"
  exit 1
fi

echo ""
echo "=== Merged Coverage Report ($SHARDS blackbox shards + unit pass) ==="
COV_EXIT=0
npx c8 report --temp-directory="$MERGED_TMP" --reporter=text --reporter=text-summary --reporter=json-summary \
  --check-coverage || COV_EXIT=$?
if [[ "$COV_EXIT" -eq 0 ]]; then
  rm -rf "$MERGED_TMP"
else
  archive_merged_coverage report-failed
fi
exit "$COV_EXIT"
