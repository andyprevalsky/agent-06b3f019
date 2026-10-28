#!/usr/bin/env bash
set -euo pipefail

# Re-prove only the tests that failed in the previous backend coverage run.
#
# Reads the failed blackbox domains from the preserved blackbox summary.json and
# the failed unit files from the unit results file, then runs run-coverage.sh
# with exactly that selection. A selected-only run cannot enforce the coverage
# thresholds, so it always ends with "PARTIAL"; the full `npm run test:coverage`
# remains mandatory once every rerun passes. Missing or unreadable results fall
# back to the full suite instead of guessing.
#
# Usage: bash scripts/coverage-rerun-failed.sh [failure-evidence-dir]
#   failure-evidence-dir defaults to the newest
#   .context/test-runs/backend-coverage-failed-* directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
EVIDENCE_DIR="${1:-}"
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
    const domains = blackbox.results.filter((r) => !r.passed).map((r) => r.domain);
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
echo "Rerunning failed blackbox domains: ${DOMAINS:-<none>}"
echo "Rerunning failed unit files: ${UNITS:-<none>}"
SKIP_BLACKBOX=0
SKIP_UNITS=0
[[ -n "$DOMAINS" ]] || SKIP_BLACKBOX=1
[[ -n "$UNITS" ]] || SKIP_UNITS=1
exec env BACKEND_COVERAGE_BLACKBOX_DOMAINS="$DOMAINS" BACKEND_UNIT_TEST_FILES="$UNITS" \
  BACKEND_COVERAGE_SKIP_BLACKBOX="$SKIP_BLACKBOX" BACKEND_COVERAGE_SKIP_UNITS="$SKIP_UNITS" \
  bash "$SCRIPT_DIR/run-coverage.sh"
