#!/usr/bin/env bash
# Dependency preparation owns Prisma client generation: test launchers only
# assert freshness (back-end/scripts/assert-prisma-client-current.mjs) and
# never rewrite the client. A deploy worktree reuses a linked dependency tree
# whose generated client was compiled for whatever schema its source checkout
# had at the time; on 2026-10-29 that client lacked a column merged two days
# earlier, so every Prisma-backed lane (backend coverage shards, live probes)
# refused to start while the structural lanes were green.
#
#   back-end/prisma/schema.prisma ──assert──► fresh ──► exit 0
#                                      └──► stale ──► own node_modules/.prisma
#                                                     (never a link into another
#                                                     checkout) ──► prisma generate
#                                                     ──► client resolves inside
#                                                     this checkout ──► assert
set -euo pipefail
CHECKOUT="${1:?usage: ensure-prisma-client.sh <checkout>}"
CHECKOUT="$(cd "$CHECKOUT" && pwd -P)"
cd "$CHECKOUT"
ASSERT="back-end/scripts/assert-prisma-client-current.mjs"
if node "$ASSERT" >/dev/null 2>&1; then
  exit 0
fi
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
echo "🔧 Prisma client is stale for $CHECKOUT/back-end/prisma/schema.prisma; regenerating"
(cd back-end && npx prisma generate >/dev/null)
resolved="$(cd back-end && node -e '
const { createRequire } = require("node:module");
const { realpathSync } = require("node:fs");
const clientRequire = createRequire(require.resolve("@prisma/client/package.json"));
process.stdout.write(realpathSync(clientRequire.resolve(".prisma/client/default")));
')"
case "$resolved" in
  "$CHECKOUT"/*) ;;
  *)
    echo "❌ The regenerated Prisma client resolves outside this checkout ($resolved); link node_modules/@prisma and node_modules/.prisma into the checkout before preparing it." >&2
    exit 1
    ;;
esac
node "$ASSERT"
echo "✅ Prisma client regenerated: $resolved"
