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
# Export the caller's isolated port/workspace before run.sh sources .cloud-env.
# Without BENCHMARK_ISOLATED_RUN=true, .cloud-env would clobber CONDUCTOR_PORT
# onto the shared Step 5 port and SIGTERM the deploy stack.
export CONDUCTOR_PORT
export CONDUCTOR_WORKSPACE_NAME="${CONDUCTOR_WORKSPACE_NAME:-$(basename "$ROOT_DIR")}"
export BENCHMARK_ISOLATED_RUN=true
export TEMPORAL_TASK_QUEUE="navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME"
export ALLOW_TEMPORAL_CLEANUP=true
# Payment lifecycle tasks must run with the fast-mode LLM cache OFF: cached agent
# decisions from prior runs replay stale patterns (observed: the root agent
# re-spawns the browser after a successful checkout, looping until timeout). Real
# uncached decisions complete the checkout once. Mirrors benchmarks/local.py.
# Force it off unconditionally — a pre-set BENCHMARK_FAST_MODE_CACHE=true would
# otherwise reintroduce the stale-replay loop.
export BENCHMARK_FAST_MODE_CACHE=false
# The lifecycle gate disables Fast Mode, so its startup must not depend on the
# shared production cache pooler. A saturated pooler previously held the schema
# ensure past this helper's 120-second readiness bound before the benchmark even
# received an agent ID. Force run.sh's idempotent schema preflight onto the
# workspace Postgres instead, and clear any inherited remote override so the
# isolation contract cannot be bypassed accidentally.
unset FAST_MODE_CACHE_DATABASE_URL DEMO_CACHE_DATABASE_URL
export FAST_MODE_CACHE_USE_LOCAL=1
# Hosted AgentCard onboarding requires an allowlisted HTTPS callback. The local
# lifecycle benchmark never follows this URL—it completes the sandbox fixture
# through the scoped test-payment API—but minting must still create a genuine
# hosted session before the expected attention gate can be raised. Pin that
# boundary to the stable backend callback registered for the Rose Labs org so a
# workspace-local `.env` URL cannot turn setup/resume into an opaque mint 500.
export AGENTCARD_ONBOARDING_RETURN_URL="${AGENTCARD_ONBOARDING_RETURN_URL:-https://navi-j9a9.onrender.com/api/agentcard/onboarding/callback}"
# These payment-lifecycle tasks drive browser checkout, not Claude Code. The
# deploy-approved Claude smoke owns real Claude coverage and is skippable when
# Claude credentials are unavailable; AgentCard should still run against the
# available GPT compute lane instead of blocking on absent Claude OAuth or a
# cooled-down shared Anthropic fallback.
export ROSE_EXCLUDE_ANTHROPIC_FAMILY=1
export SEED_REQUIRE_COMPUTE_TOKEN_TYPES=gpt
# This stack runs in an isolated database as the admin account and forces the
# customer mint path so stripeHold / payment_approval stay reachable.
export BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH=1
export BENCHMARK_AGENT_PAYMENT_USER_ID="${BENCHMARK_AGENT_PAYMENT_USER_ID:-1f85ff25-6e29-4c1b-8739-f917bd101a30}"
# Keep the synced GPT credential owned by the dev user and expose it through the
# local compute pool; never duplicate that Integration into a synthetic user.
export SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS=1
# The catalog pins every task accepted by this launcher to
# requires_claude_code=false. A missing Claude Code integration must not block
# these root/browser lifecycle checks before an agent exists; Claude-dependent
# benchmark launchers remain strict because this opt-out is scoped to this
# four-task script.
export SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK=1
# These tasks also never spawn a Codex code agent. An externally rate-limited
# or quota-exhausted gpt_code integration must not block their setup. The root
# and browser agent provider still performs its own runtime credential checks.
export SEED_ALLOW_MISSING_GPT_CODE=1
# These sandbox lifecycle tasks use only the bundled /test_payment fixture and
# never consume production browser cookies, passwords, passkeys, or storage.
# Skipping that unrelated graph prevents a warm local database from spending
# minutes upserting every production cookie before the lifecycle stack starts.
export BENCHMARK_SKIP_BROWSER_AUTH_SYNC=1
# AgentCard lifecycle tasks do not simulate against the World Model Harness. A
# WMH build/delta refresh can consume the entire lifecycle readiness window
# before the public tunnel smoke runs, blocking the payment gate even though the
# backend, frontend, and worker are healthy.
export BENCHMARK_SKIP_WMH_BUILD=1

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
      BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH=1 \
      npx tsx scripts/setup-benchmark-payment.ts \
      --user-id "${BENCHMARK_AGENT_PAYMENT_USER_ID:-1f85ff25-6e29-4c1b-8739-f917bd101a30}"
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
