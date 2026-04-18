#!/usr/bin/env bash
set -euo pipefail
# Verify formatting and linting for the research repo.
# Usage: bash research/scripts/lint-check.sh [--fix]

FIX=false
[[ "${1:-}" == "--fix" ]] && FIX=true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Deno discovers the root package.json workspaces (which includes agents/ with
# no package.json), so suppress that lookup to avoid a spurious error.
export DENO_NO_PACKAGE_JSON=1

FAIL=0

echo "=== TypeScript (deno fmt + deno lint) ==="
if $FIX; then
  deno fmt || true
  deno lint --fix || true
  # Re-check after fix to detect unfixable issues
  deno fmt --check || FAIL=1
  deno lint || FAIL=1
else
  deno fmt --check || FAIL=1
  deno lint || FAIL=1
fi

echo ""
echo "=== TypeScript strict overlay (cleaned domains) ==="
if $FIX; then
  deno lint --fix --config deno-strict.json || true
  # Re-check after fix to detect unfixable issues
  deno lint --config deno-strict.json || FAIL=1
else
  deno lint --config deno-strict.json || FAIL=1
fi

echo ""
echo "=== Structural checks (file/function length) ==="
npx tsx "$ROOT/scripts/lint-structure.ts" || FAIL=1

echo ""
echo "=== Structural checks (layer dependencies) ==="
npx tsx "$ROOT/tests/structural/layer-deps.ts" || FAIL=1

echo ""
echo "=== Python (ruff format + ruff check) ==="
if $FIX; then
  ruff format .
  ruff check --fix .
  # Re-check after fix to detect unfixable issues
  ruff format --check . || FAIL=1
  ruff check . || FAIL=1
else
  ruff format --check . || FAIL=1
  ruff check . || FAIL=1
fi

exit $FAIL
