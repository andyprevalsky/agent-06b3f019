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
    local pid
    for pid in "${PIDS[@]:-}"; do
        kill_pid_tree "$pid"
        wait "$pid" 2>/dev/null || true
    done
    rm -rf "$TMP_ROOT"
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
        if lsof -ti :"$port" >/dev/null 2>&1; then
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

    assert_controller_match 0 'bash scripts/run-predeploy-local-helper'
    assert_controller_match 0 'bash scripts/run-predeploy-cloud-old'
    assert_controller_match 0 'bash scripts/run-bench-fleet-helper'
    assert_controller_match 0 'python benchmarks/local.py.bak'
    assert_controller_match 0 'python benchmarks/run_benchmark.py.bak'
    assert_controller_match 0 'python otherbenchmarks/local.py'
    assert_controller_match 0 'bash notrun-predeploy-local'
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

    if printf '%s\n' "$reduced" | grep -q "^900${TAB}"; then
        echo "FAIL: PID with conflicting identity observations was not dropped" >&2
        printf '%s\n' "$reduced" >&2
        exit 1
    fi
    if printf '%s\n' "$reduced" | grep -q "^700${TAB}"; then
        echo "FAIL: PID poisoned during tree expansion was not dropped" >&2
        printf '%s\n' "$reduced" >&2
        exit 1
    fi
    if printf '%s\n' "$reduced" | grep -q "^42424[23]${TAB}"; then
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
if ! echo "$list_output" | grep -q "$worker_pid"; then
    echo "FAIL: list-services did not show worktree listener PID $worker_pid" >&2
    echo "$list_output" >&2
    exit 1
fi
if ! echo "$list_output" | grep -q "$cwd_only_pid"; then
    echo "FAIL: list-services did not show cwd-only service PID $cwd_only_pid" >&2
    echo "$list_output" >&2
    exit 1
fi

(cd "$WORKTREE" && bash scripts/kill-services.sh)

assert_dead "$worker_pid" "worktree listener"
assert_dead "$cwd_only_pid" "cwd-only service process"
assert_alive "$foreign_pid" "foreign listener"

if lsof -ti :"$worker_port" >/dev/null 2>&1; then
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

echo "All kill-services tests passed."
