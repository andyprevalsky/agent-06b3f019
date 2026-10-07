#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROSE_GROUPING_PROJECT_ROOT="${ROSE_GROUPING_PROJECT_ROOT:-$ROOT_DIR}"
export ROSE_GROUPING_SOURCE_ROOT="${ROSE_GROUPING_SOURCE_ROOT:-$ROOT_DIR}"
# A root npm workspace install hoists tsx out of back-end/node_modules.
TSX="$ROSE_GROUPING_PROJECT_ROOT/back-end/node_modules/.bin/tsx"
[ -x "$TSX" ] || TSX="$ROSE_GROUPING_PROJECT_ROOT/node_modules/.bin/tsx"
exec "$TSX" --test "$ROOT_DIR/scripts/tests/campaign-hub-grouping.test.ts"
