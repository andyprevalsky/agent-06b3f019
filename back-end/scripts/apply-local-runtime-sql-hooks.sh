#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_SQL="$BACKEND_DIR/prisma/migrations/20260723000000_add_workflow_iteration_offset/migration.sql"
UTC_CLEANUP_MIGRATION_SQL="$BACKEND_DIR/prisma/migrations/20260724002500_temporal_cleanup_utc_grace/migration.sql"

validate_local_database_url() {
  local variable_name=$1
  local value=${!variable_name:-}
  if [ -z "$value" ]; then
    echo "$variable_name must be set before applying local runtime SQL hooks" >&2
    exit 2
  fi
  node -e '
    const parsed = new URL(process.argv[1]);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) process.exit(1);
  ' "$value" || {
    echo "Refusing local runtime SQL hooks: $variable_name is not a localhost database" >&2
    exit 2
  }
}

validate_local_database_url DATABASE_URL

command -v psql >/dev/null 2>&1 || {
  echo "psql is required to apply local runtime SQL hooks" >&2
  exit 2
}

awk '
  /^-- Protect the rolling-deploy window/ { emit = 1 }
  /^-- Prefer explicit logical-iteration checkpoints/ { emit = 0 }
  emit { print }
' "$MIGRATION_SQL" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$UTC_CLEANUP_MIGRATION_SQL"
