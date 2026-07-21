#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT_DIR/scripts/lib/fast-mode-cache-schema.sh"

PASS=0
FAIL=0
check() {
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1)); echo "  ✅ $1"
    else
        FAIL=$((FAIL + 1)); echo "  ❌ $1 — expected '$2' got '$3'"
    fi
}

ATTEMPTS=0
fail_twice_then_pass() {
    ATTEMPTS=$((ATTEMPTS + 1))
    [ "$ATTEMPTS" -ge 3 ]
}
FAST_MODE_CACHE_SCHEMA_RETRY_BASE_SECONDS=0 \
    ensure_fast_mode_cache_schema fail_twice_then_pass >/dev/null 2>&1
check "transient failures retry until the idempotent ensure succeeds" "3" "$ATTEMPTS"

ATTEMPTS=0
always_fail() {
    ATTEMPTS=$((ATTEMPTS + 1))
    return 17
}
FAST_MODE_CACHE_SCHEMA_MAX_ATTEMPTS=4 \
FAST_MODE_CACHE_SCHEMA_RETRY_BASE_SECONDS=0 \
    ensure_fast_mode_cache_schema always_fail >/dev/null 2>&1
check "persistent failure returns non-zero" "17" "$?"
check "persistent failure stops at the configured bound" "4" "$ATTEMPTS"

if grep -q 'lib/fast-mode-cache-schema.sh' "$ROOT_DIR/scripts/run.sh" \
   && grep -q 'ensure_fast_mode_cache_schema bash -c' "$ROOT_DIR/scripts/run.sh"; then
    PASS=$((PASS + 1)); echo "  ✅ run.sh executes the cache-schema ensure through the retry helper"
else
    FAIL=$((FAIL + 1)); echo "  ❌ run.sh bypasses the cache-schema retry helper"
fi

echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
