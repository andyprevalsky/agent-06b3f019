#!/usr/bin/env bash
# List all runtime services currently running from this worktree: run.sh and
# the subprocess tree it spawned (backend, agents worker, supabase, etc.).
# Prints PID, PPID, state, listening ports, and the first 100 chars of command.
#
# Scope is $PWD — sibling worktrees are not listed. Pair with
# scripts/kill-services.sh to clean up what you see here.
#
# Usage: scripts/list-services.sh

# No `set -e` on purpose: lsof/ps can fail transiently on exiting pids and we
# don't want to abort the whole listing when one row can't be inspected.

WORKTREE_DIR="$PWD"

pid_tree() {
    local root=$1
    echo "$root"
    for child in $(pgrep -P "$root" 2>/dev/null); do
        pid_tree "$child"
    done
}

cwd_of() {
    lsof -p "$1" -Fn 2>/dev/null | awk '/^fcwd$/ {getline; sub(/^n/,""); print; exit}'
}

ALL=$(mktemp)
trap 'rm -f "$ALL"' EXIT

for pattern in \
    "scripts/run\.sh" \
    "$WORKTREE_DIR/back-end" \
    "$WORKTREE_DIR/agents" \
    "$WORKTREE_DIR/research" \
    "$WORKTREE_DIR/front-end" \
    "$WORKTREE_DIR/mac-app"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        cwd=$(cwd_of "$pid")
        [[ -z "$cwd" || "$cwd" == "$WORKTREE_DIR"* ]] || continue
        pid_tree "$pid" >> "$ALL"
    done
done

PIDS=$(sort -un "$ALL")

if [[ -z "$PIDS" ]]; then
    echo "No services running in $WORKTREE_DIR"
    exit 0
fi

SELF=$$
printf "%-7s %-7s %-5s %-20s %s\n" PID PPID STAT PORTS COMMAND
printf "%s\n" "-------------------------------------------------------------------------------------------------------------"
for pid in $PIDS; do
    [[ "$pid" == "$SELF" ]] && continue
    info=$(ps -o ppid=,stat=,command= -p "$pid" 2>/dev/null | head -1)
    if [[ -z "$info" ]]; then continue; fi
    ppid=$(echo "$info" | awk '{print $1}')
    stat=$(echo "$info" | awk '{print $2}')
    cmd=$(echo "$info" | awk '{for(i=3;i<=NF;i++) printf "%s ",$i; print ""}' | cut -c-100)
    ports=$(lsof -Pan -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null \
        | awk 'NR>1 {n=split($9,a,":"); print a[n]}' \
        | sort -un | paste -sd, - || true)
    printf "%-7s %-7s %-5s %-20s %s\n" "$pid" "$ppid" "$stat" "${ports:-—}" "$cmd"
done
