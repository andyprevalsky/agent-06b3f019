#!/usr/bin/env bash
# Agents layering invariants: forward-only domain layers, no cross-domain
# imports, the helpers/ and utils/ boundaries, no first-party import cycles,
# every activity a workflow schedules registered on the worker, and every
# blackbox test registered. scripts/test.sh ran these but /deploy did not, so
# violations accumulated on main unseen.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT/agents"

PYTHON_BIN="${PYTHON_BIN:-venv/bin/python}"
if [ ! -x "$PYTHON_BIN" ]; then
  echo "FAIL: agents interpreter missing at agents/$PYTHON_BIN (run scripts/cloud-build.sh or set PYTHON_BIN)" >&2
  exit 1
fi

# Discovered by glob so a new suite cannot be left out of /deploy.
shopt -s nullglob
suites=(tests/structural/structural*.py)
if [ "${#suites[@]}" -eq 0 ]; then
  echo "FAIL: no agents/tests/structural/structural*.py suites found" >&2
  exit 1
fi

status=0
for suite in "${suites[@]}"; do
  if ! "$PYTHON_BIN" "$suite"; then
    echo "FAIL: agents/$suite" >&2
    status=1
  fi
done
exit "$status"
