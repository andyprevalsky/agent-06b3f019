#!/usr/bin/env bash
# Shared Linux prerequisite for cloud-init and isolated benchmark frontends.
set -euo pipefail

ngrok_version() {
    python3 - "$1" <<'PY'
import subprocess
import sys

try:
    result = subprocess.run([sys.argv[1], "version"], timeout=5, check=False)
except (OSError, subprocess.TimeoutExpired):
    sys.exit(1)
sys.exit(result.returncode)
PY
}

installed="$(command -v ngrok || true)"
if [ -n "$installed" ] && ngrok_version "$installed" >/dev/null 2>&1; then
    exit 0
fi

[ "$(uname -s)" = Linux ] || { echo "ngrok bootstrap requires Linux" >&2; exit 1; }
case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "unsupported ngrok bootstrap architecture" >&2; exit 1 ;;
esac

install_dir="${NGROK_INSTALL_DIR:-/usr/local/bin}"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/rose-ngrok.XXXXXXXX")"
staged=""
trap 'rm -rf "$temporary"; [ -z "$staged" ] || rm -f "$staged"' EXIT

curl -fsSL --connect-timeout 10 --max-time 30 \
    "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${arch}.tgz" \
    -o "$temporary/ngrok.tgz"
tar -xzf "$temporary/ngrok.tgz" -C "$temporary" ngrok
[ -f "$temporary/ngrok" ] && [ ! -L "$temporary/ngrok" ]
chmod 755 "$temporary/ngrok"
ngrok_version "$temporary/ngrok" >/dev/null
mkdir -p "$install_dir"
staged="$(mktemp "$install_dir/.ngrok.XXXXXXXX")"
install -m 755 "$temporary/ngrok" "$staged"
mv -f "$staged" "$install_dir/ngrok"
staged=""
ngrok_version "$install_dir/ngrok"
