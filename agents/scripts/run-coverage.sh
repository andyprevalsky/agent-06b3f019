#!/usr/bin/env bash
# Run blackbox tests under coverage.py and enforce the configured fail_under threshold.
#
#   scripts/run-coverage.sh            # check threshold (exits nonzero on failure)
#   scripts/run-coverage.sh --report   # detailed report without threshold enforcement
#   scripts/run-coverage.sh --html     # generate HTML report into htmlcov/
set -euo pipefail

AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$AGENTS_DIR"

PYTHON_BIN="${PYTHON_BIN:-venv/bin/python}"
COVERAGE_BIN="${COVERAGE_BIN:-venv/bin/coverage}"

if [ ! -x "$COVERAGE_BIN" ]; then
    echo "coverage not installed in venv; run: $PYTHON_BIN -m pip install coverage" >&2
    exit 1
fi

MODE="${1:-check}"

"$COVERAGE_BIN" run scripts/run_blackbox_tests.py

if [ -d tests/fast_cache ]; then
    "$COVERAGE_BIN" run --append -m pytest tests/fast_cache -q
fi

case "$MODE" in
    --report)
        "$COVERAGE_BIN" report --no-fail-under
        ;;
    --html)
        "$COVERAGE_BIN" html
        echo "HTML report written to: $AGENTS_DIR/htmlcov/index.html"
        ;;
    *)
        "$COVERAGE_BIN" report
        ;;
esac
