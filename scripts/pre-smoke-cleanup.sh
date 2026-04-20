#!/usr/bin/env bash
# Idempotent pre-smoke cleanup. Safe to call any number of times.
#
# Enforces "at most 1 of each service per worktree" by:
#   1. Killing stale service processes in THIS worktree (kill-services.sh)
#   2. Marking stale ACTIVE agents in THIS worktree's DB as FAILED
#   3. Reaping idle docker containers from OTHER worktrees ( > IDLE_MIN min
#      since their last log line). This worktree's own containers are never
#      touched — parallel worktrees with recent activity are preserved.
#
# Temporal workflow cleanup is not done here (it requires the agents/ venv
# and is handled in-process by run_benchmark.py's preflight).
#
# Usage:
#   scripts/pre-smoke-cleanup.sh
#   PRE_SMOKE_IDLE_MIN=60 scripts/pre-smoke-cleanup.sh
#   scripts/pre-smoke-cleanup.sh --dry-run

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE="${CONDUCTOR_WORKSPACE_NAME:-}"
IDLE_MIN="${PRE_SMOKE_IDLE_MIN:-30}"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

echo "🧹 Pre-smoke cleanup"
echo "   worktree:   $WORKTREE_DIR"
echo "   workspace:  ${WORKSPACE:-<unset — step 2 will be skipped>}"
echo "   idle thr.:  ${IDLE_MIN}m"
[[ $DRY -eq 1 ]] && echo "   DRY RUN — no mutations"
echo ""

# ───────────────────────── Step 1: process dedup ─────────────────────────
echo "▸ Step 1: kill stale service processes in this worktree"
if [[ $DRY -eq 1 ]]; then
    bash "$SCRIPT_DIR/kill-services.sh" --dry-run
else
    bash "$SCRIPT_DIR/kill-services.sh"
fi

# ─────────────────── Step 2: stale ACTIVE agents → FAILED ────────────────
echo ""
echo "▸ Step 2: mark stale ACTIVE agents in this workspace's DB as FAILED"
if [[ -z "$WORKSPACE" ]]; then
    echo "   skipped (CONDUCTOR_WORKSPACE_NAME unset)"
else
    DB_CONTAINER="victoria-db-$WORKSPACE"
    if docker ps --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
        SQL='UPDATE "Agent" SET status = '"'"'FAILED'"'"', "updatedAt" = NOW() WHERE status = '"'"'ACTIVE'"'"' AND "createdAt" < NOW() - INTERVAL '"'"'30 minutes'"'"' RETURNING id;'
        if [[ $DRY -eq 1 ]]; then
            echo "   (dry-run) would execute: $SQL"
        else
            # Run inside container to avoid needing host psql
            OUTPUT=$(docker exec "$DB_CONTAINER" psql -U postgres -d victoria -t -A -c "$SQL" 2>&1)
            RC=$?
            if [[ $RC -eq 0 ]]; then
                COUNT=$(echo "$OUTPUT" | grep -c '^[0-9a-f-]\{36\}$' || true)
                echo "   ✅ marked $COUNT stale ACTIVE agent(s) as FAILED"
            else
                echo "   ⚠ SQL failed: $OUTPUT"
            fi
        fi
    else
        echo "   skipped ($DB_CONTAINER not running — run.sh will start it)"
    fi
fi

# ───────────── Step 3: reap idle containers from other worktrees ─────────
echo ""
echo "▸ Step 3: reap idle docker containers from other worktrees (>${IDLE_MIN}m idle)"

NOW_EPOCH=$(date +%s)
THRESHOLD=$((NOW_EPOCH - IDLE_MIN * 60))

# docker-ts-iso → epoch (BSD date on macOS)
iso_to_epoch() {
    local iso="$1"
    # Strip sub-second fraction + timezone suffix so BSD date parses it
    iso="${iso%%.*}"
    iso="${iso%%+*}"
    iso="${iso%%Z}"
    date -j -f "%Y-%m-%dT%H:%M:%S" "$iso" +%s 2>/dev/null || echo 0
}

reap_count=0
preserved_count=0

# Only scan containers that look like per-worktree services
for name in $(docker ps --format '{{.Names}}' | grep -E '^(victoria-db-|supabase_)' || true); do
    # Preserve anything associated with this worktree's workspace
    if [[ -n "$WORKSPACE" && "$name" == *"$WORKSPACE"* ]]; then
        preserved_count=$((preserved_count + 1))
        continue
    fi

    # Prefer last log line timestamp (tracks real activity).
    # Fall back to StartedAt when the container hasn't logged anything.
    last_ts=$(docker logs --tail 1 -t "$name" 2>/dev/null | awk '{print $1}' | head -1)
    if [[ -z "$last_ts" || "$last_ts" == "" ]]; then
        last_ts=$(docker inspect "$name" --format '{{.State.StartedAt}}' 2>/dev/null)
    fi

    last_epoch=$(iso_to_epoch "$last_ts")
    if [[ "$last_epoch" == "0" ]]; then
        # Can't determine age — skip rather than risk stopping a live container
        continue
    fi

    if (( last_epoch < THRESHOLD )); then
        age_min=$(( (NOW_EPOCH - last_epoch) / 60 ))
        if [[ $DRY -eq 1 ]]; then
            echo "   (dry-run) would stop $name (idle ${age_min}m)"
        else
            echo "   🧹 stopping $name (idle ${age_min}m)"
            docker stop "$name" >/dev/null 2>&1
        fi
        reap_count=$((reap_count + 1))
    fi
done

echo "   reaped $reap_count, preserved $preserved_count (this worktree + active)"

echo ""
echo "✅ Pre-smoke cleanup complete"
