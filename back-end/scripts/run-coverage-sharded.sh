#!/usr/bin/env bash
set -euo pipefail

# Sharded backend coverage: N independent blackbox run-coverage.sh shards (own
# instrumented backend, own local database, own port and raw V8 directory),
# the unit pass beside them (BACKEND_COVERAGE_UNIT_PASS=1: its own `_s0`
# database, port pair and raw directory, every unit file except the fps probe),
# then the fps probe alone (a second, labelled unit pass:
# BACKEND_COVERAGE_UNIT_PASS_LABEL=probe, BACKEND_UNIT_TEST_FILES=<probe>) once
# every shard and the unit pass have finished, then one merged c8 report that
# enforces back-end/.c8rc.json thresholds. Only the probe is host-load
# dependent: rose-ui-cli-browser's headless-browser perf check (fps-p50 >= 55)
# failed 4/4 sharded runs beside two blackbox streams while passing unsharded
# (2026-10-30). The rest of the unit suite ran alone for 12.7 min after the
# shards on #1639 (2026-10-30); overlapping it saves that serial wait minus the
# probe's ~2 min.
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
# Validated up front, before any shard runs: the merged c8 report's heap ceiling.
source "$SCRIPT_DIR/coverage-report-heap.sh"

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
# The one host-load-dependent unit file; it never runs beside a blackbox shard.
FPS_PROBE_FILE="rose-ui-cli-browser.test.ts"
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
# The unit pass runs beside the shards on its own `_s0` database and +20/+21
# port pair, minus the fps probe (run alone below).
env -u BACKEND_UNIT_TEST_FILES -u BACKEND_COVERAGE_UNIT_PASS_LABEL BACKEND_COVERAGE_UNIT_PASS=1 \
  BACKEND_UNIT_EXCLUDE_FILES="$FPS_PROBE_FILE" \
  BACKEND_COVERAGE_MERGE_DIR="$MERGED_TMP" \
  BACKEND_COVERAGE_START_PORT="$((BASE_PORT + 20))" BACKEND_COVERAGE_END_PORT="$((BASE_PORT + 21))" \
  bash "$SCRIPT_DIR/run-coverage.sh" >"$BACKEND_DIR/coverage/units.log" 2>&1 &
UNIT_PASS_PID="$!"
echo "Started the unit pass beside the shards (pid $UNIT_PASS_PID, fps probe $FPS_PROBE_FILE excluded, log coverage/units.log)"

terminate_unit_pass() {
  [[ -n "$UNIT_PASS_PID" ]] || return 0
  kill -TERM "$UNIT_PASS_PID" 2>/dev/null || true
  wait "$UNIT_PASS_PID" 2>/dev/null || true
  UNIT_PASS_PID=""
}
terminate_shards() {
  for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap 'terminate_shards; terminate_unit_pass; archive_merged_coverage interrupted; exit 130' INT TERM

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
        echo "Failed-first: stopping the remaining shards and the unit pass."
        terminate_shards
        terminate_unit_pass
        ABORTED=1
        DONE_COUNT=$SHARDS
      fi
    else
      echo "✅ Coverage shard $i/$SHARDS passed"
    fi
  done
  if ((DONE_COUNT < SHARDS)); then sleep 1; fi
done
record_domain_durations

# The concurrent unit pass, like run-coverage.sh's own test phase, still
# completes after a failed shard so one sweep reports every failure; only a
# failed-first abort stops it (above).
if [[ -n "$UNIT_PASS_PID" ]]; then
  UNIT_RC=0
  wait "$UNIT_PASS_PID" || UNIT_RC=$?
  UNIT_PASS_PID=""
  if [[ "$UNIT_RC" -ne 0 ]]; then
    echo "❌ Unit pass failed (exit $UNIT_RC); see coverage/units.log"
    grep -E '^\s+FAIL\s' "$BACKEND_DIR/coverage/units.log" || true
    FAILED=1
  else
    echo "✅ Unit pass passed"
  fi
fi
trap - INT TERM

# The fps probe runs alone, after every blackbox shard and the unit pass (see
# the header): a labelled unit pass selecting only that file. Skipped only
# after a failed-first abort.
PROBE_PASS_PID=""
terminate_probe_pass() {
  [[ -n "$PROBE_PASS_PID" ]] || return 0
  kill -TERM "$PROBE_PASS_PID" 2>/dev/null || true
  wait "$PROBE_PASS_PID" 2>/dev/null || true
}
if [[ "$ABORTED" -eq 0 ]]; then
  echo "Blackbox shards and the unit pass finished; running the fps probe alone (log coverage/units-probe.log)"
  trap 'terminate_probe_pass; archive_merged_coverage interrupted; exit 130' INT TERM
  env -u BACKEND_UNIT_EXCLUDE_FILES BACKEND_COVERAGE_UNIT_PASS=1 BACKEND_COVERAGE_UNIT_PASS_LABEL=probe \
    BACKEND_UNIT_TEST_FILES="$FPS_PROBE_FILE" \
    BACKEND_COVERAGE_MERGE_DIR="$MERGED_TMP" \
    BACKEND_COVERAGE_START_PORT="$((BASE_PORT + 20))" BACKEND_COVERAGE_END_PORT="$((BASE_PORT + 21))" \
    bash "$SCRIPT_DIR/run-coverage.sh" >"$BACKEND_DIR/coverage/units-probe.log" 2>&1 &
  PROBE_PASS_PID="$!"
  PROBE_RC=0
  wait "$PROBE_PASS_PID" || PROBE_RC=$?
  PROBE_PASS_PID=""
  trap - INT TERM
  if [[ "$PROBE_RC" -ne 0 ]]; then
    echo "❌ fps probe pass failed (exit $PROBE_RC); see coverage/units-probe.log"
    grep -E '^\s+FAIL\s' "$BACKEND_DIR/coverage/units-probe.log" || true
    FAILED=1
  else
    echo "✅ fps probe pass passed"
  fi
else
  echo "Failed-first abort: the unit pass was stopped and the fps probe is skipped until the blackbox failure is fixed."
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
echo "=== Merged Coverage Report ($SHARDS blackbox shards + unit pass + fps probe) ==="
COV_EXIT=0
# The merged report holds every shard's and the unit pass's raw V8 files: the
# same in-memory merge that exhausted node's default heap unsharded.
coverage_report_node npx c8 report --temp-directory="$MERGED_TMP" --reporter=text --reporter=text-summary --reporter=json-summary \
  --check-coverage || COV_EXIT=$?
if [[ "$COV_EXIT" -eq 0 ]]; then
  rm -rf "$MERGED_TMP"
else
  archive_merged_coverage report-failed
fi
exit "$COV_EXIT"
