#!/usr/bin/env bash
set -euo pipefail

TASK_NAME="${1:-}"
BOOTSTRAP_FLAG="${2:-}"

case "$TASK_NAME" in
  agent-payment-test-shop|agent-payment-setup-resume|agent-payment-idempotent-abandonment|agent-payment-abandonment) ;;
  *)
    echo "Usage: $0 <agentcard sandbox lifecycle task> [--bootstrap]" >&2
    exit 2
    ;;
esac

if [ -z "${CONDUCTOR_PORT:-}" ]; then
  echo "CONDUCTOR_PORT must be set (run this from Conductor)." >&2
  exit 2
fi

if [ -n "$BOOTSTRAP_FLAG" ] && [ "$BOOTSTRAP_FLAG" != "--bootstrap" ]; then
  echo "Unknown option: $BOOTSTRAP_FLAG" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CONDUCTOR_WORKSPACE_NAME="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$ROOT_DIR")}"
export TEMPORAL_TASK_QUEUE="navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME"
export ALLOW_TEMPORAL_CLEANUP=true
# Payment lifecycle tasks must run with the fast-mode LLM cache OFF: cached agent
# decisions from prior runs replay stale patterns (observed: the root agent
# re-spawns the browser after a successful checkout, looping until timeout). Real
# uncached decisions complete the checkout once. Mirrors benchmarks/local.py.
# Force it off unconditionally — a pre-set BENCHMARK_FAST_MODE_CACHE=true would
# otherwise reintroduce the stale-replay loop.
export BENCHMARK_FAST_MODE_CACHE=false
# Hosted AgentCard onboarding requires an allowlisted HTTPS callback. The local
# lifecycle benchmark never follows this URL—it completes the sandbox fixture
# through the scoped test-payment API—but minting must still create a genuine
# hosted session before the expected attention gate can be raised. Pin that
# boundary to the stable backend callback registered for the Rose Labs org so a
# workspace-local `.env` URL cannot turn setup/resume into an opaque mint 500.
export AGENTCARD_ONBOARDING_RETURN_URL="${AGENTCARD_ONBOARDING_RETURN_URL:-https://navi-j9a9.onrender.com/api/agentcard/onboarding/callback}"
# These payment-lifecycle tasks drive a browser checkout on claude compute
# tokens and never spawn a Codex agent. An externally rate-limited or
# quota-exhausted gpt_code (Codex) integration must not fail the stack's
# compute-token sync and block an otherwise-healthy lifecycle gate. Allow the
# sync to proceed without a usable Codex integration; the compute-token sync
# stays strict everywhere else (default), so Codex regressions still surface in
# the codex-code test that actually uses it.
export SEED_ALLOW_MISSING_GPT_CODE=1

LOG_FILE="$ROOT_DIR/.context/agentcard-lifecycle-$TASK_NAME.log"
STACK_PID=""
HEARTBEAT_PID=""

cleanup() {
  trap - EXIT INT TERM
  cd "$ROOT_DIR"
  if [ -n "$HEARTBEAT_PID" ]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  if [ -n "$STACK_PID" ]; then
    kill -TERM "$STACK_PID" 2>/dev/null || true
    wait "$STACK_PID" 2>/dev/null || true
  fi
  bash scripts/kill-services.sh >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd "$ROOT_DIR"
bash scripts/kill-services.sh >/dev/null 2>&1 || true
# A prior run.sh (or a prior session's stack) may still be completing its final
# process sweep after kill-services returns. Launching run.sh while that sweep is
# draining races the SIGKILL pass and the new stack dies before it writes a line
# to its log. Wait until the ports run.sh needs are actually free (bounded) so a
# fixed sleep can't be outrun by a slow, many-process teardown.
for settle_attempt in $(seq 1 30); do
  ports_busy=""
  for probe_port in "$CONDUCTOR_PORT" "$((CONDUCTOR_PORT + 1))" "$((CONDUCTOR_PORT + 2))"; do
    if lsof -nP -iTCP:"$probe_port" -sTCP:LISTEN >/dev/null 2>&1; then
      ports_busy="$probe_port $ports_busy"
    fi
  done
  if [ -z "$ports_busy" ]; then
    break
  fi
  if [ "$settle_attempt" -eq 1 ]; then
    echo "Waiting for prior stack teardown to release ports: $ports_busy"
  fi
  sleep 1
done
if [ -n "$ports_busy" ]; then
  # Teardown never released the ports within the window. Launching run.sh now
  # would just hit a bind failure/collision, so fail loudly instead.
  echo "Prior stack still owns required ports after teardown wait: $ports_busy" >&2
  exit 1
fi
# Small extra settle so any child-process SIGKILL sweep fully drains after the
# listeners close.
sleep 2

BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 \
  bash scripts/run.sh --benchmark > "$LOG_FILE" 2>&1 &
STACK_PID=$!

ready=false
for readiness_attempt in $(seq 1 120); do
  if ! kill -0 "$STACK_PID" 2>/dev/null; then
    echo "Lifecycle stack exited before becoming ready. Last log lines:" >&2
    tail -80 "$LOG_FILE" >&2 || true
    exit 1
  fi

  if curl -sf "http://localhost:$CONDUCTOR_PORT/health" >/dev/null \
    && curl -sf "http://localhost:$((CONDUCTOR_PORT + 1))/test_payment" >/dev/null \
    && curl -sf "http://localhost:$((CONDUCTOR_PORT + 2))/health" >/dev/null \
    && grep -q "Public tunnel smoke passed" "$LOG_FILE"; then
    ready=true
    break
  fi
  if [ $((readiness_attempt % 10)) -eq 0 ]; then
    echo "Waiting for AgentCard lifecycle stack ($TASK_NAME)..."
  fi
  sleep 1
done

if [ "$ready" != true ]; then
  echo "Lifecycle stack did not become ready in 120 seconds. Last log lines:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

if [ "$BOOTSTRAP_FLAG" = "--bootstrap" ]; then
  read -r LOCAL_DB_ACTUAL_PORT LOCAL_DB_NAME < <(
    python3 - "$ROOT_DIR/.context/services.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    database = json.load(manifest_file)["database"]
print(database["port"], database["name"])
PY
  )
  LOCAL_DB_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_ACTUAL_PORT/$LOCAL_DB_NAME"
  (
    cd "$ROOT_DIR/back-end"
    DATABASE_URL="$LOCAL_DB_URL?connection_limit=50&pool_timeout=30" \
      DIRECT_URL="$LOCAL_DB_URL" \
      npx tsx scripts/setup-benchmark-payment.ts
  )
fi

(while true; do
  sleep 20
  echo "AgentCard lifecycle task still running: $TASK_NAME"
done) &
HEARTBEAT_PID=$!

benchmark_args=(
  benchmarks/run_benchmark.py
  --task "$TASK_NAME"
  --port "$CONDUCTOR_PORT"
  --ci
)
if [ "$BOOTSTRAP_FLAG" = "--bootstrap" ]; then
  benchmark_args+=(--bootstrap)
fi

cd "$ROOT_DIR/agents"
venv/bin/python "${benchmark_args[@]}"
