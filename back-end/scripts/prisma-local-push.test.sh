#!/usr/bin/env bash
set -euo pipefail

SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prisma-local-push.sh
LOCAL_URL=postgresql://postgres:postgres@localhost:5432/test
REMOTE_URL=postgresql://postgres:postgres@db.example.com:5432/prod

if DATABASE_URL="$REMOTE_URL" DIRECT_URL="$LOCAL_URL" PRISMA_LOCAL_PUSH_DRY_RUN=1 \
  bash "$SCRIPT" >/dev/null 2>&1; then
  echo "DATABASE_URL remote-target guard failed" >&2
  exit 1
fi

if DATABASE_URL="$LOCAL_URL" DIRECT_URL="$REMOTE_URL" PRISMA_LOCAL_PUSH_DRY_RUN=1 \
  bash "$SCRIPT" >/dev/null 2>&1; then
  echo "DIRECT_URL remote-target guard failed" >&2
  exit 1
fi

DATABASE_URL="$LOCAL_URL" DIRECT_URL="$LOCAL_URL" PRISMA_LOCAL_PUSH_DRY_RUN=1 \
  bash "$SCRIPT" | grep -Fq 'validation passed'

# Agents follow these docs literally. A bare `npx prisma db push` from back-end/
# picks up back-end/.env's prod URLs and drops every index Prisma cannot model,
# so instructions must route local pushes through the guarded wrapper instead.
ROOT=$(cd "$(dirname "$SCRIPT")/../.." && pwd)
bare=$(cd "$ROOT" && find CLAUDE.md AGENTS.md .claude docs -name '*.md' \
  -not -path 'docs/rca/*' -not -path 'docs/plans/*' -print0 2>/dev/null \
  | xargs -0 awk '
    FNR == 1 { command = ""; continued = 0 }
    {
      command = continued ? command " " $0 : $0
      continued = ($0 ~ /\\[[:space:]]*$/)
      if (continued) next
      local_url = "postgres(ql)?://[^@ ]*@(localhost|127\\.0\\.0\\.1)"
      scoped = command ~ ("DATABASE_URL=\"?" local_url) && command ~ ("DIRECT_URL=\"?" local_url)
      if (command ~ /npx( --no-install)? prisma db push/ && !scoped) print FILENAME ":" FNR ": " $0
    }' || true)
if [ -n "$bare" ]; then
  printf '%s\n' "$bare" >&2
  echo "instruction docs tell agents to run a bare prisma db push; use npm run prisma:push:local" >&2
  exit 1
fi

echo "local Prisma push safety tests: PASS"
