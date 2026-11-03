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

# spawn-browser-agent-v3 real-browser cases use the *venv* Playwright
# revision (1.62 → chromium-1234). Node Playwright in this repo installs
# chromium-1243 into the same ~/.cache/ms-playwright and can leave the
# Python revision missing ("Executable doesn't exist at
# chromium_headless_shell-1234"). Install the venv browsers before the
# suite so a shared cache cannot fail the domain.
#
# `install` always takes the machine-wide ms-playwright directory lock, even
# when every browser is present, and on a loaded host shared by many worktrees
# that lock's heartbeat goes stale ("Unable to update lock within the stale
# threshold"), failing coverage before any test runs. Only install when a
# revision this Playwright needs lacks its INSTALLATION_COMPLETE marker.
playwright_chromium_installed() {
    local locations location
    locations="$("$PYTHON_BIN" -m playwright install --dry-run chromium 2>/dev/null |
        sed -n 's/^[[:space:]]*Install location:[[:space:]]*//p')" || return 1
    [ -n "$locations" ] || return 1
    while IFS= read -r location; do
        [ -f "$location/INSTALLATION_COMPLETE" ] || return 1
    done <<< "$locations"
}
if ! playwright_chromium_installed; then
    "$PYTHON_BIN" -m playwright install chromium
fi

# Domain tests share process-global mock state. Give each domain a fresh process
# inside a bounded worker pool, then merge their parallel coverage files before
# the focused pytest suites append their data.
rm -f .coverage .coverage.*
AGENTS_BLACKBOX_DOMAINS="" COVERAGE_BIN="$COVERAGE_BIN" "$PYTHON_BIN" scripts/run_coverage_blackbox_parallel.py
"$COVERAGE_BIN" combine

if [ -d tests/demo_cache ]; then
    "$COVERAGE_BIN" run --append -m pytest tests/demo_cache -q
fi

if [ -d tests/unit ]; then
    "$COVERAGE_BIN" run --append -m pytest tests/unit -q
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
