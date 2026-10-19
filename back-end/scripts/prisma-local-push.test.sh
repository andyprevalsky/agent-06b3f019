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

# The pre-push User.phone normalizer rewrites rows, so it must refuse remote
# targets exactly like the push wrapper.
NORMALIZE="$(dirname "$SCRIPT")/normalize-local-user-phones.sh"
if NORMALIZE_LOCAL_USER_PHONES_DRY_RUN=1 bash "$NORMALIZE" "$REMOTE_URL" >/dev/null 2>&1; then
  echo "User.phone normalizer remote-target guard failed" >&2
  exit 1
fi
NORMALIZE_LOCAL_USER_PHONES_DRY_RUN=1 bash "$NORMALIZE" "$LOCAL_URL" | grep -Fq 'validation passed'

# Exercise the real SQL on a scratch database when a local Postgres is up:
# blanks become NULL, the oldest row keeps a duplicated phone, reruns are no-ops.
ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres
# Only when a local server accepts these credentials with a role that may create
# the scratch database; otherwise the SQL check is reported as skipped.
can_create_scratch_db() {
  command -v psql >/dev/null 2>&1 || return 1
  [ "$(psql "$ADMIN_URL" -Atc \
    'SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user' \
    2>/dev/null)" = t ]
}
if can_create_scratch_db; then
  SCRATCH_DB="phone_normalize_test_$$"
  SCRATCH_URL="postgresql://postgres:postgres@localhost:5432/$SCRATCH_DB"
  psql "$ADMIN_URL" -qc "CREATE DATABASE $SCRATCH_DB" >/dev/null
  trap 'psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null 2>&1 || true' EXIT
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
CREATE TABLE "User" ("userId" text PRIMARY KEY, "phone" text, "createdAt" timestamp NOT NULL);
INSERT INTO "User" VALUES
  ('blank-a', '', now()), ('blank-b', '  ', now()),
  ('dup-newer', '+15550001111', now()),
  ('dup-oldest', '+15550001111', now() - interval '1 day'),
  ('solo', '+15550002222', now()), ('none', NULL, now());
SQL
  bash "$NORMALIZE" "$SCRATCH_URL" >/dev/null
  bash "$NORMALIZE" "$SCRATCH_URL" >/dev/null
  actual=$(psql "$SCRATCH_URL" -Atc \
    "SELECT string_agg(\"userId\" || '=' || coalesce(\"phone\", 'NULL'), ',' ORDER BY \"userId\") FROM \"User\"")
  expected='blank-a=NULL,blank-b=NULL,dup-newer=NULL,dup-oldest=+15550001111,none=NULL,solo=+15550002222'
  if [ "$actual" != "$expected" ]; then
    echo "User.phone normalizer produced $actual, expected $expected" >&2
    exit 1
  fi
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -qc \
    'CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone")' >/dev/null
  echo "local User.phone normalization SQL: PASS"
else
  echo "local User.phone normalization SQL: skipped (no local Postgres)"
fi

echo "local Prisma push safety tests: PASS"
