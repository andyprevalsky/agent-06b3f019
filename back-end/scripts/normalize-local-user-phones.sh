#!/usr/bin/env bash
# Make a LOCAL database's User.phone values satisfy the unique User.phone index
# before `prisma db push` adds it. Production got there through the
# 20261018120000_unique_user_phone migration (blank -> NULL) and had no
# duplicates; long-lived local databases can still hold blank phones written by
# anonymous sessions, or two seeded copies of one account (an account that was
# later merged in production). Without this, push refuses to create the index
# and every local stack/test run on that database fails.
#
# Blank phones become NULL. For a phone stored on several rows, the oldest
# account keeps it (the account phone login resolves to) and the newer rows'
# phone becomes NULL. Idempotent, and a no-op when the User table is missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
URL="${1:-${DATABASE_URL:-}}"

if [ -z "$URL" ]; then
  echo "normalize-local-user-phones: pass a database URL or set DATABASE_URL" >&2
  exit 2
fi
node -e '
  const parsed = new URL(process.argv[1]);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) process.exit(1);
  // libpq/Prisma prefer a `host`/`hostaddr` query parameter over the authority.
  if (["host", "hostaddr"].some((key) => parsed.searchParams.has(key))) process.exit(1);
' "$URL" || {
  echo "Refusing to normalize User.phone: target is not a localhost database" >&2
  exit 2
}

if [ "${NORMALIZE_LOCAL_USER_PHONES_DRY_RUN:-0}" = "1" ]; then
  echo "Local User.phone normalization target validation passed"
  exit 0
fi

cd "$BACKEND_DIR"
PRISMA_HIDE_UPDATE_MESSAGE=1 npx --no-install prisma db execute --url "$URL" --stdin <<'SQL'
DO $$
BEGIN
  IF to_regclass('"User"') IS NOT NULL THEN
    UPDATE "User" SET "phone" = NULL WHERE btrim("phone") = '';
    UPDATE "User" AS u
    SET "phone" = NULL
    FROM (
      SELECT "userId",
             row_number() OVER (PARTITION BY "phone" ORDER BY "createdAt", "userId") AS rank
      FROM "User"
      WHERE "phone" IS NOT NULL
    ) AS ranked
    WHERE u."userId" = ranked."userId" AND ranked.rank > 1;
  END IF;
END $$;
SQL
