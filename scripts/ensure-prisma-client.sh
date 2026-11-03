#!/usr/bin/env bash
# Dependency preparation owns Prisma client generation: test launchers only
# assert freshness (back-end/scripts/assert-prisma-client-current.mjs) and
# never rewrite the client. A deploy worktree reuses a linked dependency tree
# whose generated client was compiled for whatever schema its source checkout
# had at the time; on 2026-10-29 that client lacked a column merged two days
# earlier, so every Prisma-backed lane (backend coverage shards, live probes)
# refused to start while the structural lanes were green.
#
#   resolve the client back-end sees ──inside this checkout and fresh──► exit 0
#        └── outside this checkout, missing or stale ──► own node_modules/.prisma
#            (never a link into another checkout) ──► prisma generate ──► the
#            client resolves inside this checkout ──► assert freshness
#
# A client that resolves into another checkout is never accepted, fresh or
# not: a later regeneration there would silently change this worktree's lanes.
set -euo pipefail
CHECKOUT="${1:?usage: ensure-prisma-client.sh <checkout>}"
CHECKOUT="$(cd "$CHECKOUT" && pwd -P)"
cd "$CHECKOUT"
ASSERT="back-end/scripts/assert-prisma-client-current.mjs"

resolve_client() {  # realpath of the generated client back-end resolves, or nothing
  (cd back-end && node -e '
const { createRequire } = require("node:module");
const { realpathSync } = require("node:fs");
const clientRequire = createRequire(require.resolve("@prisma/client/package.json"));
process.stdout.write(realpathSync(clientRequire.resolve(".prisma/client/default")));
') 2>/dev/null || true
}

resolved="$(resolve_client)"
case "$resolved" in
  "$CHECKOUT"/*)
    if node "$ASSERT" >/dev/null 2>&1; then
      exit 0
    fi
    echo "🔧 Prisma client is stale for $CHECKOUT/back-end/prisma/schema.prisma; regenerating"
    ;;
  "")
    echo "🔧 No generated Prisma client resolves from $CHECKOUT/back-end; generating"
    ;;
  *)
    echo "🔧 The Prisma client resolves outside this checkout ($resolved); generating a local one"
    ;;
esac
# `prisma generate` writes beside the @prisma/client package it resolves. A
# node_modules/.prisma linked into another checkout would make it rewrite that
# checkout's client (and any live stack there): give this checkout its own.
for dir in node_modules/.prisma back-end/node_modules/.prisma; do
  if [ -L "$dir" ]; then
    case "$(readlink -f "$dir")" in
      "$CHECKOUT"/*) ;;
      *) rm "$dir"; mkdir -p "$dir" ;;
    esac
  fi
done
(cd back-end && npx prisma generate >/dev/null)
resolved="$(resolve_client)"
case "$resolved" in
  "$CHECKOUT"/*) ;;
  *)
    echo "❌ The regenerated Prisma client resolves outside this checkout (${resolved:-nowhere}); link node_modules/@prisma and node_modules/.prisma into the checkout before preparing it." >&2
    exit 1
    ;;
esac
node "$ASSERT"
echo "✅ Prisma client regenerated: $resolved"
