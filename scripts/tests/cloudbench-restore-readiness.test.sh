#!/usr/bin/env bash
# Focused test for the cloud bench seed FAST-RESTORE path in scripts/run.sh.
#
# RCA cement (fleet run 20260720-102212-78585: 41/42 boxes wedged).
# The box seeds its local Postgres one of two ways:
#   • cold-sync (else branch): `prisma db push` → `ensure-agent-network-grep-indexes.ts`
#     → prod seed → `pg_dump` a reusable dump. Backends on this DB are HEALTHY.
#   • fast-restore (then branch, when a schema-matched dump exists): `pg_restore`
#     the dump and SKIP everything else.
#
# The fast-restore branch was NOT equivalent to the cold-sync branch, so it could
# hand the app a DB that is not backend-ready:
#   1. It hardcoded the database name `victoria` for BOTH the `pg_restore` target
#      and the `pg_dump` save, while the backend's DATABASE_URL uses `$LOCAL_DB_NAME`
#      — which run.sh sets to `victoria_bench_<run-id>` for an isolated benchmark
#      run (see the BENCHMARK_RUN_ID branch). When the two names diverge the restore
#      populates the WRONG database (leaving the app DB empty) and the saved dump is
#      taken from the wrong database (poisoning the shared R2 cache for later boxes).
#   2. It skipped `ensure-agent-network-grep-indexes.ts`, so a dump published by an
#      older box (before that step existed) or a partially-applied restore leaves the
#      Message trgm/grep index absent — and, on a cold box, this is also the FIRST
#      idempotent readiness step that would run before the backend launches.
#   3. It swallowed `pg_restore` stderr to /dev/null (`>/dev/null 2>&1`), so a
#      partial restore (pg_restore continues on error and still exits 0 without `-e`)
#      reported "✅ DB restored" while the DB was incomplete — undiagnosable.
#
# These assertions pin the fast-restore branch to be equivalent + observable so the
# "optimal reseeding" optimization can be safely re-enabled.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="$ROOT_DIR/scripts/run.sh"
[ -f "$RUN_SH" ] || { echo "FATAL: missing $RUN_SH" >&2; exit 1; }

fail() { echo "FAIL: $*" >&2; exit 1; }

# Extract the fast-restore (then) branch body: everything between `if $DB_RESTORED; then`
# and the matching `else` on the seed decision.
RESTORE_BRANCH="$(awk '
  /^if \$DB_RESTORED; then$/ { grab=1; next }
  grab && /^else$/           { exit }
  grab                       { print }
' "$RUN_SH")"

[ -n "$RESTORE_BRANCH" ] || fail "could not locate the 'if \$DB_RESTORED; then ... else' branch in run.sh"

# ── 1: restore branch must run the grep-index readiness step ─────────────────
echo "$RESTORE_BRANCH" | grep -q 'ensure-agent-network-grep-indexes.ts' \
  || fail "fast-restore branch does not run ensure-agent-network-grep-indexes.ts (readiness/index parity skipped)"
echo "PASS 1 — fast-restore branch ensures agent-network grep indexes"

# ── 2: restore helper must receive and target the app's $LOCAL_DB_NAME ────────
RESTORE_HELPER="$ROOT_DIR/scripts/restore-seed-dump.sh"
[ -f "$RESTORE_HELPER" ] || fail "missing restore-seed-dump.sh"
RESTORE_CALL="$(grep -A2 -E 'bash scripts/restore-seed-dump\.sh' "$RUN_SH" || true)"
[ -n "$RESTORE_CALL" ] || fail "could not find the restore-seed-dump.sh call in run.sh"
echo "$RESTORE_CALL" | grep -q '"\$LOCAL_DB_NAME"' \
  || fail "restore helper must receive \$LOCAL_DB_NAME (found: $RESTORE_CALL)"
RESTORE_DB_ARG="$(grep -E -- '-d "\$DB_NAME"' "$RESTORE_HELPER" || true)"
[ -n "$RESTORE_DB_ARG" ] \
  || fail "restore helper must pass its database argument to pg_restore"
grep -q -- '--exit-on-error' "$RESTORE_HELPER" \
  || fail "restore helper must fail on the first pg_restore error"
grep -q -- '--single-transaction' "$RESTORE_HELPER" \
  || fail "restore helper must make the restore atomic"
echo "PASS 2 — restore helper targets \$LOCAL_DB_NAME atomically (not a hardcoded db)"

# ── 3: the seed-dump pg_dump must dump the app's $LOCAL_DB_NAME ───────────────
DUMP_LINE="$(grep -E 'pg_dump .*-Fc "\$LOCAL_DB_NAME"' "$RUN_SH" || true)"
[ -n "$DUMP_LINE" ] || fail "could not find the seed-dump pg_dump command in run.sh"
echo "$DUMP_LINE" | grep -qE -- '-Fc "\$LOCAL_DB_NAME"' \
  || fail "seed-dump pg_dump must dump \"\$LOCAL_DB_NAME\" (found: $DUMP_LINE)"
echo "$DUMP_LINE" | grep -qE -- '-Fc victoria( |$|>)' \
  && fail "seed-dump pg_dump still hardcodes victoria instead of \$LOCAL_DB_NAME (found: $DUMP_LINE)"
echo "PASS 3 — seed-dump pg_dump dumps \$LOCAL_DB_NAME (not a hardcoded db)"

# ── 4: restore must NOT swallow stderr to /dev/null (keep it diagnosable) ─────
echo "$RESTORE_CALL" | grep -qE '2>&1' \
  && fail "restore call merges stderr into /dev/null — partial-restore errors are hidden"
grep -E 'pg_restore' "$RESTORE_HELPER" | grep -qE '2>&1' \
  && fail "restore helper merges pg_restore stderr into /dev/null"
echo "PASS 4 — pg_restore surfaces stderr (partial-restore failures are visible)"

echo "ALL PASS: cloudbench restore readiness"
