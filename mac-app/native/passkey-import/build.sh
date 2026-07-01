#!/usr/bin/env bash
# Compile native passkey helpers against the macOS 26 SDK.
# Outputs:
#   dist/native/rose-passkey-import
#   dist/native/librose_passkey_import.dylib
#   dist/native/rose-passkey-permission
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/native}"
mkdir -p "$OUT_DIR"
swiftc -O -target arm64-apple-macos26.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  -framework AuthenticationServices -framework Foundation \
  "$HERE/ImportCore.swift" "$HERE/main.swift" -o "$OUT_DIR/rose-passkey-import"
swiftc -O -target arm64-apple-macos26.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  -framework AuthenticationServices -framework Foundation \
  -emit-library -module-name RosePasskeyImport \
  "$HERE/ImportCore.swift" "$HERE/library.swift" -o "$OUT_DIR/librose_passkey_import.dylib"
swiftc -O -target arm64-apple-macos26.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  -framework AuthenticationServices -framework Foundation \
  "$HERE/../passkey-permission/main.swift" -o "$OUT_DIR/rose-passkey-permission"
echo "built -> $OUT_DIR/rose-passkey-import"
echo "built -> $OUT_DIR/librose_passkey_import.dylib"
echo "built -> $OUT_DIR/rose-passkey-permission"
