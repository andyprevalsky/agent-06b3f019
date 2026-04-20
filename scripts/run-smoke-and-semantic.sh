#!/usr/bin/env bash
set -eo pipefail

# Combined smoke + semantic test runner.
#
# Runs the two tiers in parallel:
#   - Smoke benchmarks (autonomous): `benchmarks/run_benchmark.py --suite smoke`
#     kicked off in the background, its log tailed to `.context/deploy-smoke.log`.
#   - Semantic tests (Claude-driven): this script prints the test bodies to
#     stdout and the caller (Claude) drives each via Chrome CDP, recording
#     results through `front-end/scripts/run-semantic-tests.sh --record`.
#
# The script only exits 0 when BOTH gates are green:
#   - Smoke benchmark process exited 0.
#   - Every *.semantic.md file in front-end/src/tests/semantic/ has a matching
#     .context/semantic-results/<name>.json with status=pass AND head_sha
#     matching the current HEAD.
#
# This is what prevents the "smoke went green, I forgot semantic" failure mode
# that nuked the last /deploy run.
#
# Usage:
#   CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=foo \
#     bash scripts/run-smoke-and-semantic.sh
#
# Prereqs (caller responsibility):
#   - `scripts/run.sh --benchmark` running in a parallel terminal with
#     back-end + front-end + agents all healthy on $CONDUCTOR_PORT.
#   - Temporal credentials in agents/.env.
#   - Chrome with the Claude extension connected (for Claude to drive CDP).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${CONDUCTOR_PORT:?CONDUCTOR_PORT must be set}"
: "${CONDUCTOR_WORKSPACE_NAME:?CONDUCTOR_WORKSPACE_NAME must be set}"

BACKEND_URL="http://localhost:$CONDUCTOR_PORT"
FRONTEND_URL="http://localhost:$((CONDUCTOR_PORT + 1))"
SMOKE_LOG="$REPO_ROOT/.context/deploy-smoke.log"
SEMANTIC_DIR="$REPO_ROOT/front-end/src/tests/semantic"
RESULTS_DIR="$REPO_ROOT/.context/semantic-results"
HEAD_SHA="$(git rev-parse HEAD)"

mkdir -p "$(dirname "$SMOKE_LOG")" "$RESULTS_DIR"

# Clear stale semantic results so we only gate on results recorded this run.
rm -f "$RESULTS_DIR"/*.json

echo "=========================================="
echo "Combined smoke + semantic runner"
echo "  HEAD:        $HEAD_SHA"
echo "  backend:     $BACKEND_URL"
echo "  frontend:    $FRONTEND_URL"
echo "  smoke log:   $SMOKE_LOG"
echo "  results dir: $RESULTS_DIR"
echo "=========================================="

# Health check both services before committing to a run.
if ! curl -sf "$BACKEND_URL/health" > /dev/null; then
  echo "FAIL: backend unhealthy at $BACKEND_URL — is scripts/run.sh --benchmark running?" >&2
  exit 1
fi
if ! curl -sf "$FRONTEND_URL" > /dev/null; then
  echo "FAIL: frontend unreachable at $FRONTEND_URL — is scripts/run.sh --benchmark running?" >&2
  exit 1
fi

# List the semantic tests the gate will require.
# (avoid `mapfile` — bash 3.2 on stock macOS doesn't ship it)
SEMANTIC_TESTS=()
for f in "$SEMANTIC_DIR"/*.semantic.md; do
  [ -f "$f" ] || continue
  SEMANTIC_TESTS+=("$(basename "$f" .semantic.md)")
done
echo ""
echo "Semantic tests to be driven in parallel (${#SEMANTIC_TESTS[@]}):"
for name in "${SEMANTIC_TESTS[@]}"; do
  echo "  - $name"
done

# Kick off smoke in the background. Log goes to $SMOKE_LOG; PID is captured
# so we can wait on it and surface its exit code.
echo ""
echo "Starting smoke benchmarks in background..."
(
  cd "$REPO_ROOT/agents"
  # Activate venv if present (local dev) or fall back to system python (CI).
  if [ -f venv/bin/activate ]; then
    # shellcheck disable=SC1091
    source venv/bin/activate
  fi
  TEMPORAL_TASK_QUEUE="navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME" \
    ALLOW_TEMPORAL_CLEANUP=true \
    python benchmarks/run_benchmark.py \
      --suite smoke \
      --port "$CONDUCTOR_PORT" \
      --ci \
      --parallel
) > "$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
echo "Smoke PID: $SMOKE_PID (tail $SMOKE_LOG for progress)"

# Emit the semantic test bodies so the caller (Claude) can drive them via CDP
# while smoke runs. The caller MUST record each result via:
#   bash front-end/scripts/run-semantic-tests.sh --record <name> <pass|fail> [reason]
echo ""
echo "=========================================="
echo "SEMANTIC TEST INSTRUCTIONS (drive in parallel with smoke)"
echo "=========================================="
for name in "${SEMANTIC_TESTS[@]}"; do
  echo ""
  echo "---- semantic test: $name ----"
  cat "$SEMANTIC_DIR/${name}.semantic.md"
  echo ""
  echo "---- record result with: ----"
  echo "bash front-end/scripts/run-semantic-tests.sh --record $name pass"
  echo "bash front-end/scripts/run-semantic-tests.sh --record $name fail \"<reason>\""
done
echo ""
echo "=========================================="
echo "Waiting for smoke to finish (PID $SMOKE_PID)..."
echo "=========================================="

set +e
wait "$SMOKE_PID"
SMOKE_EXIT=$?
set -e

echo ""
echo "Smoke exit code: $SMOKE_EXIT"

# Validate semantic results — must exist, must be 'pass', must match HEAD.
SEMANTIC_FAIL=0
echo ""
echo "Checking semantic gate..."
for name in "${SEMANTIC_TESTS[@]}"; do
  RESULT_FILE="$RESULTS_DIR/${name}.json"
  if [ ! -f "$RESULT_FILE" ]; then
    echo "  [MISSING] $name — no result recorded"
    SEMANTIC_FAIL=1
    continue
  fi
  STATUS="$(python3 -c "import json,sys; print(json.load(open('$RESULT_FILE')).get('status',''))")"
  RESULT_SHA="$(python3 -c "import json,sys; print(json.load(open('$RESULT_FILE')).get('head_sha',''))")"
  if [ "$RESULT_SHA" != "$HEAD_SHA" ]; then
    echo "  [STALE]   $name — recorded against $RESULT_SHA, HEAD is $HEAD_SHA"
    SEMANTIC_FAIL=1
    continue
  fi
  if [ "$STATUS" != "pass" ]; then
    REASON="$(python3 -c "import json,sys; print(json.load(open('$RESULT_FILE')).get('reason',''))")"
    echo "  [FAIL]    $name — $STATUS ($REASON)"
    SEMANTIC_FAIL=1
    continue
  fi
  echo "  [PASS]    $name"
done

echo ""
if [ "$SMOKE_EXIT" -ne 0 ] || [ "$SEMANTIC_FAIL" -ne 0 ]; then
  echo "FAIL — smoke_exit=$SMOKE_EXIT semantic_fail=$SEMANTIC_FAIL"
  exit 1
fi
echo "PASS — smoke 5/5 + all semantic tests green"
exit 0
