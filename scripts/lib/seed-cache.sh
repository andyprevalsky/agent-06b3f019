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
# One source of truth for the schema/day path consumed by local.py and produced
# by setup-db.sh. Keep cloud's persistent /data path separate: it is not a daily
# local cache and is validated by its schemahash sidecar instead.
benchmark_seed_dump_path() {
    local schema_path="$1"
    local cache_dir="$2"
    local cache_day="${3:-}"
    local lib_dir
    local repo_root
    local python_bin

    if [ ! -f "$schema_path" ]; then
        echo "benchmark seed schema does not exist: $schema_path" >&2
        return 1
    fi
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    repo_root="$(cd "$lib_dir/../.." && pwd)"
    python_bin="$repo_root/agents/venv/bin/python"
    [ -x "$python_bin" ] || python_bin="$(command -v python3)"
    if [ -n "$cache_day" ]; then
        "$python_bin" "$repo_root/agents/benchmarks/seed_cache_path.py" \
            "$schema_path" "$cache_dir" "$cache_day"
    else
        "$python_bin" "$repo_root/agents/benchmarks/seed_cache_path.py" \
            "$schema_path" "$cache_dir"
    fi
}

# Immutable R2 object identity for the canonical benchmark base fixture. Unlike
# setup-db.sh's daily developer snapshot, this changes only when the schema, the
# pg_dump major that wrote the archive, or the explicitly reviewed base-image
# revision changes.
benchmark_base_cache_token() {
    local schema_path="$1"
    local pg_major="${2:-}"
    local lib_dir
    local repo_root
    local python_bin

    if [ ! -f "$schema_path" ]; then
        echo "benchmark seed schema does not exist: $schema_path" >&2
        return 1
    fi
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    repo_root="$(cd "$lib_dir/../.." && pwd)"
    python_bin="$repo_root/agents/venv/bin/python"
    [ -x "$python_bin" ] || python_bin="$(command -v python3)"
    if [ -n "$pg_major" ]; then
        "$python_bin" "$repo_root/agents/benchmarks/seed_cache_path.py" \
            --cache-token --pg-major "$pg_major" "$schema_path"
    else
        "$python_bin" "$repo_root/agents/benchmarks/seed_cache_path.py" \
            --cache-token "$schema_path"
    fi
}

# Producers and consumers hold the same per-dump directory lock across every
# read/delete/restore or replacement of the dump + sidecar pair. The lock is
# host-local: it coordinates sibling isolated stacks without creating a global
# bottleneck across benchmark machines.
acquire_benchmark_seed_lock() {
    local seed_dump="$1"
    local attempts="${2:-600}"
    local lock_dir="${seed_dump}.publish.lock"
    local owner_pid="${BASHPID:-$$}"
    local current_owner
    local attempt=0
    [ -n "$seed_dump" ] || return 0
    mkdir -p "$(dirname "$seed_dump")"
    while ! ln -s "$owner_pid" "$lock_dir" 2>/dev/null; do
        current_owner="$(readlink "$lock_dir" 2>/dev/null || true)"
        case "$current_owner" in
            ''|*[!0-9]*) ;;
            *)
                if ! kill -0 "$current_owner" 2>/dev/null \
                   && [ "$(readlink "$lock_dir" 2>/dev/null || true)" = "$current_owner" ]; then
                    rm -f "$lock_dir" 2>/dev/null || true
                    continue
                fi
                ;;
        esac
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$attempts" ]; then
            echo "timed out acquiring benchmark seed lock: $seed_dump" >&2
            return 1
        fi
        sleep 0.1
    done
}

release_benchmark_seed_lock() {
    local seed_dump="$1"
    local owner_pid="${BASHPID:-$$}"
    local lock_dir="${seed_dump}.publish.lock"
    [ -n "$seed_dump" ] || return 0
    if [ "$(readlink "$lock_dir" 2>/dev/null || true)" = "$owner_pid" ]; then
        rm -f "$lock_dir" 2>/dev/null || true
    fi
}

wait_for_benchmark_seed_publish() {
    local seed_dump="$1"
    local attempts="${2:-600}"
    local lock_dir="${seed_dump}.publish.lock"
    local attempt=0
    while [ -e "$lock_dir" ] || [ -L "$lock_dir" ]; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$attempts" ]; then
            echo "timed out waiting for benchmark seed publication: $seed_dump" >&2
            return 1
        fi
        sleep 0.1
    done
}

# seed_cache_decision <seed_dump_path> <schema_hash> <cache_enabled 0|1> [cache_token]
#   echoes exactly one of:
#     restore-local  — a schema-VALID local dump exists; restore it, skip the cache
#     consult-remote — no valid local dump but the shared cache is on; pull from it
#     cold-sync      — no valid local dump and no cache; seed from prod as before
seed_cache_decision() {
    local seed_dump="$1" schema_hash="$2" cache_enabled="$3" cache_token="${4:-}"
    # No dump path configured (e.g. local dev) → always cold-sync (unchanged).
    [ -n "$seed_dump" ] || { printf 'cold-sync\n'; return 0; }
    # A local dump is usable ONLY if it exists AND its sidecar hash matches the
    # current schema. Anything else (absent, empty, missing sidecar, drifted hash)
    # counts as "no valid local dump" and must fall through to the shared cache.
    if [ -s "$seed_dump" ] && \
       [ "$(cat "${seed_dump}.schemahash" 2>/dev/null || printf 'x')" = "$schema_hash" ] && \
       { [ -z "$cache_token" ] || \
         [ "$(cat "${seed_dump}.cachetoken" 2>/dev/null || printf 'x')" = "$cache_token" ]; }; then
        printf 'restore-local\n'; return 0
    fi
    if [ "$cache_enabled" = 1 ]; then
        printf 'consult-remote\n'; return 0
    fi
    printf 'cold-sync\n'
}

# Publish a synchronized workspace database under the exact schema/day key that
# agents/benchmarks/local.py selects for isolated local runs. This closes the
# bootstrap loop: /sync already paid to refresh the persistent workspace DB, so
# the next isolated stack should restore that snapshot instead of depending on a
# prior cloud run having populated R2.
materialize_benchmark_seed_dump() (
    local schema_path="$1"
    local cache_dir="$2"
    local db_container="$3"
    local cache_day="${4:-$(date -u +%Y%m%d)}"
    local database_name="${5:-victoria}"
    local schema_hash
    local target_dump
    local temp_dump
    local temp_hash

    target_dump="$(benchmark_seed_dump_path "$schema_path" "$cache_dir" "$cache_day")" || return 1
    schema_hash="${target_dump##*/}"
    schema_hash="${schema_hash%%-*}"

    mkdir -p "$cache_dir"
    temp_dump="${target_dump}.tmp.$$"
    temp_hash="${target_dump}.schemahash.tmp.$$"
    acquire_benchmark_seed_lock "$target_dump" || return 1
    trap 'rm -f "$temp_dump" "$temp_hash" 2>/dev/null || true; release_benchmark_seed_lock "$target_dump"' EXIT INT TERM
    rm -f "$temp_dump" "$temp_hash" 2>/dev/null || true

    if ! docker exec "$db_container" pg_dump -U postgres -Fc "$database_name" > "$temp_dump"; then
        echo "could not dump synchronized benchmark database from $db_container" >&2
        return 1
    fi
    if [ ! -s "$temp_dump" ]; then
        echo "synchronized benchmark database dump was empty: $db_container" >&2
        return 1
    fi

    printf '%s' "$schema_hash" > "$temp_hash"
    mv "$temp_dump" "$target_dump"
    mv "$temp_hash" "${target_dump}.schemahash"
    release_benchmark_seed_lock "$target_dump"
    trap - EXIT INT TERM
    printf '%s\n' "$target_dump"
)

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
