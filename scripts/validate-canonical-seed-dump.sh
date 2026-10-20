#!/usr/bin/env bash
# Validate that a restored database still carries the reviewed content promised
# by BASE_IMAGE_CACHE_REVISION=victoria-prod-sync-v1-whatsapp-v2: the frozen
# WhatsApp history and the archived prior agent trajectories indexed in
# AgentTrajectorySearch. Each PG-major artifact is published separately, so a
# publication that drops either row set must fail here, not in a benchmark.
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
# Archived prior runs recalled by the grep-agent-trajectories-* tasks
# (tasks.json context_notes: "materialized in the canonical base image search
# index"): root agent id and its reviewed archive-backed row count. Live rows
# written by the restored stack's own runs never satisfy this promise.
TRAJECTORY_ROOTS=(
  "ec19feb9-2b8a-4369-8c1b-886be79c8a8c:42"  # browser run: example.com title
  "c4531f8e-ad45-41a0-84a1-eb6714b5c63b:21"  # coding run: Collatz from 27
  "18ad8b43-1363-43dd-a4df-278b80bc1b63:178" # research run: city comparison
)

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
trajectory_counts="$(
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -At <<SQL
SELECT "rootAgentId" || ':' || COUNT(*)::text FROM "AgentTrajectorySearch"
 WHERE "userId" = '${BENCH_USER_ID}' AND "archivePath" IS NOT NULL
 GROUP BY "rootAgentId";
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

trajectory_rows=0
for entry in "${TRAJECTORY_ROOTS[@]}"; do
  root="${entry%%:*}"
  min_rows="${entry##*:}"
  got="$(printf '%s\n' "$trajectory_counts" | awk -F: -v root="$root" '$1 == root { print $2 }')"
  if ! [[ "${got:-0}" =~ ^[0-9]+$ ]] || [ "${got:-0}" -lt "$min_rows" ]; then
    echo "canonical seed dump missing archived agent trajectory ${root}: got ${got:-0} AgentTrajectorySearch archive rows for ${BENCH_USER_ID}, need >= ${min_rows}" >&2
    ok=0
  else
    trajectory_rows=$((trajectory_rows + got))
  fi
done

if [ "$ok" -ne 1 ]; then
  exit 1
fi

echo "canonical seed dump ok: ${wa_count} WHATSAPP messages + CONNECTED whatsapp Integration + ${trajectory_rows} archived trajectory rows (${#TRAJECTORY_ROOTS[@]} runs) for ${BENCH_USER_ID}"
