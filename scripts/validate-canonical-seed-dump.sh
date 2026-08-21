#!/usr/bin/env bash
# Validate that a restored database still carries the reviewed WhatsApp
# history promised by BASE_IMAGE_CACHE_REVISION=victoria-prod-sync-v1-whatsapp-v2.
#
# Size alone cannot guard this: a custom-format (-Fc) archive of the good
# fixture is ~31MiB, the same ballpark as a cold-sync dump with ZERO
# MessageRecords. The only trustworthy check is row content after restore.
#
# Usage:
#   validate-canonical-seed-dump.sh <database> [host] [port] [user]
#
# Exit 0 when invariants hold; non-zero otherwise (stdout/stderr explain).
set -euo pipefail

DB_NAME="${1:-}"
DB_HOST="${2:-localhost}"
DB_PORT="${3:-5432}"
DB_USER="${4:-postgres}"

if [ -z "$DB_NAME" ]; then
  echo "usage: validate-canonical-seed-dump.sh <database> [host] [port] [user]" >&2
  exit 2
fi

# Bench user whose frozen WhatsApp history the revision promises
# (agents/benchmarks/tasks.json → whatsapp-history-recall context_notes).
# These are fixed canonical constants — do NOT read them from the environment.
# Inherited CANONICAL_SEED_* overrides could zero the floor or redirect the
# check to a noncanonical user and silently bless a poisoned dump on restore.
BENCH_USER_ID="1f85ff25-6e29-4c1b-8739-f917bd101a30"
MIN_WHATSAPP_MESSAGES="3825"

export PGPASSWORD="${PGPASSWORD:-postgres}"

result="$(
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<SQL
SELECT
  (SELECT COUNT(*)::text FROM "MessageRecord" mr
     JOIN "Person" p ON p.id = mr."personId"
    WHERE p."userId" = '${BENCH_USER_ID}' AND mr.channel::text = 'WHATSAPP'),
  (SELECT COUNT(*)::text FROM "Integration"
    WHERE "userId" = '${BENCH_USER_ID}' AND name = 'whatsapp' AND status::text = 'CONNECTED');
SQL
)"

wa_count="${result%%|*}"
wa_connected="${result##*|}"

ok=1
if ! [[ "$wa_count" =~ ^[0-9]+$ ]] || [ "$wa_count" -lt "$MIN_WHATSAPP_MESSAGES" ]; then
  echo "canonical seed dump missing WhatsApp history: got ${wa_count:-?} WHATSAPP MessageRecords for ${BENCH_USER_ID}, need >= ${MIN_WHATSAPP_MESSAGES}" >&2
  ok=0
fi
if [ "${wa_connected:-0}" != "1" ]; then
  echo "canonical seed dump missing CONNECTED whatsapp Integration for ${BENCH_USER_ID} (got ${wa_connected:-?})" >&2
  ok=0
fi

if [ "$ok" -ne 1 ]; then
  exit 1
fi

echo "canonical seed dump ok: ${wa_count} WHATSAPP messages + CONNECTED whatsapp Integration for ${BENCH_USER_ID}"
