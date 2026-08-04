#!/usr/bin/env bash
# Kill all runtime services started from this worktree (run.sh + descendants:
# backend, agents worker, front-end, mac-app). Preserves the Postgres container
# and its volume so subsequent runs can reuse them.
#
# Scope: only kills PIDs tied to $PWD by manifest PID, current working
# directory, or listener ownership on this workspace's service ports. Sibling
# worktrees are untouched. Walks descendants and worktree-local ancestors so
# orphaned grandchildren and wrapper shells are reached.
#
# Usage:
#   scripts/kill-services.sh            # kill
#   scripts/kill-services.sh --dry-run  # print targets, don't kill

# No `set -e`/`pipefail`: ps|head|cut races can SIGPIPE benignly and we don't
# want that to abort the teardown mid-list.

WORKTREE_DIR="$(pwd -P)"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

SELF=$$
SELF_PPID=$PPID
MANIFEST="$WORKTREE_DIR/.context/services.json"

# Emit this pid + all descendants, one per line.
pid_tree() {
    local root=$1
    echo "$root"
    for child in $(pgrep -P "$root" 2>/dev/null); do
        pid_tree "$child"
    done
}

cwd_of() {
    local pid=$1
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

cmd_of() {
    ps -p "$1" -o command= 2>/dev/null | head -1
}

cwd_matches() {
    local cwd
    cwd=$(cwd_of "$1")
    [[ "$cwd" == "$WORKTREE_DIR" || "$cwd" == "$WORKTREE_DIR"/* ]]
}

is_self_or_parent() {
    [[ "$1" == "$SELF" || "$1" == "$SELF_PPID" ]]
}

is_self_ancestor() {
    local candidate=$1
    local current=$SELF
    while true; do
        local ppid
        ppid=$(ps -p "$current" -o ppid= 2>/dev/null | tr -d ' ') || return 1
        [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ] && return 1
        [ "$ppid" = "$candidate" ] && return 0
        current="$ppid"
    done
}

# Agent tool shells (Claude Code wraps every Bash call in a shell that sources a
# generated snapshot) routinely sit in the worktree and launch run.sh, so the
# ancestor walk climbs straight into them and the cwd sweep can select them.
# They are the agent's own pollers, not services: killing one silently destroys
# the monitor that is supposed to be watching the stack being restarted, which
# looks identical to "the task is still running".
# Match the shape of the wrapper, not merely a mention of the path: the process
# must itself be a shell interpreter invoked with -c on a snapshot script. A
# substring test would let any service evade cleanup just by carrying the
# snapshot path somewhere in its argv.
is_agent_tool_shell() {
    local cmd
    cmd=$(cmd_of "$1")
    [[ "$cmd" =~ ^(/[^[:space:]]*/)?(zsh|bash|sh)[[:space:]] ]] || return 1
    [[ "$cmd" =~ [[:space:]]-[[:alnum:]]*c[[:space:]] ]] || return 1
    [[ "$cmd" =~ \.claude/shell-snapshots/[^[:space:]]+\.sh ]]
}

is_protected_process() {
    is_self_or_parent "$1" || is_self_ancestor "$1" || is_agent_tool_shell "$1"
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
            echo "$cmd" | grep -Eq 'worker\.py|run_local_worker|playwright.*/driver|package/cli\.js run-driver|wmh serve|uvicorn'
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
for key in ("backend", "frontend", "health", "mac_app", "sdk_metrics", "wmh"):
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

mark_manifest_stopped() {
    [ -f "$MANIFEST" ] || return 0
    python3 - "$MANIFEST" <<'PY' 2>/dev/null || true
import json
import os
import sys
from datetime import datetime, timezone

path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
data["status"] = "stopped"
data["generated_at"] = datetime.now(timezone.utc).isoformat()
tmp = f"{path}.tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PY
}

add_pid_with_tree_and_ancestors() {
    local pid=$1
    is_protected_process "$pid" && return
    kill -0 "$pid" 2>/dev/null || return

    pid_tree "$pid" >> "$ALL_FILE"

    local current=$pid
    while true; do
        local ppid
        ppid=$(ps -p "$current" -o ppid= 2>/dev/null | tr -d ' ') || return
        [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ] && return
        is_protected_process "$ppid" && return
        if cwd_matches "$ppid"; then
            echo "$ppid" >> "$ALL_FILE"
            current="$ppid"
            continue
        fi
        return
    done
}

ROOTS_FILE=$(mktemp)
ALL_FILE=$(mktemp)
KEEP_FILE=$(mktemp)
IDENT_FILE=$(mktemp)
trap 'rm -f "$ROOTS_FILE" "$ALL_FILE" "$KEEP_FILE" "$IDENT_FILE"' EXIT

# Manifest PIDs are authoritative when present. They catch wrappers whose argv
# is generic after cd'ing into a service directory.
manifest_pids >> "$ROOTS_FILE"

# Patterns that identify service roots. The worktree-prefixed patterns catch
# grandchildren (node, python, vite) that carry the absolute path in argv.
for pattern in \
    "scripts/run\.sh" \
    "$WORKTREE_DIR/back-end/src/server\.ts" \
    "$WORKTREE_DIR/back-end.*tsx.*server\.ts" \
    "$WORKTREE_DIR/agents/scripts/run_local_worker" \
    "$WORKTREE_DIR/agents.*worker\.py" \
    "$WORKTREE_DIR/agents.*wmh serve" \
    "$WORKTREE_DIR/front-end.*vite" \
    "$WORKTREE_DIR/mac-app/node_modules"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        is_protected_process "$pid" && continue
        cwd_matches "$pid" || echo "$(cmd_of "$pid")" | grep -Fq "$WORKTREE_DIR" || continue
        echo "$pid" >> "$ROOTS_FILE"
    done
done

for port in $(service_ports); do
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
        is_protected_process "$pid" && continue
        cwd_matches "$pid" || continue
        echo "$pid" >> "$ROOTS_FILE"
    done
done

# Last-resort cwd sweep for service-shaped processes. This catches leaked
# children like `python worker.py` or `node ...` whose argv no longer includes
# the absolute worktree path and whose original run.sh parent is gone.
while read -r pid; do
    [ -n "$pid" ] || continue
    is_protected_process "$pid" && continue
    service_like_process "$pid" || continue
    echo "$pid" >> "$ROOTS_FILE"
done < <(service_dir_cwd_pids | sort -un)

sort -un "$ROOTS_FILE" -o "$ROOTS_FILE"

while read -r pid; do
    [[ -z "$pid" ]] && continue
    add_pid_with_tree_and_ancestors "$pid"
done < "$ROOTS_FILE"

> "$KEEP_FILE"
while read -r pid; do
    [[ -z "$pid" ]] && continue
    # pid_tree collects descendants without consulting the root filters, so the
    # protection check has to be re-applied to the fully expanded set.
    is_protected_process "$pid" && continue
    echo "$pid" >> "$KEEP_FILE"
done < <(sort -un "$ALL_FILE")

PIDS=$(grep -v "^$SELF$" "$KEEP_FILE" | grep -v "^$SELF_PPID$" || true)

# A PID is only a stable handle while its process lives. Between collection and
# the TERM/KILL passes a target can exit and the kernel can hand its number to
# an unrelated process, so record each target's start time now and re-check it
# immediately before every signal.
pid_identity() {
    ps -p "$1" -o lstart= 2>/dev/null | tr -s ' ' | sed 's/^ *//;s/ *$//'
}

> "$IDENT_FILE"
for pid in $PIDS; do
    identity=$(pid_identity "$pid")
    [ -n "$identity" ] && printf '%s\t%s\n' "$pid" "$identity" >> "$IDENT_FILE"
done

recorded_identity() {
    awk -F'\t' -v want="$1" '$1 == want { print $2; exit }' "$IDENT_FILE"
}

# Signal only if this PID still refers to the exact process we selected.
signal_if_same_process() {
    local pid=$1 sig=$2 expected current
    expected=$(recorded_identity "$pid")
    [ -n "$expected" ] || return 0
    current=$(pid_identity "$pid")
    [ -n "$current" ] || return 0
    if [ "$current" != "$expected" ]; then
        echo "   ⏭️  pid $pid was recycled since selection; not signalling"
        return 0
    fi
    is_protected_process "$pid" && return 0
    kill "-$sig" "$pid" 2>/dev/null || true
}

# Alive AND still the same process we selected.
is_live_target() {
    local pid=$1 expected current
    expected=$(recorded_identity "$pid")
    [ -n "$expected" ] || return 1
    current=$(pid_identity "$pid")
    [ -n "$current" ] || return 1
    [ "$current" = "$expected" ]
}

if [[ -z "$PIDS" ]]; then
    if [[ $DRY -eq 0 ]]; then
        mark_manifest_stopped
    fi
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
for pid in $PIDS; do signal_if_same_process "$pid" TERM; done
sleep 2

# SIGKILL any survivors
SURVIVORS=""
for pid in $PIDS; do
    is_live_target "$pid" && SURVIVORS="$SURVIVORS $pid"
done
if [[ -n "$SURVIVORS" ]]; then
    echo "   SIGTERM survivors → SIGKILL:$SURVIVORS"
    for pid in $SURVIVORS; do signal_if_same_process "$pid" KILL; done
    sleep 1
fi

# Final verify. A recycled PID that is merely alive is not a survivor.
STILL=""
for pid in $PIDS; do
    is_live_target "$pid" && STILL="$STILL $pid"
done
if [[ -n "$STILL" ]]; then
    echo "⚠️  Survived TERM+KILL:$STILL"
    exit 1
fi

PORT_SURVIVORS=""
for port in $(service_ports); do
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
        cwd_matches "$pid" || continue
        PORT_SURVIVORS="$PORT_SURVIVORS $pid:$port"
    done
done
if [[ -n "$PORT_SURVIVORS" ]]; then
    echo "⚠️  Worktree listeners survived cleanup:$PORT_SURVIVORS"
    exit 1
fi

mark_manifest_stopped

echo "✅ Killed $count service pid(s); DB container untouched"
