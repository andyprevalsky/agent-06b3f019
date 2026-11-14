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
# run_path_in_worktree / run_cmd_mentions_worktree: nested-worktree-aware scope.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/run-process-cleanup.sh"
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

# Sentinel written in place of a real identity when discovery observed a PID
# mutate mid-walk. It can never equal an identity the helper emits, so
# `reduce_stable_identities` always drops the PID it is attached to.
IDENTITY_CONFLICT='conflict:identity-changed-during-discovery'
IDENTITY_SEP=$'\t'

# Append one `pid<TAB>identity` observation. When `expected_start` is supplied,
# the identity read here must still equal it — a PID recycled between the
# caller's validation and this write is discarded rather than recorded under a
# stranger's identity.
record_pid() {
    local file=$1 pid=$2 expected_start=${3:-} start_time
    start_time=$(process_start_time "$pid") || start_time=""
    [[ -n "$start_time" ]] || return 1
    if [[ -n "$expected_start" && "$start_time" != "$expected_start" ]]; then
        return 1
    fi
    printf '%s\t%s\n' "$pid" "$start_time" >> "$file"
}

identity_matches() {
    local pid=$1 expected_start=$2 current_start
    current_start=$(process_start_time "$pid") || current_start=""
    [[ -n "$expected_start" && "$current_start" == "$expected_start" ]]
}

# Validate the identity and deliver the signal inside ONE helper process, so the
# identity read and the kill(2) are adjacent syscalls instead of separate shell
# steps with a command substitution, a fork/exec teardown, and a builtin
# dispatch in between.
#
# RESIDUAL RACE — NOT closed, and not closable here. POSIX kill(2) addresses a
# PID, never a process instance. Linux pidfd_send_signal(2) and Darwin's
# dispatch process sources would make check-and-signal atomic, but bash exposes
# neither and `kill` is a builtin over the raw PID. The target can therefore
# still exit and have its PID reused between the helper's identity read and its
# kill(2). What this buys is width, not atomicity: a microsecond window inside a
# single process rather than a multi-millisecond window across a shell round
# trip. Skipping the signal instead is not an option — that would leave every
# service running and break teardown outright — so we minimize the window and
# fail closed on every mismatch we can actually observe.
signal_if_same_identity() {
    local pid=$1 expected_start=$2 signal=$3 status=0
    if [[ -z "$expected_start" ]]; then
        echo "🛡️  Refusing SIG${signal} for PID $pid with no captured identity" >&2
        return 1
    fi
    python3 "$PROCESS_IDENTITY_HELPER" \
        --expect "$expected_start" --signal "$signal" "$pid" 2>/dev/null || status=$?
    case $status in
        0) return 0 ;;
        # 4 = identity matched but kill(2) failed (already reaped / EPERM).
        # Nothing was signaled and nothing else can be done about it here.
        4) return 1 ;;
        *)
            echo "🛡️  Refusing SIG${signal} for gone or recycled PID $pid" >&2
            return 1
            ;;
    esac
}

# Record this pid + all descendants with the identity validated at discovery
# time. `expected_start` is threaded in by the caller so the identity that was
# vetted is the identity that gets persisted: without it, a root that exits
# after validation and whose PID is reused would be recorded under the
# replacement's identity, and the later signal check would happily validate —
# and kill — that stranger.
pid_tree() {
    local root=$1 expected_start=${2:-} start_time children child

    if [[ -n "$expected_start" ]]; then
        start_time=$expected_start
    else
        start_time=$(process_start_time "$root") || start_time=""
        [[ -n "$start_time" ]] || return
    fi
    identity_matches "$root" "$start_time" || return

    children=$(pgrep -P "$root" 2>/dev/null) || children=""

    # Re-validate AFTER enumerating children. If the root exited and its PID was
    # reused during the pgrep, `children` describes a stranger's subtree. Poison
    # the root record so the identity-aware reducer drops it, and abandon the
    # subtree rather than adopting processes we never vetted.
    if ! identity_matches "$root" "$start_time"; then
        printf '%s%s%s\n' "$root" "$IDENTITY_SEP" "$IDENTITY_CONFLICT" >> "$ALL_FILE"
        return
    fi

    printf '%s%s%s\n' "$root" "$IDENTITY_SEP" "$start_time" >> "$ALL_FILE"

    for child in $children; do
        pid_tree "$child"
    done
}

# Read a parent PID only when the child's identity is unchanged both before and
# after the read, so a recycled child can never graft a stranger's ancestor
# chain into the kill set.
verified_ppid_of() {
    local pid=$1 expected_start=$2 ppid
    identity_matches "$pid" "$expected_start" || return 1
    ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ') || ppid=""
    [[ -n "$ppid" ]] || return 1
    identity_matches "$pid" "$expected_start" || return 1
    printf '%s\n' "$ppid"
}

# Collapse repeated observations of one PID into at most one record. Sorting is
# keyed on the pid AND the identity so distinct identities for a single pid both
# survive into the reducer — a `sort -n -u` on the pid alone would keep one
# arbitrary record and hide the conflict entirely. A pid is emitted only when
# every observation of it agrees; conflicting or poisoned observations drop it
# (fail closed), and self/parent are never emitted at all.
reduce_stable_identities() {
    sort -t "$IDENTITY_SEP" -k1,1n -k2,2 -u "$1" | awk -F '\t' \
        -v self="$SELF" -v parent="$SELF_PPID" -v conflict="$IDENTITY_CONFLICT" '
        $1 == self || $1 == parent { next }
        !($1 in first) { first[$1] = $2; order[++count] = $1 }
        $2 == conflict || first[$1] != $2 { unstable[$1] = 1 }
        END {
            for (i = 1; i <= count; i++) {
                pid = order[i]
                if (!(pid in unstable)) print pid "\t" first[pid]
            }
        }
    '
}

cwd_of() {
    local pid=$1
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

cmd_of() {
    ps -p "$1" -o command= 2>/dev/null | head -1
}

cwd_matches() {
    run_path_in_worktree "$(cwd_of "$1")" "$WORKTREE_DIR"
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
        # Stop only when the walk runs out of parents. PID 1 must still be
        # COMPARED against the candidate: on a Fly cloudbench guest the boot
        # command is PID 1, so it can genuinely be our ancestor, and bailing
        # early left it unprotected. Walking onto PID 1 terminates safely
        # because its own parent is 0. The kill-target walk below deliberately
        # keeps its `ppid == 1` stop, since climbing there could make PID 1 a
        # target rather than merely classify it.
        if [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "$current" ]; then
            return 1
        fi
        [ "$ppid" = "$candidate" ] && return 0
        current="$ppid"
    done
}

# Benchmark controllers are NEVER ours to kill (never kill another session's benchmark processes). They own Fly
# machines, volumes, and isolated stacks, and they reap those resources through
# their own signal traps — killing one from outside leaks paid infrastructure and
# can terminate healthy fleets belonging to other worktrees or sessions.
#
# `run-predeploy-local` starts an ISOLATED `scripts/run.sh` stack as a child. That
# child matches the `scripts/run\.sh` root pattern below, and
# `add_pid_with_tree_and_ancestors` then walks upward through same-worktree
# ancestors. Protect the whole controller tree — not just the controller PID —
# so a shared Step 5 stack dying under OOM/exit cannot SIGTERM an in-flight
# isolated smoke run (observed as smoke exit 143 after backend exit 137).
is_benchmark_controller() {
    local cmd
    cmd=$(cmd_of "$1")
    echo "$cmd" | grep -Eq '(^|[[:space:]/])run-predeploy-(local|cloud)([[:space:]]|$)|(^|[[:space:]/])run-bench(-fleet|-cloud|-hub-poller)?([[:space:]]|$)|(^|[[:space:]])([^[:space:]]*/)?benchmarks/(local|run_benchmark|run_eval_suite)\.py([[:space:]]|$)|(^|[[:space:]])([^[:space:]]*/)?run_deploy_stage\.py([[:space:]]|$)'
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
        # Evaluate PID 1 before ending the walk: on Fly cloudbench the boot
        # command is PID 1 and can be a real controller ancestor. Stop only on
        # absent/zero/self parents (same contract as is_self_ancestor).
        [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "$current" ] && return 1
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

# Isolated benchmark stacks are reaped only through the exact identity in their
# `.context/benchmarks/<run>/local-stack-owner.json` (local.py stop_services).
# A stack retained after unverified cleanup is recovery authority that outlives
# its benchmark controller, so controller ancestry alone cannot protect it.
ISOLATED_STACK_OWNERS=""
load_isolated_stack_owners() {
    ISOLATED_STACK_OWNERS=$(python3 - "$WORKTREE_DIR/.context/benchmarks" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

for path in sorted(Path(sys.argv[1]).glob("*/local-stack-owner.json")):
    if path.is_symlink() or not path.is_file():
        continue
    try:
        owner = json.loads(path.read_text())
    except (OSError, ValueError):
        continue
    if not isinstance(owner, dict):
        continue
    pid, identity = owner.get("pid"), owner.get("native_identity")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        continue
    if not isinstance(identity, str) or not identity or any(c in identity for c in "\t\n"):
        continue
    print(f"{pid}\t{identity}")
PY
)
}

is_owned_isolated_stack() {
    local pid=$1 owner_pid owner_identity
    while IFS=$'\t' read -r owner_pid owner_identity; do
        [ "$owner_pid" = "$pid" ] && identity_matches "$pid" "$owner_identity" && return 0
    done <<< "$ISOLATED_STACK_OWNERS"
    return 1
}

is_protected_isolated_stack_tree() {
    local current=$1
    [ -n "$ISOLATED_STACK_OWNERS" ] || return 1
    while true; do
        is_owned_isolated_stack "$current" && return 0
        local ppid
        ppid=$(ps -p "$current" -o ppid= 2>/dev/null | tr -d ' ') || return 1
        [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "$current" ] && return 1
        current="$ppid"
    done
}

# Every process an isolated run launches carries its BENCHMARK_RUN_ID (local.py
# exports it to run.sh, whose services, tunnels and reparented children inherit
# it). The owner-record walk above protects only processes that still descend
# from the recorded run.sh; a service that lost that ancestry (a detached tunnel,
# a child whose wrapper exited) was reaped by the argv/cwd sweeps when the
# semantic lane's non-isolated run.sh started or stopped beside a live smoke run
# in the same worktree. A run is live while its owner record still names the
# recorded process instance, its manifest is starting/running with a live
# run.sh, or it has not published a manifest yet and is younger than the
# startup grace (same BENCHMARK_STARTUP_GRACE_SECONDS as run.sh, default 90).
# Finished, dead or unknown runs grant nothing: their leftovers stay reapable.
# Mirrors run.sh's pid_belongs_to_active_isolated_benchmark run-identity check.
LIVE_ISOLATED_RUNS=""
load_live_isolated_runs() {
    local status=0
    LIVE_ISOLATED_RUNS=$(python3 - "$WORKTREE_DIR/.context/benchmarks" "$PROCESS_IDENTITY_HELPER" \
        "${BENCHMARK_STARTUP_GRACE_SECONDS:-90}" <<'PYRUNS'
import json
import re
import subprocess
import sys
import time
from pathlib import Path

root, helper, grace = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
grace_seconds = int(grace) if re.fullmatch(r"0|[1-9][0-9]{0,4}", grace) else 90


def read_json(path):
    if path.is_symlink() or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def valid_pid(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def identity_of(pid):
    result = subprocess.run([sys.executable, helper, str(pid)], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def command_of(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, check=False)
    return result.stdout.strip()


for run_dir in sorted(path for path in root.glob("*") if path.is_dir() and not path.is_symlink()):
    run_id = run_dir.name
    if not re.fullmatch(r"[A-Za-z0-9._-]+", run_id) or run_id in {".", ".."}:
        continue
    owner = read_json(run_dir / "local-stack-owner.json")
    if owner and valid_pid(owner.get("pid")) and isinstance(owner.get("native_identity"), str) \
            and owner["native_identity"] and identity_of(owner["pid"]) == owner["native_identity"]:
        print(run_id)
        continue
    manifest_path = run_dir / "services.json"
    if manifest_path.exists() or manifest_path.is_symlink():
        manifest = read_json(manifest_path)
        if manifest and str(manifest.get("status", "")).strip().lower() in {"starting", "running"} \
                and valid_pid(manifest.get("run_sh_pid")) and "run.sh" in command_of(manifest["run_sh_pid"]):
            print(run_id)
        continue
    try:
        age = time.time() - run_dir.stat().st_mtime
    except OSError:
        continue
    if age < grace_seconds:
        print(run_id)
PYRUNS
) || status=$?
    [ "$status" -eq 0 ] && return 0
    # Fail closed, never open: an empty list would silently restore the kill of
    # every reparented child of a live isolated run. With an owner record on
    # disk a live stack may exist, so the sweep is refused (run.sh startup
    # propagates the failure); without one there is nothing to protect.
    LIVE_ISOLATED_RUNS=""
    if compgen -G "$WORKTREE_DIR/.context/benchmarks/*/local-stack-owner.json" > /dev/null; then
        echo "⚠️  Could not determine the live isolated benchmark runs (loader exit $status) while isolated stack owner records exist under $WORKTREE_DIR/.context/benchmarks; refusing to sweep" >&2
        return 1
    fi
    echo "⚠️  Could not determine the live isolated benchmark runs (loader exit $status); no isolated stack owner record exists, sweeping without run-identity protection" >&2
    return 0
}

# run_process_env_value reads /proc/<pid>/environ and falls back to `ps eww`,
# which can surface a stale or duplicate token: that fallback can only
# over-protect (keep a process alive), never reap one that the run owns.
is_live_isolated_run_process() {
    local pid=$1 run_id live
    [ -n "$LIVE_ISOLATED_RUNS" ] || return 1
    run_id=$(run_process_env_value "$pid" BENCHMARK_RUN_ID)
    [ -n "$run_id" ] || return 1
    while IFS= read -r live; do
        [ "$live" = "$run_id" ] && return 0
    done <<< "$LIVE_ISOLATED_RUNS"
    return 1
}

# The tmux server is a same-cwd ancestor of every pane started in this
# worktree. Walking ancestors from Step 5 services and signalling it
# destroys every session — including an isolated smoke supervisor that
# kill-services is explicitly forbidden to touch (never kill another session's benchmark processes). Protect the
# server and its clients; the services they wrap are still discovered
# as descendants of run.sh.
is_tmux_process() {
    local cmd
    cmd=$(cmd_of "$1")
    echo "$cmd" | grep -Eq '(^|[[:space:]/])tmux([:[:space:]]|$)'
}

# A wrapper shell exists only to run the process below it. An ancestor that is
# not a shell, or that has other children, is not part of the stack: an agent
# CLI or tool shell whose cwd is the worktree must never be climbed into.
is_sole_wrapper_shell_of() {
    local parent=$1 child=$2 children
    case "$(ps -p "$parent" -o comm= 2>/dev/null | tr -d ' ')" in
        bash|sh|dash|zsh) ;;
        *) return 1 ;;
    esac
    children=$(pgrep -P "$parent" 2>/dev/null) || return 1
    [ "$children" = "$child" ]
}

# Signal-time recheck of a recorded wrapper: still a shell, and every current
# child is the one recorded at discovery (it may already have exited). A wrapper
# that started other work since then is no longer only part of the stack.
wrapper_relationship_holds() {
    local pid=$1 child=$2 children current
    case "$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')" in
        bash|sh|dash|zsh) ;;
        *) return 1 ;;
    esac
    children=$(pgrep -P "$pid" 2>/dev/null) || children=""
    for current in $children; do
        [ "$current" = "$child" ] || return 1
    done
}

recorded_wrapper_child() {
    [ -n "${WRAPPERS_FILE:-}" ] || return 1
    awk -F'\t' -v pid="$1" '$1 == pid { print $2; found = 1; exit } END { exit !found }' "$WRAPPERS_FILE"
}

is_protected_process() {
    is_self_or_parent "$1" || is_self_ancestor "$1" || is_protected_benchmark_tree "$1" \
        || is_protected_isolated_stack_tree "$1" || is_live_isolated_run_process "$1" || is_tmux_process "$1"
}

service_like_process() {
    local pid=$1
    local cwd cmd
    cwd=$(cwd_of "$pid")
    run_path_in_worktree "$cwd" "$WORKTREE_DIR" || return 1

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

    run_cmd_mentions_worktree "$cmd" "$WORKTREE_DIR"
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

    # The protection probes above each shell out to ps/lsof; re-confirm the
    # instance before its identity is threaded into the tree/ancestor walk.
    identity_matches "$pid" "$expected_start" || return

    pid_tree "$pid" "$expected_start"

    local current=$pid current_start=$expected_start
    while true; do
        local ppid ppid_start
        ppid=$(verified_ppid_of "$current" "$current_start") || return
        if [ "$ppid" = "0" ] || [ "$ppid" = "1" ]; then
            return
        fi
        # Capture the ancestor's identity BEFORE the vetting probes and require
        # it to still hold when the record is written, so an ancestor that exits
        # mid-vetting cannot hand its PID to an unrelated process we then kill.
        ppid_start=$(process_start_time "$ppid") || ppid_start=""
        [ -n "$ppid_start" ] || return
        is_protected_process "$ppid" && return
        cwd_matches "$ppid" || return
        is_sole_wrapper_shell_of "$ppid" "$current" || return
        record_pid "$ALL_FILE" "$ppid" "$ppid_start" || return
        [ -z "${WRAPPERS_FILE:-}" ] || printf '%s\t%s\n' "$ppid" "$current" >> "$WRAPPERS_FILE"
        current="$ppid"
        current_start="$ppid_start"
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
SCRATCH_FILE=$(mktemp)
SURVIVORS_FILE=$(mktemp)
WRAPPERS_FILE=$(mktemp)
SKIPPED_FILE=$(mktemp)
trap 'rm -f "$ROOTS_FILE" "$ALL_FILE" "$TARGETS_FILE" "$KEPT_FILE" "$SCRATCH_FILE" "$SURVIVORS_FILE" "$WRAPPERS_FILE" "$SKIPPED_FILE"' EXIT
load_isolated_stack_owners
load_live_isolated_runs || exit 1

# Manifest PIDs are authoritative when present. They catch wrappers whose argv
# is generic after cd'ing into a service directory. Capture identity at the
# same moment each numeric PID enters the root set.
while read -r pid; do
    [[ -n "$pid" ]] && record_pid "$ROOTS_FILE" "$pid" || true
done < <(manifest_pids)

# Patterns that identify service roots. The worktree-prefixed patterns catch
# grandchildren (node, python, vite) that carry the absolute path in argv. The
# run.sh pattern requires a shell executing the script: a process whose argv
# only mentions it (an agent's `pgrep -af` or `grep`) is not a stack.
for pattern in \
    "^([^ ]*/)?(ba|da|z)?sh( -[A-Za-z]+)* ([^ ]*/)?scripts/run\.sh( |$)" \
    "$WORKTREE_DIR/back-end/src/server\.ts" \
    "$WORKTREE_DIR/back-end.*tsx.*server\.ts" \
    "$WORKTREE_DIR/agents/scripts/run_local_worker" \
    "$WORKTREE_DIR/agents.*worker\.py" \
    "$WORKTREE_DIR/agents.*wmh serve" \
    "$WORKTREE_DIR/front-end.*vite" \
    "$WORKTREE_DIR/mac-app/node_modules"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        # Capture identity before the vetting probes (each of which is a
        # subprocess) and require it to still hold at record time.
        root_start=$(process_start_time "$pid") || root_start=""
        [[ -n "$root_start" ]] || continue
        is_protected_process "$pid" && continue
        cwd_matches "$pid" || run_cmd_mentions_worktree "$(cmd_of "$pid")" "$WORKTREE_DIR" || continue
        record_pid "$ROOTS_FILE" "$pid" "$root_start" || true
    done
done

for port in $(service_ports); do
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
        root_start=$(process_start_time "$pid") || root_start=""
        [[ -n "$root_start" ]] || continue
        is_protected_process "$pid" && continue
        cwd_matches "$pid" || continue
        record_pid "$ROOTS_FILE" "$pid" "$root_start" || true
    done
done

# Last-resort cwd sweep for service-shaped processes. This catches leaked
# children like `python worker.py` or `node ...` whose argv no longer includes
# the absolute worktree path and whose original run.sh parent is gone.
while read -r pid; do
    [ -n "$pid" ] || continue
    root_start=$(process_start_time "$pid") || root_start=""
    [ -n "$root_start" ] || continue
    is_protected_process "$pid" && continue
    service_like_process "$pid" || continue
    record_pid "$ROOTS_FILE" "$pid" "$root_start" || true
done < <(service_dir_cwd_pids | sort -un)

# Reduce roots BEFORE expansion. Discovery runs four independent sweeps, so one
# PID is routinely observed several times; if it was recycled between two of
# those sweeps we hold two different identities for it and cannot tell which is
# the service. Emitting either would risk killing a stranger, so the reducer
# drops the PID. (The previous `sort -n -u` collapsed those observations on the
# numeric PID alone, which silently discarded the evidence of the conflict.)
reduce_stable_identities "$ROOTS_FILE" > "$SCRATCH_FILE"
mv "$SCRATCH_FILE" "$ROOTS_FILE"
SCRATCH_FILE=$(mktemp)

while IFS=$'\t' read -r pid start_time; do
    [[ -z "$pid" ]] && continue
    add_pid_with_tree_and_ancestors "$pid" "$start_time"
done < "$ROOTS_FILE"

# Same fail-closed reduction over the expanded tree: keep one identity only when
# every observation of a PID agrees, and never keep a PID poisoned by
# `IDENTITY_CONFLICT` during the walk.
reduce_stable_identities "$ALL_FILE" > "$TARGETS_FILE"

# Final backstop: drop any PID in a foreign benchmark-controller tree, an
# owner-recorded isolated stack or a live isolated run that entered the set as
# a descendant. `pid_tree` walks downward and does not consult
# `is_protected_process`, so the ancestor guard alone cannot catch this path —
# and a shared-stack startup/EXIT sweep must not harvest isolated smoke.
while IFS=$'\t' read -r pid start_time; do
    [[ -n "$pid" ]] || continue
    identity_matches "$pid" "$start_time" || continue
    if is_protected_benchmark_tree "$pid"; then
        echo "🛡️  Refusing to kill benchmark controller tree PID $pid: $(cmd_of "$pid" | cut -c1-90)" >&2
        continue
    fi
    if is_protected_isolated_stack_tree "$pid"; then
        echo "🛡️  Refusing to kill owner-recorded isolated stack PID $pid: $(cmd_of "$pid" | cut -c1-90)" >&2
        continue
    fi
    if is_live_isolated_run_process "$pid"; then
        echo "🛡️  Refusing to kill live isolated run process PID $pid: $(cmd_of "$pid" | cut -c1-90)" >&2
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

# Signal a recorded wrapper only while its relationship still holds; the
# relationship was observed at discovery, before any signal was sent.
signal_wrapper_if_unchanged() {
    local pid=$1 start_time=$2 sig=$3 child
    child=$(recorded_wrapper_child "$pid") || return 2
    if ! wrapper_relationship_holds "$pid" "$child"; then
        echo "🛡️  Refusing $sig for wrapper PID $pid: it started other work since discovery" >&2
        printf '%s\n' "$pid" >> "$SKIPPED_FILE"
        return 1
    fi
    signal_if_same_identity "$pid" "$start_time" "$sig"
}

was_skipped() {
    grep -qx "$1" "$SKIPPED_FILE"
}

# SIGTERM pass: wrappers first, while their recorded child is still running,
# so a restart loop cannot launch a fresh stack between the two signals.
while IFS=$'\t' read -r pid start_time; do
    recorded_wrapper_child "$pid" >/dev/null || continue
    signal_wrapper_if_unchanged "$pid" "$start_time" TERM || true
done < "$TARGETS_FILE"
while IFS=$'\t' read -r pid start_time; do
    recorded_wrapper_child "$pid" >/dev/null && continue
    signal_if_same_identity "$pid" "$start_time" TERM || true
done < "$TARGETS_FILE"
sleep 2

# SIGKILL any survivors
while IFS=$'\t' read -r pid start_time; do
    was_skipped "$pid" && continue
    if identity_matches "$pid" "$start_time" && kill -0 "$pid" 2>/dev/null; then
        printf '%s\t%s\n' "$pid" "$start_time" >> "$SURVIVORS_FILE"
    fi
done < "$TARGETS_FILE"
if [[ -s "$SURVIVORS_FILE" ]]; then
    echo "   SIGTERM survivors → SIGKILL: $(cut -f1 "$SURVIVORS_FILE" | tr '\n' ' ')"
    while IFS=$'\t' read -r pid start_time; do
        if recorded_wrapper_child "$pid" >/dev/null; then
            signal_wrapper_if_unchanged "$pid" "$start_time" KILL || true
        else
            signal_if_same_identity "$pid" "$start_time" KILL || true
        fi
    done < "$SURVIVORS_FILE"
    sleep 1
fi

# Final verify
STILL=""
while IFS=$'\t' read -r pid start_time; do
    was_skipped "$pid" && continue
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
