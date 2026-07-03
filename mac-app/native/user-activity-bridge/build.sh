#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-../../dist/native}"
cd "$(dirname "$0")"

ELECTRON_VERSION="$(node -p "require('../../node_modules/electron/package.json').version")"
npx --yes node-gyp@10.2.0 rebuild \
  --target="$ELECTRON_VERSION" \
  --arch="$(uname -m)" \
  --dist-url=https://electronjs.org/headers \
  >/dev/null

mkdir -p "$OUT_DIR"
cp build/Release/rose_user_activity_bridge.node "$OUT_DIR/rose-user-activity-bridge.node"
echo "built -> $OUT_DIR/rose-user-activity-bridge.node"
