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
FOREIGN_OUTPUT="$(mktemp)"
FOREIGN_PID=""
PORT=""
TERM_PORT=""
RUNNER_PID=""

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$RUNNER_PID" ]] && kill -0 "$RUNNER_PID" 2>/dev/null; then
    kill -KILL "$RUNNER_PID" 2>/dev/null || true
  fi
  if [[ -n "$FOREIGN_PID" ]]; then
    kill -KILL "$FOREIGN_PID" 2>/dev/null || true
  fi
  for port in "$PORT" "$TERM_PORT"; do
    if [[ -n "$port" ]]; then
      lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill -KILL 2>/dev/null || true
    fi
  done
  rm -rf "$ARTIFACT_DIR" "$TERM_ARTIFACT_DIR" "$TERM_OUTPUT" "$FOREIGN_ARTIFACT_DIR" "$FOREIGN_OUTPUT"
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

# Another worktree's run already serves /health on the port this run reserved.
# Port locks live under each worktree's own artifact root, so two worktrees
# can pick the same port (2026-10-20: three lanes all reserved 55100); the
# readiness probe then accepted the foreign backend, ran the domain against it
# and crashed with ECONNREFUSED once that run exited (or could pass against
# another checkout's code). Readiness must wait for THIS run's backend, whose
# /health names its run, and fail loudly when that backend cannot come up.
FOREIGN_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
python3 - "$FOREIGN_PORT" <<'PY' &
import http.server, json, sys
class Foreign(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"status": "ok", "instance": "some-other-run"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.HTTPServer(("0.0.0.0", int(sys.argv[1])), Foreign).serve_forever()
PY
FOREIGN_PID=$!
for _ in $(seq 1 100); do
  curl -fsS -m 1 "http://localhost:$FOREIGN_PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS -m 1 "http://localhost:$FOREIGN_PORT/health" >/dev/null 2>&1 || fail "the foreign backend never answered"

set +e
(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_RUN_ID="$FOREIGN_RUN_ID" \
    BLACKBOX_TEST_BACKEND_PORT="$FOREIGN_PORT" \
    bash scripts/run-blackbox-tests.sh __teardown_probe__
) >"$FOREIGN_OUTPUT" 2>&1
FOREIGN_STATUS=$?
set -e

[[ "$FOREIGN_STATUS" -ne 0 ]] || fail "the runner succeeded against a foreign backend"
if grep -Eq "Backend ready at|Unknown domain\(s\)" "$FOREIGN_OUTPUT"; then
  cat "$FOREIGN_OUTPUT" >&2
  fail "the runner accepted another run's backend on port $FOREIGN_PORT as its own"
fi
grep -Eq "Backend process exited before becoming ready|Timed out waiting for backend health" "$FOREIGN_OUTPUT" || {
  cat "$FOREIGN_OUTPUT" >&2
  fail "the runner did not report that its own backend never came up"
}
[[ ! -d "$ARTIFACT_ROOT/.port-locks/$FOREIGN_PORT" ]] || fail "port lock $FOREIGN_PORT outlived the run"
echo "PASS: a foreign backend on port $FOREIGN_PORT is never accepted as this run's backend"
