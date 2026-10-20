#!/usr/bin/env bash
# run-blackbox-tests.sh owns an isolated backend and a port lock for the length
# of one run. Both must be gone when it exits: a surviving backend keeps serving
# (and writing to the test database) on a port no run will reclaim, and a
# surviving lock makes every later run skip that port.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Resolve the root exactly as run-blackbox-tests.sh does, so a deploy env that
# moves artifacts (BLACKBOX_TEST_ARTIFACT_ROOT) is probed and cleaned in place.
ARTIFACT_ROOT="${BLACKBOX_TEST_ARTIFACT_ROOT:-${CONTRACT_TEST_ARTIFACT_ROOT:-$ROOT_DIR/.context/test-runs}}"
RUN_ID="teardown-probe-$$-$RANDOM"
ARTIFACT_DIR="$ARTIFACT_ROOT/$RUN_ID"
TERM_RUN_ID="teardown-term-probe-$$-$RANDOM"
TERM_ARTIFACT_DIR="$ARTIFACT_ROOT/$TERM_RUN_ID"
TERM_OUTPUT="$(mktemp)"
FOREIGN_RUN_ID="teardown-foreign-probe-$$-$RANDOM"
FOREIGN_ARTIFACT_DIR="$ARTIFACT_ROOT/$FOREIGN_RUN_ID"
PORT=""
TERM_PORT=""
FOREIGN_PORT=""
FOREIGN_PID=""
RACE_RUN_ID="teardown-race-probe-$$-$RANDOM"
RACE_ARTIFACT_DIR="$ARTIFACT_ROOT/$RACE_RUN_ID"
RACE_OUTPUT="$(mktemp)"
RACE_PORT=""
RACE_PID=""
RUNNER_PID=""

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$RUNNER_PID" ]] && kill -0 "$RUNNER_PID" 2>/dev/null; then
    kill -KILL "$RUNNER_PID" 2>/dev/null || true
  fi
  for port in "$PORT" "$TERM_PORT"; do
    if [[ -n "$port" ]]; then
      lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill -KILL 2>/dev/null || true
    fi
  done
  for pid in "$FOREIGN_PID" "$RACE_PID"; do
    if [[ -n "$pid" ]]; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  if [[ -n "$FOREIGN_PORT" ]]; then
    rmdir "$ARTIFACT_ROOT/.port-locks/$FOREIGN_PORT" 2>/dev/null || true
  fi
  rm -rf "$ARTIFACT_DIR" "$TERM_ARTIFACT_DIR" "$FOREIGN_ARTIFACT_DIR" "$RACE_ARTIFACT_DIR" \
    "$TERM_OUTPUT" "$RACE_OUTPUT"
}
trap cleanup EXIT

assert_released() {
  local manifest="$1" label="$2" port base_url
  port=$(jq -er '.port' "$manifest")
  base_url=$(jq -er '.base_url' "$manifest")
  if curl -fsS -m 2 "$base_url/health" >/dev/null 2>&1; then
    fail "$label: the isolated backend is still serving $base_url after the runner exited"
  fi
  if [[ -d "$ARTIFACT_ROOT/.port-locks/$port" ]]; then
    fail "$label: port lock $port outlived the run"
  fi
  echo "$port"
}

set +e
OUTPUT=$(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_RUN_ID="$RUN_ID" \
    bash scripts/run-blackbox-tests.sh __teardown_probe__ 2>&1
)
STATUS=$?
set -e

[[ "$STATUS" -ne 0 ]] || fail "an unknown domain was accepted"
grep -Fq "Backend ready at" <<<"$OUTPUT" || {
  echo "$OUTPUT" >&2
  fail "the isolated backend never became ready"
}
grep -Fq "Unknown domain(s): __teardown_probe__" <<<"$OUTPUT" || {
  echo "$OUTPUT" >&2
  fail "the runner did not reach the black-box test runner"
}

PORT=$(jq -er '.port' "$ARTIFACT_DIR/manifest.json")
assert_released "$ARTIFACT_DIR/manifest.json" "normal exit" >/dev/null
echo "PASS: isolated backend and port lock $PORT released on exit"

# SIGTERM while the backend boots. Bash resumes a script after a signal trap
# returns, so a cleanup-only TERM trap released the lock and kept going.
(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_RUN_ID="$TERM_RUN_ID" \
    exec bash scripts/run-blackbox-tests.sh __teardown_probe__
) >"$TERM_OUTPUT" 2>&1 &
RUNNER_PID=$!

for _ in $(seq 1 1200); do
  grep -Fq "Starting isolated backend" "$TERM_OUTPUT" && break
  kill -0 "$RUNNER_PID" 2>/dev/null || break
  sleep 0.1
done
grep -Fq "Starting isolated backend" "$TERM_OUTPUT" || {
  cat "$TERM_OUTPUT" >&2
  fail "the TERM probe never reached backend launch"
}
# Let the launch line and BACKEND_PID assignment run before signalling.
sleep 1
grep -Fq "Backend ready at" "$TERM_OUTPUT" && fail "the backend became ready before the TERM probe could signal"
TERM_PORT=$(jq -er '.port' "$TERM_ARTIFACT_DIR/manifest.json")

kill -TERM "$RUNNER_PID"
set +e
wait "$RUNNER_PID"
TERM_STATUS=$?
set -e
RUNNER_PID=""

if [[ "$TERM_STATUS" -ne 143 ]]; then
  cat "$TERM_OUTPUT" >&2
  fail "the runner exited $TERM_STATUS after SIGTERM; it must stop with 143"
fi
if grep -Eq "Backend ready at|Backend process exited before becoming ready" "$TERM_OUTPUT"; then
  cat "$TERM_OUTPUT" >&2
  fail "the runner kept running after its SIGTERM cleanup"
fi
assert_released "$TERM_ARTIFACT_DIR/manifest.json" "SIGTERM" >/dev/null
echo "PASS: SIGTERM stops the runner with 143 and releases backend and port lock $TERM_PORT"

# Port locks are per worktree, so another worktree's backend can already be
# serving this run's port. Its /health must never make the run "ready": the
# tests would then exercise another branch's code (seen 2026-10-20 when two
# lanes both took 55100). Our own backend loses the bind and the run fails.
free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# A dual-stack /health server holding $1, like another worktree's backend.
start_foreign_server() {
  python3 -c '
import http.server, socket, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *args):
        pass
class DualStack(http.server.HTTPServer):
    address_family = socket.AF_INET6
    def server_bind(self):
        # Hold the port on IPv4 and IPv6, exactly like a Node backend on "::".
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()
DualStack(("::", int(sys.argv[1])), H).serve_forever()
' "$1" &
  STARTED_PID=$!
  for _ in $(seq 1 50); do
    curl -fsS -m 1 "http://localhost:$1/health" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "the foreign /health server on $1 never started"
}

FOREIGN_PORT=$(free_port)
start_foreign_server "$FOREIGN_PORT"
FOREIGN_PID=$STARTED_PID

set +e
FOREIGN_OUTPUT=$(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_RUN_ID="$FOREIGN_RUN_ID" \
    BLACKBOX_TEST_BACKEND_PORT="$FOREIGN_PORT" \
    bash scripts/run-blackbox-tests.sh __teardown_probe__ 2>&1
)
FOREIGN_STATUS=$?
set -e
if grep -Fq "Backend ready at" <<<"$FOREIGN_OUTPUT"; then
  echo "$FOREIGN_OUTPUT" >&2
  fail "a foreign server on the run's port was reported as the isolated backend"
fi
[[ "$FOREIGN_STATUS" -ne 0 ]] || fail "the runner succeeded against a foreign backend"
grep -Eq "Backend process exited before becoming ready|Timed out waiting for backend health" <<<"$FOREIGN_OUTPUT" || {
  echo "$FOREIGN_OUTPUT" >&2
  fail "the runner did not report that its own backend never became ready"
}
echo "PASS: a foreign server on port $FOREIGN_PORT is never reported as the isolated backend"

# The same race without an explicit port: the probe saw the port free, then a
# foreign server bound it before our backend did. The run moves to the next
# free port instead of failing (or testing the foreign server).
RACE_PORT=$(free_port)
(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_RUN_ID="$RACE_RUN_ID" \
    BLACKBOX_TEST_BACKEND_START_PORT="$RACE_PORT" \
    exec bash scripts/run-blackbox-tests.sh __teardown_probe__
) >"$RACE_OUTPUT" 2>&1 &
RUNNER_PID=$!
for _ in $(seq 1 1200); do
  grep -Fq "Starting isolated backend for black-box tests on port $RACE_PORT" "$RACE_OUTPUT" && break
  kill -0 "$RUNNER_PID" 2>/dev/null || break
  sleep 0.05
done
grep -Fq "Starting isolated backend for black-box tests on port $RACE_PORT" "$RACE_OUTPUT" || {
  cat "$RACE_OUTPUT" >&2
  fail "the race probe did not start on its requested start port $RACE_PORT"
}
# tsx needs seconds to compile before listen(); take the port first.
start_foreign_server "$RACE_PORT"
RACE_PID=$STARTED_PID
set +e
wait "$RUNNER_PID"
set -e
RUNNER_PID=""
grep -Fq "Port $RACE_PORT was taken before the isolated backend bound it" "$RACE_OUTPUT" || {
  cat "$RACE_OUTPUT" >&2
  fail "the runner did not notice its port was taken"
}
READY_LINE=$(grep -F "Backend ready at" "$RACE_OUTPUT" || true)
[[ -n "$READY_LINE" && "$READY_LINE" != *":$RACE_PORT" ]] || {
  cat "$RACE_OUTPUT" >&2
  fail "the runner did not become ready on a different free port"
}
grep -Fq "Unknown domain(s): __teardown_probe__" "$RACE_OUTPUT" || fail "the race probe never reached the test runner"
assert_released "$RACE_ARTIFACT_DIR/manifest.json" "port race" >/dev/null
echo "PASS: a port taken between probe and bind moves the run to the next free port"
