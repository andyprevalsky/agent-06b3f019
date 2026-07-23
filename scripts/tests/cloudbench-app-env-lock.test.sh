#!/usr/bin/env bash
# Focused test for the shared benchmark app-environment lock
# (scripts/lib/cloudbench-app-env-lock.sh).
#
# RCA cement. A concurrent peer fleet's warm-volume dependency refresh holds this
# lock for MINUTES. The prior flat 120s acquire cap (60 × sleep 2) was shorter than
# that, so a second fleet launched alongside the first timed out and aborted its
# entire run ("Timed out waiting for shared benchmark app environment lock"),
# breaking "handle any set of concurrent workstreams". These cases prove:
#   case 1 — a DEAD-holder lock is broken immediately (never waits on a corpse).
#   case 2 — a budget SHORTER than a live holder times out (reproduces the bug).
#   case 3 — an ADEQUATE budget waits the live holder out and acquires (the fix).
#   case 4 — the shipped DEFAULT budget is large enough to outlast a real refresh
#            (locks in that nobody silently reverts it toward the fatal 120s).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT_DIR/scripts/lib/cloudbench-app-env-lock.sh"
[ -f "$LIB" ] || { echo "FATAL: missing $LIB" >&2; exit 1; }

command -v shlock >/dev/null 2>&1 || { echo "SKIP: shlock unavailable"; exit 0; }

TMP="$(mktemp -d)"
HOLDER_PID=""
cleanup() {
    [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT
export APP_ENV_LOCK_FILE="$TMP/app-env.lock"

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── case 1: a DEAD-holder lock is broken immediately ─────────────────────────
dead_pid=999999
while kill -0 "$dead_pid" 2>/dev/null; do dead_pid=$((dead_pid + 1)); done
printf '%s\n' "$dead_pid" > "$APP_ENV_LOCK_FILE"
( source "$LIB"; CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS=4 acquire_app_environment_lock >/dev/null ) \
    || fail "case 1: dead-holder lock was not broken"
rm -f "$APP_ENV_LOCK_FILE"
echo "PASS case 1 — dead-holder lock broken immediately"

# ── live holder: owns the lock for HOLD_SECONDS, then releases ───────────────
HOLD_SECONDS=8
(
    source "$LIB"
    CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS=10 acquire_app_environment_lock >/dev/null
    sleep "$HOLD_SECONDS"
    release_app_environment_lock
) &
HOLDER_PID=$!
for _ in $(seq 1 50); do [ -s "$APP_ENV_LOCK_FILE" ] && break; sleep 0.1; done
[ -s "$APP_ENV_LOCK_FILE" ] || fail "live holder never acquired the lock"

# ── case 2 (THE BUG): budget shorter than the live holder → acquire FAILS ────
if ( source "$LIB"
     CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS=2 CLOUDBENCH_APP_ENV_LOCK_POLL_SECONDS=1 \
       acquire_app_environment_lock >/dev/null 2>&1 ); then
    fail "case 2: acquire succeeded with a budget shorter than the live holder (bug not reproduced)"
fi
echo "PASS case 2 — too-short budget times out on a live holder (reproduces the 120s abort)"

# ── case 3 (THE FIX): adequate budget waits the holder out → acquire SUCCEEDS ─
c3_start=$(date +%s)
( source "$LIB"
  CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS=30 CLOUDBENCH_APP_ENV_LOCK_POLL_SECONDS=1 \
    acquire_app_environment_lock >/dev/null ) \
    || fail "case 3: adequate budget failed to wait the live holder out"
c3_elapsed=$(( $(date +%s) - c3_start ))
[ "$c3_elapsed" -ge 2 ] || fail "case 3: acquired instantly (${c3_elapsed}s) — did not actually wait for the live holder to release"
echo "PASS case 3 — adequate budget waited ${c3_elapsed}s through the live holder and acquired"
wait "$HOLDER_PID" 2>/dev/null || true
HOLDER_PID=""

# ── case 4: shipped DEFAULT budget outlasts a realistic warm-dep refresh ─────
default_budget="$( source "$LIB"; printf '%s' "${CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS}" )"
case "$default_budget" in
    ''|*[!0-9]*) fail "case 4: default lock wait is not numeric: '$default_budget'" ;;
esac
[ "$default_budget" -ge 900 ] \
    || fail "case 4: default lock wait ${default_budget}s is too short to outlast a warm-dep refresh (fatal-120s regression)"
echo "PASS case 4 — default lock wait ${default_budget}s outlasts a real refresh"

echo "ALL PASS: cloudbench app-env lock"
