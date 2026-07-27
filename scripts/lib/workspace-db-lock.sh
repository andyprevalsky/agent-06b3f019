#!/usr/bin/env bash
# Per-workspace-database lock for the destructive local-DB critical section
# (DROP SCHEMA → prisma db push → seed prod data → publish benchmark dump).
#
# RCA cement — a fresh Conductor workspace runs `bash scripts/setup-db.sh` as the
# tail of its `setup` hook (.conductor/settings.toml) while the first `/sync` in
# that same workspace runs the identical script. Both target ONE database, and
# nothing serialized them, so the second invocation's `DROP SCHEMA public
# CASCADE` + `prisma db push` executed straight through the first invocation's
# in-flight seed: tables the seed had already written vanished under it
# (`relation "public.LocalStorageOrigin" does not exist`), a not-yet-recreated
# unique index broke an upsert (`no unique or exclusion constraint matching the
# ON CONFLICT specification`), and the wiped User row broke a foreign key. The
# seed aborted and the workspace had no trustworthy local database.
#
# The wait budget must OUTLAST the longest legitimate hold: a full prod sync is
# minutes, so a short cap would make the loser abort instead of waiting its
# turn — reintroducing the failure it is meant to prevent. A lock whose recorded
# PID is DEAD is broken immediately, so a generous budget only ever waits on a
# live, progressing holder.
#
# Tunables (env, all optional):
#   ROSE_WORKSPACE_DB_LOCK_DIR       lock directory   (default $TMPDIR/rose-workspace-db-locks)
#   ROSE_WORKSPACE_DB_LOCK_WAIT_SECONDS  total budget (default 1800)
#   ROSE_WORKSPACE_DB_LOCK_POLL_SECONDS  poll interval (default 2)

: "${ROSE_WORKSPACE_DB_LOCK_WAIT_SECONDS:=1800}"
: "${ROSE_WORKSPACE_DB_LOCK_POLL_SECONDS:=2}"

WORKSPACE_DB_LOCK_FILE=""

# Atomically claim $1 for this PID, or return non-zero when someone else holds
# it. `shlock` does exactly this and also breaks a dead holder's lock; the
# noclobber fallback keeps the same on-disk format (a file holding the owner
# PID) on hosts without it.
_claim_workspace_db_lock() {
    local lock_file="$1" owner
    if command -v shlock >/dev/null 2>&1; then
        shlock -p "$$" -f "$lock_file" && return 0
        return 1
    fi
    if (set -o noclobber; printf '%s\n' "$$" > "$lock_file") 2>/dev/null; then
        return 0
    fi
    owner="$(head -1 "$lock_file" 2>/dev/null || true)"
    case "$owner" in
        ''|*[!0-9]*) rm -f "$lock_file" ;;
        *) kill -0 "$owner" 2>/dev/null || rm -f "$lock_file" ;;
    esac
    return 1
}

# acquire_workspace_db_lock <db-container-name>
acquire_workspace_db_lock() {
    local key="$1" lock_dir lock_file owner elapsed=0 announced_at=-1
    local budget="${ROSE_WORKSPACE_DB_LOCK_WAIT_SECONDS:-1800}"
    local poll="${ROSE_WORKSPACE_DB_LOCK_POLL_SECONDS:-2}"

    [ -n "$key" ] || {
        echo "❌ acquire_workspace_db_lock requires a database container name." >&2
        return 1
    }
    lock_dir="${ROSE_WORKSPACE_DB_LOCK_DIR:-${TMPDIR:-/tmp}/rose-workspace-db-locks}"
    mkdir -p "$lock_dir" || return 1
    lock_file="$lock_dir/${key}.lock"

    while :; do
        if _claim_workspace_db_lock "$lock_file"; then
            WORKSPACE_DB_LOCK_FILE="$lock_file"
            return 0
        fi
        owner="$(head -1 "$lock_file" 2>/dev/null || true)"
        if [ "$elapsed" -ge "$budget" ]; then
            echo "❌ Timed out (${budget}s) waiting for the $key database lock (owner=${owner:-unknown})." >&2
            return 1
        fi
        # Announce on entry, then periodically, so a long-but-legitimate wait (a
        # peer prod sync in progress) reads as progressing rather than hung.
        if [ "$announced_at" -lt 0 ]; then
            echo "⏳ waiting for the $key database lock (owner=${owner:-unknown})..."
            announced_at="$elapsed"
        elif [ $(( elapsed - announced_at )) -ge 30 ]; then
            echo "⏳ still waiting for the $key database lock (owner=${owner:-unknown}, ${elapsed}s/${budget}s)..."
            announced_at="$elapsed"
        fi
        sleep "$poll"
        elapsed=$(( elapsed + poll ))
    done
}

release_workspace_db_lock() {
    [ -n "$WORKSPACE_DB_LOCK_FILE" ] || return 0
    rm -f "$WORKSPACE_DB_LOCK_FILE"
    WORKSPACE_DB_LOCK_FILE=""
}
