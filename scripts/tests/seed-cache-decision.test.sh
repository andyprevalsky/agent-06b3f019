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

# Canonical base restores additionally require the immutable cache-token sidecar.
# A same-schema daily snapshot is not evidence that the reviewed fixture rows
# (including WhatsApp history) are present.
CACHE_TOKEN="$HASH-victoria-prod-sync-v1-whatsapp-v2"
check "same-schema dump without canonical token → consult-remote" \
    "consult-remote" "$(seed_cache_decision "$VALID" "$HASH" 1 "$CACHE_TOKEN")"
printf '%s' "$CACHE_TOKEN" > "$VALID.cachetoken"
check "schema + canonical token → restore-local" \
    "restore-local" "$(seed_cache_decision "$VALID" "$HASH" 1 "$CACHE_TOKEN")"

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
   && grep -q 'seed_cache_decision' "$ROOT_DIR/scripts/run.sh" \
   && grep -q 'benchmark_base_cache_token' "$ROOT_DIR/scripts/run.sh" \
   && grep -q '\.cachetoken' "$ROOT_DIR/scripts/run.sh"; then
    PASS=$((PASS+1)); echo "  ✅ run.sh sources + calls seed_cache_decision"
else
    FAIL=$((FAIL+1)); echo "  ❌ run.sh does not wire the canonical base cache identity"
fi
# And it must NOT reintroduce the buggy guard that skipped the cache on any dump.
if grep -qE '\[ *! *-s *"\$_SEED_DUMP" *\].*seed-dump-cache|! -s "\$_SEED_DUMP" \] && \[ "\$_SEED_CACHE_ENABLED"' "$ROOT_DIR/scripts/run.sh"; then
    FAIL=$((FAIL+1)); echo "  ❌ run.sh still gates the R2 download on '! -s dump' (the stale-dump bug)"
else
    PASS=$((PASS+1)); echo "  ✅ run.sh no longer gates the R2 download on '! -s dump'"
fi
if grep -q 'BENCHMARK_PUBLISH_SEED_DUMP' "$ROOT_DIR/scripts/run.sh"; then
    PASS=$((PASS+1)); echo "  ✅ ordinary cold syncs cannot overwrite the canonical base artifact"
else
    FAIL=$((FAIL+1)); echo "  ❌ canonical base publication is not explicitly gated"
fi
# Ubuntu's `pg_dump --version` ends with "...24.04.1)"; a greedy "last X.Y" sed
# extracts 04 and looks up a nonexistent pg04 cache token. Anchor at the first
# version number so system-PG hosts keep matching the pg16 (or real major) artifact.
MAJOR_BIN="$TMP/major-bin"
mkdir -p "$MAJOR_BIN"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$FAKE_PG_DUMP_VERSION"' > "$MAJOR_BIN/pg_dump"
chmod +x "$MAJOR_BIN/pg_dump"
check "system pg_dump major anchors at the first X.Y (not Ubuntu 24.04)" "16" \
    "$(FAKE_PG_DUMP_VERSION='pg_dump (PostgreSQL) 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)' \
        PATH="$MAJOR_BIN:$PATH" benchmark_seed_client_major true)"
check "system pg_dump major follows a newer host client" "18" \
    "$(FAKE_PG_DUMP_VERSION='pg_dump (PostgreSQL) 18.1' PATH="$MAJOR_BIN:$PATH" benchmark_seed_client_major true)"
check "Docker path keeps the pinned postgres:16 major" "16" \
    "$(FAKE_PG_DUMP_VERSION='pg_dump (PostgreSQL) 18.1' PATH="$MAJOR_BIN:$PATH" benchmark_seed_client_major false)"
check "unparseable host client yields an explicit unknown major" "unknown" \
    "$(FAKE_PG_DUMP_VERSION='' PATH="$MAJOR_BIN:$PATH" benchmark_seed_client_major true)"
if grep -q 'benchmark_seed_client_major "${USE_SYSTEM_PG:-false}"' "$ROOT_DIR/scripts/run.sh"; then
    PASS=$((PASS+1)); echo "  ✅ run.sh derives the cache-token pg major from the shared helper"
else
    FAIL=$((FAIL+1)); echo "  ❌ run.sh no longer derives the cache-token pg major from benchmark_seed_client_major"
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

echo
echo "local isolated seed materialization — /sync must publish the dump"
echo "that scripts/run-bench --local requires before starting an agent."

FAKE_BIN="$TMP/fake-bin"
SCHEMA_FILE="$TMP/schema.prisma"
LOCAL_CACHE="$TMP/local-cache"
SEED_CLI="$ROOT_DIR/scripts/benchmark-seed-cache"
PYTHON_BIN="$ROOT_DIR/agents/venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN=python3
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN=python
  else
    echo "❌ neither agents/venv/bin/python, python3, nor python is available" >&2
    exit 1
  fi
fi
mkdir -p "$FAKE_BIN"
printf '%s\n' \
    '#!/bin/sh' \
    '[ "$1" = exec ] || exit 91' \
    '[ "$2" = victoria-db-test ] || exit 92' \
    '[ "$3" = pg_dump ] || exit 93' \
    '[ "${FAKE_DOCKER_FAIL:-0}" = 0 ] || exit 94' \
    'sleep "${FAKE_DOCKER_DELAY:-0}"' \
    'printf "seed-dump-from-%s\\n" "$2"' \
    > "$FAKE_BIN/docker"
chmod +x "$FAKE_BIN/docker"
printf 'model Agent { id String @id }\n' > "$SCHEMA_FILE"

set +e
MATERIALIZED_PATH="$(
    PATH="$FAKE_BIN:$PATH" bash "$SEED_CLI" materialize \
        "$SCHEMA_FILE" "$LOCAL_CACHE" victoria-db-test 20260723
)"
MATERIALIZE_STATUS=$?
set -e

EXPECTED_PATH="$(bash "$SEED_CLI" path "$SCHEMA_FILE" "$LOCAL_CACHE" 20260723)"
CONSUMED_PATH="$(
    PYTHONPATH="$ROOT_DIR/agents" "$PYTHON_BIN" -c \
        'import sys; from pathlib import Path; from benchmarks.local import local_seed_dump_path; print(local_seed_dump_path(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]))' \
        "$SCHEMA_FILE" "$LOCAL_CACHE" 20260723
)"
EXPECTED_HASH="${EXPECTED_PATH##*/}"
EXPECTED_HASH="${EXPECTED_HASH%%-*}"
if [ "$MATERIALIZE_STATUS" -eq 0 ] \
   && [ "$MATERIALIZED_PATH" = "$EXPECTED_PATH" ] \
   && [ "$CONSUMED_PATH" = "$EXPECTED_PATH" ] \
   && [ "$(cat "$EXPECTED_PATH" 2>/dev/null)" = "seed-dump-from-victoria-db-test" ] \
   && [ "$(cat "${EXPECTED_PATH}.schemahash" 2>/dev/null)" = "$EXPECTED_HASH" ]; then
    PASS=$((PASS+1)); echo "  ✅ setup producer and local.py consumer share one schema/day path contract"
else
    FAIL=$((FAIL+1)); echo "  ❌ producer/consumer seed contract failed: status=$MATERIALIZE_STATUS produced='$MATERIALIZED_PATH' consumed='$CONSUMED_PATH'"
fi

# The setup boundary must actually call the materializer after synchronization.
# setup_db_run_interruptible runs it as `bash "$1" materialize ...` with the
# CLI path passed as $1 so TERM is not deferred behind a foreground wait.
if grep -Eq 'benchmark-seed-cache"[[:space:]]+materialize|bash "\$1" materialize' \
    "$ROOT_DIR/scripts/setup-db.sh" \
  && grep -q 'benchmark-seed-cache' "$ROOT_DIR/scripts/setup-db.sh" \
  && grep -q 'materialize' "$ROOT_DIR/scripts/setup-db.sh"; then
    PASS=$((PASS+1)); echo "  ✅ setup-db invokes the tested materialization boundary"
else
    FAIL=$((FAIL+1)); echo "  ❌ setup-db never invokes the tested materialization boundary"
fi

# Lock ownership is PID-bound, so acquire/release cannot be separate CLI
# processes. Consumers source seed-cache.sh and hold the lock in one shell.
set +e
bash "$SEED_CLI" acquire "$EXPECTED_PATH" >/dev/null 2>&1
ACQUIRE_CLI_STATUS=$?
bash "$SEED_CLI" release "$EXPECTED_PATH" >/dev/null 2>&1
RELEASE_CLI_STATUS=$?
set -e
if [ "$ACQUIRE_CLI_STATUS" -ne 0 ] && [ "$RELEASE_CLI_STATUS" -ne 0 ]; then
    PASS=$((PASS+1)); echo "  ✅ PID-bound acquire/release are not exposed as separate CLI processes"
else
    FAIL=$((FAIL+1)); echo "  ❌ seed-cache CLI still exposes PID-invalid acquire/release commands"
fi

# Producer-first ordering: a consumer arriving during publication must acquire
# the same lock and see the complete pair, never a half-published result.
rm -f "$EXPECTED_PATH" "${EXPECTED_PATH}.schemahash"
FAKE_DOCKER_DELAY=1 PATH="$FAKE_BIN:$PATH" \
    bash "$SEED_CLI" materialize \
        "$SCHEMA_FILE" "$LOCAL_CACHE" victoria-db-test 20260723 \
        > "$TMP/race-result" &
PUBLISH_PID=$!
for _ in $(seq 1 50); do
    [ -L "${EXPECTED_PATH}.publish.lock" ] && break
    sleep 0.02
done
PRODUCER_FIRST_LOCK_SEEN=0
[ -L "${EXPECTED_PATH}.publish.lock" ] && PRODUCER_FIRST_LOCK_SEEN=1
acquire_benchmark_seed_lock "$EXPECTED_PATH" 50
PRODUCER_FIRST_DECISION="$(seed_cache_decision "$EXPECTED_PATH" "$EXPECTED_HASH" 0)"
PRODUCER_FIRST_DUMP="$(cat "$EXPECTED_PATH" 2>/dev/null || true)"
PRODUCER_FIRST_HASH="$(cat "${EXPECTED_PATH}.schemahash" 2>/dev/null || true)"
release_benchmark_seed_lock "$EXPECTED_PATH"
wait "$PUBLISH_PID"
if [ "$PRODUCER_FIRST_LOCK_SEEN" -eq 1 ] \
   && [ "$PRODUCER_FIRST_DECISION" = "restore-local" ] \
   && [ "$PRODUCER_FIRST_DUMP" = "seed-dump-from-victoria-db-test" ] \
   && [ "$PRODUCER_FIRST_HASH" = "$EXPECTED_HASH" ]; then
    PASS=$((PASS+1)); echo "  ✅ producer-first ordering fences decision + pair read"
else
    FAIL=$((FAIL+1)); echo "  ❌ producer-first ordering exposed incomplete seed state"
fi

# Consumer-first ordering: publication must wait until the consumer finishes its
# decision + read/mutation handoff, then replace the pair as one fenced update.
printf 'consumer-visible-dump\n' > "$EXPECTED_PATH"
printf '%s' "$EXPECTED_HASH" > "${EXPECTED_PATH}.schemahash"
acquire_benchmark_seed_lock "$EXPECTED_PATH" 50
PATH="$FAKE_BIN:$PATH" \
    bash "$SEED_CLI" materialize \
        "$SCHEMA_FILE" "$LOCAL_CACHE" victoria-db-test 20260723 \
        > "$TMP/consumer-first-result" &
WAITING_PRODUCER_PID=$!
sleep 0.2
CONSUMER_FIRST_PRODUCER_WAITING=0
kill -0 "$WAITING_PRODUCER_PID" 2>/dev/null && CONSUMER_FIRST_PRODUCER_WAITING=1
CONSUMER_FIRST_DECISION="$(seed_cache_decision "$EXPECTED_PATH" "$EXPECTED_HASH" 0)"
CONSUMER_FIRST_DUMP="$(cat "$EXPECTED_PATH")"
release_benchmark_seed_lock "$EXPECTED_PATH"
wait "$WAITING_PRODUCER_PID"
if [ "$CONSUMER_FIRST_PRODUCER_WAITING" -eq 1 ] \
   && [ "$CONSUMER_FIRST_DECISION" = "restore-local" ] \
   && [ "$CONSUMER_FIRST_DUMP" = "consumer-visible-dump" ] \
   && [ "$(cat "$EXPECTED_PATH")" = "seed-dump-from-victoria-db-test" ] \
   && [ "$(cat "${EXPECTED_PATH}.schemahash")" = "$EXPECTED_HASH" ]; then
    PASS=$((PASS+1)); echo "  ✅ consumer-first ordering fences restore handoff from publication"
else
    FAIL=$((FAIL+1)); echo "  ❌ consumer-first ordering allowed publication during the consumer handoff"
fi

# Wiring guard: run.sh must keep decision, optional remote replacement, and the
# synchronous restore inside one consumer critical section.
CRITICAL_SECTION="$(sed -n '/BEGIN BENCHMARK_SEED_CONSUMER_CRITICAL_SECTION/,/END BENCHMARK_SEED_CONSUMER_CRITICAL_SECTION/p' "$ROOT_DIR/scripts/run.sh")"
ACQUIRE_LINE="$(printf '%s\n' "$CRITICAL_SECTION" | grep -n 'acquire_benchmark_seed_lock' | head -1 | cut -d: -f1)"
DECISION_LINE="$(printf '%s\n' "$CRITICAL_SECTION" | grep -n '_SEED_DECISION=' | head -1 | cut -d: -f1)"
RESTORE_LINE="$(printf '%s\n' "$CRITICAL_SECTION" | grep -n 'scripts/restore-seed-dump.sh' | head -1 | cut -d: -f1)"
RELEASE_LINE="$(printf '%s\n' "$CRITICAL_SECTION" | grep -n '^release_seed_lock_if_held$' | head -1 | cut -d: -f1)"
if [ -n "$ACQUIRE_LINE" ] && [ -n "$DECISION_LINE" ] \
   && [ -n "$RESTORE_LINE" ] && [ -n "$RELEASE_LINE" ] \
   && [ "$ACQUIRE_LINE" -lt "$DECISION_LINE" ] \
   && [ "$DECISION_LINE" -lt "$RESTORE_LINE" ] \
   && [ "$RESTORE_LINE" -lt "$RELEASE_LINE" ]; then
    PASS=$((PASS+1)); echo "  ✅ run.sh holds one seed lock across decision, replacement, and restore"
else
    FAIL=$((FAIL+1)); echo "  ❌ run.sh seed consumer critical section is incomplete"
fi

# A failed pg_dump must preserve the last valid pair and release all lock/temp state.
printf 'previous-valid-dump\n' > "$EXPECTED_PATH"
printf '%s' "$EXPECTED_HASH" > "${EXPECTED_PATH}.schemahash"
set +e
FAKE_DOCKER_FAIL=1 PATH="$FAKE_BIN:$PATH" \
    bash "$SEED_CLI" materialize \
        "$SCHEMA_FILE" "$LOCAL_CACHE" victoria-db-test 20260723 \
        > /dev/null 2>&1
FAILED_PUBLISH_STATUS=$?
set -e
if [ "$FAILED_PUBLISH_STATUS" -ne 0 ] \
   && [ "$(cat "$EXPECTED_PATH")" = "previous-valid-dump" ] \
   && [ "$(cat "${EXPECTED_PATH}.schemahash")" = "$EXPECTED_HASH" ] \
   && [ ! -e "${EXPECTED_PATH}.publish.lock" ] \
   && [ ! -L "${EXPECTED_PATH}.publish.lock" ] \
   && ! find "$LOCAL_CACHE" -type f -name '*.tmp.*' -print -quit | grep -q .; then
    PASS=$((PASS+1)); echo "  ✅ failed publication preserves the prior pair and releases lock/temp state"
else
    FAIL=$((FAIL+1)); echo "  ❌ failed publication corrupted state or leaked lock/temp files"
fi

# System-Postgres materialize path (Cloud: ROSE_USE_SYSTEM_PG / Docker overlay
# mount failures). Must dump via host pg_dump, not docker exec.
rm -f "$EXPECTED_PATH" "${EXPECTED_PATH}.schemahash"
printf '%s\n' \
    '#!/bin/sh' \
    'printf "%s\n" "$*" >> "$SEED_DUMP_TEST_LOG"' \
    'printf "seed-dump-from-system-pg\n"' \
    > "$FAKE_BIN/pg_dump"
chmod +x "$FAKE_BIN/pg_dump"
: > "${SEED_DUMP_TEST_LOG:=$TMP/system-pg-dump.log}"
export SEED_DUMP_TEST_LOG
set +e
SYSTEM_MATERIALIZED_PATH="$(
    PATH="$FAKE_BIN:$PATH" bash "$SEED_CLI" materialize \
        "$SCHEMA_FILE" "$LOCAL_CACHE" system 20260723
)"
SYSTEM_MATERIALIZE_STATUS=$?
set -e
if [ "$SYSTEM_MATERIALIZE_STATUS" -eq 0 ] \
   && [ "$SYSTEM_MATERIALIZED_PATH" = "$EXPECTED_PATH" ] \
   && [ "$(cat "$EXPECTED_PATH" 2>/dev/null)" = "seed-dump-from-system-pg" ] \
   && grep -q -- '-h 127.0.0.1 -p 5432 -U postgres -Fc victoria' "$SEED_DUMP_TEST_LOG"; then
    PASS=$((PASS+1)); echo "  ✅ system token materializes via host pg_dump (no Docker)"
else
    FAIL=$((FAIL+1)); echo "  ❌ system materialize path failed: status=$SYSTEM_MATERIALIZE_STATUS path='$SYSTEM_MATERIALIZED_PATH'"
fi

# setup-db.sh must support ROSE_USE_SYSTEM_PG and pass "system" to materialize.
SETUP_DB="$ROOT_DIR/scripts/setup-db.sh"
if grep -q 'ROSE_USE_SYSTEM_PG' "$SETUP_DB" \
   && grep -q 'SEED_DUMP_SOURCE="system"' "$SETUP_DB" \
   && grep -q 'use_system_postgres' "$SETUP_DB"; then
    PASS=$((PASS+1)); echo "  ✅ setup-db.sh owns the system-Postgres sync path"
else
    FAIL=$((FAIL+1)); echo "  ❌ setup-db.sh missing ROSE_USE_SYSTEM_PG / system seed source wiring"
fi

# Fleet must fail closed before provisioning when the cloud-guest (pg15)
# canonical seed dump is missing — otherwise every clone dies at the barrier.
FLEET="$ROOT_DIR/scripts/run-bench-fleet"
SEED_GET="$ROOT_DIR/scripts/cloudbench-seed-get.sh"
# Follow the actual standalone helper; cohort proof admission is exercised by
# cloudbench_campaign_inventory_test.py's native loopback seed preflight cases.
PREFLIGHT="$(sed -n '/^CLOUDBENCH_GUEST_PG_MAJOR=/,/^echo "✅ Canonical seed dump present/p' "$FLEET")"
SEED_FAILURE="$(printf '%s\n' "$PREFLIGHT" | sed -n '/if ! bash.*cloudbench-seed-get.sh/,/^    fi/p')"
PREFLIGHT_LINE="$(grep -n '^CLOUDBENCH_GUEST_PG_MAJOR=' "$FLEET" | cut -d: -f1)"
PROVISION_LINE="$(grep -n '^echo "⏳ provisioning ' "$FLEET" | cut -d: -f1)"
if grep -q -- '--pg-major "$CLOUDBENCH_GUEST_PG_MAJOR"' <<<"$PREFLIGHT" \
   && grep -q 'if ! bash "$CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-seed-get.sh"' <<<"$PREFLIGHT" \
   && grep -q '"$ROOT_DIR" "$_SEED_GUEST_TOKEN" "$_SEED_GUEST_PROBE"; then' <<<"$PREFLIGHT" \
   && grep -q 'Missing canonical base fixture for cloud guests' <<<"$SEED_FAILURE" \
   && grep -q 'exit 1' <<<"$SEED_FAILURE" \
   && [ -n "$PREFLIGHT_LINE" ] && [ -n "$PROVISION_LINE" ] \
   && [ "$PREFLIGHT_LINE" -lt "$PROVISION_LINE" ] \
   && grep -q 'seed-dump-cache.ts get' "$SEED_GET" \
   && grep -q 'experimental-strip-types' "$SEED_GET" \
   && grep -q 'node_modules/.bin/tsx' "$SEED_GET"; then
    PASS=$((PASS+1)); echo "  ✅ run-bench-fleet preflights the cloud-guest pg major seed dump"
else
    FAIL=$((FAIL+1)); echo "  ❌ run-bench-fleet missing cloud-guest canonical seed-dump preflight"
fi

echo
echo "canonical base pull — a box that has not run a benchmark yet must fetch the"
echo "reviewed base fixture into the exact pair an isolated benchmark restores."

SEED_CACHE_GET_LOG="$TMP/seed-cache-get.log"
: > "$SEED_CACHE_GET_LOG"
export SEED_CACHE_GET_LOG
printf '%s\n' \
    '#!/bin/sh' \
    'printf "%s\n" "$*" >> "$SEED_CACHE_GET_LOG"' \
    '[ "$1 $2 $3" = "tsx scripts/seed-dump-cache.ts get" ] || exit 95' \
    '[ "${FAKE_SEED_CACHE_MISS:-0}" = 0 ] || exit 1' \
    'printf "canonical-base-for-%s\n" "$4" > "$5"' \
    > "$FAKE_BIN/npx"
chmod +x "$FAKE_BIN/npx"
PULL_CACHE="$TMP/pull-cache"
CANONICAL_TOKEN="$(benchmark_base_cache_token "$SCHEMA_FILE" 16)"
CANONICAL_HASH="${CANONICAL_TOKEN%%-*}"
CANONICAL_PATH="$(
    PYTHONPATH="$ROOT_DIR/agents" "$PYTHON_BIN" -c \
        'import sys; from pathlib import Path; from benchmarks.local import local_seed_dump_path; print(local_seed_dump_path(Path(sys.argv[1]), Path(sys.argv[2])))' \
        "$SCHEMA_FILE" "$PULL_CACHE"
)"

set +e
PULLED_PATH="$(cd "$TMP" && PATH="$FAKE_BIN:$PATH" bash "$SEED_CLI" pull-canonical \
    "$SCHEMA_FILE" pull-cache 16)"
PULL_STATUS=$?
set -e
check "canonical pull exits 0" "0" "$PULL_STATUS"
check "canonical pull lands on the path local.py restores" "$CANONICAL_PATH" "$PULLED_PATH"
check "canonical pull fetches the run.sh shared-cache token" \
    "canonical-base-for-$CANONICAL_TOKEN" "$(cat "$CANONICAL_PATH" 2>/dev/null)"
check "pulled pair restores locally for the same token" "restore-local" \
    "$(seed_cache_decision "$CANONICAL_PATH" "$CANONICAL_HASH" 1 "$CANONICAL_TOKEN")"

set +e
REPULLED_PATH="$(PATH="$FAKE_BIN:$PATH" bash "$SEED_CLI" pull-canonical \
    "$SCHEMA_FILE" "$PULL_CACHE" 16)"
REPULL_STATUS=$?
set -e
check "a valid pulled pair is reused without another fetch" \
    "0 $CANONICAL_PATH 1" "$REPULL_STATUS $REPULLED_PATH $(wc -l < "$SEED_CACHE_GET_LOG" | tr -d ' ')"

rm -f "$CANONICAL_PATH" "$CANONICAL_PATH.schemahash" "$CANONICAL_PATH.cachetoken"
set +e
FAKE_SEED_CACHE_MISS=1 PATH="$FAKE_BIN:$PATH" bash "$SEED_CLI" pull-canonical \
    "$SCHEMA_FILE" "$PULL_CACHE" 16 >/dev/null 2>&1
MISS_STATUS=$?
set -e
if [ "$MISS_STATUS" -ne 0 ] \
   && [ ! -e "$CANONICAL_PATH" ] \
   && [ ! -e "$CANONICAL_PATH.schemahash" ] \
   && [ ! -e "$CANONICAL_PATH.cachetoken" ] \
   && [ ! -L "$CANONICAL_PATH.publish.lock" ] \
   && ! find "$PULL_CACHE" -type f -name '*.tmp.*' -print -quit | grep -q .; then
    PASS=$((PASS+1)); echo "  ✅ a shared-cache miss fails without leaving a pair, lock, or temp file"
else
    FAIL=$((FAIL+1)); echo "  ❌ shared-cache miss: status=$MISS_STATUS or leaked dump/sidecar/lock/temp state"
fi

MEASUREMENT="$ROOT_DIR/back-end/scripts/measure-seed-memory.sh"
if grep -q 'benchmark-seed-cache" pull-canonical' "$MEASUREMENT"; then
    PASS=$((PASS+1)); echo "  ✅ seed memory measurement pulls the canonical base when no dump is cached"
else
    FAIL=$((FAIL+1)); echo "  ❌ seed memory measurement fails on a box with no cached dump"
fi

# A copy reused from a persistent volume can predate a corrective republication
# of the same immutable key (2026-10-19: the cf8b...-pg15 object was republished
# with its archived agent trajectories). Execute run.sh's real consumer section
# with fake R2/restore/validate: a stale reused copy that fails the canonical
# content check must re-pull the shared object exactly once, and a freshly
# pulled failure must stay final.
run_consumer_section() {
    local case_dir="$1" local_content="$2" remote_content="$3"
    rm -rf "$case_dir"
    mkdir -p "$case_dir/root/back-end" "$case_dir/root/scripts" "$case_dir/bin" "$case_dir/cache"
    printf '%s\n' '#!/bin/sh' \
        'printf "get\n" >> "$CONSUMER_LOG"' \
        'printf "%s" "$CONSUMER_REMOTE" > "$5"' > "$case_dir/bin/npx"
    printf '%s\n' '#!/bin/sh' 'cp "$1" "$CONSUMER_DB"' > "$case_dir/root/scripts/restore-seed-dump.sh"
    printf '%s\n' '#!/bin/sh' 'grep -qx reviewed "$CONSUMER_DB"' > "$case_dir/root/scripts/validate-canonical-seed-dump.sh"
    chmod +x "$case_dir/bin/npx"
    local dump="$case_dir/cache/seed.dump" token="cf8b-pg15-victoria-prod-sync-v1-whatsapp-v2"
    if [ -n "$local_content" ]; then
        printf '%s' "$local_content" > "$dump"
        printf '%s' "schema-hash" > "${dump}.schemahash"
        printf '%s' "$token" > "${dump}.cachetoken"
    fi
    {
        printf '%s\n' "set -eo pipefail" \
            "source '$ROOT_DIR/scripts/lib/seed-cache.sh'" \
            'acquire_benchmark_seed_lock() { :; }' \
            'release_seed_lock_if_held() { :; }' \
            'fail_required_seed_dump() { echo "FAIL_CLOSED: $1"; exit 3; }' \
            "_SEED_DUMP='$dump' _SCHEMA_HASH=schema-hash _SEED_CACHE_ENABLED=1" \
            "_SEED_CACHE_TOKEN='$token' USE_SYSTEM_PG=true BENCHMARK_REQUIRE_SEED_DUMP=1" \
            "LOCAL_DB_ACTUAL_PORT=5432 LOCAL_DB_NAME=victoria DB_RESTORED=false"
        sed -n '/BEGIN BENCHMARK_SEED_CONSUMER_CRITICAL_SECTION/,/END BENCHMARK_SEED_CONSUMER_CRITICAL_SECTION/p' \
            "$ROOT_DIR/scripts/run.sh"
        printf '%s\n' 'echo "DB_RESTORED=$DB_RESTORED"'
    } > "$case_dir/section.sh"
    : > "$case_dir/get.log"
    (cd "$case_dir/root" && CONSUMER_LOG="$case_dir/get.log" CONSUMER_DB="$case_dir/db" \
        CONSUMER_REMOTE="$remote_content" PATH="$case_dir/bin:$PATH" \
        bash "$case_dir/section.sh" > "$case_dir/out.log" 2>&1)
}
set +e
run_consumer_section "$TMP/consumer-stale" stale reviewed; STALE_STATUS=$?
run_consumer_section "$TMP/consumer-fresh-bad" "" stale; FRESH_BAD_STATUS=$?
run_consumer_section "$TMP/consumer-both-bad" stale stale; BOTH_BAD_STATUS=$?
set -e
if [ "$STALE_STATUS" -eq 0 ] && grep -qx 'DB_RESTORED=true' "$TMP/consumer-stale/out.log" \
   && [ "$(wc -l < "$TMP/consumer-stale/get.log")" -eq 1 ] \
   && [ "$(cat "$TMP/consumer-stale/db")" = reviewed ]; then
    PASS=$((PASS+1)); echo "  ✅ a stale reused dump that fails content re-pulls the shared object once and restores it"
else
    FAIL=$((FAIL+1)); echo "  ❌ stale reused dump was not re-pulled: status=$STALE_STATUS $(tr '\n' ' ' < "$TMP/consumer-stale/out.log")"
fi
if [ "$FRESH_BAD_STATUS" -eq 3 ] && [ "$(wc -l < "$TMP/consumer-fresh-bad/get.log")" -eq 1 ] \
   && grep -q 'FAIL_CLOSED' "$TMP/consumer-fresh-bad/out.log"; then
    PASS=$((PASS+1)); echo "  ✅ a freshly pulled dump that fails content fails closed without another pull"
else
    FAIL=$((FAIL+1)); echo "  ❌ freshly pulled bad dump: status=$FRESH_BAD_STATUS gets=$(wc -l < "$TMP/consumer-fresh-bad/get.log")"
fi
if [ "$BOTH_BAD_STATUS" -eq 3 ] && [ "$(wc -l < "$TMP/consumer-both-bad/get.log")" -eq 1 ]; then
    PASS=$((PASS+1)); echo "  ✅ a stale copy and a bad shared object fail closed after exactly one re-pull"
else
    FAIL=$((FAIL+1)); echo "  ❌ stale copy + bad shared object: status=$BOTH_BAD_STATUS gets=$(wc -l < "$TMP/consumer-both-bad/get.log")"
fi

echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
echo "PASS: seed-cache decision routes stale/absent dumps to the shared cache; valid dumps restore locally"
