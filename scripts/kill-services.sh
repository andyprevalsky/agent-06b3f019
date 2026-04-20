#!/usr/bin/env bash
# Kill all runtime services started from this worktree (run.sh + descendants:
# backend, agents worker, front-end, mac-app). Preserves the Postgres container
# and its volume so subsequent runs can reuse them.
#
# Scope: only kills PIDs whose command line OR current working directory sits
# inside $PWD, so sibling worktrees are untouched. Walks each root's descendant
# tree (via pgrep -P) so orphaned grandchildren (node under a dead bash, etc.)
# are reached.
#
# Usage:
#   scripts/kill-services.sh            # kill
#   scripts/kill-services.sh --dry-run  # print targets, don't kill

# No `set -e`/`pipefail`: ps|head|cut races can SIGPIPE benignly and we don't
# want that to abort the teardown mid-list.

WORKTREE_DIR="$PWD"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

SELF=$$
SELF_PPID=$PPID

# Emit this pid + all descendants, one per line.
pid_tree() {
    local root=$1
    echo "$root"
    for child in $(pgrep -P "$root" 2>/dev/null); do
        pid_tree "$child"
    done
}

# A pid belongs to us if its CWD (or any ancestor's CWD) is under $WORKTREE_DIR.
# We check the pid's own CWD via lsof; the patterns below already filter to ones
# whose command line mentions the worktree path, so this is a belt-and-braces
# check against pgrep matching a sibling worktree's scripts/run.sh.
cwd_matches() {
    local pid=$1
    local cwd
    cwd=$(lsof -p "$pid" -Fn 2>/dev/null | awk '/^fcwd$/ {getline; sub(/^n/,""); print; exit}')
    # If we can't read cwd (permission / race), accept the match — the pattern
    # already scoped it.
    [[ -z "$cwd" || "$cwd" == "$WORKTREE_DIR"* ]]
}

ROOTS_FILE=$(mktemp)
trap 'rm -f "$ROOTS_FILE" "$ALL_FILE"' EXIT
ALL_FILE=$(mktemp)

# Patterns that identify service roots. run.sh is matched by path fragment +
# PWD scope. The worktree-prefixed patterns catch grandchildren (node, python,
# vite) that carry the absolute path in their argv.
for pattern in \
    "scripts/run\.sh" \
    "$WORKTREE_DIR/back-end/src/server\.ts" \
    "$WORKTREE_DIR/back-end.*tsx.*server\.ts" \
    "$WORKTREE_DIR/agents/scripts/run_local_worker" \
    "$WORKTREE_DIR/agents.*worker\.py" \
    "$WORKTREE_DIR/front-end.*vite" \
    "$WORKTREE_DIR/mac-app/node_modules"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        # Never kill ourselves or our invoking shell
        [[ "$pid" == "$SELF" || "$pid" == "$SELF_PPID" ]] && continue
        cwd_matches "$pid" || continue
        echo "$pid" >> "$ROOTS_FILE"
    done
done

sort -un "$ROOTS_FILE" -o "$ROOTS_FILE"

while read -r pid; do
    [[ -z "$pid" ]] && continue
    pid_tree "$pid" >> "$ALL_FILE"
done < "$ROOTS_FILE"

PIDS=$(sort -un "$ALL_FILE" | grep -v "^$SELF$" | grep -v "^$SELF_PPID$" || true)

if [[ -z "$PIDS" ]]; then
    echo "No services to kill in $WORKTREE_DIR"
    exit 0
fi

count=$(echo "$PIDS" | wc -l | tr -d ' ')
echo "🧹 Targets in $WORKTREE_DIR ($count pid(s)):"
for pid in $PIDS; do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -1 | cut -c-100)
    if [[ -n "$cmd" ]]; then echo "   $pid  $cmd"; fi
done

if [[ $DRY -eq 1 ]]; then
    echo "(dry-run — no processes killed)"
    exit 0
fi

# SIGTERM pass
for pid in $PIDS; do kill -TERM "$pid" 2>/dev/null || true; done
sleep 2

# SIGKILL any survivors
SURVIVORS=""
for pid in $PIDS; do
    kill -0 "$pid" 2>/dev/null && SURVIVORS="$SURVIVORS $pid"
done
if [[ -n "$SURVIVORS" ]]; then
    echo "   SIGTERM survivors → SIGKILL:$SURVIVORS"
    for pid in $SURVIVORS; do kill -9 "$pid" 2>/dev/null || true; done
    sleep 1
fi

# Final verify
STILL=""
for pid in $PIDS; do
    kill -0 "$pid" 2>/dev/null && STILL="$STILL $pid"
done
if [[ -n "$STILL" ]]; then
    echo "⚠️  Survived TERM+KILL:$STILL"
    exit 1
fi
echo "✅ Killed $count service pid(s); DB container untouched"
