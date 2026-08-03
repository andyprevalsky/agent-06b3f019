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

WORKTREE="$TMP_ROOT/worktree"
mkdir -p "$WORKTREE/scripts" "$WORKTREE/.context" "$WORKTREE/agents" "$WORKTREE/back-end" "$TMP_ROOT/foreign"
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

kill "$controller_pid" 2>/dev/null || true
[ -n "$isolated_runsh_pid" ] && kill "$isolated_runsh_pid" 2>/dev/null || true

echo "All kill-services tests passed."
