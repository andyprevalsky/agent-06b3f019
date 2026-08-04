#!/usr/bin/env bash
# Snapshot every row of an account touched by an impersonated machine-data sync,
# so restore-impersonation-contaminated-account.sql is reversible.
#
# Dumps ALL rows for the victim in the affected tables — not just the ones the
# restore deletes — so a mis-attributed delete can be reconstructed exactly.
#
# Usage: DIRECT_URL=... bash scripts/backup-impersonation-contaminated-account.sh <victimUserId> [outDir]
set -euo pipefail

# These CSVs are the most sensitive artifact this repo produces: cleartext
# session cookies, browser-password ciphertext, and message history for a real
# user. Written under the default 022 umask they land 0644/0755 — readable by
# every account and every process on the host. Restrict before anything is
# created; `umask` applies to the mkdir and to psql's \copy output alike.
umask 077

VICTIM="${1:?usage: backup-impersonation-contaminated-account.sh <victimUserId> [outDir]}"
OUT_DIR="${2:-../.context/impersonation-restore}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$OUT_DIR/$VICTIM-$STAMP"

# psql rejects libpq-incompatible query params such as ?pgbouncer=true.
DB_URL="${DIRECT_URL%%\?*}"
[ -n "$DB_URL" ] || { echo "DIRECT_URL is not set" >&2; exit 1; }

# A userId is always a UUID here. Validating it keeps the value out of the
# \copy SQL string as anything but a literal, and catches a shell-quoting slip
# before it becomes a predicate.
case "$VICTIM" in
  [0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*) ;;
  *) echo "victimUserId must be a UUID, got: $VICTIM" >&2; exit 1 ;;
esac

mkdir -p "$DEST"

for table in Cookie CookieBundle BrowserPassword LocalStorageOrigin IndexedDBOrigin \
             CacheStorageOrigin BrowserPermission Person Integration SteelSessionAuth; do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q \
    -c "\copy (SELECT * FROM \"$table\" WHERE \"userId\" = '$VICTIM') TO '$DEST/$table.csv' WITH CSV HEADER"
  echo "  $table -> $(( $(wc -l < "$DEST/$table.csv") - 1 )) rows"
done

# Messages hang off Person, so capture them through the join.
psql "$DB_URL" -v ON_ERROR_STOP=1 -q \
  -c "\copy (SELECT m.* FROM \"MessageRecord\" m JOIN \"Person\" p ON p.id = m.\"personId\" WHERE p.\"userId\" = '$VICTIM') TO '$DEST/MessageRecord.csv' WITH CSV HEADER"
echo "  MessageRecord -> $(( $(wc -l < "$DEST/MessageRecord.csv") - 1 )) rows"

echo "Backup written to $DEST"
