#!/usr/bin/env bash
set -euo pipefail

# Read repository-relative paths on stdin and print only files shipped in the
# Temporal worker image. Test suites and their local orchestration harnesses do
# not change the code executing existing production workflows.
grep -E '^agents/' |
  grep -Ev \
    '^agents/(tests/|benchmarks/|\.context/|scripts/(run-coverage\.sh|run_blackbox_tests\.py|run_coverage_blackbox_parallel\.py)$)|(^|/)__pycache__/|\.pyc$|\.md$|/README' ||
  true
