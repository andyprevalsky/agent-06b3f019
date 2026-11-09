#!/usr/bin/env bash
set -euo pipefail

# Prisma db push owns tables and columns but intentionally ignores hand-written
# functions and triggers from migrations. Re-apply the exact idempotent workflow
# DDL after every local db push so local tests exercise the production schema.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_SQL="$BACKEND_DIR/prisma/migrations/20260723000000_add_workflow_iteration_offset/migration.sql"
TRAJECTORY_SQL="$BACKEND_DIR/prisma/migrations/20260929120000_agent_trajectory_search/migration.sql"
PHONE_MESSAGE_SQL=(
  "$BACKEND_DIR/prisma/migrations/20261105233000_cloud_message_unresolved_task/migration.sql"
  "$BACKEND_DIR/prisma/migrations/20261105233001_cloud_message_drop_historical_unique/migration.sql"
  "$BACKEND_DIR/prisma/migrations/20261105233002_cloud_message_task_history_index/migration.sql"
)
DATABASE_TARGET="${DIRECT_URL:-${DATABASE_URL:-}}"
START_MARKER="-- Protect the rolling-deploy window"
END_MARKER="-- Prefer explicit logical-iteration checkpoints"

if [[ ! -f "$MIGRATION_SQL" ]]; then
  echo "Workflow migration is missing: $MIGRATION_SQL" >&2
  exit 1
fi
if [[ ! -f "$TRAJECTORY_SQL" ]]; then
  echo "Trajectory migration is missing: $TRAJECTORY_SQL" >&2
  exit 1
fi

DDL_SQL="$(
  awk -v start="$START_MARKER" -v end="$END_MARKER" '
    index($0, start) == 1 {
      if (started) exit 2
      started = 1
      emit = 1
    }
    index($0, end) == 1 {
      if (!started || ended) exit 2
      ended = 1
      emit = 0
    }
    emit
    END {
      if (!started || !ended) exit 2
    }
  ' "$MIGRATION_SQL"
)"

# Production migrations are single concurrent statements; local initialization
# translates the same ordered sources into one idempotent transaction.
phone_message_ddl() {
  echo 'BEGIN;'
  echo "SELECT pg_advisory_xact_lock(hashtext('rose-local-runtime-sql-hooks'));"
  sed -e 's/CREATE UNIQUE INDEX CONCURRENTLY /CREATE UNIQUE INDEX IF NOT EXISTS /' \
    -e 's/DROP INDEX CONCURRENTLY /DROP INDEX IF EXISTS /' \
    -e 's/CREATE INDEX CONCURRENTLY /CREATE INDEX IF NOT EXISTS /' "${PHONE_MESSAGE_SQL[@]}"
  echo 'COMMIT;'
}

# When ROSE_USE_SYSTEM_PG=true, always apply via host psql + DATABASE_URL. A
# leftover empty Docker container with the workspace name must not steal DDL
# (observed on Cloud: prisma syncs system PG, then this script docker-execs an
# empty container → "relation Agent does not exist" and run.sh aborts).
if [[ "${ROSE_USE_SYSTEM_PG:-false}" != "true" ]] &&
  [[ -n "${DB_CONTAINER:-}" ]] &&
  command -v docker >/dev/null 2>&1 &&
  docker inspect "$DB_CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
  { printf '%s\n' "$DDL_SQL"; phone_message_ddl; } |
    docker exec -i "$DB_CONTAINER" psql \
      -U "${LOCAL_DB_USER:-postgres}" \
      -d "${LOCAL_DB_NAME:-victoria}" \
      -v ON_ERROR_STOP=1 >/dev/null
  docker exec -i "$DB_CONTAINER" psql \
    -U "${LOCAL_DB_USER:-postgres}" \
    -d "${LOCAL_DB_NAME:-victoria}" \
    -v ON_ERROR_STOP=1 < "$TRAJECTORY_SQL" >/dev/null
elif [[ -n "$DATABASE_TARGET" ]] && command -v psql >/dev/null 2>&1; then
  { printf '%s\n' "$DDL_SQL"; phone_message_ddl; } | psql "$DATABASE_TARGET" -v ON_ERROR_STOP=1 >/dev/null
  psql "$DATABASE_TARGET" -v ON_ERROR_STOP=1 < "$TRAJECTORY_SQL" >/dev/null
else
  echo "A running DB_CONTAINER or host psql with DATABASE_URL/DIRECT_URL is required." >&2
  exit 1
fi

echo "Applied local workflow and trajectory search functions and triggers."
