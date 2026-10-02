#!/usr/bin/env bash
# Regenerate the Prisma client only when it no longer matches schema.prisma.
#
# Test launchers used to run `prisma generate` on every start. That rewrites the
# shared generated client in place, so a lint or type check running beside a
# launcher (the parallel /deploy verifiers) read half-written declarations, saw
# every Prisma result as `any`, and failed on files nobody changed. Concurrent
# launchers also regenerated over each other.
#
# The client is fresh when the installed @prisma/client generated it from the
# current schema. The generated index.js records its client version and the
# hash of the schema copy it embeds; Prisma reformats that copy, so it never
# byte-matches the source, and the marker ties the embedded hash to the source
# schema's hash. A manual `prisma generate` of the same schema keeps the
# embedded hash, so it does not force another regeneration.
#
# Usage: sync-prisma-client.sh [backend-dir]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${1:-$SCRIPT_DIR/..}" && pwd)"
# shellcheck source=../../scripts/lib/workspace-db-lock.sh
. "$SCRIPT_DIR/../../scripts/lib/workspace-db-lock.sh"

cd "$BACKEND_DIR"

# Prints "<generated-client-dir> <source-schema-sha256> <fresh|stale>".
read_client_state() {
    local state
    state="$(node - <<'JS'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const clientPackage = require.resolve('@prisma/client/package.json', { paths: [process.cwd()] });
const { version } = JSON.parse(fs.readFileSync(clientPackage, 'utf8'));
const generatedDir = path.join(path.dirname(path.dirname(path.dirname(clientPackage))), '.prisma', 'client');
const schemaHash = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join('prisma', 'schema.prisma')))
  .digest('hex');

const readOrEmpty = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const index = readOrEmpty(path.join(generatedDir, 'index.js'));
const embeddedHash = index.match(/"inlineSchemaHash": "([0-9a-f]+)"/)?.[1];
const clientVersion = index.match(/"clientVersion": "([^"]+)"/)?.[1];
const marker = readOrEmpty(path.join(generatedDir, '..', '.rose-client-fingerprint')).trim();
const fresh =
  embeddedHash !== undefined && clientVersion === version && marker === `${schemaHash} ${embeddedHash}`;
console.log(`${generatedDir} ${schemaHash} ${fresh ? 'fresh' : 'stale'}`);
JS
)"
    read -r GENERATED_DIR SCHEMA_HASH CLIENT_STATE <<<"$state"
}

read_client_state
[ "$CLIENT_STATE" = fresh ] && exit 0

trap release_workspace_db_lock EXIT
acquire_workspace_db_lock "prisma-client:$GENERATED_DIR"

# Another launcher may have regenerated while this one waited for the lock.
read_client_state
[ "$CLIENT_STATE" = fresh ] && exit 0

echo "Prisma client is stale; regenerating."
npx prisma generate >/dev/null

embedded_hash="$(sed -nE 's/.*"inlineSchemaHash": "([0-9a-f]+)".*/\1/p' "$GENERATED_DIR/index.js" | head -1)"
if [ -z "$embedded_hash" ]; then
    echo "❌ prisma generate wrote no inlineSchemaHash to $GENERATED_DIR/index.js" >&2
    exit 1
fi
marker="$(dirname "$GENERATED_DIR")/.rose-client-fingerprint"
printf '%s %s\n' "$SCHEMA_HASH" "$embedded_hash" > "$marker.tmp.$$"
mv "$marker.tmp.$$" "$marker"
