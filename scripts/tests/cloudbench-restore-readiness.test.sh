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
grep -q 'ensure-agent-network-grep-indexes.ts' <<<"$RESTORE_BRANCH" \
  || fail "fast-restore branch does not run ensure-agent-network-grep-indexes.ts (readiness/index parity skipped)"
echo "PASS 1 — fast-restore branch ensures agent-network grep indexes"

# ── 2: restore helper must receive and target the app's $LOCAL_DB_NAME ────────
RESTORE_HELPER="$ROOT_DIR/scripts/restore-seed-dump.sh"
[ -f "$RESTORE_HELPER" ] || fail "missing restore-seed-dump.sh"
RESTORE_CALL="$(grep -A2 -E 'bash scripts/restore-seed-dump\.sh' "$RUN_SH" || true)"
[ -n "$RESTORE_CALL" ] || fail "could not find the restore-seed-dump.sh call in run.sh"
grep -q '"\$LOCAL_DB_NAME"' <<<"$RESTORE_CALL" \
  || fail "restore helper must receive \$LOCAL_DB_NAME (found: $RESTORE_CALL)"
RESTORE_DB_ARG="$(grep -E -- '-d "\$DB_NAME"' "$RESTORE_HELPER" || true)"
[ -n "$RESTORE_DB_ARG" ] \
  || fail "restore helper must pass its database argument to pg_restore"
grep -q -- '--exit-on-error' "$RESTORE_HELPER" \
  || fail "restore helper must fail on the first pg_restore error"
grep -q -- '--single-transaction' "$RESTORE_HELPER" \
  || fail "restore helper must make the restore atomic"
echo "PASS 2 — restore helper targets \$LOCAL_DB_NAME atomically (not a hardcoded db)"

# ── 3: seed dumps must use the target DB's matching client + database ─────────
SAVE_HELPER="$ROOT_DIR/scripts/save-seed-dump.sh"
[ -f "$SAVE_HELPER" ] || fail "missing save-seed-dump.sh"
SAVE_CALL="$(grep -A2 -E 'bash scripts/save-seed-dump\.sh' "$RUN_SH" || true)"
[ -n "$SAVE_CALL" ] || fail "could not find the save-seed-dump.sh call in run.sh"
grep -q '"\$LOCAL_DB_NAME"' <<<"$SAVE_CALL" \
  || fail "save helper must receive \$LOCAL_DB_NAME (found: $SAVE_CALL)"
grep -q '"\$_SEED_DUMP_CONTAINER"' <<<"$SAVE_CALL" \
  || fail "save helper must receive the target container (found: $SAVE_CALL)"
grep -q '_SEED_DUMP_CONTAINER="\$DB_CONTAINER"' "$RUN_SH" \
  || fail "Docker mode must select the target DB container for pg_dump"
grep -q 'docker exec "\$DB_CONTAINER" pg_dump .* -Fc "\$DB_NAME"' "$SAVE_HELPER" \
  || fail "Docker save must use the target container's pg_dump and database argument"
grep -q 'mv "\$DUMP_TMP" "\$DUMP_PATH"' "$SAVE_HELPER" \
  || fail "save helper must atomically publish the completed archive"
echo "PASS 3 — seed-dump uses the target DB/client and publishes atomically"

# ── 4: restore must NOT swallow stderr to /dev/null (keep it diagnosable) ─────
grep -qE '2>&1' <<<"$RESTORE_CALL" \
  && fail "restore call merges stderr into /dev/null — partial-restore errors are hidden"
grep -E 'pg_restore' "$RESTORE_HELPER" | grep -qE '2>&1' \
  && fail "restore helper merges pg_restore stderr into /dev/null"
echo "PASS 4 — pg_restore surfaces stderr (partial-restore failures are visible)"

# ── 5: a plain-SQL base image must restore into a RESET schema ────────────────
# Same class as cases 1-3: the fast-restore path must be equivalent to a clean
# seed. pg_restore gets that from `--clean --if-exists`, but a plain-SQL dump
# replays bare CREATEs, so any object the caller already made collides and
# ON_ERROR_STOP=1 fails the whole restore. run.sh ensures the DEMO cache
# table BEFORE the restore, which made a canonical base die with
# `relation "FastModeCacheEntry" already exists` and refuse to boot.
grep -q 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' "$RESTORE_HELPER" \
  || fail "plain-SQL restore must reset the target schema (else pre-created objects collide)"
PLAIN_BRANCH="$(awk '
  /^if \[ "\$ARCHIVE_MAGIC" != "PGDMP" \]; then$/ { grab=1; next }
  grab && /^elif /                                { exit }
  grab                                            { print }
' "$RESTORE_HELPER")"
[ -n "$PLAIN_BRANCH" ] || fail "could not locate the plain-SQL branch in restore-seed-dump.sh"
grep -q 'RESET_SQL' <<<"$PLAIN_BRANCH" \
  || fail "plain-SQL branch must apply the schema reset before replaying the dump"
grep -q 'ON_ERROR_STOP=1' <<<"$PLAIN_BRANCH" \
  || fail "plain-SQL restore must still fail closed on the first error"
echo "PASS 5 — plain-SQL base image restores into a reset schema, still fail-closed"

# ── 6: anything ensured before the restore must be re-ensured after it ────────
# The reset in case 5 drops whatever the dump does not carry, so a dump
# published before a table existed would otherwise leave it missing at runtime.
grep -q 'ensure-fast-mode-cache-schema.ts' <<<"$RESTORE_BRANCH" \
  || fail "fast-restore branch must re-ensure the DEMO cache schema after a reset restore"
echo "PASS 6 — fast-restore re-ensures pre-restore schema (DEMO cache)"

echo "ALL PASS: cloudbench restore readiness"
