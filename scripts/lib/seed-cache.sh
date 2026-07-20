#!/bin/bash
# Seed-dump cache decision helper for scripts/run.sh (benchmark fast warm-start).
#
# A freshly-cloned cloud guest's /data can carry a seed dump baked into the warm
# snapshot. If that dump's schema hash no longer matches the current schema it is
# STALE: it cannot be restored, and — critically — it must NOT shadow the shared
# R2 cache. The original inline guard consulted the cache only when NO local dump
# existed (`[ ! -s dump ]`), so a stale snapshot dump silently forced the full
# ~13-min prod cold-sync on EVERY clone and made the shared cache dead code on the
# cloud path. At fleet width that starved the synchronized-start barrier (only the
# one box that won the cold-sync race reached it) → 0/N. Centralising the decision
# here makes it unit-testable (scripts/tests/seed-cache-decision.test.sh).
#
# seed_cache_decision <seed_dump_path> <schema_hash> <cache_enabled 0|1>
#   echoes exactly one of:
#     restore-local  — a schema-VALID local dump exists; restore it, skip the cache
#     consult-remote — no valid local dump but the shared cache is on; pull from it
#     cold-sync      — no valid local dump and no cache; seed from prod as before
seed_cache_decision() {
    local seed_dump="$1" schema_hash="$2" cache_enabled="$3"
    # No dump path configured (e.g. local dev) → always cold-sync (unchanged).
    [ -n "$seed_dump" ] || { printf 'cold-sync\n'; return 0; }
    # A local dump is usable ONLY if it exists AND its sidecar hash matches the
    # current schema. Anything else (absent, empty, missing sidecar, drifted hash)
    # counts as "no valid local dump" and must fall through to the shared cache.
    if [ -s "$seed_dump" ] && \
       [ "$(cat "${seed_dump}.schemahash" 2>/dev/null || printf 'x')" = "$schema_hash" ]; then
        printf 'restore-local\n'; return 0
    fi
    if [ "$cache_enabled" = 1 ]; then
        printf 'consult-remote\n'; return 0
    fi
    printf 'cold-sync\n'
}

# How many 1-second /health probes to allow the isolated benchmark backend before
# declaring it hung. A box that just materialised the FULL production DB needs a
# long budget to initialise it — and it does so WHETHER the DB arrived via a cold
# prod seed (FIRST_RUN_SEEDED) or by RESTORING the cached dump (DB_RESTORED). The
# two paths leave the backend an identical amount of state to warm. The original
# code granted the long budget only to the cold-seed path, so once the seed-dump
# cache actually started warm-restoring boxes, every warm box was capped at 60s,
# timed out both supervised backend attempts, and was excluded before the start
# barrier → 0/8. Restore must get the same budget as a cold seed.
# backend_ready_budget <first_run_seeded 0|1> <db_restored 0|1> [override]
backend_ready_budget() {
    local first_run_seeded="$1" db_restored="$2" override="${3:-}"
    local cold_budget="${CLOUDBENCH_COLD_BACKEND_START_READY_ATTEMPTS:-180}"
    if [ -n "$override" ]; then printf '%s\n' "$override"; return 0; fi
    if [ "$first_run_seeded" = 1 ] || [ "$db_restored" = 1 ]; then
        printf '%s\n' "$cold_budget"; return 0
    fi
    printf '%s\n' 60
}
