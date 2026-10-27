#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_SQL="$BACKEND_DIR/prisma/migrations/20260723000000_add_workflow_iteration_offset/migration.sql"
UTC_CLEANUP_MIGRATION_SQL="$BACKEND_DIR/prisma/migrations/20260724002500_temporal_cleanup_utc_grace/migration.sql"
TRAJECTORY_SQL="$BACKEND_DIR/prisma/migrations/20260929120000_agent_trajectory_search/migration.sql"
# Prisma cannot model trigram indexes, so `db push` never creates them locally.
# Supersedes the trajectory trigger above (goals stored once per agent).
TRAJECTORY_AGENT_SQL="$BACKEND_DIR/prisma/migrations/20261026210002_agent_trajectory_agent/migration.sql"
TOOL_SIDE_EFFECT_TRGM_SQL="$BACKEND_DIR/prisma/migrations/20261026210001_tool_side_effect_operation_key_trgm/migration.sql"

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
    // libpq/Prisma prefer a `host`/`hostaddr` query parameter over the authority.
    if (["host", "hostaddr"].some((key) => parsed.searchParams.has(key))) process.exit(1);
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

WORKFLOW_SQL="$(awk '
  /^-- Protect the rolling-deploy window/ { starts++; if (starts == 1 && ends == 0) emit = 1 }
  /^-- Prefer explicit logical-iteration checkpoints/ { if (starts == 0) misordered = 1; ends++; emit = 0 }
  emit && $0 !~ /^[[:space:]]*(--.*)?$/ { statements++ }
  emit { print }
  END {
    if (starts != 1 || ends != 1 || misordered) exit 3
    if (statements == 0) exit 4
  }
' "$MIGRATION_SQL")" || {
  case $? in
    4) echo "Refusing local runtime SQL hooks: no workflow SQL between the markers in $MIGRATION_SQL" >&2 ;;
    *) echo "Refusing local runtime SQL hooks: workflow markers must each appear exactly once, in order, in $MIGRATION_SQL" >&2 ;;
  esac
  exit 2
}

# Concurrent black-box runners share one local database, and DROP/CREATE
# TRIGGER pairs race each other ("already exists", "tuple concurrently
# updated"). One transaction behind an advisory lock serializes them.
{
  echo "SELECT pg_advisory_xact_lock(hashtext('rose-local-runtime-sql-hooks'));"
  printf '%s\n' "$WORKFLOW_SQL"
  cat "$UTC_CLEANUP_MIGRATION_SQL"
  cat "$TRAJECTORY_SQL"
  cat "$TRAJECTORY_AGENT_SQL"
  # CONCURRENTLY cannot run inside this hook's single transaction.
  sed 's/INDEX CONCURRENTLY/INDEX/' "$TOOL_SIDE_EFFECT_TRGM_SQL"
} | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction
