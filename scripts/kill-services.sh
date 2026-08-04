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
    ps -ww -p "$1" -o command= 2>/dev/null | head -1
}

# Stable identity for the lifetime of one process. The start time rejects PID
# reuse; the command rejects an exec-in-place transition between discovery and
# signalling (especially a service wrapper becoming a benchmark controller).
process_fingerprint() {
    local identity
    identity=$(ps -ww -p "$1" -o lstart= -o command= 2>/dev/null | head -1) || return 1
    [[ -n "$identity" ]] || return 1
    printf '%s' "$identity" | cksum | awk '{ print $1 ":" $2 }'
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
        if [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "$current" ]; then
            return 1
        fi
        [ "$ppid" = "$candidate" ] && return 0
        current="$ppid"
    done
}

# Benchmark controllers are NEVER ours to kill (CLAUDE.md rule 27). They own Fly
# machines, volumes, and isolated stacks, and they reap those resources through
# their own signal traps — killing one from outside leaks paid infrastructure and
# has repeatedly murdered healthy fleets belonging to other worktrees/sessions.
#
# This matters here specifically because `run-predeploy-local` starts an ISOLATED
# `scripts/run.sh` stack as a child. That child matches the `scripts/run\.sh`
# root pattern below, and `add_pid_with_tree_and_ancestors` then walks UPWARD to
# same-worktree ancestors — escalating from "stop a stray service" to "SIGTERM the
# benchmark controller that owns it". Observed during /deploy: a Step 5 `run.sh`
# startup sweep killed an in-flight `run-predeploy-local` smoke run (exit 143).
is_benchmark_controller() {
    local cmd
    cmd=$(cmd_of "$1")
    echo "$cmd" | grep -Eq 'run-predeploy-(local|cloud)|run-bench(-fleet|-cloud|-hub-poller)?( |$)|benchmarks/(local|run_benchmark|run_eval_suite)\.py'
}

benchmark_controller_for_pid() {
    local current=$1
    while true; do
        if is_benchmark_controller "$current"; then
            echo "$current"
            return 0
        fi
        local ppid
        ppid=$(ps -p "$current" -o ppid= 2>/dev/null | tr -d ' ') || return 1
        # Stop only when the walk has genuinely run out of parents. PID 1 must
        # still be classified: on a Fly cloudbench guest the boot command IS
        # PID 1, so a benchmark controller legitimately lives there and every
        # service beneath it must stay protected (CLAUDE.md rule 27). Walking
        # onto PID 1 is safe because its own parent is 0, which ends the loop.
        if [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "$current" ]; then
            return 1
        fi
        current="$ppid"
    done
}

is_protected_benchmark_tree() {
    local pid=$1
    local target_controller self_controller
    target_controller=$(benchmark_controller_for_pid "$pid") || return 1

    # The controller process itself is never a service target. A child cleanup
    # may, however, reap services owned by that SAME controller.
    [ "$target_controller" = "$pid" ] && return 0
    self_controller=$(benchmark_controller_for_pid "$SELF" 2>/dev/null || true)
    [ -z "$self_controller" ] || [ "$target_controller" != "$self_controller" ]
}

is_protected_process() {
    is_self_or_parent "$1" || is_self_ancestor "$1" || is_protected_benchmark_tree "$1"
}

safe_to_signal() {
    local pid=$1
    local expected_fingerprint=$2
    local current_fingerprint

    current_fingerprint=$(process_fingerprint "$pid") || return 1
    if [[ "$current_fingerprint" != "$expected_fingerprint" ]]; then
        echo "🛡️  Refusing to signal changed/reused PID $pid" >&2
        return 1
    fi
    if is_protected_benchmark_tree "$pid"; then
        echo "🛡️  Refusing to signal benchmark controller tree PID $pid: $(cmd_of "$pid" | cut -c1-90)" >&2
        return 1
    fi
    return 0
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

manifest_has_protected_benchmark_tree() {
    local pid
    while read -r pid; do
        [ -n "$pid" ] || continue
        kill -0 "$pid" 2>/dev/null || continue
        is_protected_benchmark_tree "$pid" && return 0
    done < <(manifest_pids)
    return 1
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
TARGETS_FILE=$(mktemp)
SURVIVORS_FILE=$(mktemp)
trap 'rm -f "$ROOTS_FILE" "$ALL_FILE" "$TARGETS_FILE" "$SURVIVORS_FILE"' EXIT

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

PIDS=$(sort -un "$ALL_FILE" | grep -v "^$SELF$" | grep -v "^$SELF_PPID$" || true)

# Final backstop: drop any benchmark controller that entered the set as a
# DESCENDANT (pid_tree walks down and does not consult is_protected_process, so
# the ancestor guard alone cannot catch this direction). Rule 27 is absolute —
# a benchmark controller must never be signalled by this script.
if [[ -n "$PIDS" ]]; then
    KEPT=""
    while read -r pid; do
        [[ -z "$pid" ]] && continue
        if is_protected_benchmark_tree "$pid"; then
            echo "🛡️  Refusing to kill benchmark controller tree PID $pid: $(cmd_of "$pid" | cut -c1-90)" >&2
            continue
        fi
        KEPT+="$pid"$'\n'
    done <<< "$PIDS"
    PIDS=$(printf '%s' "$KEPT" | grep -v '^$' || true)
fi

# Snapshot every target's start time + command after discovery. Every signal
# revalidates this fingerprint and the controller boundary, closing the gap
# between the earlier filters and the later TERM/KILL passes.
: > "$TARGETS_FILE"
if [[ -n "$PIDS" ]]; then
    while read -r pid; do
        [[ -z "$pid" ]] && continue
        if is_protected_benchmark_tree "$pid"; then
            echo "🛡️  Refusing to target benchmark controller tree PID $pid: $(cmd_of "$pid" | cut -c1-90)" >&2
            continue
        fi
        fingerprint=$(process_fingerprint "$pid") || continue
        printf '%s\t%s\n' "$pid" "$fingerprint" >> "$TARGETS_FILE"
    done <<< "$PIDS"
fi

if [[ ! -s "$TARGETS_FILE" ]]; then
    if [[ $DRY -eq 0 ]]; then
        if manifest_has_protected_benchmark_tree; then
            echo "🛡️  Preserving running manifest for protected benchmark controller tree" >&2
        else
            mark_manifest_stopped
        fi
    fi
    echo "No services to kill in $WORKTREE_DIR"
    exit 0
fi

count=$(wc -l < "$TARGETS_FILE" | tr -d ' ')
echo "🧹 Targets in $WORKTREE_DIR ($count pid(s)):"
while IFS=$'\t' read -r pid _fingerprint; do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -1 | cut -c-100)
    if [[ -n "$cmd" ]]; then echo "   $pid  $cmd"; fi
done < "$TARGETS_FILE"

if [[ $DRY -eq 1 ]]; then
    echo "(dry-run — no processes killed)"
    exit 0
fi

# Deterministic blackbox hook: lets the regression turn a discovered service
# into a protected controller after snapshotting but before the signal pass.
if [[ -n "${KILL_SERVICES_TEST_BEFORE_SIGNAL_MARKER:-}" ]]; then
    : > "$KILL_SERVICES_TEST_BEFORE_SIGNAL_MARKER"
fi
if [[ -n "${KILL_SERVICES_TEST_BEFORE_SIGNAL_DELAY_SECONDS:-}" ]]; then
    sleep "$KILL_SERVICES_TEST_BEFORE_SIGNAL_DELAY_SECONDS"
fi

# SIGTERM pass
while IFS=$'\t' read -r pid fingerprint; do
    safe_to_signal "$pid" "$fingerprint" && kill -TERM "$pid" 2>/dev/null || true
done < "$TARGETS_FILE"
sleep 2

# SIGKILL any survivors
: > "$SURVIVORS_FILE"
while IFS=$'\t' read -r pid fingerprint; do
    if kill -0 "$pid" 2>/dev/null && safe_to_signal "$pid" "$fingerprint"; then
        printf '%s\t%s\n' "$pid" "$fingerprint" >> "$SURVIVORS_FILE"
    fi
done < "$TARGETS_FILE"
if [[ -s "$SURVIVORS_FILE" ]]; then
    survivor_pids=$(cut -f1 "$SURVIVORS_FILE" | tr '\n' ' ')
    echo "   SIGTERM survivors → SIGKILL: $survivor_pids"
    while IFS=$'\t' read -r pid fingerprint; do
        safe_to_signal "$pid" "$fingerprint" && kill -9 "$pid" 2>/dev/null || true
    done < "$SURVIVORS_FILE"
    sleep 1
fi

# Final verify
STILL=""
while IFS=$'\t' read -r pid fingerprint; do
    if kill -0 "$pid" 2>/dev/null && safe_to_signal "$pid" "$fingerprint"; then
        STILL="$STILL $pid"
    fi
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
