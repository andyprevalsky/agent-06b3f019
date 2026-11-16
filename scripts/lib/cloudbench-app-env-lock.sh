#!/usr/bin/env bash
# Cross-workspace lock for the SHARED benchmark app environment (secrets, warm
# volume dep trees, snapshots). Every concurrent fleet/maintenance op that
# mutates the shared app serializes behind this one lock so they never race.
#
# The caller must have `APP_ENV_LOCK_FILE` set (run-bench-cloud points it at
# $GIT_COMMON_DIR/cloudbench-app-env.lock, shared across sibling worktrees).
#
# RCA cement — the wait budget must OUTLAST the longest operation that legitimately
# holds the lock. A warm-volume dependency refresh + snapshot takes MINUTES; the
# prior flat 120s acquire cap (60 × sleep 2) was SHORTER than a single peer
# refresh, so when two fleets launched together the second one timed out and
# aborted its ENTIRE run instead of waiting its turn — directly breaking "handle
# any set of concurrent workstreams". `shlock -p "$$"` still breaks a lock whose
# recorded PID is DEAD immediately, so a generous budget only ever waits on a
# LIVE, progressing holder (which will release), never on a crashed one.
# On 2026-10-12 one refresh held the lock about 20 minutes (a 14-minute Fly
# snapshot) and its snapshot wait allows 30, so 1800s was no longer enough.
#
# Tunables (env, all optional):
#   CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS  total wait budget      (default 3600)
#   CLOUDBENCH_APP_ENV_LOCK_POLL_SECONDS  poll interval          (default 2)

: "${CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS:=3600}"
: "${CLOUDBENCH_APP_ENV_LOCK_POLL_SECONDS:=2}"

acquire_app_environment_lock() {
    local owner elapsed=0 announced_at=-1
    local budget="${CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS:-3600}"
    local poll="${CLOUDBENCH_APP_ENV_LOCK_POLL_SECONDS:-2}"
    command -v shlock >/dev/null 2>&1 || {
        echo "❌ shlock is required for cross-workspace benchmark environment locking." >&2
        return 1
    }
    [ -n "${APP_ENV_LOCK_FILE:-}" ] || {
        echo "❌ APP_ENV_LOCK_FILE is unset — cannot acquire the app environment lock." >&2
        return 1
    }
    while :; do
        # shlock records our PID and atomically breaks any lock whose recorded
        # PID is no longer alive (a crashed peer's stale lock).
        shlock -p "$$" -f "$APP_ENV_LOCK_FILE" && return 0
        owner="$(cat "$APP_ENV_LOCK_FILE" 2>/dev/null || true)"
        if [ "$elapsed" -ge "$budget" ]; then
            echo "❌ Timed out (${budget}s) waiting for shared benchmark app environment lock (owner=${owner:-unknown})." >&2
            return 1
        fi
        # Announce on entry, then periodically, so a long-but-legitimate wait (a
        # peer refresh in progress) is visibly progressing rather than looking hung.
        if [ "$announced_at" -lt 0 ]; then
            echo "⏳ waiting for shared benchmark app environment lock (owner=${owner:-unknown})..."
            announced_at="$elapsed"
        elif [ $(( elapsed - announced_at )) -ge 30 ]; then
            echo "⏳ still waiting for shared benchmark app environment lock (owner=${owner:-unknown}, ${elapsed}s/${budget}s)..."
            announced_at="$elapsed"
        fi
        sleep "$poll"
        elapsed=$(( elapsed + poll ))
    done
}

release_app_environment_lock() {
    local owner
    owner="$(cat "$APP_ENV_LOCK_FILE" 2>/dev/null || true)"
    [ "$owner" = "$$" ] && rm -f "$APP_ENV_LOCK_FILE" 2>/dev/null || true
}

# Read-only peer probe: print the PID of a LIVE process other than the caller
# that owns the lock, using the same liveness rule shlock applies before it
# breaks a lock (the recorded PID must still exist). An absent, malformed or
# dead-owner lock prints nothing and returns 1. Never acquires or breaks it.
# Maintenance (--setup / --refresh-deps / --refresh-wmh) holds the lock while
# it starts the shared warm donor and parks the donor before releasing it, so a
# live owner is how a provisioning fleet recognises in-flight maintenance.
app_environment_lock_live_owner() {
    local owner
    [ -n "${APP_ENV_LOCK_FILE:-}" ] || return 1
    owner="$(cat "$APP_ENV_LOCK_FILE" 2>/dev/null || true)"
    case "$owner" in ''|*[!0-9]*) return 1 ;; esac
    [ "$owner" -gt 1 ] && [ "$owner" != "$$" ] || return 1
    kill -0 "$owner" 2>/dev/null || return 1
    printf '%s\n' "$owner"
}

assert_app_environment_lock_ownership() {
    local actual_owner
    actual_owner="$(cat "$APP_ENV_LOCK_FILE" 2>/dev/null || true)"
    if [ "$actual_owner" != "$$" ] || ! kill -0 "$$" 2>/dev/null; then
        echo "❌ Lost ownership of shared benchmark app environment lock." >&2
        return 1
    fi
}
