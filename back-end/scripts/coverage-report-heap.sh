#!/usr/bin/env bash
# Shared by run-coverage.sh and run-coverage-sharded.sh: run the c8 report step
# with a raised V8 heap ceiling. c8 merges every raw coverage file in memory,
# and the full backend sweep (347 unit files + 238 blackbox domains) exhausted
# node's default ~2 GB heap after every test had passed (2026-10-30). The
# option is a cap, not a reservation; BACKEND_COVERAGE_REPORT_HEAP_MB overrides
# it, and any NODE_OPTIONS the caller set are preserved.
#
# Usage: source coverage-report-heap.sh; coverage_report_node npx c8 report ...

COVERAGE_REPORT_HEAP_MB="${BACKEND_COVERAGE_REPORT_HEAP_MB:-6144}"
if ! [[ "$COVERAGE_REPORT_HEAP_MB" =~ ^[1-9][0-9]*$ ]]; then
  echo "❌ BACKEND_COVERAGE_REPORT_HEAP_MB must be a positive integer (MB)." >&2
  exit 2
fi

coverage_report_node() {
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$COVERAGE_REPORT_HEAP_MB" "$@"
}
