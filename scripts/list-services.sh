#!/usr/bin/env bash
# List all runtime services currently running from this worktree: run.sh and
# the subprocess tree it spawned (backend, agents worker, front-end, mac-app).
# Prints PID, PPID, state, listening ports, and the first 100 chars of command.
#
# Scope is $PWD — sibling worktrees are not listed. Pair with
# scripts/kill-services.sh to clean up what you see here.
#
# Usage: scripts/list-services.sh

# No `set -e` on purpose: lsof/ps can fail transiently on exiting pids and we
# don't want to abort the whole listing when one row can't be inspected.

WORKTREE_DIR="$(pwd -P)"
MANIFEST="$WORKTREE_DIR/.context/services.json"

pid_tree() {
    local root=$1
    echo "$root"
    for child in $(pgrep -P "$root" 2>/dev/null); do
        pid_tree "$child"
    done
}

cwd_of() {
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

cmd_of() {
    ps -p "$1" -o command= 2>/dev/null | head -1
}

cwd_matches() {
    local cwd
    cwd=$(cwd_of "$1")
    [[ "$cwd" == "$WORKTREE_DIR" || "$cwd" == "$WORKTREE_DIR"/* ]]
}

service_like_process() {
    local pid=$1
    local cwd cmd
    cwd=$(cwd_of "$pid")
    [[ "$cwd" == "$WORKTREE_DIR" || "$cwd" == "$WORKTREE_DIR"/* ]] || return 1
    cmd=$(cmd_of "$pid")
    case "$cwd" in
        "$WORKTREE_DIR/back-end"|"$WORKTREE_DIR/back-end"/*)
            echo "$cmd" | grep -Eq 'tsx.*src/server\.ts|tsx.*server\.ts|node .*src/server\.ts|npm exec tsx src/server\.ts'
            return
            ;;
        "$WORKTREE_DIR/front-end"|"$WORKTREE_DIR/front-end"/*)
            echo "$cmd" | grep -Eq '(^|/| )(vite|npm|npx)( |$|/)'
            return
            ;;
        "$WORKTREE_DIR/agents"|"$WORKTREE_DIR/agents"/*)
            echo "$cmd" | grep -Eq 'worker\.py|run_local_worker|playwright.*/driver|package/cli\.js run-driver'
            return
            ;;
        "$WORKTREE_DIR/mac-app"|"$WORKTREE_DIR/mac-app"/*)
            echo "$cmd" | grep -Eq 'electron|npm run dev|vite'
            return
            ;;
    esac
    echo "$cmd" | grep -Fq "$WORKTREE_DIR"
}

manifest_pids() {
    [ -f "$MANIFEST" ] || return 0
    python3 - "$MANIFEST" <<'PY' 2>/dev/null || true
import json
import sys

with open(sys.argv[1]) as f:
    data = json.load(f)

for pid in [data.get("run_sh_pid"), *[service.get("pid") for service in data.get("services", [])]]:
    if isinstance(pid, int) and pid > 0:
        print(pid)
PY
}

service_ports() {
    [ -f "$MANIFEST" ] || return 0
    python3 - "$MANIFEST" <<'PY' 2>/dev/null || true
import json
import sys

with open(sys.argv[1]) as f:
    data = json.load(f)

ports = data.get("ports", {})
for key in ("backend", "frontend", "health", "mac_app", "sdk_metrics"):
    value = ports.get(key)
    if isinstance(value, int) and value > 0:
        print(value)
PY
}

service_dir_cwd_pids() {
    local dir
    for dir in "$WORKTREE_DIR/back-end" "$WORKTREE_DIR/front-end" "$WORKTREE_DIR/agents" "$WORKTREE_DIR/mac-app"; do
        [ -d "$dir" ] || continue
        lsof -n -w -t -a -d cwd +d "$dir" 2>/dev/null || true
    done
}

add_pid() {
    local pid=$1
    [ -n "$pid" ] || return
    [ "$pid" = "$$" ] && return
    kill -0 "$pid" 2>/dev/null || return
    pid_tree "$pid" >> "$ALL"
}

ALL=$(mktemp)
trap 'rm -f "$ALL"' EXIT

for pid in $(manifest_pids); do
    add_pid "$pid"
done

for pattern in \
    "scripts/run\.sh" \
    "$WORKTREE_DIR/back-end" \
    "$WORKTREE_DIR/agents" \
    "$WORKTREE_DIR/front-end" \
    "$WORKTREE_DIR/mac-app"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        cwd_matches "$pid" || echo "$(cmd_of "$pid")" | grep -Fq "$WORKTREE_DIR" || continue
        add_pid "$pid"
    done
done

for port in $(service_ports); do
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
        cwd_matches "$pid" || continue
        add_pid "$pid"
    done
done

while read -r pid; do
    [ -n "$pid" ] || continue
    service_like_process "$pid" || continue
    add_pid "$pid"
done < <(service_dir_cwd_pids | sort -un)

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
