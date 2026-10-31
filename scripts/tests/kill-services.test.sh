#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
PIDS=()

# Fixtures spawn as `( cd ...; cmd ) &`, so $! is the SUBSHELL, not the command it
# forks. Signalling only the recorded PID orphaned every fixture to init. That is
# especially harmful here: this suite deliberately spawns fake `run-predeploy-local`
# benchmark controllers to prove they are PROTECTED from cleanup, so nothing else
# ever reaps them. Leaked copies then masquerade as real benchmark runs under
# `pgrep -f run-predeploy-local` — exactly the signal used to decide whether
# someone else's fleet is live (repo rule 27). Reap descendants before the PID.
kill_pid_tree() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill_pid_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

cleanup() {
    local status=$? pid diagnostics
    if [ "$status" -ne 0 ]; then
        diagnostics="${BLACKBOX_TEST_ARTIFACT_DIR:-$ROOT_DIR/.context/test-runs}/kill-services-$(date -u +%Y%m%dT%H%M%SZ)-$$"
        if mkdir -p -m 700 "$diagnostics"; then
            cp -R "$TMP_ROOT/." "$diagnostics/" || true
            if [ -n "${worker_port:-}" ]; then
                lsof -nP -i :"$worker_port" -FpcnT > "$diagnostics/port-sockets.txt" 2>&1 || true
            fi
            chmod -R go-rwx "$diagnostics" || true
            echo "Fixture failure evidence retained: $diagnostics" >&2
        fi
    fi
    for pid in "${PIDS[@]:-}"; do
        kill_pid_tree "$pid"
        wait "$pid" 2>/dev/null || true
    done
    rm -rf "$TMP_ROOT"
    return "$status"
}
trap cleanup EXIT

find_free_port() {
    local port
    for port in $(seq 62000 63000); do
        if ! lsof -ti :"$port" >/dev/null 2>&1; then
            printf "%s" "$port"
            return 0
        fi
    done
    echo "FAIL: could not find a free test port" >&2
    exit 1
}

wait_for_port() {
    local port="$1"
    local attempt
    for attempt in $(seq 1 30); do
        if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.1
    done
    echo "FAIL: listener did not start on port $port" >&2
    exit 1
}

assert_dead() {
    local pid="$1"
    local label="$2"
    local attempt
    for attempt in $(seq 1 30); do
        if ! kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.1
    done
    echo "FAIL: $label survived cleanup (PID $pid)" >&2
    exit 1
}

assert_alive() {
    local pid="$1"
    local label="$2"
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "FAIL: $label was killed unexpectedly (PID $pid)" >&2
        exit 1
    fi
}

# With `set -o pipefail`, a producer piped into `grep -q` can receive SIGPIPE
# after grep finds an early match. That turns a true assertion into exit 141.
if grep -nE '\|[[:space:]]*grep[[:space:]]+-q' "${BASH_SOURCE[0]}"; then
    echo "FAIL: early-exit grep assertions must read from files or here-strings" >&2
    exit 1
fi

# Unit-check controller token boundaries without running teardown. Exact
# controller basenames must be protected; prefixes, suffixes, backup files, and
# lookalike directories must not be.
(
    source "$ROOT_DIR/scripts/kill-services.sh"
    MATCH_CMD=""
    cmd_of() { printf '%s\n' "$MATCH_CMD"; }

    assert_controller_match() {
        local expected="$1" command="$2" actual=0
        MATCH_CMD="$command"
        is_benchmark_controller 999999 && actual=1
        if [ "$actual" -ne "$expected" ]; then
            echo "FAIL: controller match expected=$expected actual=$actual command=$command" >&2
            exit 1
        fi
    }

    assert_controller_match 1 'bash scripts/run-predeploy-local'
    assert_controller_match 1 'bash /tmp/work/scripts/run-predeploy-cloud --full'
    assert_controller_match 1 'bash scripts/run-bench-fleet --task smoke'
    assert_controller_match 1 'python benchmarks/local.py --port 3001'
    assert_controller_match 1 'python /tmp/work/agents/benchmarks/run_benchmark.py --task chat'
    assert_controller_match 1 'python benchmarks/run_eval_suite.py --port 3001'
    assert_controller_match 1 'python3 /workspace/scripts/run_deploy_stage.py smoke -- true'

    assert_controller_match 0 'bash scripts/run-predeploy-local-helper'
    assert_controller_match 0 'bash scripts/run-predeploy-cloud-old'
    assert_controller_match 0 'bash scripts/run-bench-fleet-helper'
    assert_controller_match 0 'python benchmarks/local.py.bak'
    assert_controller_match 0 'python benchmarks/run_benchmark.py.bak'
    assert_controller_match 0 'python otherbenchmarks/local.py'
    assert_controller_match 0 'bash notrun-predeploy-local'
    assert_controller_match 0 'python3 scripts/run_deploy_stage_helper.py'

    # The tmux server is a worktree-cwd ancestor of every pane. Walking
    # ancestors from Step 5 services and SIGTERM-ing it destroys every
    # session in the worktree, including an in-flight isolated smoke run
    # (observed as smoke supervisor death + a fake-pass EXIT trap).
    assert_tmux_match() {
        local expected="$1" command="$2" actual=0
        MATCH_CMD="$command"
        is_tmux_process 999999 && actual=1
        if [ "$actual" -ne "$expected" ]; then
            echo "FAIL: tmux match expected=$expected actual=$actual command=$command" >&2
            exit 1
        fi
    }
    assert_tmux_match 1 '/exec-daemon/tmux-root/bin/tmux -f /exec-daemon/tmux.portal.conf new-session -d -s backend-coverage'
    assert_tmux_match 1 'tmux -f /exec-daemon/tmux.portal.conf attach-session -t deploy-smoke'
    assert_tmux_match 1 'tmux new-session -d -s deploy-step5'
    assert_tmux_match 0 'python scripts/tmux-helper.py'
    assert_tmux_match 0 'bash scripts/run-tmuxinator'
    assert_tmux_match 0 'bash scripts/run.sh --benchmark'

    # Foreign controller trees (isolated smoke under run-predeploy-local) must
    # be protected from a shared-stack kill-services sweep.
    sleep 1000 &
    fake_controller_pid=$!
    MATCH_CMD='bash scripts/run-predeploy-local'
    cmd_of() {
        if [ "$1" = "$fake_controller_pid" ]; then
            printf '%s\n' "$MATCH_CMD"
        else
            ps -p "$1" -o command= 2>/dev/null | head -1
        fi
    }
    sleep 1000 &
    fake_child_pid=$!
    # Re-parent is not possible here; simulate ancestry by temporarily wrapping
    # benchmark_controller_for_pid via is_protected_benchmark_tree on the
    # controller PID itself (always protected) and asserting the helper returns
    # the controller for that PID.
    found_controller=$(benchmark_controller_for_pid "$fake_controller_pid")
    if [ "$found_controller" != "$fake_controller_pid" ]; then
        echo "FAIL: benchmark_controller_for_pid did not identify controller" >&2
        kill "$fake_controller_pid" "$fake_child_pid" 2>/dev/null || true
        exit 1
    fi
    if ! is_protected_benchmark_tree "$fake_controller_pid"; then
        echo "FAIL: controller PID must be a protected benchmark tree" >&2
        kill "$fake_controller_pid" "$fake_child_pid" 2>/dev/null || true
        exit 1
    fi
    kill "$fake_controller_pid" "$fake_child_pid" 2>/dev/null || true
    wait "$fake_controller_pid" "$fake_child_pid" 2>/dev/null || true
)

# A mismatched OS-native birth identity models PID reuse deterministically: the
# signal helper must preserve that process, while the captured identity may be killed.
(
    source "$ROOT_DIR/scripts/kill-services.sh"
    sleep 1000 &
    identity_probe_pid=$!
    trap 'kill "$identity_probe_pid" 2>/dev/null || true' EXIT
    identity_probe_start=$(process_start_time "$identity_probe_pid")
    [ -n "$identity_probe_start" ] || {
        echo "FAIL: could not capture identity probe start time" >&2
        exit 1
    }
    case "$(uname -s):$identity_probe_start" in
        Darwin:darwin:[0-9]*:[0-9]*) ;;
        Linux:linux:*:[0-9]*) ;;
        *)
            echo "FAIL: identity probe was not an OS-native high-precision identity: $identity_probe_start" >&2
            exit 1
            ;;
    esac
    identity_probe_again=$(process_start_time "$identity_probe_pid")
    [ "$identity_probe_again" = "$identity_probe_start" ] || {
        echo "FAIL: identity changed for a live process" >&2
        exit 1
    }

    signal_if_same_identity "$identity_probe_pid" 'definitely-not-the-start-time' TERM >/dev/null 2>&1 || true
    assert_alive "$identity_probe_pid" "recycled-PID identity probe"

    signal_if_same_identity "$identity_probe_pid" "$identity_probe_start" TERM
    wait "$identity_probe_pid" 2>/dev/null || true
    if kill -0 "$identity_probe_pid" 2>/dev/null; then
        echo "FAIL: matching PID identity was not signaled" >&2
        exit 1
    fi
    trap - EXIT
)

# ── Regression: an identity validated at discovery must be THREADED THROUGH the
#    PID-tree and ancestor expansion. Previously `pid_tree` re-read the identity
#    itself, so a root that exited after validation and whose PID was reused was
#    recorded under the replacement's identity — and the later signal check then
#    validated, and killed, that innocent replacement.
#
#    A supplied-but-stale identity models the recycled PID deterministically:
#    every stage must refuse it, and the live process must survive.
(
    source "$ROOT_DIR/scripts/kill-services.sh"
    ALL_FILE="$TMP_ROOT/recycled-observations"
    : > "$ALL_FILE"

    sleep 1000 &
    recycled_pid=$!
    trap 'kill "$recycled_pid" 2>/dev/null || true' EXIT
    live_identity="$(process_start_time "$recycled_pid")"
    [ -n "$live_identity" ] || {
        echo "FAIL: could not capture identity for the recycled-PID probe" >&2
        exit 1
    }
    stale_identity='darwin:1:000001'

    assert_no_observations() {
        if [ -s "$ALL_FILE" ]; then
            echo "FAIL: $1" >&2
            cat "$ALL_FILE" >&2
            exit 1
        fi
    }

    if record_pid "$ALL_FILE" "$recycled_pid" "$stale_identity"; then
        echo "FAIL: record_pid accepted a PID whose identity changed" >&2
        exit 1
    fi
    assert_no_observations "record_pid persisted a recycled PID's identity"

    # Both refuse by returning early with the failed check's status; the binding
    # assertion is that they wrote nothing.
    pid_tree "$recycled_pid" "$stale_identity" || true
    assert_no_observations "pid_tree recorded a PID whose identity changed"

    add_pid_with_tree_and_ancestors "$recycled_pid" "$stale_identity" || true
    assert_no_observations "ancestor walk recorded a PID whose identity changed"

    if signal_if_same_identity "$recycled_pid" "$stale_identity" TERM >/dev/null 2>&1; then
        echo "FAIL: signaled a PID whose identity changed since discovery" >&2
        exit 1
    fi
    assert_alive "$recycled_pid" "process holding a recycled PID"

    # Positive control: the validated identity IS the one persisted, so the tree
    # walk cannot silently substitute a freshly-read one.
    pid_tree "$recycled_pid" "$live_identity"
    if ! grep -Fqx "$recycled_pid$(printf '\t')$live_identity" "$ALL_FILE"; then
        echo "FAIL: pid_tree did not persist the caller-validated root identity" >&2
        cat "$ALL_FILE" >&2
        exit 1
    fi

    kill "$recycled_pid" 2>/dev/null || true
    trap - EXIT
)

# ── Regression: conflicting identity observations for ONE PID must drop that
#    PID (fail closed). The root set was previously deduped with `sort -n -u`,
#    which collapsed every record for a repeated PID on the numeric key alone —
#    so when discovery observed both the original and a recycled process on one
#    PID, the evidence of the conflict was destroyed before the reducer ran and
#    an arbitrary one of the two was killed.
(
    source "$ROOT_DIR/scripts/kill-services.sh"
    SELF=424242
    SELF_PPID=424243
    TAB="$(printf '\t')"
    observations="$TMP_ROOT/conflicting-observations"

    {
        # Repeated PID, two different identities => must be dropped. Recorded
        # out of numeric order to prove the sort cannot collapse them.
        printf '900%sdarwin:100:000001\n' "$TAB"
        printf '800%sdarwin:200:000002\n' "$TAB"
        printf '900%sdarwin:999:000009\n' "$TAB"
        # Repeated PID, identical identity => stable, emitted exactly once.
        printf '800%sdarwin:200:000002\n' "$TAB"
        # Poisoned by pid_tree when the root mutated mid-walk => must be dropped.
        printf '700%sdarwin:300:000003\n' "$TAB"
        printf '700%s%s\n' "$TAB" "$IDENTITY_CONFLICT"
        # Self and parent are never targets.
        printf '424242%sdarwin:400:000004\n' "$TAB"
        printf '424243%sdarwin:500:000005\n' "$TAB"
    } > "$observations"

    reduced="$(reduce_stable_identities "$observations")"

    if grep -q "^900${TAB}" <<<"$reduced"; then
        echo "FAIL: PID with conflicting identity observations was not dropped" >&2
        printf '%s\n' "$reduced" >&2
        exit 1
    fi
    if grep -q "^700${TAB}" <<<"$reduced"; then
        echo "FAIL: PID poisoned during tree expansion was not dropped" >&2
        printf '%s\n' "$reduced" >&2
        exit 1
    fi
    if grep -q "^42424[23]${TAB}" <<<"$reduced"; then
        echo "FAIL: reducer emitted self or parent as a target" >&2
        printf '%s\n' "$reduced" >&2
        exit 1
    fi
    if [ "$reduced" != "800${TAB}darwin:200:000002" ]; then
        echo "FAIL: reducer did not emit the one stable PID exactly once, got: $reduced" >&2
        exit 1
    fi
)

WORKTREE="$TMP_ROOT/worktree"
mkdir -p "$WORKTREE/scripts" "$WORKTREE/.context" "$WORKTREE/agents" "$WORKTREE/back-end" "$TMP_ROOT/foreign"
cp "$ROOT_DIR/scripts/kill-services.sh" "$WORKTREE/scripts/kill-services.sh"
cp "$ROOT_DIR/scripts/list-services.sh" "$WORKTREE/scripts/list-services.sh"
cp "$ROOT_DIR/scripts/process-identity.py" "$WORKTREE/scripts/process-identity.py"
mkdir -p "$WORKTREE/scripts/lib"
cp "$ROOT_DIR/scripts/lib/run-process-cleanup.sh" "$WORKTREE/scripts/lib/run-process-cleanup.sh"
printf 'import time\ntime.sleep(1000)\n' > "$WORKTREE/agents/worker.py"

worker_port="$(find_free_port)"

(
    cd "$WORKTREE/agents"
    python3 -m http.server "$worker_port" --bind 127.0.0.1 >/dev/null 2>&1
) &
worker_launcher_pid=$!
PIDS+=("$worker_launcher_pid")
wait_for_port "$worker_port"
worker_pid="$(lsof -tiTCP:"$worker_port" -sTCP:LISTEN | head -1)"
PIDS+=("$worker_pid")

(
    cd "$WORKTREE/agents"
    python3 worker.py >/dev/null 2>&1
) &
cwd_only_launcher_pid=$!
PIDS+=("$cwd_only_launcher_pid")
sleep 0.2
cwd_only_pid="$(pgrep -P "$cwd_only_launcher_pid" 2>/dev/null | head -1 || true)"
if [ -z "$cwd_only_pid" ]; then
    cwd_only_pid="$cwd_only_launcher_pid"
fi
PIDS+=("$cwd_only_pid")

foreign_port="$(find_free_port)"
(
    cd "$TMP_ROOT/foreign"
    python3 -m http.server "$foreign_port" --bind 127.0.0.1 >/dev/null 2>&1
) &
foreign_launcher_pid=$!
PIDS+=("$foreign_launcher_pid")
wait_for_port "$foreign_port"
foreign_pid="$(lsof -tiTCP:"$foreign_port" -sTCP:LISTEN | head -1)"
PIDS+=("$foreign_pid")

# A foreign client can retain a socket after our listener exits (CLOSE_WAIT).
# It must survive service cleanup and must not be mistaken for a live listener.
(
    cd "$TMP_ROOT/foreign"
    exec python3 - "$worker_port" "$TMP_ROOT/client-ready" <<'PY'
import socket
import sys
import time
from pathlib import Path

client = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
Path(sys.argv[2]).touch()
time.sleep(1000)
PY
) &
foreign_client_pid=$!
PIDS+=("$foreign_client_pid")
for attempt in $(seq 1 30); do
    [ -f "$TMP_ROOT/client-ready" ] && break
    sleep 0.1
done
[ -f "$TMP_ROOT/client-ready" ] || {
    echo "FAIL: foreign socket client did not connect" >&2
    exit 1
}

cat > "$WORKTREE/.context/services.json" <<JSON
{
  "status": "running",
  "run_sh_pid": 0,
  "ports": {
    "backend": $worker_port,
    "frontend": 0,
    "health": 0,
    "mac_app": 0,
    "sdk_metrics": 0,
    "local_db": $foreign_port
  },
  "services": []
}
JSON

list_output="$(cd "$WORKTREE" && bash scripts/list-services.sh)"
if ! grep -q "$worker_pid" <<<"$list_output"; then
    echo "FAIL: list-services did not show worktree listener PID $worker_pid" >&2
    echo "$list_output" >&2
    exit 1
fi
if ! grep -q "$cwd_only_pid" <<<"$list_output"; then
    echo "FAIL: list-services did not show cwd-only service PID $cwd_only_pid" >&2
    echo "$list_output" >&2
    exit 1
fi

(cd "$WORKTREE" && bash scripts/kill-services.sh)

assert_dead "$worker_pid" "worktree listener"
assert_dead "$cwd_only_pid" "cwd-only service process"
assert_alive "$foreign_pid" "foreign listener"
assert_alive "$foreign_client_pid" "foreign client retaining a closed connection"

if lsof -tiTCP:"$worker_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "FAIL: worktree service port $worker_port is still occupied" >&2
    exit 1
fi

status="$(python3 - "$WORKTREE/.context/services.json" <<'PY'
import json
import sys
with open(sys.argv[1]) as f:
    print(json.load(f).get("status"))
PY
)"
if [ "$status" != "stopped" ]; then
    echo "FAIL: expected services manifest status to be stopped, got $status" >&2
    exit 1
fi

# ── Rule 27: a benchmark controller must survive, and must not drag its
#    isolated stack's ancestors into the kill set ──────────────────────────────
#
# Regression: `run-predeploy-local` starts an ISOLATED `scripts/run.sh` as a
# child. That child matches the run.sh root pattern, and the ancestor walk in
# add_pid_with_tree_and_ancestors then climbed from it up to the controller and
# SIGTERM'd an in-flight smoke run (observed in /deploy: stage exit 143).
mkdir -p "$WORKTREE/scripts"
cat > "$WORKTREE/scripts/run-predeploy-local" <<'CONTROLLER'
#!/usr/bin/env bash
# Stand-in benchmark controller: starts an isolated run.sh child, then waits.
bash "$(dirname "$0")/run.sh" --benchmark &
sleep 1000
CONTROLLER
chmod +x "$WORKTREE/scripts/run-predeploy-local"
cat > "$WORKTREE/scripts/run.sh" <<'ISOLATED'
#!/usr/bin/env bash
sleep 1000
ISOLATED
chmod +x "$WORKTREE/scripts/run.sh"

(cd "$WORKTREE" && bash scripts/run-predeploy-local > /dev/null 2>&1) &
controller_pid=$!
PIDS+=("$controller_pid")
sleep 1

isolated_runsh_pid="$(pgrep -P "$controller_pid" -f 'run\.sh' 2>/dev/null | head -1 || true)"
[ -n "$isolated_runsh_pid" ] && PIDS+=("$isolated_runsh_pid")

(cd "$WORKTREE" && bash scripts/kill-services.sh > /dev/null 2>&1) || true

assert_alive "$controller_pid" "benchmark controller (run-predeploy-local)"
if [ -n "$isolated_runsh_pid" ]; then
    assert_alive "$isolated_runsh_pid" "benchmark controller's isolated run.sh child"
fi

# Reap the whole tree. Signalling only $controller_pid killed the subshell and
# orphaned the real `run-predeploy-local` (and its isolated run.sh) to init, where
# the EXIT trap could no longer reach them through pgrep -P.
kill_pid_tree "$controller_pid"
[ -n "$isolated_runsh_pid" ] && kill_pid_tree "$isolated_runsh_pid"

# ── An isolated stack retained after unverified cleanup outlives its controller ─
#
# Regression (2026-10-07): AgentCard payment cleanup timed out, so `local.py`
# recorded `failed_retained` and kept the isolated run.sh, services and database
# as exact-owner recovery authority, then exited. With no benchmark-controller
# ancestor left, stopping the shared deploy stack ran this sweep, which matched
# the orphaned run.sh and SIGTERMed it; its EXIT trap dropped the retained
# database. A live run.sh matching its `local-stack-owner.json` identity, and
# every descendant, is reaped only through that owner. A stale record grants nothing.
cat > "$WORKTREE/scripts/run.sh" <<'ISOLATED'
#!/usr/bin/env bash
( cd "$(dirname "$0")/../agents" && exec python3 worker.py ) &
wait
ISOLATED
chmod +x "$WORKTREE/scripts/run.sh"

start_owned_isolated_stack() {
    local run_id="$1" identity_override="${2:-}" stack_pid identity
    (cd "$WORKTREE" && exec bash scripts/run.sh --benchmark) > /dev/null 2>&1 &
    stack_pid=$!
    identity="$(python3 "$WORKTREE/scripts/process-identity.py" "$stack_pid")"
    [ -n "$identity" ] || {
        echo "FAIL: could not capture isolated stack identity" >&2
        exit 1
    }
    mkdir -p "$WORKTREE/.context/benchmarks/$run_id"
    python3 - "$WORKTREE/.context/benchmarks/$run_id/local-stack-owner.json" \
        "$run_id" "$stack_pid" "${identity_override:-$identity}" <<'PY'
import json
import sys

path, run_id, pid, identity = sys.argv[1:]
with open(path, "w") as handle:
    json.dump(
        {"version": 1, "run_id": run_id, "token": "fixture", "pid": int(pid),
         "native_identity": identity, "birth": "fixture"},
        handle,
    )
PY
    printf '%s' "$stack_pid"
}

wait_for_child() {
    local parent="$1" child attempt
    for attempt in $(seq 1 30); do
        child="$(pgrep -P "$parent" -f 'worker\.py' 2>/dev/null | head -1 || true)"
        if [ -n "$child" ]; then
            printf '%s' "$child"
            return 0
        fi
        sleep 0.1
    done
    echo "FAIL: isolated stack $parent did not start its worker" >&2
    exit 1
}

retained_stack_pid="$(start_owned_isolated_stack retained-fixture)"
PIDS+=("$retained_stack_pid")
retained_worker_pid="$(wait_for_child "$retained_stack_pid")"
PIDS+=("$retained_worker_pid")
stale_stack_pid="$(start_owned_isolated_stack stale-fixture 'linux:stale-boot:1')"
PIDS+=("$stale_stack_pid")
stale_worker_pid="$(wait_for_child "$stale_stack_pid")"
PIDS+=("$stale_worker_pid")

(cd "$WORKTREE" && bash scripts/kill-services.sh > "$TMP_ROOT/retained-sweep.log" 2>&1) || true

assert_alive "$retained_stack_pid" "retained isolated run.sh with a matching owner record"
assert_alive "$retained_worker_pid" "retained isolated stack's worker"
assert_dead "$stale_stack_pid" "run.sh whose owner record names a different process"
assert_dead "$stale_worker_pid" "worker under a stale isolated owner record"
echo "PASS: retained isolated stacks are reaped only through their owner record"

kill_pid_tree "$retained_stack_pid"

# ── The sweep never matches, or climbs into, a process that is not the stack ───
#
# Regression (2026-10-12): an agent tool shell whose argv only mentioned
# `scripts/run.sh` (inside a `pgrep -af` pattern) matched the run.sh root
# pattern, and the ancestor walk climbed from it into the agent CLI, whose cwd
# was the worktree. The sweep SIGTERMed the agent and ended its session. A root
# must be executing run.sh, and the upward walk enters only a wrapper shell
# whose sole child is the process below it.
rm -rf "$WORKTREE/.context/benchmarks"
cat > "$WORKTREE/scripts/run.sh" <<'FAKE'
#!/usr/bin/env bash
sleep 1000
FAKE
chmod +x "$WORKTREE/scripts/run.sh"

wait_for_stack_child() {
    local parent="$1" child attempt
    for attempt in $(seq 1 30); do
        child="$(pgrep -P "$parent" -f 'scripts/run\.sh' 2>/dev/null | head -1 || true)"
        if [ -n "$child" ]; then
            printf '%s' "$child"
            return 0
        fi
        sleep 0.1
    done
    echo "FAIL: $parent did not start its run.sh child" >&2
    exit 1
}

(cd "$WORKTREE" && exec python3 -c \
    'import subprocess, time; subprocess.Popen(["bash", "scripts/run.sh", "--benchmark"]).wait(); time.sleep(1000)') &
agent_pid=$!
(cd "$WORKTREE" && exec bash -c 'bash scripts/run.sh --benchmark & sleep 1000 & wait') &
busy_shell_pid=$!
(cd "$WORKTREE" && exec -a "pgrep -af scripts/run.sh --benchmark" sleep 1000) &
mention_pid=$!
(cd "$WORKTREE" && exec bash -c 'bash scripts/run.sh --benchmark; true') &
wrapper_pid=$!
PIDS+=("$agent_pid" "$busy_shell_pid" "$mention_pid" "$wrapper_pid")
agent_stack_pid="$(wait_for_stack_child "$agent_pid")"
busy_stack_pid="$(wait_for_stack_child "$busy_shell_pid")"
wrapper_stack_pid="$(wait_for_stack_child "$wrapper_pid")"
busy_sibling_pid="$(pgrep -P "$busy_shell_pid" -x sleep | head -1)"
PIDS+=("$agent_stack_pid" "$busy_stack_pid" "$wrapper_stack_pid" "$busy_sibling_pid")

(cd "$WORKTREE" && bash scripts/kill-services.sh > "$TMP_ROOT/caller-sweep.log" 2>&1) || true

assert_dead "$agent_stack_pid" "run.sh started by a non-shell process"
assert_alive "$agent_pid" "non-shell parent of a run.sh stack (an agent CLI)"
assert_dead "$busy_stack_pid" "run.sh started by a shell with other children"
assert_alive "$busy_shell_pid" "shell with a child beside the stack"
assert_alive "$busy_sibling_pid" "unrelated child of that shell"
assert_alive "$mention_pid" "process whose argv only mentions scripts/run.sh"
assert_dead "$wrapper_stack_pid" "run.sh under a pure wrapper shell"
assert_dead "$wrapper_pid" "pure wrapper shell of the stack"
echo "PASS: the sweep reaps only run.sh stacks and their pure wrapper shells"

# A recorded wrapper is rechecked at signal time: it may still be signaled while
# it wraps only its recorded child (or that child already exited), but not once
# it has started other work, and never when it is not a shell.
(
    source "$ROOT_DIR/scripts/kill-services.sh"
    wait_for_children() {
        local parent="$1" want="$2" attempt
        for attempt in $(seq 1 30); do
            [ "$(pgrep -P "$parent" | wc -l | tr -d ' ')" -ge "$want" ] && return 0
            sleep 0.1
        done
        echo "FAIL: $parent did not start $want child(ren)" >&2
        exit 1
    }
    bash -c 'sleep 1000 & wait' & sole_wrapper=$!
    bash -c 'sleep 1000 & sleep 1000 & wait' & busy_wrapper=$!
    python3 -c 'import subprocess, time; subprocess.Popen(["sleep", "1000"]).wait(); time.sleep(1000)' &
    non_shell=$!
    trap 'kill_pid_tree "$sole_wrapper"; kill_pid_tree "$busy_wrapper"; kill_pid_tree "$non_shell"' EXIT
    wait_for_children "$sole_wrapper" 1
    wait_for_children "$busy_wrapper" 2
    wait_for_children "$non_shell" 1
    sole_child="$(pgrep -P "$sole_wrapper" | head -1)"
    busy_child="$(pgrep -P "$busy_wrapper" | head -1)"
    non_shell_child="$(pgrep -P "$non_shell" | head -1)"

    wrapper_relationship_holds "$sole_wrapper" "$sole_child" || {
        echo "FAIL: a wrapper with only its recorded child must remain signalable" >&2
        exit 1
    }
    if wrapper_relationship_holds "$busy_wrapper" "$busy_child"; then
        echo "FAIL: a wrapper that started other work must not be signaled" >&2
        exit 1
    fi
    if wrapper_relationship_holds "$non_shell" "$non_shell_child"; then
        echo "FAIL: a non-shell process is never a wrapper" >&2
        exit 1
    fi
    (
        pgrep() { :; }
        wrapper_relationship_holds "$sole_wrapper" "$sole_child"
    ) || {
        echo "FAIL: a wrapper whose recorded child already exited must remain signalable" >&2
        exit 1
    }
)
echo "PASS: recorded wrappers are rechecked before they are signaled"

# The protection walk must not stop before classifying PID 1. On a Fly cloudbench
# guest the boot command IS PID 1, so it can genuinely be this script's ancestor;
# bailing at ppid == 1 left it unprotected (CLAUDE.md rule 27). is_self_ancestor
# must terminate only on an absent/zero/self parent. The kill-target walk in
# add_pid_with_tree_and_ancestors deliberately KEEPS its ppid == 1 stop, since
# climbing there could make PID 1 itself a target rather than merely classify it.
protection_walk_source=$(awk '/^is_self_ancestor\(\)/,/^\}/' "$ROOT_DIR/scripts/kill-services.sh")
if [[ -z "$protection_walk_source" ]]; then
    echo "FAIL: could not read is_self_ancestor" >&2
    exit 1
fi
if grep -q '"\$ppid" = "1"' <<<"$protection_walk_source"; then
    echo "FAIL: is_self_ancestor still stops on PID 1; a controller at PID 1 would be unprotected" >&2
    exit 1
fi
if ! grep -q '"\$ppid" = "\$current"' <<<"$protection_walk_source"; then
    echo "FAIL: is_self_ancestor must guard against a self-parent loop once PID 1 is reachable" >&2
    exit 1
fi
echo "PASS: is_self_ancestor classifies PID 1 instead of bailing before it"

# Same PID-1 contract for benchmark_controller_for_pid: a controller that is PID 1
# (or reached via parent=1) must still be classified before the walk ends.
controller_walk_source=$(awk '/^benchmark_controller_for_pid\(\)/,/^\}/' "$ROOT_DIR/scripts/kill-services.sh")
if [[ -z "$controller_walk_source" ]]; then
    echo "FAIL: could not read benchmark_controller_for_pid" >&2
    exit 1
fi
if grep -q '"\$ppid" = "1"' <<<"$controller_walk_source"; then
    echo "FAIL: benchmark_controller_for_pid still stops on PID 1 before classifying it" >&2
    exit 1
fi
if ! grep -q '"\$ppid" = "\$current"' <<<"$controller_walk_source"; then
    echo "FAIL: benchmark_controller_for_pid must stop on self-parent loops, not PID 1" >&2
    exit 1
fi
echo "PASS: benchmark_controller_for_pid classifies PID 1 instead of bailing before it"

# ── A nested Git worktree is a different stack, never part of this one ────────
#
# Regression (2026-10-26 09:50:58Z): agent worktrees live under the canonical
# checkout at `.claude/worktrees/<name>`. A sweep run from the canonical
# checkout treated every cwd under `$WORKTREE_DIR/*` as its own, so it SIGTERMed
# a gate worker's `run.sh --benchmark` running in `.claude/worktrees/gate-GH`.
# A process whose cwd (or argv path) crosses into a directory with its own
# `.git` belongs to that nested worktree, not to the sweeping one.
rm -rf "$WORKTREE/.context/benchmarks"
NESTED="$WORKTREE/.claude/worktrees/gate-nested"
mkdir -p "$NESTED/scripts" "$NESTED/agents"
printf 'gitdir: /nonexistent/.git/worktrees/gate-nested\n' > "$NESTED/.git"
cp "$WORKTREE/scripts/run.sh" "$NESTED/scripts/run.sh"
printf 'import time\ntime.sleep(1000)\n' > "$NESTED/agents/worker.py"
(cd "$NESTED" && exec bash scripts/run.sh --benchmark) > /dev/null 2>&1 &
nested_stack_pid=$!
(cd "$NESTED/agents" && exec python3 "$NESTED/agents/worker.py") > /dev/null 2>&1 &
nested_worker_pid=$!
(cd "$WORKTREE" && exec bash scripts/run.sh --benchmark) > /dev/null 2>&1 &
own_stack_pid=$!
# A `..` token that textually starts with this worktree but resolves outside
# it (CodeRabbit, PR #1592): the argv pattern `$WORKTREE/agents.*worker.py`
# matches it, so only the lexically normalized path predicate keeps it alive.
ESCAPE="$TMP_ROOT/escape"
mkdir -p "$ESCAPE/agents"
printf 'import time\ntime.sleep(1000)\n' > "$ESCAPE/agents/worker.py"
(cd "$ESCAPE/agents" && exec python3 "$WORKTREE/agents/../../escape/agents/worker.py") > /dev/null 2>&1 &
escape_worker_pid=$!
PIDS+=("$nested_stack_pid" "$nested_worker_pid" "$own_stack_pid" "$escape_worker_pid")
sleep 0.5

(cd "$WORKTREE" && bash scripts/kill-services.sh > "$TMP_ROOT/nested-sweep.log" 2>&1) || true

assert_alive "$nested_stack_pid" "run.sh in a nested Git worktree"
assert_alive "$nested_worker_pid" "worker.py in a nested Git worktree"
assert_alive "$escape_worker_pid" "worker.py named through a \$WORKTREE/.. escape"
assert_dead "$own_stack_pid" "this worktree's own run.sh"

# The path predicate itself: the root and its plain subdirectories are owned;
# a nested worktree root and anything inside it are not; siblings that merely
# share a prefix are not.
(
    source "$WORKTREE/scripts/kill-services.sh"
    for owned in "$WORKTREE" "$WORKTREE/agents" "$WORKTREE/.claude/worktrees" "$WORKTREE/agents/worker.py" \
        "$WORKTREE/agents/../back-end" "$WORKTREE//agents/./worker.py" "$WORKTREE/agents/.." "$WORKTREE/"; do
        run_path_in_worktree "$owned" "$WORKTREE" || { echo "FAIL: $owned should be in $WORKTREE" >&2; exit 1; }
    done
    run_path_in_worktree "$WORKTREE/agents" "$WORKTREE/./" \
        || { echo "FAIL: a non-normalized root must still own its subdirectories" >&2; exit 1; }
    # `..` segments are resolved lexically before the prefix and nested-.git
    # checks: escapes to a sibling, the parent, or into a nested worktree miss.
    for foreign in "$NESTED" "$NESTED/agents" "$NESTED/agents/worker.py" "${WORKTREE}-sibling/agents" "$TMP_ROOT/foreign" \
        "$WORKTREE/.." "$WORKTREE/../foreign" "$WORKTREE/agents/../../escape/agents/worker.py" \
        "$WORKTREE/./../worktree-sibling" "$WORKTREE/agents/../.claude/worktrees/gate-nested/agents" \
        "$WORKTREE/agents"$'\n'"$TMP_ROOT/foreign"; do
        if run_path_in_worktree "$foreign" "$WORKTREE"; then
            echo "FAIL: $foreign must not be in $WORKTREE" >&2
            exit 1
        fi
    done
    run_cmd_mentions_worktree "python3 $WORKTREE/agents/worker.py" "$WORKTREE" \
        || { echo "FAIL: own argv path not recognized" >&2; exit 1; }
    if run_cmd_mentions_worktree "python3 $NESTED/agents/worker.py --x=$NESTED" "$WORKTREE"; then
        echo "FAIL: nested worktree argv path treated as own" >&2
        exit 1
    fi
    if run_cmd_mentions_worktree "python3 $WORKTREE/agents/../../escape/agents/worker.py --x=$WORKTREE/../foreign" "$WORKTREE"; then
        echo "FAIL: a \$WORKTREE/.. argv escape treated as own" >&2
        exit 1
    fi
)
echo "PASS: the sweep never crosses into a nested Git worktree or out through .."

# ── The semantic lane's sweep beside a LIVE isolated smoke stack ──────────────
#
# Follow-up "an" (2026-10-31): /deploy serialized `semantic-stack` after the
# stack-owning lanes (`smoke`, `agentcard-lifecycle`) because this sweep, run by
# the semantic lane's non-isolated `run.sh --benchmark` at startup and at EXIT,
# was believed to kill the smoke lane's isolated stack in the same worktree.
# That stack is a distinct run (`.context/benchmarks/<run>/`: an owner record and
# a manifest with its own ports and workspace), and every process it launches
# carries BENCHMARK_RUN_ID. Its run.sh and the descendants of that process were
# already protected through the owner record; a service that lost that ancestry
# (reparented to init: a detached tunnel, a child whose wrapper exited) was not,
# and the argv/cwd sweeps reaped it. Every process of a live isolated run must
# survive the sweep, while this workspace's own stale stack and the leftovers of
# finished or unknown runs are still reaped.
rm -rf "$WORKTREE/.context/benchmarks" "$WORKTREE/.claude"
# STALE_CHILD_RUN_ID: a second child carrying another run's BENCHMARK_RUN_ID,
# so a stale stack's downward walk contains an env-protected descendant.
cat > "$WORKTREE/scripts/run.sh" <<'ISOLATED'
#!/usr/bin/env bash
( cd "$(dirname "$0")/../agents" && exec python3 worker.py ) &
if [ -n "${STALE_CHILD_RUN_ID:-}" ]; then
    ( cd "$(dirname "$0")/../agents" && BENCHMARK_RUN_ID="$STALE_CHILD_RUN_ID" exec python3 worker.py "$STALE_CHILD_MARKER" ) &
fi
wait
ISOLATED
chmod +x "$WORKTREE/scripts/run.sh"
dead_pid=999999
while kill -0 "$dead_pid" 2>/dev/null; do dead_pid=$((dead_pid - 1)); done

start_isolated_run() {  # <run-id> <backend-port>: a live isolated stack with owner record + manifest
    local run_id="$1" port="$2" stack_pid identity run_dir
    (cd "$WORKTREE" && BENCHMARK_RUN_ID="$run_id" BENCHMARK_ISOLATED_RUN=true \
        CONDUCTOR_WORKSPACE_NAME="worktree-bench-$run_id" CONDUCTOR_PORT="$port" \
        exec bash scripts/run.sh --benchmark) > /dev/null 2>&1 &
    stack_pid=$!
    identity="$(python3 "$WORKTREE/scripts/process-identity.py" "$stack_pid")"
    [ -n "$identity" ] || {
        echo "FAIL: could not capture isolated stack identity for $run_id" >&2
        exit 1
    }
    run_dir="$WORKTREE/.context/benchmarks/$run_id"
    mkdir -p "$run_dir"
    python3 - "$run_dir" "$run_id" "$stack_pid" "$identity" "$port" <<'PY'
import json
import sys

run_dir, run_id, pid, identity, port = sys.argv[1:]
with open(f"{run_dir}/local-stack-owner.json", "w") as handle:
    json.dump({"version": 1, "run_id": run_id, "token": "fixture", "pid": int(pid),
               "native_identity": identity, "birth": "fixture"}, handle)
with open(f"{run_dir}/services.json", "w") as handle:
    json.dump({"status": "running", "run_sh_pid": int(pid), "services": [],
               "workspace": f"worktree-bench-{run_id}",
               "ports": {"backend": int(port), "frontend": int(port) + 1}}, handle)
PY
    printf '%s' "$stack_pid"
}

# A worker of <run-id> that no longer descends from its stack: the outer
# subshell exits at once, so the worker is reparented away from this test. Both
# levels redirect, or the inner shell would hold this $(...) pipe open.
detached_run_worker() {  # <run-id> <marker>
    local pid attempt
    ( ( cd "$WORKTREE/agents" && BENCHMARK_RUN_ID="$1" exec python3 worker.py "$2" ) > /dev/null 2>&1 & )
    for attempt in $(seq 1 30); do
        pid="$(pgrep -f "worker\.py $2\$" 2>/dev/null | head -1 || true)"
        if [ -n "$pid" ]; then
            printf '%s' "$pid"
            return 0
        fi
        sleep 0.1
    done
    echo "FAIL: detached worker for $1 did not start" >&2
    exit 1
}

marker="semantic-sweep-$$"
live_stack_pid="$(start_isolated_run smoke-live 20110)"
PIDS+=("$live_stack_pid")
live_worker_pid="$(wait_for_child "$live_stack_pid")"
PIDS+=("$live_worker_pid")
live_detached_pid="$(detached_run_worker smoke-live "$marker-live")"
PIDS+=("$live_detached_pid")
# A run that is still bootstrapping: directory created, nothing published yet.
mkdir -p "$WORKTREE/.context/benchmarks/smoke-boot"
boot_detached_pid="$(detached_run_worker smoke-boot "$marker-boot")"
PIDS+=("$boot_detached_pid")
# Leftovers that grant nothing: a finished run (manifest stopped, owner gone)
# and a run id with no run directory at all.
mkdir -p "$WORKTREE/.context/benchmarks/smoke-done"
printf '{"version": 1, "run_id": "smoke-done", "token": "fixture", "pid": 999997, "native_identity": "linux:gone:1", "birth": "fixture"}\n' \
    > "$WORKTREE/.context/benchmarks/smoke-done/local-stack-owner.json"
printf '{"status": "stopped", "run_sh_pid": 999997, "services": [], "ports": {"backend": 20120}}\n' \
    > "$WORKTREE/.context/benchmarks/smoke-done/services.json"
done_detached_pid="$(detached_run_worker smoke-done "$marker-done")"
PIDS+=("$done_detached_pid")
ghost_detached_pid="$(detached_run_worker smoke-ghost "$marker-ghost")"
PIDS+=("$ghost_detached_pid")
# A manifest still `running` whose run.sh is gone and that has no owner record:
# nothing owns it any more, so its leftovers are reapable (same predicate as
# run.sh's startup sweep).
mkdir -p "$WORKTREE/.context/benchmarks/smoke-orphan"
printf '{"status": "running", "run_sh_pid": %s, "services": [], "ports": {"backend": 20130}}\n' "$dead_pid" \
    > "$WORKTREE/.context/benchmarks/smoke-orphan/services.json"
orphan_detached_pid="$(detached_run_worker smoke-orphan "$marker-orphan")"
PIDS+=("$orphan_detached_pid")
# This workspace's own stale stack (the semantic lane's previous run.sh): no run
# id, listed in the worktree manifest on its own ports. One of its children
# carries the live run's id, so it enters the kill set through the downward
# walk and only the final backstop can spare it.
(cd "$WORKTREE" && STALE_CHILD_RUN_ID=smoke-live STALE_CHILD_MARKER="$marker-stale-child" \
    exec bash scripts/run.sh --benchmark) > /dev/null 2>&1 &
own_stale_stack_pid=$!
PIDS+=("$own_stale_stack_pid")
own_stale_worker_pid=""
for attempt in $(seq 1 30); do
    own_stale_worker_pid="$(pgrep -P "$own_stale_stack_pid" -f 'worker\.py$' 2>/dev/null | head -1 || true)"
    [ -n "$own_stale_worker_pid" ] && break
    sleep 0.1
done
[ -n "$own_stale_worker_pid" ] || { echo "FAIL: stale stack did not start its worker" >&2; exit 1; }
PIDS+=("$own_stale_worker_pid")
stale_env_child_pid=""
for attempt in $(seq 1 30); do
    stale_env_child_pid="$(pgrep -P "$own_stale_stack_pid" -f "worker\.py $marker-stale-child\$" 2>/dev/null | head -1 || true)"
    [ -n "$stale_env_child_pid" ] && break
    sleep 0.1
done
[ -n "$stale_env_child_pid" ] || { echo "FAIL: stale stack did not start its env-protected child" >&2; exit 1; }
PIDS+=("$stale_env_child_pid")
cat > "$WORKTREE/.context/services.json" <<JSON
{"status": "running", "run_sh_pid": $own_stale_stack_pid, "services": [], "ports": {"backend": 20010, "frontend": 20011}}
JSON
sleep 0.3

(cd "$WORKTREE" && bash scripts/kill-services.sh > "$TMP_ROOT/semantic-sweep.log" 2>&1) || true

assert_alive "$live_stack_pid" "live isolated run.sh (owner record)"
assert_alive "$live_worker_pid" "live isolated stack's worker"
assert_alive "$live_detached_pid" "detached worker carrying a live run's BENCHMARK_RUN_ID"
assert_alive "$boot_detached_pid" "detached worker of an isolated run that is still bootstrapping"
assert_dead "$own_stale_stack_pid" "this workspace's own stale run.sh"
assert_dead "$own_stale_worker_pid" "this workspace's own stale worker"
assert_dead "$done_detached_pid" "leftover worker of a finished isolated run"
assert_dead "$ghost_detached_pid" "worker naming an isolated run that does not exist"
assert_dead "$orphan_detached_pid" "leftover worker of a running-manifest run whose run.sh is gone"
assert_alive "$stale_env_child_pid" "live run's child under a stale stack (final backstop)"
echo "PASS: the sweep leaves every process of a live isolated run alone and reaps its own stale stack"

# The live-run loader must fail closed. A python3 shim fails only that loader
# (its script arrives on stdin and names grace_seconds); every other call
# reaches the real interpreter. With an owner record on disk the sweep is
# refused before any signal; without one it warns and proceeds.
mkdir -p "$TMP_ROOT/broken-python"
cat > "$TMP_ROOT/broken-python/python3" <<'SHIM'
#!/usr/bin/env bash
real="$(command -v -p python3)"
if [ "${1:-}" = "-" ]; then
    script="$(cat)"
    case "$script" in *grace_seconds*) echo "simulated loader failure" >&2; exit 7 ;; esac
    printf '%s\n' "$script" | exec "$real" "$@"
fi
exec "$real" "$@"
SHIM
chmod +x "$TMP_ROOT/broken-python/python3"
(cd "$WORKTREE" && exec bash scripts/run.sh --benchmark) > /dev/null 2>&1 &
refused_stack_pid=$!
PIDS+=("$refused_stack_pid")
refused_worker_pid="$(wait_for_child "$refused_stack_pid")"
PIDS+=("$refused_worker_pid")
sleep 0.3
loader_rc=0
(cd "$WORKTREE" && PATH="$TMP_ROOT/broken-python:$PATH" bash scripts/kill-services.sh \
    > "$TMP_ROOT/loader-refused.log" 2>&1) || loader_rc=$?
if [ "$loader_rc" -eq 0 ]; then
    echo "FAIL: a failed live-run loader with owner records on disk must refuse the sweep" >&2
    exit 1
fi
if ! grep -q "refusing to sweep" "$TMP_ROOT/loader-refused.log"; then
    echo "FAIL: the refused sweep must say why" >&2
    cat "$TMP_ROOT/loader-refused.log" >&2
    exit 1
fi
assert_alive "$refused_stack_pid" "stale run.sh while the sweep is refused"
assert_alive "$refused_worker_pid" "stale worker while the sweep is refused"
assert_alive "$live_stack_pid" "live isolated run.sh while the sweep is refused"
assert_alive "$live_detached_pid" "detached live-run worker while the sweep is refused"
echo "PASS: a failed live-run loader refuses the sweep while owner records exist"

kill_pid_tree "$live_stack_pid"
kill "$live_detached_pid" "$boot_detached_pid" "$stale_env_child_pid" 2>/dev/null || true
rm -rf "$WORKTREE/.context/benchmarks"
loader_rc=0
(cd "$WORKTREE" && PATH="$TMP_ROOT/broken-python:$PATH" bash scripts/kill-services.sh \
    > "$TMP_ROOT/loader-warned.log" 2>&1) || loader_rc=$?
if [ "$loader_rc" -ne 0 ]; then
    echo "FAIL: a failed live-run loader with no owner record must warn and sweep (exit $loader_rc)" >&2
    cat "$TMP_ROOT/loader-warned.log" >&2
    exit 1
fi
if ! grep -q "sweeping without run-identity protection" "$TMP_ROOT/loader-warned.log"; then
    echo "FAIL: the degraded sweep must warn" >&2
    cat "$TMP_ROOT/loader-warned.log" >&2
    exit 1
fi
assert_dead "$refused_stack_pid" "stale run.sh under a degraded sweep"
assert_dead "$refused_worker_pid" "stale worker under a degraded sweep"
echo "PASS: a failed live-run loader warns and sweeps when no owner record exists"

echo "All kill-services tests passed."
