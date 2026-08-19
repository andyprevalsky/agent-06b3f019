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

isolated_dist_a=$(resolve_frontend_dist_dir "$ROOT_DIR" true 'run/a' 61001)
isolated_dist_b=$(resolve_frontend_dist_dir "$ROOT_DIR" true 'run/b' 61001)
shared_dist=$(resolve_frontend_dist_dir "$ROOT_DIR" false '' 61001)
[ "$isolated_dist_a" != "$isolated_dist_b" ] || {
    echo "FAIL: concurrent isolated stacks must not share a frontend bundle" >&2
    exit 1
}
[ "$isolated_dist_a" != "$shared_dist" ] || {
    echo "FAIL: semantic and isolated stacks must not share a frontend bundle" >&2
    exit 1
}
for frontend_dist in "$isolated_dist_a" "$isolated_dist_b" "$shared_dist"; do
    case "$frontend_dist" in
        "$ROOT_DIR/.context/frontend-builds/"*) ;;
        *)
            echo "FAIL: frontend bundles must remain under the worktree context directory" >&2
            exit 1
            ;;
    esac
done
echo "PASS: concurrent benchmark stacks own distinct frontend bundles"

docker_info_quick() {
    return 1
}
docker_ps_ports_quick() {
    printf '%s\n' 'victoria-db-port-collision-test'
}
if ! docker_available_for_workspace_db 'victoria-db-port-collision-test'; then
    echo "FAIL: a pre-started workspace DB must keep Docker selected when docker info is slow" >&2
    exit 1
fi
if docker_available_for_workspace_db 'victoria-db-another-workspace'; then
    echo "FAIL: another workspace's DB must not make Docker available for this workspace" >&2
    exit 1
fi
echo "PASS: a pre-started workspace DB survives a slow docker info probe"

# An isolated benchmark stack creates its DB container later in the same run, so
# its name cannot already be listed. Requiring it made a healthy-but-slow
# `docker info` (Docker Desktop routinely answers in ~2s) silently downgrade
# every isolated benchmark run to the shared system Postgres. The canonical base
# fixture is published per pg major, so a system PG17/18 host then hard-failed
# with "canonical base fixture is unavailable" instead of running the benchmark.
docker_info_quick() {
    return 1
}
docker_ps_ports_quick() {
    printf '%s\n' 'victoria-db-some-other-workspace'
}
if ! docker_available_for_workspace_db 'victoria-db-bench-not-created-yet' true; then
    echo "FAIL: an isolated benchmark run must keep Docker selected via a responsive docker ps" >&2
    exit 1
fi
if docker_available_for_workspace_db 'victoria-db-bench-not-created-yet'; then
    echo "FAIL: a non-isolated workspace must still require its own DB container" >&2
    exit 1
fi
docker_ps_ports_quick() {
    return 1
}
if docker_available_for_workspace_db 'victoria-db-bench-not-created-yet' true; then
    echo "FAIL: an unresponsive Docker daemon must not report the workspace DB as available" >&2
    exit 1
fi
echo "PASS: isolated benchmark runs survive a slow docker info without losing Docker"

# A healthy `docker info` alone must select Docker, with no container-name check.
# DOCKER_OK is precisely what makes run.sh *create* the workspace DB container
# (create_db_container), so demanding the container already exist is circular: a
# first-ever workspace has none, would be denied Docker, and would silently run
# on the shared system Postgres forever. Do not "harden" the fast path by
# requiring container_may_not_exist_yet here.
HEALTHY_DOCKER_PS_CALLS=0
docker_info_quick() {
    return 0
}
docker_ps_ports_quick() {
    HEALTHY_DOCKER_PS_CALLS=$((HEALTHY_DOCKER_PS_CALLS + 1))
    printf '%s\n' 'victoria-db-some-other-workspace'
}
if ! docker_available_for_workspace_db 'victoria-db-never-created'; then
    echo "FAIL: a healthy docker info must select Docker for a not-yet-created workspace DB" >&2
    exit 1
fi
if ! docker_available_for_workspace_db 'victoria-db-never-created' true; then
    echo "FAIL: a healthy docker info must select Docker for an isolated run too" >&2
    exit 1
fi
[ "$HEALTHY_DOCKER_PS_CALLS" -eq 0 ] || {
    echo "FAIL: a healthy docker info must not need a container listing" >&2
    exit 1
}
echo "PASS: a healthy docker info selects Docker without requiring an existing container"

DOCKER_COLD_SEED_PROBES=0
docker_info_quick() {
    DOCKER_COLD_SEED_PROBES=$((DOCKER_COLD_SEED_PROBES + 1))
    [ "$DOCKER_COLD_SEED_PROBES" -ge 3 ]
}
COLD_SEED_DOCKER_RETRY_DELAY_SECONDS=0
if ! docker_available_for_cold_seed; then
    echo "FAIL: a cold isolated seed must retry a transient Docker health miss" >&2
    exit 1
fi
[ "$DOCKER_COLD_SEED_PROBES" -eq 3 ] || {
    echo "FAIL: cold-seed Docker retry did not stop after daemon recovery" >&2
    exit 1
}
unset COLD_SEED_DOCKER_RETRY_DELAY_SECONDS
echo "PASS: cold isolated seed retries transient Docker health misses"

SLEEP_DELAYS=()
sleep() {
    SLEEP_DELAYS+=("$1")
}
docker_info_quick() {
    return 1
}
for delay_case in invalid -1 999999 0 2.5; do
    SLEEP_DELAYS=()
    COLD_SEED_DOCKER_RETRY_DELAY_SECONDS="$delay_case"
    if docker_available_for_cold_seed; then
        echo "FAIL: unavailable Docker unexpectedly recovered for delay $delay_case" >&2
        exit 1
    fi
    case "$delay_case" in
        invalid|-1) expected_delay=1 ;;
        999999) expected_delay=5 ;;
        0) expected_delay='' ;;
        2.5) expected_delay=2.5 ;;
    esac
    if [ -z "$expected_delay" ]; then
        [ "${#SLEEP_DELAYS[@]}" -eq 0 ] || {
            echo "FAIL: zero cold-seed delay must not sleep" >&2
            exit 1
        }
    else
        [ "${#SLEEP_DELAYS[@]}" -eq 5 ] || {
            echo "FAIL: expected five bounded sleeps for delay $delay_case" >&2
            exit 1
        }
        for observed_delay in "${SLEEP_DELAYS[@]}"; do
            [ "$observed_delay" = "$expected_delay" ] || {
                echo "FAIL: delay $delay_case normalized to $observed_delay, expected $expected_delay" >&2
                exit 1
            }
        done
    fi
done
unset COLD_SEED_DOCKER_RETRY_DELAY_SECONDS
unset -f sleep
echo "PASS: cold isolated seed validates and caps retry delays"

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

wait_for_frontend_test_port="$(find_free_port)"
wait_for_frontend_test_root="$TMP_ROOT/frontend-ready"
wait_for_frontend_test_log="$TMP_ROOT/frontend-ready.log"
mkdir -p "$wait_for_frontend_test_root"
printf '%s\n' 'ready' > "$wait_for_frontend_test_root/test_payment"
(
    sleep 0.4
    cd "$wait_for_frontend_test_root"
    python3 -m http.server "$wait_for_frontend_test_port" --bind 127.0.0.1 \
        >"$wait_for_frontend_test_log" 2>&1
) &
frontend_test_pid=$!
PIDS+=("$frontend_test_pid")

if ! FRONTEND_START_READY_ATTEMPTS=30 RUN_SERVICE_READY_SLEEP_SECONDS=0.1 \
    wait_for_frontend_ready "$frontend_test_pid" "$wait_for_frontend_test_port" "$wait_for_frontend_test_log"; then
    echo "FAIL: frontend readiness must wait for a slow bundled build before tunnel smoke" >&2
    exit 1
fi
echo "PASS: frontend readiness waits for a delayed local frontend"

failed_frontend_log="$TMP_ROOT/frontend-failed.log"
printf '%s\n' 'synthetic frontend build failure' > "$failed_frontend_log"
(
    sleep 0.1
    exit 1
) &
failed_frontend_pid=$!
PIDS+=("$failed_frontend_pid")
if FRONTEND_START_READY_ATTEMPTS=30 RUN_SERVICE_READY_SLEEP_SECONDS=0.1 \
    wait_for_frontend_ready "$failed_frontend_pid" "$(find_free_port)" "$failed_frontend_log" >/dev/null 2>&1; then
    echo "FAIL: frontend readiness must fail when the frontend process exits" >&2
    exit 1
fi
echo "PASS: frontend readiness fails when the frontend process exits"

RUN_SH_PATH="$ROOT_DIR/scripts/run.sh" python3 - <<'PY'
import os
from pathlib import Path

text = Path(os.environ["RUN_SH_PATH"]).read_text()
ready = text.find('wait_for_frontend_ready "$FRONTEND_PID"')
tunnel = text.find("bash scripts/test-public-tunnel.sh", ready)
running = text.find("SERVICE_STATUS=running", ready)
manifest = text.find("write_services_manifest", running)
if (
    ready < 0
    or tunnel < 0
    or running < 0
    or manifest < 0
    or not ready < tunnel < running < manifest
):
    raise SystemExit(
        "frontend readiness and public tunnel smoke must precede running manifest publication"
    )
PY
echo "PASS: run.sh publishes running only after frontend and public tunnel readiness"

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
