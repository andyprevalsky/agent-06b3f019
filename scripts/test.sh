#!/usr/bin/env bash
set -euo pipefail

# ── Root-level test runner ──────────────────────────────────────
#
# Usage:
#   bash scripts/test.sh                              # all offline tests
#   bash scripts/test.sh --smoke --port=3001           # + smoke benchmarks
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
  echo ""
  echo "  research"
  echo "    deno-tests  (requires Deno + running Supabase)"
  exit 0
fi

# ── Smoke validation ──
if $SMOKE && [ -z "$PORT" ]; then
  echo "ERROR: --port=N is required when using --smoke."
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

# ── Blackbox tests (sequential) ──

if should_run "agents"; then
  if [ -n "$DOMAIN" ] && [ "$REPO" = "agents" ]; then
    run_suite "Agents Blackbox ($DOMAIN)" bash -c "cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py $DOMAIN"
  else
    run_suite "Agents Blackbox" bash -c "cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py"
  fi
fi

if should_run "back-end"; then
  run_suite "Backend Structural" bash -c "cd back-end && npx tsx src/tests/structural/layer-deps.test.ts"

  if [ -n "$DOMAIN" ] && [ "$REPO" = "back-end" ]; then
    run_suite "Backend Blackbox ($DOMAIN)" bash -c "cd back-end && bash scripts/run-blackbox-tests.sh $DOMAIN"
  else
    run_suite "Backend Blackbox" bash -c "cd back-end && bash scripts/run-blackbox-tests.sh"
  fi
fi

if should_run "front-end"; then
  if [ -n "$DOMAIN" ] && [ "$REPO" = "front-end" ]; then
    run_suite "Frontend Blackbox ($DOMAIN)" bash -c "cd front-end && bash scripts/run-blackbox-tests.sh $DOMAIN"
  else
    run_suite "Frontend Blackbox" bash -c "cd front-end && bash scripts/run-blackbox-tests.sh"
  fi
fi

if should_run "research"; then
  if command -v deno &>/dev/null; then
    run_suite "Research Deno Tests" bash -c "cd research && bash run-tests.sh"
  else
    echo "  ⚠️  Skipping research tests (Deno not installed)"
  fi
fi

# ── Smoke benchmarks (only if --smoke --port=N) ──
if $SMOKE; then
  run_suite "Smoke Benchmarks" bash -c "cd agents && source venv/bin/activate && python benchmarks/run_benchmark.py --suite smoke --port $PORT --ci --parallel"
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
