#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROSE_GROUPING_PROJECT_ROOT="${ROSE_GROUPING_PROJECT_ROOT:-$ROOT_DIR}"
export ROSE_GROUPING_SOURCE_ROOT="${ROSE_GROUPING_SOURCE_ROOT:-$ROOT_DIR}"
exec "$ROSE_GROUPING_PROJECT_ROOT/back-end/node_modules/.bin/tsx" --test "$ROOT_DIR/scripts/tests/campaign-hub-grouping.test.ts"
