#!/usr/bin/env bash
set -euo pipefail

# Retry backend coverage after a failed run, using that run's failures.
#
# --mode=failed-first (default, a valid gate): one FULL sweep in which the
#   previously failed blackbox domains run first and the sweep aborts as soon as
#   one fails again. When they pass, every other domain and unit file still runs
#   and thresholds are enforced, so a regression elsewhere is still caught.
# --mode=subset (fast diagnosis only, NOT a gate): run just the failed blackbox
#   domains and unit files. It cannot enforce thresholds and ends "PARTIAL" with
#   a non-zero exit (3) even when every selected test passed, so it can never be
#   recorded as a passing gate; a full sweep remains mandatory afterwards.
# Missing or unreadable failure records fall back to the plain full suite.
#
# Usage: bash scripts/coverage-rerun-failed.sh [--mode=failed-first|subset] [failure-evidence-dir]
#   failure-evidence-dir defaults to the newest
#   .context/test-runs/backend-coverage-failed-* directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
MODE=failed-first
EVIDENCE_DIR=""
for arg in "$@"; do
  case "$arg" in
    --mode=failed-first | --mode=subset) MODE="${arg#--mode=}" ;;
    --*)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
    *) EVIDENCE_DIR="$arg" ;;
  esac
done
if [[ -z "$EVIDENCE_DIR" ]]; then
  EVIDENCE_DIR="$(ls -1dt "$ROOT_DIR"/.context/test-runs/backend-coverage-failed-* 2>/dev/null | head -1 || true)"
fi
BLACKBOX_SUMMARY="${EVIDENCE_DIR:+$EVIDENCE_DIR/summary.json}"
UNIT_RESULTS="$BACKEND_DIR/coverage/unit-run/results.json"

selection="$(
  BLACKBOX_SUMMARY="$BLACKBOX_SUMMARY" UNIT_RESULTS="$UNIT_RESULTS" node -e '
    const fs = require("node:fs");
    const read = (path) => {
      try { return path ? JSON.parse(fs.readFileSync(path, "utf8")) : undefined; }
      catch { return undefined; }
    };
    const blackbox = read(process.env.BLACKBOX_SUMMARY);
    const unit = read(process.env.UNIT_RESULTS);
    if (!blackbox || !Array.isArray(blackbox.results) || !unit || !Array.isArray(unit.failed)) {
      console.log("FULL");
      process.exit(0);
    }
    const domains = blackbox.results.filter((r) => !r.passed && !r.aborted).map((r) => r.domain);
    console.log(`DOMAINS=${domains.join(",")}`);
    console.log(`UNITS=${unit.failed.join(",")}`);
  '
)"

if [[ "$selection" == "FULL" ]]; then
  echo "No complete failed-test record (blackbox summary: ${BLACKBOX_SUMMARY:-none}); running the full coverage suite."
  exec bash "$SCRIPT_DIR/run-coverage.sh"
fi
DOMAINS="$(sed -n 's/^DOMAINS=//p' <<<"$selection")"
UNITS="$(sed -n 's/^UNITS=//p' <<<"$selection")"
if [[ -z "$DOMAINS" && -z "$UNITS" ]]; then
  echo "The previous run recorded no failed tests; running the full coverage suite."
  exec bash "$SCRIPT_DIR/run-coverage.sh"
fi
if [[ "$MODE" == "failed-first" ]]; then
  echo "Full coverage sweep; previously failed blackbox domains first: ${DOMAINS:-<none>}"
  exec env BLACKBOX_TEST_PRIORITY_DOMAINS="$DOMAINS" BLACKBOX_TEST_ABORT_ON_PRIORITY_FAILURE=1 \
    bash "$SCRIPT_DIR/run-coverage.sh"
fi
echo "Rerunning failed blackbox domains: ${DOMAINS:-<none>}"
echo "Rerunning failed unit files: ${UNITS:-<none>}"
echo "Subset mode is diagnostic only: it ends PARTIAL with a non-zero exit and never satisfies the coverage gate."
SKIP_BLACKBOX=0
SKIP_UNITS=0
[[ -n "$DOMAINS" ]] || SKIP_BLACKBOX=1
[[ -n "$UNITS" ]] || SKIP_UNITS=1
exec env BACKEND_COVERAGE_BLACKBOX_DOMAINS="$DOMAINS" BACKEND_UNIT_TEST_FILES="$UNITS" \
  BACKEND_COVERAGE_SKIP_BLACKBOX="$SKIP_BLACKBOX" BACKEND_COVERAGE_SKIP_UNITS="$SKIP_UNITS" \
  bash "$SCRIPT_DIR/run-coverage.sh"
