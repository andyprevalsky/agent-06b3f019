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
PORT=""

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$PORT" ]]; then
    lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -KILL 2>/dev/null || true
  fi
  rm -rf "$ARTIFACT_DIR"
}
trap cleanup EXIT

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
BASE_URL=$(jq -er '.base_url' "$ARTIFACT_DIR/manifest.json")

if curl -fsS -m 2 "$BASE_URL/health" >/dev/null 2>&1; then
  fail "the isolated backend is still serving $BASE_URL after the runner exited"
fi
if [[ -d "$ARTIFACT_ROOT/.port-locks/$PORT" ]]; then
  fail "port lock $PORT outlived the run"
fi

echo "PASS: isolated backend and port lock $PORT released on exit"
