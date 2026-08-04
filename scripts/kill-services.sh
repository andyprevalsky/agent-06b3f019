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
PROCESS_IDENTITY_HELPER="$WORKTREE_DIR/scripts/process-identity.py"

# Return an OS-native process birth identity: Linux boot ID + start ticks, or
# Darwin proc_pidinfo start time with microsecond precision. Unsupported or
# unreadable identities fail closed instead of falling back to second-precision
# ps output. The identity is captured at discovery and rechecked immediately
# before every signal so a recycled PID is never treated as the original service.
process_start_time() {
    python3 "$PROCESS_IDENTITY_HELPER" "$1" 2>/dev/null
}

record_pid() {
    local file=$1 pid=$2 start_time
    start_time=$(process_start_time "$pid")
    [[ -n "$start_time" ]] || return 1
    printf '%s\t%s\n' "$pid" "$start_time" >> "$file"
}

identity_matches() {
    local pid=$1 expected_start=$2 current_start
    current_start=$(process_start_time "$pid")
    [[ -n "$expected_start" && "$current_start" == "$expected_start" ]]
}

signal_if_same_identity() {
    local pid=$1 expected_start=$2 signal=$3
    if ! identity_matches "$pid" "$expected_start"; then
        echo "🛡️  Refusing SIG${signal} for gone or recycled PID $pid" >&2
        return 1
    fi
    kill "-$signal" "$pid" 2>/dev/null
}

# Record this pid + all descendants with their identity at discovery time.
pid_tree() {
    local root=$1
    record_pid "$ALL_FILE" "$root" || return
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

# Benchmark controllers are NEVER ours to kill (CLAUDE.md rule 27). They own Fly
# machines, volumes, and isolated stacks, and they reap those resources through
# their own signal traps — killing one from outside leaks paid infrastructure and
# can terminate healthy fleets belonging to other worktrees or sessions.
#
# `run-predeploy-local` starts an ISOLATED `scripts/run.sh` stack as a child. That
# child matches the `scripts/run\.sh` root pattern below, and
# `add_pid_with_tree_and_ancestors` then walks upward through same-worktree
# ancestors. Protect the controller boundary before that escalation occurs.
is_benchmark_controller() {
    local cmd
    cmd=$(cmd_of "$1")
    echo "$cmd" | grep -Eq '(^|[[:space:]/])run-predeploy-(local|cloud)([[:space:]]|$)|(^|[[:space:]/])run-bench(-fleet|-cloud|-hub-poller)?([[:space:]]|$)|(^|[[:space:]])([^[:space:]]*/)?benchmarks/(local|run_benchmark|run_eval_suite)\.py([[:space:]]|$)'
}

is_protected_process() {
    is_self_or_parent "$1" || is_self_ancestor "$1" || is_benchmark_controller "$1"
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
    local pid=$1 expected_start=$2
    identity_matches "$pid" "$expected_start" || return
    is_protected_process "$pid" && return
    kill -0 "$pid" 2>/dev/null || return

    pid_tree "$pid"

    local current=$pid
    while true; do
        local ppid
        ppid=$(ps -p "$current" -o ppid= 2>/dev/null | tr -d ' ') || return
        [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ] && return
        is_protected_process "$ppid" && return
        if cwd_matches "$ppid"; then
            record_pid "$ALL_FILE" "$ppid" || return
            current="$ppid"
            continue
        fi
        return
    done
}

# Allow the safety predicates to be sourced by their regression tests without
# running teardown as a side effect.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
    return 0
fi

ROOTS_FILE=$(mktemp)
ALL_FILE=$(mktemp)
TARGETS_FILE=$(mktemp)
KEPT_FILE=$(mktemp)
SURVIVORS_FILE=$(mktemp)
trap 'rm -f "$ROOTS_FILE" "$ALL_FILE" "$TARGETS_FILE" "$KEPT_FILE" "$SURVIVORS_FILE"' EXIT

# Manifest PIDs are authoritative when present. They catch wrappers whose argv
# is generic after cd'ing into a service directory. Capture identity at the
# same moment each numeric PID enters the root set.
while read -r pid; do
    [[ -n "$pid" ]] && record_pid "$ROOTS_FILE" "$pid" || true
done < <(manifest_pids)

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
        record_pid "$ROOTS_FILE" "$pid" || true
    done
done

for port in $(service_ports); do
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
        is_protected_process "$pid" && continue
        cwd_matches "$pid" || continue
        record_pid "$ROOTS_FILE" "$pid" || true
    done
done

# Last-resort cwd sweep for service-shaped processes. This catches leaked
# children like `python worker.py` or `node ...` whose argv no longer includes
# the absolute worktree path and whose original run.sh parent is gone.
while read -r pid; do
    [ -n "$pid" ] || continue
    is_protected_process "$pid" && continue
    service_like_process "$pid" || continue
    record_pid "$ROOTS_FILE" "$pid" || true
done < <(service_dir_cwd_pids | sort -un)

sort -n -u "$ROOTS_FILE" -o "$ROOTS_FILE"

while IFS=$'\t' read -r pid start_time; do
    [[ -z "$pid" ]] && continue
    add_pid_with_tree_and_ancestors "$pid" "$start_time"
done < "$ROOTS_FILE"

# Keep one identity only when every observation of a numeric PID agrees. If a
# PID was recycled while the tree was being collected, drop it fail-closed.
awk -F '\t' -v self="$SELF" -v parent="$SELF_PPID" '
    $1 == self || $1 == parent { next }
    !($1 in first) { first[$1] = $2; order[++count] = $1; next }
    first[$1] != $2 { unstable[$1] = 1 }
    END {
        for (i = 1; i <= count; i++) {
            pid = order[i]
            if (!(pid in unstable)) print pid "\t" first[pid]
        }
    }
' "$ALL_FILE" > "$TARGETS_FILE"

# Final backstop: drop any benchmark controller that entered the set as a
# descendant. `pid_tree` walks downward and does not consult
# `is_protected_process`, so the ancestor guard alone cannot catch this path.
while IFS=$'\t' read -r pid start_time; do
    [[ -n "$pid" ]] || continue
    identity_matches "$pid" "$start_time" || continue
    if is_benchmark_controller "$pid"; then
        echo "🛡️  Refusing to kill benchmark controller $pid: $(cmd_of "$pid" | cut -c1-90)" >&2
        continue
    fi
    printf '%s\t%s\n' "$pid" "$start_time" >> "$KEPT_FILE"
done < "$TARGETS_FILE"
mv "$KEPT_FILE" "$TARGETS_FILE"
KEPT_FILE=$(mktemp)

if [[ ! -s "$TARGETS_FILE" ]]; then
    if [[ $DRY -eq 0 ]]; then
        mark_manifest_stopped
    fi
    echo "No services to kill in $WORKTREE_DIR"
    exit 0
fi

count=$(wc -l < "$TARGETS_FILE" | tr -d ' ')
echo "🧹 Targets in $WORKTREE_DIR ($count pid(s)):"
while IFS=$'\t' read -r pid start_time; do
    identity_matches "$pid" "$start_time" || continue
    cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -1 | cut -c-100)
    if [[ -n "$cmd" ]]; then echo "   $pid  $cmd"; fi
done < "$TARGETS_FILE"

if [[ $DRY -eq 1 ]]; then
    echo "(dry-run — no processes killed)"
    exit 0
fi

# SIGTERM pass
while IFS=$'\t' read -r pid start_time; do
    signal_if_same_identity "$pid" "$start_time" TERM || true
done < "$TARGETS_FILE"
sleep 2

# SIGKILL any survivors
while IFS=$'\t' read -r pid start_time; do
    if identity_matches "$pid" "$start_time" && kill -0 "$pid" 2>/dev/null; then
        printf '%s\t%s\n' "$pid" "$start_time" >> "$SURVIVORS_FILE"
    fi
done < "$TARGETS_FILE"
if [[ -s "$SURVIVORS_FILE" ]]; then
    echo "   SIGTERM survivors → SIGKILL: $(cut -f1 "$SURVIVORS_FILE" | tr '\n' ' ')"
    while IFS=$'\t' read -r pid start_time; do
        signal_if_same_identity "$pid" "$start_time" KILL || true
    done < "$SURVIVORS_FILE"
    sleep 1
fi

# Final verify
STILL=""
while IFS=$'\t' read -r pid start_time; do
    identity_matches "$pid" "$start_time" && kill -0 "$pid" 2>/dev/null && STILL="$STILL $pid"
done < "$TARGETS_FILE"
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
