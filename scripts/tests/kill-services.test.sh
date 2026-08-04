#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
PIDS=()

cleanup() {
    local pid
    for pid in "${PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
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

manifest_status() {
    python3 - "$WORKTREE/.context/services.json" <<'PY'
import json
import sys
with open(sys.argv[1]) as f:
    print(json.load(f).get("status"))
PY
}

WORKTREE="$TMP_ROOT/worktree"
mkdir -p "$WORKTREE/scripts" "$WORKTREE/.context" "$WORKTREE/agents" "$WORKTREE/back-end" "$TMP_ROOT/foreign"
WORKTREE="$(cd "$WORKTREE" && pwd -P)"
cp "$ROOT_DIR/scripts/kill-services.sh" "$WORKTREE/scripts/kill-services.sh"
cp "$ROOT_DIR/scripts/list-services.sh" "$WORKTREE/scripts/list-services.sh"
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

status="$(manifest_status)"
if [ "$status" != "stopped" ]; then
    echo "FAIL: expected services manifest status to be stopped, got $status" >&2
    exit 1
fi

# Controller markers can occur beyond BSD ps's default output width. The
# manifest must remain running when its only live PID is such a protected
# controller, even though there are no service targets to signal.
long_controller_argv="$(printf 'x%.0s' $(seq 1 4000)) run-predeploy-local"
(
    cd "$WORKTREE"
    exec -a "$long_controller_argv" sleep 1000
) &
long_controller_pid=$!
PIDS+=("$long_controller_pid")
python3 - "$WORKTREE/.context/services.json" "$long_controller_pid" <<'PY'
import json
import sys
path, pid = sys.argv[1], int(sys.argv[2])
with open(path) as f:
    data = json.load(f)
data["status"] = "running"
data["run_sh_pid"] = pid
with open(path, "w") as f:
    json.dump(data, f, indent=2, sort_keys=True)
    f.write("\n")
PY

(cd "$WORKTREE" && bash scripts/kill-services.sh > /dev/null)
assert_alive "$long_controller_pid" "long-argv benchmark controller"
status="$(manifest_status)"
if [ "$status" != "running" ]; then
    echo "FAIL: protected controller manifest must stay running, got $status" >&2
    exit 1
fi
kill "$long_controller_pid" 2>/dev/null || true
wait "$long_controller_pid" 2>/dev/null || true
echo "PASS: long-argv benchmark controller is detected and preserves the manifest"

# ── Rule 27: a benchmark controller must survive, and must not drag its
#    isolated stack's ancestors into the kill set ───────────────────────────────
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
sleep 1000 &
wait
ISOLATED
chmod +x "$WORKTREE/scripts/run.sh"

(cd "$WORKTREE" && bash scripts/run-predeploy-local > /dev/null 2>&1) &
controller_pid=$!
sleep 1

isolated_runsh_pid=""
for candidate in $(pgrep -f 'scripts/run\.sh --benchmark' 2>/dev/null || true); do
    candidate_cwd="$(lsof -a -p "$candidate" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    if [ "$candidate_cwd" = "$WORKTREE" ]; then
        isolated_runsh_pid="$candidate"
        break
    fi
done
[ -n "$isolated_runsh_pid" ] || {
    echo "FAIL: benchmark controller did not retain an identifiable run.sh child" >&2
    exit 1
}
PIDS+=("$isolated_runsh_pid")

(cd "$WORKTREE" && bash scripts/kill-services.sh > /dev/null 2>&1) || true

assert_alive "$controller_pid" "benchmark controller (run-predeploy-local)"
assert_alive "$isolated_runsh_pid" "benchmark controller's isolated run.sh child"

kill "$controller_pid" 2>/dev/null || true
[ -n "$isolated_runsh_pid" ] && kill "$isolated_runsh_pid" 2>/dev/null || true

# The controller's OWN cleanup must still reap its isolated stack. The real
# benchmarks/local.py invokes kill-services.sh from beneath the controller; an
# ancestor guard that cannot distinguish ownership would leak every local run.
cat > "$WORKTREE/scripts/run-predeploy-local" <<'OWNER_CONTROLLER'
#!/usr/bin/env bash
bash scripts/run.sh --benchmark &
owned_child=$!
bash scripts/kill-services.sh > /dev/null 2>&1
for _attempt in $(seq 1 20); do
    kill -0 "$owned_child" 2>/dev/null || break
    sleep 0.05
done
if kill -0 "$owned_child" 2>/dev/null; then
    kill "$owned_child" 2>/dev/null || true
    wait "$owned_child" 2>/dev/null || true
    echo "FAIL: benchmark controller could not reap its own isolated child" >&2
    exit 1
fi
wait "$owned_child" 2>/dev/null || true
OWNER_CONTROLLER
chmod +x "$WORKTREE/scripts/run-predeploy-local"
(cd "$WORKTREE" && bash scripts/run-predeploy-local)
cat > "$WORKTREE/scripts/run-predeploy-local" <<'CONTROLLER'
#!/usr/bin/env bash
bash "$(dirname "$0")/run.sh" --benchmark &
sleep 1000
CONTROLLER
chmod +x "$WORKTREE/scripts/run-predeploy-local"

# A service may exec in place after discovery and become a benchmark
# controller before the signal pass. Its PID stays the same, so cleanup must
# revalidate both identity and controller status at the signal boundary.
transition_marker="$TMP_ROOT/before-signal.marker"
cat > "$WORKTREE/agents/worker.py" <<'TRANSITION'
#!/usr/bin/env bash
while [ ! -f "$KILL_SERVICES_TRANSITION_MARKER" ]; do sleep 0.01; done
exec bash "$(dirname "$0")/../scripts/run-predeploy-local"
TRANSITION
chmod +x "$WORKTREE/agents/worker.py"
(
    cd "$WORKTREE/agents"
    export KILL_SERVICES_TRANSITION_MARKER="$transition_marker"
    exec bash worker.py
) > /dev/null 2>&1 &
transition_pid=$!
PIDS+=("$transition_pid")
sleep 0.2

(
    cd "$WORKTREE"
    KILL_SERVICES_TEST_BEFORE_SIGNAL_MARKER="$transition_marker" \
        KILL_SERVICES_TEST_BEFORE_SIGNAL_DELAY_SECONDS=0.5 \
        bash scripts/kill-services.sh > /dev/null 2>&1
)

assert_alive "$transition_pid" "service that exec'd into a benchmark controller"
transition_cmd="$(ps -p "$transition_pid" -o command= 2>/dev/null || true)"
if ! echo "$transition_cmd" | grep -q 'run-predeploy-local'; then
    echo "FAIL: transition PID did not exec into the controller: $transition_cmd" >&2
    exit 1
fi
transition_child="$(pgrep -P "$transition_pid" 2>/dev/null | head -1 || true)"
kill "$transition_pid" 2>/dev/null || true
[ -n "$transition_child" ] && kill "$transition_child" 2>/dev/null || true

# The protected boundary can also appear in an ANCESTOR after discovery. Keep
# the service child's identity stable while its parent execs into a benchmark
# controller; safe_to_signal must re-check the whole ancestor chain.
ancestor_transition_marker="$TMP_ROOT/ancestor-before-signal.marker"
cat > "$WORKTREE/agents/worker.py" <<'ANCESTOR_CHILD'
#!/usr/bin/env bash
sleep 1000 &
wait
ANCESTOR_CHILD
chmod +x "$WORKTREE/agents/worker.py"
cat > "$WORKTREE/agents/controller-transition.sh" <<'ANCESTOR_PARENT'
#!/usr/bin/env bash
bash worker.py &
while [ ! -f "$KILL_SERVICES_ANCESTOR_TRANSITION_MARKER" ]; do sleep 0.01; done
exec bash ../scripts/run-predeploy-local
ANCESTOR_PARENT
chmod +x "$WORKTREE/agents/controller-transition.sh"
(
    cd "$WORKTREE/agents"
    export KILL_SERVICES_ANCESTOR_TRANSITION_MARKER="$ancestor_transition_marker"
    exec bash controller-transition.sh
) > /dev/null 2>&1 &
ancestor_controller_pid=$!
PIDS+=("$ancestor_controller_pid")
sleep 0.2
ancestor_worker_pid="$(pgrep -P "$ancestor_controller_pid" -f 'worker\.py' 2>/dev/null | head -1 || true)"
[ -n "$ancestor_worker_pid" ] || {
    echo "FAIL: ancestor-transition worker did not start" >&2
    exit 1
}
PIDS+=("$ancestor_worker_pid")

(
    cd "$WORKTREE"
    KILL_SERVICES_TEST_BEFORE_SIGNAL_MARKER="$ancestor_transition_marker" \
        KILL_SERVICES_TEST_BEFORE_SIGNAL_DELAY_SECONDS=0.5 \
        bash scripts/kill-services.sh > /dev/null 2>&1
)

assert_alive "$ancestor_controller_pid" "ancestor that became a benchmark controller"
assert_alive "$ancestor_worker_pid" "service beneath a benchmark controller ancestor"
ancestor_transition_children="$(pgrep -P "$ancestor_controller_pid" 2>/dev/null || true)"
kill "$ancestor_controller_pid" 2>/dev/null || true
for pid in $ancestor_transition_children; do kill "$pid" 2>/dev/null || true; done

# Protection walks must never stop before classifying PID 1. On a Fly cloudbench
# guest the boot command IS PID 1, so a benchmark controller legitimately lives
# there; bailing at ppid == 1 left every service beneath it unprotected and
# killable from outside (CLAUDE.md rule 27). The two protection walks
# (is_self_ancestor, benchmark_controller_for_pid) must therefore terminate only
# on an absent/zero/self parent. add_pid_with_tree_and_ancestors deliberately
# KEEPS its ppid == 1 stop: that walk collects kill targets, so climbing onto
# PID 1 there could make PID 1 itself a target.
protection_walk_source=$(
    awk '/^is_self_ancestor\(\)/,/^\}/' "$ROOT_DIR/scripts/kill-services.sh"
    awk '/^benchmark_controller_for_pid\(\)/,/^\}/' "$ROOT_DIR/scripts/kill-services.sh"
)
if [[ -z "$protection_walk_source" ]]; then
    echo "FAIL: could not read the protection walk functions" >&2
    exit 1
fi
if grep -q '"\$ppid" = "1"' <<<"$protection_walk_source"; then
    echo "FAIL: a protection walk still stops on PID 1; a controller at PID 1 would leave its services unprotected" >&2
    exit 1
fi
if ! grep -q '"\$ppid" = "\$current"' <<<"$protection_walk_source"; then
    echo "FAIL: protection walks must guard against a self-parent loop once PID 1 is reachable" >&2
    exit 1
fi
echo "PASS: protection walks classify PID 1 instead of bailing before it"

echo "All kill-services tests passed."
