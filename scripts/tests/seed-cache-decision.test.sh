#!/usr/bin/env bash
# scripts/run.sh warm-starts a benchmark box by restoring a pg_dump from /data,
# falling back to a shared R2 cache, falling back to a full ~13-min prod cold-sync.
#
# REGRESSION UNDER TEST: the warm snapshot (cloudbench-warm-local-*) bakes a seed
# dump into /data whose schema hash drifts as migrations land. The original guard
# consulted the shared cache ONLY when no local dump existed (`[ ! -s dump ]`), so
# that STALE snapshot dump both (a) blocked the R2 download and (b) failed the
# restore's hash check → every clone cold-synced (~13 min). At fleet width only the
# one box that won the cold-sync race reached the synchronized-start barrier; the
# rest were excluded as infra failures → 0/8 on the ecommerce slice (two runs).
#
# The fix centralises the choice in seed_cache_decision(): a dump that is absent OR
# schema-stale must route to the shared cache (consult-remote), never shadow it.
# This test drives the REAL helper run.sh uses and pins every branch, so the stale
# dump → cold-sync bug cannot silently return.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/lib/seed-cache.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HASH="abc123schemahash"
PASS=0 FAIL=0
check() { # <description> <expected> <actual>
    if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✅ $1"; \
    else FAIL=$((FAIL+1)); echo "  ❌ $1 — expected '$2' got '$3'"; fi
}

# 1. No dump path configured (local dev) → cold-sync, cache untouched.
check "no dump path → cold-sync" "cold-sync" "$(seed_cache_decision "" "$HASH" 1)"

# 2. Schema-VALID local dump (file + matching sidecar) → restore-local, skip cache.
VALID="$TMP/valid.dump"; printf 'x' > "$VALID"; printf '%s' "$HASH" > "$VALID.schemahash"
check "valid local dump → restore-local" "restore-local" "$(seed_cache_decision "$VALID" "$HASH" 1)"

# 3. THE BUG: stale dump (present, sidecar hash mismatched) + cache ON.
#    Old `[ ! -s ]` guard skipped the cache and cold-synced. Must now consult-remote.
STALE="$TMP/stale.dump"; printf 'x' > "$STALE"; printf 'OLD-drifted-hash' > "$STALE.schemahash"
check "stale dump + cache on → consult-remote (was the 0/8 bug)" \
    "consult-remote" "$(seed_cache_decision "$STALE" "$HASH" 1)"

# 4. Stale dump but cache OFF (local dev / no R2) → cold-sync (can't consult).
check "stale dump + cache off → cold-sync" "cold-sync" "$(seed_cache_decision "$STALE" "$HASH" 0)"

# 5. Dump present but NO sidecar at all + cache ON → treated as stale → consult-remote.
NOSIDE="$TMP/nosidecar.dump"; printf 'x' > "$NOSIDE"
check "dump w/o sidecar + cache on → consult-remote" "consult-remote" "$(seed_cache_decision "$NOSIDE" "$HASH" 1)"

# 6. No local dump file + cache ON → consult-remote (fresh clone happy path).
check "absent dump + cache on → consult-remote" "consult-remote" "$(seed_cache_decision "$TMP/missing.dump" "$HASH" 1)"

# 7. No local dump file + cache OFF → cold-sync.
check "absent dump + cache off → cold-sync" "cold-sync" "$(seed_cache_decision "$TMP/missing.dump" "$HASH" 0)"

# 8. Empty (zero-byte) dump file + cache ON → not usable → consult-remote.
EMPTY="$TMP/empty.dump"; : > "$EMPTY"; printf '%s' "$HASH" > "$EMPTY.schemahash"
check "zero-byte dump + cache on → consult-remote" "consult-remote" "$(seed_cache_decision "$EMPTY" "$HASH" 1)"

# Wiring guard: run.sh must actually source the helper and branch on the decision,
# so the fix can't regress by reverting run.sh to the inline `[ ! -s ]` guard.
if grep -q 'lib/seed-cache.sh' "$ROOT_DIR/scripts/run.sh" \
   && grep -q 'seed_cache_decision' "$ROOT_DIR/scripts/run.sh"; then
    PASS=$((PASS+1)); echo "  ✅ run.sh sources + calls seed_cache_decision"
else
    FAIL=$((FAIL+1)); echo "  ❌ run.sh does not wire seed_cache_decision"
fi
# And it must NOT reintroduce the buggy guard that skipped the cache on any dump.
if grep -qE '\[ *! *-s *"\$_SEED_DUMP" *\].*seed-dump-cache|! -s "\$_SEED_DUMP" \] && \[ "\$_SEED_CACHE_ENABLED"' "$ROOT_DIR/scripts/run.sh"; then
    FAIL=$((FAIL+1)); echo "  ❌ run.sh still gates the R2 download on '! -s dump' (the stale-dump bug)"
else
    PASS=$((PASS+1)); echo "  ✅ run.sh no longer gates the R2 download on '! -s dump'"
fi

echo
echo "backend_ready_budget — warm-restored boxes must get the same startup budget"
echo "as cold-seeded boxes (both hold the full prod DB). Capping restore at 60s"
echo "timed out every warm box and starved the barrier once the seed cache landed."
# Cold prod seed → long budget (default 180).
check "cold seed (frs=1,dbr=0) → 180" "180" "$(backend_ready_budget 1 0)"
# THE BUG: warm restore (dbr=1) previously fell through to 60. Must now be 180.
check "warm restore (frs=0,dbr=1) → 180 (was the 60s barrier-starve bug)" "180" "$(backend_ready_budget 0 1)"
# Neither → the short 60 budget (small/empty DB, nothing to warm).
check "neither seeded nor restored → 60" "60" "$(backend_ready_budget 0 0)"
# Both flags set → long budget (still one full DB).
check "both flags → 180" "180" "$(backend_ready_budget 1 1)"
# Explicit override wins regardless of DB state.
check "explicit override wins" "42" "$(backend_ready_budget 0 1 42)"
# Cold-budget env override is honoured for the restore path.
check "restore honours COLD env override" "240" "$(CLOUDBENCH_COLD_BACKEND_START_READY_ATTEMPTS=240 backend_ready_budget 0 1)"
# Wiring guard: run.sh must call backend_ready_budget with DB_RESTORED, not gate
# the long budget on FIRST_RUN_SEEDED alone.
if grep -q 'backend_ready_budget' "$ROOT_DIR/scripts/run.sh" \
   && grep -qE '\$DB_RESTORED && _dbr=1' "$ROOT_DIR/scripts/run.sh"; then
    PASS=$((PASS+1)); echo "  ✅ run.sh routes DB_RESTORED into backend_ready_budget"
else
    FAIL=$((FAIL+1)); echo "  ❌ run.sh does not give warm-restored boxes the long backend budget"
fi

echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
echo "PASS: seed-cache decision routes stale/absent dumps to the shared cache; valid dumps restore locally"
