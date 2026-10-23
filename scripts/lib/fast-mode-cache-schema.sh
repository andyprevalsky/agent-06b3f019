#!/usr/bin/env bash

# Retry an idempotent Fast-Mode cache-schema ensure across transient shared-
# pooler saturation. The caller supplies the real ensure command so this
# boundary is deterministic under blackbox testing.
ensure_fast_mode_cache_schema() {
    local max_attempts="${FAST_MODE_CACHE_SCHEMA_MAX_ATTEMPTS:-5}"
    local retry_base_seconds="${FAST_MODE_CACHE_SCHEMA_RETRY_BASE_SECONDS:-3}"
    local attempt rc=1

    case "$max_attempts" in
        ''|*[!0-9]*|0|0[0-9]*) echo "❌ FAST_MODE_CACHE_SCHEMA_MAX_ATTEMPTS must be a positive integer without leading zeros" >&2; return 2 ;;
    esac
    case "$retry_base_seconds" in
        ''|*[!0-9]*|0[0-9]*) echo "❌ FAST_MODE_CACHE_SCHEMA_RETRY_BASE_SECONDS must be a non-negative integer without leading zeros" >&2; return 2 ;;
    esac

    for attempt in $(seq 1 "$max_attempts"); do
        if "$@"; then
            return 0
        else
            rc=$?
        fi
        if [ "$attempt" -lt "$max_attempts" ]; then
            echo "   ⚠️ DEMO cache schema attempt ${attempt}/${max_attempts} failed (rc=${rc}) — shared pooler contention? retrying..." >&2
            [ "$retry_base_seconds" = 0 ] || sleep $(( attempt * retry_base_seconds ))
        fi
    done

    # Distinguish "the pooler is busy" from "this machine cannot reach the pooler
    # at all". Retrying is only meaningful for the former; blaming saturation when
    # the DB port is firewalled sends the operator chasing a phantom load problem
    # (which cost two full stack restarts before this was added). A guest/hotspot
    # network that permits 443 but blocks 5432/6543 is the common cause.
    local host="${FAST_MODE_CACHE_SCHEMA_PROBE_HOST:-}" port="${FAST_MODE_CACHE_SCHEMA_PROBE_PORT:-}"
    if [ -z "$host" ] && [ -n "${DATABASE_URL:-}" ]; then
        host="$(printf '%s' "$DATABASE_URL" | sed -n 's|.*@\([^:/?]*\).*|\1|p')"
        port="$(printf '%s' "$DATABASE_URL" | sed -n 's|.*@[^:]*:\([0-9]*\).*|\1|p')"
    fi
    if [ -n "$host" ] && [ -n "$port" ] && command -v nc >/dev/null 2>&1; then
        if ! nc -z -G 6 "$host" "$port" >/dev/null 2>&1; then
            echo "❌ DEMO cache schema ensure failed: cannot reach ${host}:${port} from this machine." >&2
            echo "   This is NETWORK reachability, not pooler load — retrying will not help." >&2
            echo "   Check whether the current network blocks Postgres ports (guest/hotspot Wi-Fi commonly does);" >&2
            echo "   ${host}:443 being reachable while ${port} is not confirms it." >&2
            return "$rc"
        fi
    fi

    echo "❌ DEMO cache schema ensure failed after ${max_attempts} attempts (shared prod pooler saturated)" >&2
    return "$rc"
}

# Every run.sh stack sits outside production's pooler budget: database.ts gives
# the production backend about 480 of the shared pooler's 1,000 clients, and all
# developer and benchmark stacks share the rest. A DEMO cache Prisma pool
# otherwise inherits production's 75-client default, so a fleet plus idle dev
# stacks exhausted the pooler (EMAXCONN) on 2026-10-11. Every stack now defaults
# to 20, sized for the 50-child DEMO replay that both the predeploy smoke and
# `scripts/test.sh --port=3001` run (at 3, 7,709 shared reads queued at p50 8.5s
# and the replay hit its 900s limit; at 20 it passed in 263s). An explicit
# FAST_CACHE_DB_POOL still wins.
DEMO_CACHE_DB_POOL_DEFAULT=20
apply_demo_cache_pool_default() {
    [ -z "${FAST_CACHE_DB_POOL:-}" ] || return 0
    export FAST_CACHE_DB_POOL="$DEMO_CACHE_DB_POOL_DEFAULT"
    echo "🧠 DEMO cache pool limited to ${FAST_CACHE_DB_POOL} connections"
}
