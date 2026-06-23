#!/usr/bin/env bash
# Copy the user's Chrome profile (minus caches) to a temp dir and launch a
# SECOND Chrome instance from it with a CDP debug port. Keeps the Amazon login
# (same macOS Keychain decrypts copied cookies) without quitting the main Chrome.
set -euo pipefail

SRC="$HOME/Library/Application Support/Google/Chrome"
DST="${PASSKEY_PROFILE_DIR:-/tmp/passkey-enroll-profile}"
PORT="${PASSKEY_CDP_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

echo "[prep] copying profile (excluding caches) -> $DST"
rm -rf "$DST"
mkdir -p "$DST"
# Copy the whole user-data-dir but skip the heavy/regenerable cache dirs.
rsync -a \
  --exclude='*/Cache/' \
  --exclude='*/Code Cache/' \
  --exclude='*/GPUCache/' \
  --exclude='*/DawnGraphiteCache/' \
  --exclude='*/DawnWebGPUCache/' \
  --exclude='*/GrShaderCache/' \
  --exclude='*/ShaderCache/' \
  --exclude='*/Service Worker/CacheStorage/' \
  --exclude='*/Service Worker/ScriptCache/' \
  --exclude='*/Shared Dictionary/' \
  --exclude='*/component_crx_cache/' \
  --exclude='*/optimization_guide_model_store/' \
  --exclude='GraphiteDawnCache/' \
  --exclude='ShaderCache/' \
  --exclude='*/Extension State/' \
  "$SRC/" "$DST/" 2>/dev/null || true

# Chrome refuses to start if the copied profile still thinks it's running.
find "$DST" -maxdepth 2 -name 'Singleton*' -delete 2>/dev/null || true

echo "[prep] launching second Chrome instance on port $PORT"
"$CHROME" \
  --user-data-dir="$DST" \
  --remote-debugging-port="$PORT" \
  --no-first-run \
  --no-default-browser-check \
  --restore-last-session=false \
  about:blank >/tmp/passkey-chrome.log 2>&1 &

echo "[prep] waiting for CDP port..."
for i in $(seq 1 30); do
  if curl -s --max-time 2 "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "[prep] CDP up on $PORT"
    curl -s "http://localhost:$PORT/json/version" | head -c 200
    echo ""
    exit 0
  fi
  sleep 1
done
echo "[prep] ERROR: CDP port did not come up"
exit 1
