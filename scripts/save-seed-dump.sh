#!/usr/bin/env bash
set -euo pipefail

# Create a custom-format seed archive with the client that belongs to the
# database being dumped. A newer host pg_dump can emit an archive header that
# the benchmark container's older pg_restore cannot read.

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
    echo "usage: save-seed-dump.sh <dump> <host> <port> <user> <database> [container]" >&2
    exit 2
fi

DUMP_PATH="$1"
DB_HOST="$2"
DB_PORT="$3"
DB_USER="$4"
DB_NAME="$5"
DB_CONTAINER="${6:-}"
DUMP_TMP="${DUMP_PATH}.tmp.$$"

cleanup() {
    rm -f "$DUMP_TMP"
}
trap cleanup EXIT

mkdir -p "$(dirname "$DUMP_PATH")"
if [ -n "$DB_CONTAINER" ]; then
    docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$DUMP_TMP"
else
    PGPASSWORD="${PGPASSWORD:-postgres}" pg_dump \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -Fc \
        "$DB_NAME" > "$DUMP_TMP"
fi

mv "$DUMP_TMP" "$DUMP_PATH"
