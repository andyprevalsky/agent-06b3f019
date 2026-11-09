#!/usr/bin/env bash
# Republish the canonical benchmark seed fixture for a new schema.
#
# Any schema.prisma edit re-keys the canonical seed
# (`<sha1(schema)>-pg<M>-victoria-prod-sync-v1-whatsapp-v2`), and /deploy's
# seed ratchet and smoke fail until that key exists in the shared cache. This
# migrates the previous reviewed fixture instead of re-syncing prod, so the
# reviewed WhatsApp history and trajectories survive unchanged.
#
#   old fixture (base schema) ─► pgvector:pg<M> container ─► apply migrations
#        ─► validate ─► dump ─► restore into a second DB ─► validate + row counts
#        ─► seed-dump-cache put ─► get + cmp
#
# Usage:
#   migrate-canonical-seed.sh <pg-major> <base-schema.prisma> <migration.sql>...
#
# Run from the repository root with back-end/.env holding the R2 credentials.
# Needs Docker. Owns and removes only its uniquely named container.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: migrate-canonical-seed.sh <pg-major> <base-schema.prisma> <migration.sql>..." >&2
  exit 2
fi
PG_MAJOR="$1"
BASE_SCHEMA="$2"
shift 2
MIGRATIONS=("$@")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ROOT}/agents/venv/bin/python"
OLD_TOKEN="$("$PY" "$ROOT/agents/benchmarks/seed_cache_path.py" "$BASE_SCHEMA" --cache-token --pg-major "$PG_MAJOR")"
NEW_TOKEN="$("$PY" "$ROOT/agents/benchmarks/seed_cache_path.py" "$ROOT/back-end/prisma/schema.prisma" --cache-token --pg-major "$PG_MAJOR")"
if [ "$OLD_TOKEN" = "$NEW_TOKEN" ]; then
  echo "schema unchanged for pg${PG_MAJOR}; nothing to publish" >&2
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/canonical-seed-pg${PG_MAJOR}.XXXXXX")"
CONTAINER="canonical-seed-pg${PG_MAJOR}-$$"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

seed_cache() { (cd "$ROOT/back-end" && npx tsx scripts/seed-dump-cache.ts "$@"); }

echo "▶ pg${PG_MAJOR}: ${OLD_TOKEN} → ${NEW_TOKEN}"
# head exits 0 when present and 3 when absent; anything else is an error, and
# continuing could overwrite an existing published fixture.
head_rc=0
seed_cache head "$NEW_TOKEN" >/dev/null 2>&1 || head_rc=$?
if [ "$head_rc" -eq 0 ]; then
  echo "✅ ${NEW_TOKEN} already published"
  exit 0
elif [ "$head_rc" -ne 3 ]; then
  echo "❌ seed-dump-cache head ${NEW_TOKEN} failed (exit ${head_rc}); refusing to publish" >&2
  exit 1
fi
seed_cache get "$OLD_TOKEN" "$WORK/old.dump"

PORT="$("$PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:${PORT}:5432" \
  "pgvector/pgvector:pg${PG_MAJOR}" >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -p 5432 -U postgres -q 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "❌ PostgreSQL TCP readiness exhausted after 60 attempts; refusing migration/publication" >&2
  exit 1
fi

psql_c() { PGPASSWORD=postgres psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres "$@"; }
# Exact per-table row counts (pg_stat n_live_tup is only an estimate).
counts() {
  local query
  query="$(psql_c -d "$1" -At -c "SELECT string_agg(format(
      'SELECT %L || ''='' || count(*) FROM %I.%I', schemaname || '.' || tablename, schemaname, tablename),
      ' UNION ALL ' ORDER BY schemaname, tablename)
    FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")"
  psql_c -d "$1" -At -c "$query" | sort
}

psql_c -d postgres -c 'CREATE DATABASE migrated' -c 'CREATE DATABASE roundtrip'
bash "$ROOT/scripts/restore-seed-dump.sh" "$WORK/old.dump" 127.0.0.1 "$PORT" postgres migrated "$CONTAINER"
for migration in "${MIGRATIONS[@]}"; do
  echo "▶ applying ${migration}"
  psql_c -d migrated -f "$migration"
done
PGPASSWORD=postgres bash "$ROOT/scripts/validate-canonical-seed-dump.sh" migrated 127.0.0.1 "$PORT" postgres

bash "$ROOT/scripts/save-seed-dump.sh" "$WORK/new.dump" 127.0.0.1 "$PORT" postgres migrated "$CONTAINER"
bash "$ROOT/scripts/restore-seed-dump.sh" "$WORK/new.dump" 127.0.0.1 "$PORT" postgres roundtrip "$CONTAINER"
PGPASSWORD=postgres bash "$ROOT/scripts/validate-canonical-seed-dump.sh" roundtrip 127.0.0.1 "$PORT" postgres
if [ "$(counts migrated)" != "$(counts roundtrip)" ]; then
  echo "❌ row counts differ after dump/restore round trip" >&2
  exit 1
fi

seed_cache put "$NEW_TOKEN" "$WORK/new.dump"
seed_cache get "$NEW_TOKEN" "$WORK/check.dump"
cmp "$WORK/new.dump" "$WORK/check.dump"
echo "✅ published ${NEW_TOKEN} ($(wc -c <"$WORK/new.dump") bytes)"
