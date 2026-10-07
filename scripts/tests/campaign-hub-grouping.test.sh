#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROSE_GROUPING_PROJECT_ROOT="${ROSE_GROUPING_PROJECT_ROOT:-$ROOT_DIR}"
export ROSE_GROUPING_SOURCE_ROOT="${ROSE_GROUPING_SOURCE_ROOT:-$ROOT_DIR}"
# Resolve from the owning package: npm may install tsx locally or hoist it to the root.
TSX_CLI="$(node -e 'process.stdout.write(require("node:module").createRequire(process.argv[1]).resolve("tsx/cli"))' \
    "$ROSE_GROUPING_PROJECT_ROOT/back-end/package.json")"
exec node "$TSX_CLI" --test "$ROOT_DIR/scripts/tests/campaign-hub-grouping.test.ts"
