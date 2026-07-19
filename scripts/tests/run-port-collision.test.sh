#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
PIDS=()

cleanup() {
    local pid
    for pid in "${PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in "${PIDS[@]:-}"; do
        wait "$pid" 2>/dev/null || true
    done
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

export CONDUCTOR_PORT=61000
export CONDUCTOR_WORKSPACE_NAME=port-collision-test
export RUN_SH_SOURCE_ONLY=true
source "$ROOT_DIR/scripts/run.sh"

find_free_port() {
    local port
    for port in $(seq 61000 62000); do
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

wait_for_connection() {
    local port="$1"
    local attempt
    for attempt in $(seq 1 30); do
        if lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.1
    done
    echo "FAIL: outbound connection did not start from port $port" >&2
    exit 1
}

foreign_dir="$TMP_ROOT/foreign"
mkdir -p "$foreign_dir"
foreign_port="$(find_free_port)"
(
    cd "$foreign_dir"
    python3 -m http.server "$foreign_port" --bind 127.0.0.1 >/dev/null 2>&1
) &
PIDS+=("$!")
wait_for_port "$foreign_port"

if ! port_requires_reassign "$foreign_port"; then
    echo "FAIL: expected a non-worktree listener to require port reassignment" >&2
    exit 1
fi
echo "PASS: non-worktree listener requires reassignment"

last_index=$((${#PIDS[@]} - 1))
last_pid="${PIDS[$last_index]}"
kill "$last_pid" 2>/dev/null || true
wait "$last_pid" 2>/dev/null || true
unset "PIDS[$last_index]"

own_port="$(find_free_port)"
(
    cd "$ROOT_DIR"
    python3 -m http.server "$own_port" --bind 127.0.0.1 >/dev/null 2>&1
) &
PIDS+=("$!")
wait_for_port "$own_port"

if port_requires_reassign "$own_port"; then
    echo "FAIL: expected a current-worktree listener to be handled by cleanup, not reassignment" >&2
    exit 1
fi
echo "PASS: current-worktree listener does not require reassignment"

remote_port="$(find_free_port)"
python3 -m http.server "$remote_port" --bind 127.0.0.1 >/dev/null 2>&1 &
PIDS+=("$!")
wait_for_port "$remote_port"

outbound_port="$(find_free_port)"
python3 - "$outbound_port" "$remote_port" <<'PY' &
import socket
import sys
import time

connection = socket.socket()
connection.bind(("127.0.0.1", int(sys.argv[1])))
connection.connect(("127.0.0.1", int(sys.argv[2])))
time.sleep(30)
PY
PIDS+=("$!")
wait_for_connection "$outbound_port"

if port_requires_reassign "$outbound_port"; then
    echo "FAIL: an outbound connection must not trigger port reassignment" >&2
    exit 1
fi
if ! port_is_free_for_candidate_range "$outbound_port"; then
    echo "FAIL: an outbound connection must not block a candidate listener port" >&2
    exit 1
fi
echo "PASS: outbound connections do not masquerade as listeners"

unset RUN_SH_STRICT_CONDUCTOR_PORT
if ! port_range_can_reassign; then
    echo "FAIL: ordinary run.sh sessions should allow port reassignment" >&2
    exit 1
fi
echo "PASS: ordinary run.sh sessions allow port reassignment"

export RUN_SH_STRICT_CONDUCTOR_PORT=1
if port_range_can_reassign >/dev/null 2>&1; then
    echo "FAIL: deploy sessions should reject port reassignment" >&2
    exit 1
fi
echo "PASS: deploy sessions reject port reassignment"

unset RUN_SH_STRICT_CONDUCTOR_PORT
BENCHMARK_MODE=true
export BENCHMARK_BUNDLED_FRONTEND=true
if port_range_can_reassign >/dev/null 2>&1; then
    echo "FAIL: bundled benchmark stacks should reject port reassignment" >&2
    exit 1
fi
echo "PASS: bundled benchmark stacks reject port reassignment across shell boundaries"

echo "All run.sh port collision tests passed."
