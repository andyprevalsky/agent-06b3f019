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
            echo "   ⚠️ Fast Mode cache schema attempt ${attempt}/${max_attempts} failed (rc=${rc}) — shared pooler contention? retrying..." >&2
            [ "$retry_base_seconds" = 0 ] || sleep $(( attempt * retry_base_seconds ))
        fi
    done

    echo "❌ Fast Mode cache schema ensure failed after ${max_attempts} attempts (shared prod pooler saturated)" >&2
    return "$rc"
}
