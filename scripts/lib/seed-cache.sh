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
