#!/usr/bin/env bash
# run-blackbox-tests.sh owns an isolated backend and a port lock for the length
# of one run. Both must be gone when it exits: a surviving backend keeps serving
# (and writing to the test database) on a port no run will reclaim, and a
# surviving lock makes every later run skip that port.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_ROOT="$ROOT_DIR/.context/test-runs"
RUN_ID="teardown-probe-$$-$RANDOM"
ARTIFACT_DIR="$ARTIFACT_ROOT/$RUN_ID"
TERM_RUN_ID="teardown-term-probe-$$-$RANDOM"
TERM_ARTIFACT_DIR="$ARTIFACT_ROOT/$TERM_RUN_ID"
TERM_OUTPUT="$(mktemp)"
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
  for port in "$PORT" "$TERM_PORT"; do
    if [[ -n "$port" ]]; then
      lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill -KILL 2>/dev/null || true
    fi
  done
  rm -rf "$ARTIFACT_DIR" "$TERM_ARTIFACT_DIR" "$TERM_OUTPUT"
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
