#!/usr/bin/env bash
# Keep the generated Prisma client in a warm cloudbench dependency tree aligned
# with the schema checked out for this run. npm manifest fingerprints alone are
# insufficient because `prisma generate` compiles schema.prisma into node_modules.
set -euo pipefail

REPO_DIR="${1:?usage: cloudbench-sync-prisma-client.sh <repo-dir> [app-user]}"
APP_USER="${2:-rose}"
SCHEMA="$REPO_DIR/back-end/prisma/schema.prisma"
MARKER="$REPO_DIR/node_modules/.prisma/.rose-schema-fingerprint"

if [ ! -f "$SCHEMA" ]; then
    echo "[cloudbench] FATAL: missing Prisma schema: $SCHEMA" >&2
    exit 1
fi

fingerprint="$(python3 - "$SCHEMA" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"
installed="$(cat "$MARKER" 2>/dev/null || true)"

if [ "$installed" = "$fingerprint" ]; then
    exit 0
fi

echo "[cloudbench] Prisma schema changed — regenerating client"
if ! (
    cd "$REPO_DIR"
    gosu "$APP_USER" npx prisma generate --schema "$SCHEMA"
); then
    echo "[cloudbench] FATAL: Prisma client generation failed" >&2
    exit 1
fi

mkdir -p "$(dirname "$MARKER")"
printf '%s\n' "$fingerprint" > "$MARKER"
chown "$APP_USER:$APP_USER" "$MARKER" 2>/dev/null || true
