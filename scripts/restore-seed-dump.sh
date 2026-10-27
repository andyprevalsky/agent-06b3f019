#!/usr/bin/env bash
set -euo pipefail

# Isolated benchmark startup:
# cached custom archive -> pg_restore -> per-run Postgres database.
#
# Keep this boundary executable on its own so the restore contract can be
# regression-tested without launching the backend, frontend, or workers.

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
    echo "usage: restore-seed-dump.sh <dump> <host> <port> <user> <database> [container]" >&2
    exit 2
fi

DUMP_PATH="$1"
DB_HOST="$2"
DB_PORT="$3"
DB_USER="$4"
DB_NAME="$5"
DB_CONTAINER="${6:-}"

RESTORE_ARGS=(
    -U "$DB_USER"
    -d "$DB_NAME"
    --clean
    --if-exists
    --no-owner
    --exit-on-error
    --single-transaction
)

# A plain-SQL dump has no equivalent of pg_restore's --clean --if-exists: every
# CREATE runs unconditionally, so ANY object the caller already made in the
# target collides and (under ON_ERROR_STOP=1) fails the whole restore. run.sh
# does exactly that — it ensures the DEMO cache table before the seed
# restore — which made a canonical base fail with `relation
# "FastModeCacheEntry" already exists` and refuse to boot. Restoring a base
# image means "the dump IS the database state", so reset the schema first and
# give this path the same idempotence the archive path already has.
RESET_SQL='DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

ARCHIVE_MAGIC="$(LC_ALL=C head -c 5 "$DUMP_PATH" || true)"
if [ "$ARCHIVE_MAGIC" != "PGDMP" ]; then
    if [ -n "$DB_CONTAINER" ]; then
        # RESET uses -c only — do not pass -i. An interactive attach with no
        # redirected stdin inherits the caller's TTY/pipe and can hang forever
        # (fake docker stubs that drain stdin, and real psql waiting on input).
        docker exec "$DB_CONTAINER" psql \
            -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$RESET_SQL"
        docker exec -i "$DB_CONTAINER" psql \
            -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$DUMP_PATH"
    else
        PGPASSWORD="${PGPASSWORD:-postgres}" psql \
            -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" \
            -U "$DB_USER" -d "$DB_NAME" -c "$RESET_SQL"
        PGPASSWORD="${PGPASSWORD:-postgres}" psql \
            -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" \
            -U "$DB_USER" -d "$DB_NAME" < "$DUMP_PATH"
    fi
elif [ -n "$DB_CONTAINER" ]; then
    # The database image owns the only client guaranteed to understand its
    # server startup parameters. In particular, pg_restore 18 emits
    # `SET transaction_timeout`, which PostgreSQL 16 rejects before restoring
    # an otherwise-valid PostgreSQL 15 archive. Stream the archive into the
    # target container so host package upgrades cannot break isolated startup.
    docker exec -i "$DB_CONTAINER" pg_restore "${RESTORE_ARGS[@]}" < "$DUMP_PATH"
else
    # The no-Docker path uses the system server and its colocated client.
    PGPASSWORD="${PGPASSWORD:-postgres}" pg_restore \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        "${RESTORE_ARGS[@]}" \
        "$DUMP_PATH"
fi
