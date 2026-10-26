#!/usr/bin/env bash
# Give a LOCAL database's MessageRecord rows their owner before `prisma db push`
# makes MessageRecord.userId required. Production got there through the
# 20261026160000-160004 migrations (add, backfill, validate); push cannot add a
# required column to a table that already has rows, so without this every
# long-lived local stack/test database fails to sync the schema.
#
# Adds the column when missing and copies Person.userId into rows that lack it.
# Idempotent, and a no-op when the MessageRecord table is missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
URL="${1:-${DATABASE_URL:-}}"

if [ -z "$URL" ]; then
  echo "backfill-local-message-record-owner: pass a database URL or set DATABASE_URL" >&2
  exit 2
fi
node -e '
  const parsed = new URL(process.argv[1]);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) process.exit(1);
' "$URL" || {
  echo "Refusing to backfill MessageRecord.userId: target is not a localhost database" >&2
  exit 2
}

if [ "${BACKFILL_LOCAL_MESSAGE_RECORD_OWNER_DRY_RUN:-0}" = "1" ]; then
  echo "Local MessageRecord owner backfill target validation passed"
  exit 0
fi

cd "$BACKEND_DIR"
PRISMA_HIDE_UPDATE_MESSAGE=1 npx --no-install prisma db execute --url "$URL" --stdin <<'SQL'
DO $$
BEGIN
  IF to_regclass('"MessageRecord"') IS NOT NULL THEN
    ALTER TABLE "MessageRecord" ADD COLUMN IF NOT EXISTS "userId" TEXT;
    UPDATE "MessageRecord" AS m
    SET "userId" = p."userId"
    FROM "Person" AS p
    WHERE p.id = m."personId" AND m."userId" IS NULL;
  END IF;
END $$;
SQL
