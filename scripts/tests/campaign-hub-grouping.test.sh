#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROSE_GROUPING_PROJECT_ROOT="${ROSE_GROUPING_PROJECT_ROOT:-$ROOT_DIR}"
export ROSE_GROUPING_SOURCE_ROOT="${ROSE_GROUPING_SOURCE_ROOT:-$ROOT_DIR}"
# A workspace install hoists the backend's binaries to the root; a
# package-local install keeps them under back-end.
for tsx in "$ROSE_GROUPING_PROJECT_ROOT/back-end/node_modules/.bin/tsx" \
  "$ROSE_GROUPING_PROJECT_ROOT/node_modules/.bin/tsx"; do
  if [ -x "$tsx" ]; then
    exec "$tsx" --test "$ROOT_DIR/scripts/tests/campaign-hub-grouping.test.ts"
  fi
done
echo "tsx is not installed under $ROSE_GROUPING_PROJECT_ROOT; install the backend dependencies" >&2
exit 127
