#!/usr/bin/env bash
# Create MessageRecord's message trigram index on a LOCAL database after
# `prisma db push`. Prisma cannot model the gin_trgm_ops index, so push neither
# creates it nor keeps it; production gets it from the
# 20261026170000_message_record_message_trgm migration, applied here verbatim so
# local grep plans match production. Idempotent (IF NOT EXISTS); run it only
# after a push has created MessageRecord.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_SQL="$BACKEND_DIR/prisma/migrations/20261026170000_message_record_message_trgm/migration.sql"
URL="${1:-${DATABASE_URL:-}}"

if [ -z "$URL" ]; then
  echo "apply-local-message-record-trgm-index: pass a database URL or set DATABASE_URL" >&2
  exit 2
fi
# libpq/Prisma honour a `host`/`hostaddr` query parameter over the authority
# host, so a localhost authority alone does not prove a local target.
node -e '
  const parsed = new URL(process.argv[1]);
  const local = ["localhost", "127.0.0.1", "::1"];
  if (!local.includes(parsed.hostname)) process.exit(1);
  for (const key of ["host", "hostaddr"]) {
    if (parsed.searchParams.has(key)) process.exit(1);
  }
' "$URL" || {
  echo "Refusing to create the MessageRecord trigram index: target is not a localhost database" >&2
  exit 2
}
[ -f "$MIGRATION_SQL" ] || { echo "Trigram migration is missing: $MIGRATION_SQL" >&2; exit 1; }

if [ "${APPLY_LOCAL_MESSAGE_RECORD_TRGM_INDEX_DRY_RUN:-0}" = "1" ]; then
  echo "Local MessageRecord trigram index target validation passed"
  exit 0
fi

cd "$BACKEND_DIR"
PRISMA_HIDE_UPDATE_MESSAGE=1 npx --no-install prisma db execute --url "$URL" --stdin <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
# Separate call: CREATE INDEX CONCURRENTLY cannot share a batch or transaction.
PRISMA_HIDE_UPDATE_MESSAGE=1 npx --no-install prisma db execute --url "$URL" --file "$MIGRATION_SQL"
