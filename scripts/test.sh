#!/usr/bin/env bash
set -euo pipefail

# ── Root-level test runner ──────────────────────────────────────
#
# Usage:
#   bash scripts/test.sh                              # all offline tests
#   bash scripts/test.sh --smoke                       # + smoke benchmarks (auto-derives port from CONDUCTOR_PORT)
#   bash scripts/test.sh --smoke --port=3001           # + smoke benchmarks (explicit port)
#   bash scripts/test.sh agents                        # single repo
#   bash scripts/test.sh agents web-search             # single domain
#   bash scripts/test.sh back-end                      # backend tests only
#   bash scripts/test.sh back-end auth                 # backend blackbox: auth domain
#   bash scripts/test.sh front-end                     # frontend tests only
#   bash scripts/test.sh --list                        # list available repos/domains
#   bash scripts/test.sh -v                            # verbose — show all output

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Parse flags ──
REPO=""
DOMAIN=""
SMOKE=false
PORT=""
LIST=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --smoke) SMOKE=true ;;
    --port=*) PORT="${arg#--port=}" ;;
    --list) LIST=true ;;
    -v|--verbose) VERBOSE=true ;;
    -*)
      echo "Unknown flag: $arg"
      echo "Usage: bash scripts/test.sh [repo] [domain] [--smoke --port=N] [--list] [-v]"
      exit 1
      ;;
    *)
      if [ -z "$REPO" ]; then
        REPO="$arg"
      elif [ -z "$DOMAIN" ]; then
        DOMAIN="$arg"
      fi
      ;;
  esac
done

# ── List mode ──
if $LIST; then
  echo "Available repos and domains:"
  echo ""
  echo "  agents"
  (cd agents && python scripts/run_blackbox_tests.py --list 2>/dev/null) | sed 's/^/    /'
  echo ""
  echo "  back-end"
  (cd back-end && bash scripts/run-blackbox-tests.sh --list 2>/dev/null) | sed 's/^/    /'
  echo ""
  echo "  front-end"
  (cd front-end && bash scripts/run-blackbox-tests.sh --list 2>/dev/null) | sed 's/^/    /'
  echo "    (semantic — requires --smoke):"
  (cd front-end && bash scripts/run-semantic-tests.sh --list 2>/dev/null) | sed 's/^/    /'
  echo ""
  echo "  research"
  (cd research && bash scripts/run-blackbox-tests.sh --list 2>/dev/null) | sed 's/^/    /'
  exit 0
fi

# ── Smoke validation ──
# Auto-derive port from CONDUCTOR_PORT if --port not explicitly passed
if $SMOKE && [ -z "$PORT" ] && [ -n "${CONDUCTOR_PORT:-}" ]; then
  PORT="$CONDUCTOR_PORT"
fi
if $SMOKE && [ -z "$PORT" ]; then
  echo "ERROR: --port=N is required when using --smoke (or set CONDUCTOR_PORT)."
  echo "Example: bash scripts/test.sh --smoke --port=3001"
  exit 1
fi

# ── Track results ──
SUITE_NAMES=()
SUITE_STATUSES=()
SUITE_LOGS=()
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

run_suite() {
  local name="$1"
  shift
  local logfile="$TMPDIR_BASE/$(echo "$name" | tr ' ()' '___').log"

  if $VERBOSE; then
    echo ""
    echo "── $name ──"
    if "$@" 2>&1 | tee "$logfile"; then
      SUITE_NAMES+=("$name")
      SUITE_STATUSES+=("pass")
      SUITE_LOGS+=("$logfile")
    else
      SUITE_NAMES+=("$name")
      SUITE_STATUSES+=("fail")
      SUITE_LOGS+=("$logfile")
    fi
  else
    if "$@" > "$logfile" 2>&1; then
      SUITE_NAMES+=("$name")
      SUITE_STATUSES+=("pass")
      SUITE_LOGS+=("$logfile")
    else
      SUITE_NAMES+=("$name")
      SUITE_STATUSES+=("fail")
      SUITE_LOGS+=("$logfile")
    fi
  fi
}

# Launch a suite in the background — collect with collect_bg_suites later
BG_PIDS=()
BG_NAMES=()
BG_LOGS=()

bg_suite() {
  local name="$1"
  shift
  local logfile="$TMPDIR_BASE/$(echo "$name" | tr ' ()' '___').log"

  if $VERBOSE; then
    # Use pipefail so tee doesn't mask the command's exit code
    bash -c 'set -o pipefail; "$@" 2>&1 | tee "'"$logfile"'"' _ "$@" &
  else
    "$@" > "$logfile" 2>&1 &
  fi
  BG_PIDS+=($!)
  BG_NAMES+=("$name")
  BG_LOGS+=("$logfile")
}

collect_bg_suites() {
  for i in "${!BG_PIDS[@]}"; do
    if wait "${BG_PIDS[$i]}"; then
      SUITE_NAMES+=("${BG_NAMES[$i]}")
      SUITE_STATUSES+=("pass")
      SUITE_LOGS+=("${BG_LOGS[$i]}")
    else
      SUITE_NAMES+=("${BG_NAMES[$i]}")
      SUITE_STATUSES+=("fail")
      SUITE_LOGS+=("${BG_LOGS[$i]}")
    fi
  done
  BG_PIDS=()
  BG_NAMES=()
  BG_LOGS=()
}

# ── Run suites ──

should_run() {
  [ -z "$REPO" ] || [ "$REPO" = "$1" ]
}

# ── Build checks (run in parallel with blackbox tests) ──
BUILD_PIDS=()
BUILD_NAMES=()
BUILD_LOGS=()

if should_run "front-end"; then
  FE_BUILD_LOG="$TMPDIR_BASE/fe_build.log"
  bash -c "cd front-end && npx vite build" > "$FE_BUILD_LOG" 2>&1 &
  BUILD_PIDS+=($!)
  BUILD_NAMES+=("Frontend Build")
  BUILD_LOGS+=("$FE_BUILD_LOG")
fi

if should_run "mac-app"; then
  MAC_BUILD_LOG="$TMPDIR_BASE/mac_build.log"
  bash -c "cd mac-app && npx vite build && npx tsc -p tsconfig.main.json" > "$MAC_BUILD_LOG" 2>&1 &
  BUILD_PIDS+=($!)
  BUILD_NAMES+=("Mac App Build")
  BUILD_LOGS+=("$MAC_BUILD_LOG")
fi

# ── Blackbox tests (parallel) ──

if should_run "agents"; then
  if [ -n "$DOMAIN" ] && [ "$REPO" = "agents" ]; then
    bg_suite "Agents Blackbox ($DOMAIN)" bash -c "cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py $DOMAIN"
  else
    bg_suite "Agents Blackbox" bash -c "cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py"
  fi
fi

if should_run "back-end"; then
  bg_suite "Backend Structural" bash -c "cd back-end && npx tsx src/tests/structural/layer-deps.test.ts"

  if [ -n "$DOMAIN" ] && [ "$REPO" = "back-end" ]; then
    bg_suite "Backend Blackbox ($DOMAIN)" bash -c "cd back-end && bash scripts/run-blackbox-tests.sh $DOMAIN"
  else
    bg_suite "Backend Blackbox" bash -c "cd back-end && bash scripts/run-blackbox-tests.sh"
  fi
fi

if should_run "front-end"; then
  if [ -n "$DOMAIN" ] && [ "$REPO" = "front-end" ]; then
    bg_suite "Frontend Blackbox ($DOMAIN)" bash -c "cd front-end && bash scripts/run-blackbox-tests.sh $DOMAIN"
  else
    bg_suite "Frontend Blackbox" bash -c "cd front-end && bash scripts/run-blackbox-tests.sh"
  fi
fi

if should_run "research"; then
  if ! command -v deno &>/dev/null && ! [ -x "${DENO_BIN:-$HOME/.deno/bin/deno}" ]; then
    echo "ERROR: Deno is not installed. Research blackbox tests require Deno."
    echo "  Install: curl -fsSL https://deno.land/install.sh | sh"
    exit 1
  fi

  # Derive RESEARCH_PORT from --port if available (port + 3 matches run.sh fan-out)
  RESEARCH_PORT_EXPORT=""
  if [ -n "$PORT" ]; then
    RESEARCH_PORT_EXPORT="RESEARCH_PORT=$((PORT + 3))"
  fi
  if [ -n "$DOMAIN" ] && [ "$REPO" = "research" ]; then
    bg_suite "Research Blackbox ($DOMAIN)" bash -c "cd research && $RESEARCH_PORT_EXPORT bash scripts/run-blackbox-tests.sh $DOMAIN"
  else
    bg_suite "Research Blackbox" bash -c "cd research && $RESEARCH_PORT_EXPORT bash scripts/run-blackbox-tests.sh"
  fi
fi

# ── Wait for all blackbox suites ──
collect_bg_suites

# ── Smoke tests (parallel, only if --smoke --port=N) ──
if $SMOKE; then
  # Derive TEMPORAL_TASK_QUEUE from CONDUCTOR_WORKSPACE_NAME so the benchmark's
  # stale-workflow cleanup targets the correct Temporal Cloud task queue.
  SMOKE_TASK_QUEUE="navi-agent-tasks-${CONDUCTOR_WORKSPACE_NAME:-local}"
  bg_suite "Smoke Benchmarks" bash -c "cd agents && source venv/bin/activate && TEMPORAL_TASK_QUEUE=$SMOKE_TASK_QUEUE ALLOW_TEMPORAL_CLEANUP=true python benchmarks/run_benchmark.py --suite smoke --port $PORT --ci --parallel"

  # Frontend semantic tests (Chrome CDP, requires running frontend)
  SEMANTIC_BACKEND_PORT="$PORT"
  SEMANTIC_FRONTEND_PORT="$((PORT + 1))"
  if curl -s "http://localhost:$SEMANTIC_FRONTEND_PORT" > /dev/null 2>&1; then
    for f in front-end/src/tests/semantic/*.semantic.md; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .semantic.md)
      bg_suite "Frontend Semantic ($name)" bash -c "cd front-end && BACKEND_PORT=$SEMANTIC_BACKEND_PORT FRONTEND_PORT=$SEMANTIC_FRONTEND_PORT bash scripts/run-semantic-tests.sh $name"
    done
  else
    echo "  ℹ Skipping semantic tests — frontend not running on port $SEMANTIC_FRONTEND_PORT"
  fi

  collect_bg_suites
fi

# ── Collect build results (waited until blackbox tests finish) ──
for i in "${!BUILD_PIDS[@]}"; do
  if wait "${BUILD_PIDS[$i]}"; then
    SUITE_NAMES+=("${BUILD_NAMES[$i]}")
    SUITE_STATUSES+=("pass")
    SUITE_LOGS+=("${BUILD_LOGS[$i]}")
  else
    SUITE_NAMES+=("${BUILD_NAMES[$i]}")
    SUITE_STATUSES+=("fail")
    SUITE_LOGS+=("${BUILD_LOGS[$i]}")
  fi
done

# ── Report card ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  TEST REPORT"
echo "═══════════════════════════════════════════════════"

FAIL_COUNT=0
for i in "${!SUITE_NAMES[@]}"; do
  if [ "${SUITE_STATUSES[$i]}" = "pass" ]; then
    echo "  ✅ ${SUITE_NAMES[$i]}"
  else
    echo "  ❌ ${SUITE_NAMES[$i]}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo "═══════════════════════════════════════════════════"

# ── Show failure details ──
if [ $FAIL_COUNT -gt 0 ]; then
  echo ""
  for i in "${!SUITE_NAMES[@]}"; do
    if [ "${SUITE_STATUSES[$i]}" = "fail" ]; then
      echo "── ${SUITE_NAMES[$i]} failures ──"
      # Extract failure summaries: ❌ lines, FAIL lines, assertion diffs (no stack traces)
      grep -E '❌|^--- FAIL|^  FAIL|^FAILURES|Expected.*got|Received|assert.*failed' "${SUITE_LOGS[$i]}" | head -40
      echo ""
    fi
  done
  echo "Full logs: $TMPDIR_BASE/"
fi

[ $FAIL_COUNT -eq 0 ]
