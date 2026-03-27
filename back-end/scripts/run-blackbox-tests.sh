#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_DIR"

ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
RUN_ID="${BLACKBOX_TEST_RUN_ID:-${CONTRACT_TEST_RUN_ID:-$(date +%s)-$$-$RANDOM}}"
export BLACKBOX_TEST_RUN_ID="$RUN_ID"
export CONTRACT_TEST_RUN_ID="$RUN_ID"
ARTIFACT_ROOT="${BLACKBOX_TEST_ARTIFACT_ROOT:-${CONTRACT_TEST_ARTIFACT_ROOT:-$ROOT_DIR/.context/test-runs}}"
ARTIFACT_DIR="${BLACKBOX_TEST_ARTIFACT_DIR:-${CONTRACT_TEST_ARTIFACT_DIR:-$ARTIFACT_ROOT/$RUN_ID}}"
PORT_LOCK_ROOT="$ARTIFACT_ROOT/.port-locks"
mkdir -p "$ARTIFACT_DIR" "$PORT_LOCK_ROOT"
export BLACKBOX_TEST_ARTIFACT_DIR="$ARTIFACT_DIR"
export CONTRACT_TEST_ARTIFACT_DIR="$ARTIFACT_DIR"

RUNNER_CMD=(npx tsx src/tests/blackbox/run.ts)
RUNNER_LOG="$ARTIFACT_DIR/runner.log"
MANIFEST_PATH="$ARTIFACT_DIR/manifest.json"

# --list only needs filesystem discovery; skip backend boot for speed.
for arg in "$@"; do
  if [[ "$arg" == "--list" ]]; then
    "${RUNNER_CMD[@]}" "$@"
    exit $?
  fi
done

USE_EXISTING_BACKEND="${BLACKBOX_TEST_USE_EXISTING_BACKEND:-${CONTRACT_TEST_USE_EXISTING_BACKEND:-0}}"

if [[ "$USE_EXISTING_BACKEND" == "1" ]]; then
  if [[ -z "${TEST_BASE_URL:-}" ]]; then
    echo "❌ TEST_BASE_URL must be set when BLACKBOX_TEST_USE_EXISTING_BACKEND=1 or CONTRACT_TEST_USE_EXISTING_BACKEND=1"
    exit 1
  fi
  cat >"$MANIFEST_PATH" <<EOF
{"run_id":"$RUN_ID","mode":"existing-blackbox-backend","base_url":"$TEST_BASE_URL","artifact_dir":"$ARTIFACT_DIR","runner_log":"$RUNNER_LOG"}
EOF
  echo "Artifacts: $ARTIFACT_DIR"
  echo "Using existing backend at $TEST_BASE_URL"
  "${RUNNER_CMD[@]}" "$@" 2>&1 | tee "$RUNNER_LOG"
  exit $?
fi

# Conductor.run uses BACKEND_PORT=CONDUCTOR_PORT. For black-box tests we keep branch affinity
# but use a separate port range to avoid reusing the live workspace backend port.
BASE_PORT="${CONDUCTOR_PORT:-55000}"
START_PORT="${BLACKBOX_TEST_BACKEND_START_PORT:-${CONTRACT_TEST_BACKEND_START_PORT:-$((BASE_PORT + 100))}}"
PORT="${BLACKBOX_TEST_BACKEND_PORT:-${CONTRACT_TEST_BACKEND_PORT:-$START_PORT}}"
PORT_LOCK_DIR=""

reserve_port() {
  local candidate="$1"

  while true; do
    local lock_dir="$PORT_LOCK_ROOT/$candidate"
    if mkdir "$lock_dir" 2>/dev/null; then
      if lsof -ti :"$candidate" >/dev/null 2>&1; then
        rmdir "$lock_dir" >/dev/null 2>&1 || true
      else
        PORT_LOCK_DIR="$lock_dir"
        echo "$candidate"
        return 0
      fi
    fi
    candidate=$((candidate + 1))
  done
}

if [[ -z "${BLACKBOX_TEST_BACKEND_PORT:-${CONTRACT_TEST_BACKEND_PORT:-}}" ]]; then
  PORT="$(reserve_port "$START_PORT")"
else
  PORT_LOCK_DIR="$PORT_LOCK_ROOT/$PORT"
  if ! mkdir "$PORT_LOCK_DIR" 2>/dev/null; then
    echo "❌ Failed to reserve requested black-box test port $PORT"
    exit 1
  fi
fi

export TEST_BASE_URL="http://localhost:$PORT"
BACKEND_LOG="${BLACKBOX_TEST_BACKEND_LOG:-${CONTRACT_TEST_BACKEND_LOG:-$ARTIFACT_DIR/backend.log}}"

cat >"$MANIFEST_PATH" <<EOF
{"run_id":"$RUN_ID","mode":"isolated-blackbox-backend","base_url":"$TEST_BASE_URL","port":$PORT,"artifact_dir":"$ARTIFACT_DIR","backend_log":"$BACKEND_LOG","runner_log":"$RUNNER_LOG","disable_gmail_sync":true}
EOF

echo "Starting isolated backend for black-box tests on port $PORT"
echo "Backend log: $BACKEND_LOG"
echo "Artifacts: $ARTIFACT_DIR"

PORT="$PORT" DISABLE_GMAIL_SYNC=1 npx tsx src/server.ts >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

cleanup() {
  if kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ -n "$PORT_LOCK_DIR" && -d "$PORT_LOCK_DIR" ]]; then
    rmdir "$PORT_LOCK_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

READY=0
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "$TEST_BASE_URL/health" >/dev/null 2>&1; then
    READY=1
    break
  fi

  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "❌ Backend process exited before becoming ready"
    echo "Last backend log lines:"
    tail -n 80 "$BACKEND_LOG" || true
    exit 1
  fi

  sleep 0.5
done

if [[ "$READY" -ne 1 ]]; then
  echo "❌ Timed out waiting for backend health on $TEST_BASE_URL/health"
  echo "Last backend log lines:"
  tail -n 80 "$BACKEND_LOG" || true
  exit 1
fi

echo "Backend ready at $TEST_BASE_URL"
if ! "${RUNNER_CMD[@]}" "$@" 2>&1 | tee "$RUNNER_LOG"; then
  echo "❌ Black-box tests failed. Artifacts: $ARTIFACT_DIR"
  exit 1
fi
