#!/usr/bin/env bash
# Run pytest unit tests for the gepa domain with coverage enforcement.
#
# Usage: bash research/scripts/test-gepa.sh
#
# Exits non-zero if any test fails or if coverage drops below 80%.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GEPA_DIR="$RESEARCH_ROOT/domains/gepa"

cd "$GEPA_DIR"

# Prefer a project venv if one exists; otherwise fall back to system python3.
if [[ -x "$RESEARCH_ROOT/venv/bin/python" ]]; then
  PYTHON="$RESEARCH_ROOT/venv/bin/python"
elif [[ -x "$GEPA_DIR/venv/bin/python" ]]; then
  PYTHON="$GEPA_DIR/venv/bin/python"
else
  PYTHON="python3"
fi

echo "=== gepa domain unit tests ==="
echo "python: $PYTHON"
echo "cwd:    $GEPA_DIR"
echo ""

"$PYTHON" -m pytest tests/ \
  --cov=. \
  --cov-report=term-missing \
  --cov-fail-under=80
