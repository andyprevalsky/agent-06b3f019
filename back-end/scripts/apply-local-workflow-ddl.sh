#!/usr/bin/env bash
set -euo pipefail

# Prisma db push owns tables and columns but intentionally ignores hand-written
# functions and triggers from migrations. Re-apply the exact idempotent workflow
# DDL after every local db push so local tests exercise the production schema.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_SQL="$BACKEND_DIR/prisma/migrations/20260723000000_add_workflow_iteration_offset/migration.sql"
DATABASE_TARGET="${DIRECT_URL:-${DATABASE_URL:-}}"

if [[ -z "$DATABASE_TARGET" ]]; then
  echo "DATABASE_URL or DIRECT_URL is required to apply local workflow DDL." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to apply local workflow DDL." >&2
  exit 1
fi

awk '
  /^-- Protect the rolling-deploy window/ { emit = 1 }
  /^-- Prefer explicit logical-iteration checkpoints/ { emit = 0 }
  emit
' "$MIGRATION_SQL" | psql "$DATABASE_TARGET" -v ON_ERROR_STOP=1 >/dev/null

echo "Applied local workflow functions and triggers."
