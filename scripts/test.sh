#!/usr/bin/env bash
set -euo pipefail

# ── Root-level test runner ──────────────────────────────────────
#
# Runs EVERYTHING by default: offline suites + smoke (which bundles the
# Playwright semantic tests). Flags disable suites — they never enable them.
#
# Usage:
#   bash scripts/test.sh                              # offline + smoke + semantic (auto-port from CONDUCTOR_PORT)
#   bash scripts/test.sh --port=3001                   # explicit port
#   bash scripts/test.sh --full                        # offline + full benchmark suite against prod
#   bash scripts/test.sh --no-smoke                    # offline-only (skips smoke + semantic)
#   bash scripts/test.sh --mandatory-human-approval-retrieved=true
#                                                       # required when prompt edits are present
#   bash scripts/test.sh agents                        # single repo
#   bash scripts/test.sh agents web-search             # single domain
#   bash scripts/test.sh back-end                      # backend tests only
#   bash scripts/test.sh back-end auth                 # backend blackbox: auth domain
#   bash scripts/test.sh front-end                     # frontend tests only
#   bash scripts/test.sh mac-app                       # mac-app tests only
#   bash scripts/test.sh mac-app onboarding            # mac-app blackbox: onboarding domain
#   bash scripts/test.sh --auto-rca-changed-from=<sha> # trusted diff-scoped Auto-RCA offline gate
#   bash scripts/test.sh --list                        # list available repos/domains
#   bash scripts/test.sh -v                            # verbose — show all output

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# mac-app is Electron + macOS-only; skip its build on non-Darwin hosts.
IS_MAC=false
[ "$(uname)" = "Darwin" ] && IS_MAC=true

# ── Parse flags ──
REPO=""
DOMAIN=""
SMOKE=true
FULL=false
PORT=""
LIST=false
VERBOSE=false
PROMPT_HUMAN_APPROVAL_RETRIEVED=false
AGENT_BEHAVIOR_APPROVAL_RETRIEVED=false
LLM_TRAJECTORY_INJECTION_APPROVAL_RETRIEVED=false
DEFER_APPROVAL_TO_EXACT_HEAD_REVIEW=false
AUTO_RCA_BASE_SHA=""
FULL_MAX_CONCURRENCY="${BENCHMARK_PROD_MAX_CONCURRENCY:-5}"

for arg in "$@"; do
  case "$arg" in
    --full) FULL=true ;;
    --no-smoke) SMOKE=false ;;
    --port=*) PORT="${arg#--port=}" ;;
    --list) LIST=true ;;
    -v|--verbose) VERBOSE=true ;;
    mandatory-human-approval-retrieved=true|--mandatory-human-approval-retrieved=true)
      PROMPT_HUMAN_APPROVAL_RETRIEVED=true
      ;;
    mandatory-human-approval-retrieved=false|--mandatory-human-approval-retrieved=false)
      PROMPT_HUMAN_APPROVAL_RETRIEVED=false
      ;;
    agent-behavior-approval-retrieved=true|--agent-behavior-approval-retrieved=true)
      AGENT_BEHAVIOR_APPROVAL_RETRIEVED=true
      ;;
    agent-behavior-approval-retrieved=false|--agent-behavior-approval-retrieved=false)
      AGENT_BEHAVIOR_APPROVAL_RETRIEVED=false
      ;;
    llm-trajectory-injection-approval-retrieved=true|--llm-trajectory-injection-approval-retrieved=true)
      LLM_TRAJECTORY_INJECTION_APPROVAL_RETRIEVED=true
      ;;
    llm-trajectory-injection-approval-retrieved=false|--llm-trajectory-injection-approval-retrieved=false)
      LLM_TRAJECTORY_INJECTION_APPROVAL_RETRIEVED=false
      ;;
    defer-human-approval-to-exact-head-pr-review=true|--defer-human-approval-to-exact-head-pr-review=true)
      DEFER_APPROVAL_TO_EXACT_HEAD_REVIEW=true
      ;;
    --auto-rca-changed-from=*)
      AUTO_RCA_BASE_SHA="${arg#--auto-rca-changed-from=}"
      ;;
    -*)
      echo "Unknown flag: $arg"
      echo "Usage: bash scripts/test.sh [repo] [domain] [--full] [--no-smoke] [--port=N] [--list] [-v] [--mandatory-human-approval-retrieved=true] [--agent-behavior-approval-retrieved=true] [--llm-trajectory-injection-approval-retrieved=true]"
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

AUTO_RCA_MODE=false
AUTO_RCA_CHANGED=""
if [ -n "$AUTO_RCA_BASE_SHA" ]; then
  [[ "$AUTO_RCA_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: --auto-rca-changed-from requires a full commit SHA."
    exit 1
  }
  git cat-file -e "$AUTO_RCA_BASE_SHA^{commit}" || {
    echo "ERROR: Auto-RCA baseline commit is unavailable: $AUTO_RCA_BASE_SHA"
    exit 1
  }
  AUTO_RCA_MODE=true
  SMOKE=false
  AUTO_RCA_CHANGED="$(git diff --name-only "$AUTO_RCA_BASE_SHA" HEAD)"
  [ -n "$AUTO_RCA_CHANGED" ] || {
    echo "ERROR: Auto-RCA offline gate requires a non-empty baseline diff."
    exit 1
  }
  echo "Auto-RCA changed paths:"
  printf '%s\n' "$AUTO_RCA_CHANGED" | sed 's/^/  - /'
fi

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
  echo "    (semantic — runs under smoke):"
  (cd front-end && bash scripts/run-semantic-tests.sh --list 2>/dev/null) | sed 's/^/    /'
  echo ""
  echo "  mac-app"
  (cd mac-app && bash scripts/run-blackbox-tests.sh --list 2>/dev/null) | sed 's/^/    /'
  echo ""
  echo "  benchmarks"
  (cd agents && source venv/bin/activate && python benchmarks/run_benchmark.py --list 2>/dev/null) | sed 's/^/    /'
  echo "    (--full prod max concurrency: $FULL_MAX_CONCURRENCY)"
  exit 0
fi

# ── Smoke validation ──
# Smoke only runs on full-repo (unscoped) invocations. When REPO is set
# (e.g. `scripts/test.sh back-end`), smoke is off regardless of default.
if [ -n "$REPO" ]; then
  if $FULL; then
    echo "ERROR: --full runs the full prod benchmark suite and cannot be combined with repo/domain filters."
    echo "Use: bash scripts/test.sh --full"
    exit 1
  fi
  SMOKE=false
fi
if $FULL && ! $SMOKE; then
  echo "ERROR: --full cannot be combined with --no-smoke."
  echo "Use: bash scripts/test.sh --full"
  exit 1
fi

# Auto-derive port from CONDUCTOR_PORT if --port not explicitly passed
if $SMOKE && ! $FULL && [ -z "$PORT" ] && [ -n "${CONDUCTOR_PORT:-}" ]; then
  PORT="$CONDUCTOR_PORT"
fi
if $SMOKE && ! $FULL && [ -z "$PORT" ]; then
  echo "ERROR: smoke requires a port (set CONDUCTOR_PORT or pass --port=N; pass --no-smoke to skip)."
  echo "Example: bash scripts/test.sh --port=3001"
  exit 1
fi
if $FULL && [ -n "$PORT" ]; then
  echo "ERROR: --full runs benchmarks against prod and cannot be combined with --port."
  echo "Use local smoke without --full when targeting localhost."
  exit 1
fi
# Validate PORT is a decimal integer in the IANA range — downstream arithmetic
# ($((PORT + 1)) / $((PORT + 3))) silently misbehaves on non-numeric input.
if [ -n "$PORT" ]; then
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "ERROR: invalid port '$PORT' — must be an integer in 1..65535."
    exit 1
  fi
fi
# Validate FULL_MAX_CONCURRENCY (from BENCHMARK_PROD_MAX_CONCURRENCY) the same
# way — it is handed to the prod benchmark runner and must be a positive integer.
if $FULL; then
  if ! [[ "$FULL_MAX_CONCURRENCY" =~ ^[0-9]+$ ]] || [ "$FULL_MAX_CONCURRENCY" -lt 1 ]; then
    echo "ERROR: invalid BENCHMARK_PROD_MAX_CONCURRENCY '$FULL_MAX_CONCURRENCY' — must be a positive integer."
    exit 1
  fi
fi

# ── Track results ──
SUITE_NAMES=()
SUITE_STATUSES=()
SUITE_LOGS=()
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_STAMP="$(date +%Y%m%d-%H%M%S)-$$"
TMPDIR_BASE="$REPO_ROOT/.test-logs/$RUN_STAMP"
mkdir -p "$TMPDIR_BASE"
ln -sfn "$RUN_STAMP" "$REPO_ROOT/.test-logs/latest"
# Prune: keep only the 10 most recent run dirs
ls -1dt "$REPO_ROOT/.test-logs"/*/ 2>/dev/null | tail -n +11 | xargs -I{} rm -rf {} 2>/dev/null || true

run_suite() {
  local name="$1"
  local logfile
  shift
  logfile="$TMPDIR_BASE/$(echo "$name" | tr ' ()' '___').log"

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
  local logfile
  shift
  logfile="$TMPDIR_BASE/$(echo "$name" | tr ' ()' '___').log"

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
  if $AUTO_RCA_MODE; then
    printf '%s\n' "$AUTO_RCA_CHANGED" | grep -Eq "^$1/"
    return
  fi
  [ -z "$REPO" ] || [ "$REPO" = "$1" ]
}

auto_rca_changed() {
  local pattern="$1"
  ! $AUTO_RCA_MODE || printf '%s\n' "$AUTO_RCA_CHANGED" | grep -Eq "$pattern"
}

if $DEFER_APPROVAL_TO_EXACT_HEAD_REVIEW; then
  if $PROMPT_HUMAN_APPROVAL_RETRIEVED || $AGENT_BEHAVIOR_APPROVAL_RETRIEVED || $LLM_TRAJECTORY_INJECTION_APPROVAL_RETRIEVED; then
    echo "ERROR: human approval cannot be both retrieved and deferred."
    exit 1
  fi
  run_suite "Prompt Human Approval Guard" bash scripts/check-prompt-human-approval.sh \
    --defer-human-approval-to-exact-head-pr-review=true
  run_suite "Agent Behavior Approval Guard" bash scripts/check-agent-behavior-approval.sh \
    --defer-human-approval-to-exact-head-pr-review=true
  run_suite "LLM Trajectory Injection Approval Guard" bash scripts/check-llm-trajectory-injection-approval.sh \
    --defer-human-approval-to-exact-head-pr-review=true
elif $PROMPT_HUMAN_APPROVAL_RETRIEVED; then
  run_suite "Prompt Human Approval Guard" bash scripts/check-prompt-human-approval.sh mandatory-human-approval-retrieved=true
else
  run_suite "Prompt Human Approval Guard" bash scripts/check-prompt-human-approval.sh
fi
if $DEFER_APPROVAL_TO_EXACT_HEAD_REVIEW; then
  : # All three approval guards ran together above.
elif $AGENT_BEHAVIOR_APPROVAL_RETRIEVED; then
  run_suite "Agent Behavior Approval Guard" bash scripts/check-agent-behavior-approval.sh mandatory-human-approval-retrieved=true
else
  run_suite "Agent Behavior Approval Guard" bash scripts/check-agent-behavior-approval.sh
fi
if $DEFER_APPROVAL_TO_EXACT_HEAD_REVIEW; then
  :
elif $LLM_TRAJECTORY_INJECTION_APPROVAL_RETRIEVED; then
  run_suite "LLM Trajectory Injection Approval Guard" bash scripts/check-llm-trajectory-injection-approval.sh mandatory-human-approval-retrieved=true
else
  run_suite "LLM Trajectory Injection Approval Guard" bash scripts/check-llm-trajectory-injection-approval.sh
fi
run_suite "Agent Behavior Guard Unit Tests" bash scripts/tests/check-agent-behavior-approval.test.sh
run_suite "LLM Trajectory Injection Guard Unit Tests" bash scripts/tests/check-llm-trajectory-injection-approval.test.sh
run_suite "Factory Metadata" python3 scripts/tests/factory-metadata.test.py
run_suite "Factory Review Telemetry" python3 scripts/tests/factory-review.test.py
run_suite "Biz Review Card" python3 scripts/biz_review.py self-test
run_suite "Deploy Stage Telemetry" bash scripts/tests/run-deploy-stage.test.sh
run_suite "run.sh Process Tree Reaper" bash scripts/tests/run-sh-kill-tree.test.sh
run_suite "Devbox Teardown" bash scripts/tests/devbox-teardown.test.sh
run_suite "Fleet Post-Child Autoscaler Settle" bash scripts/tests/fleet-post-child-settle.test.sh
run_suite "RCA Model Intelligence Contract" bash scripts/tests/rca-model-intelligence-category.test.sh
run_suite "RCA Prompt-Edit Abstraction Contract" bash scripts/tests/rca-prompt-edit-abstraction.test.sh
run_suite "RCA Archive New Command" bash scripts/tests/rca-archive-new.test.sh
run_suite "Claude Review Fallback" bash scripts/tests/claude-review-fallback.test.sh
run_suite "Semantic Deploy Gate" bash scripts/tests/semantic-deploy-gate.test.sh
run_suite "Descend Command" bash scripts/tests/descend-command.test.sh
run_suite "Benchmark Live Results" python3 scripts/tests/benchmark-live-results.test.py
run_suite "Benchmark Scorecard" python3 scripts/tests/cloudbench-scorecard.test.py
run_suite "Benchmark Campaign Grouping" bash scripts/tests/campaign-hub-grouping.test.sh
run_suite "Benchmark Successful LLM Evidence" python3 scripts/tests/verify-successful-llm-queries.test.py
run_suite "Original600 Portable Operator" python3 scripts/tests/original600-portable-operator.test.py
run_suite "Benchmark Provider Rate-Limit Concurrency Cap" python3 scripts/tests/cloudbench-provider-capacity.test.py
run_suite "Sharded Benchmark Controllers" python3 scripts/tests/cloudbench-shard-coordinator.test.py
run_suite "Sharded Benchmark Waves" python3 scripts/tests/run-bench-sharded-waves.test.py
run_suite "Original600 Bulk Controller Transfer" python3 scripts/tests/cloudbench-controller-bulk-transfer.test.py
run_suite "Original600 Existing Controller Payload Recovery" python3 scripts/tests/cloudbench-resume-controller-payload.test.py
run_suite "Original600 Recovered Controller Finalization" python3 scripts/tests/cloudbench-controller-payload-finalization.test.py
run_suite "Original600 Pre-Supervisor Finalization" python3 scripts/tests/cloudbench-startup-finalization.test.py
run_suite "Cloud Benchmark Campaign Environment" python3 scripts/tests/cloudbench-campaign-env.test.py
run_suite "Original600 Public Status" python3 scripts/tests/original600-status.test.py
run_suite "Cloud Benchmark Stdlib Startup" python3 scripts/tests/cloudbench-site-startup.test.py
run_suite "Cloud Benchmark Hub Admission Stdlib Startup" python3 scripts/tests/cloudbench-hub-admission-site-startup.test.py
run_suite "Cloud Benchmark Persistent Aggregator" python3 scripts/tests/cloudbench-persistent-aggregator.test.py
run_suite "Cloud Benchmark Fleet Card Stdlib Startup" python3 scripts/tests/cloudbench-fleet-card-site-startup.test.py
run_suite "Cloud Benchmark Native Stdlib Startup" python3 scripts/tests/cloudbench-native-site-startup.test.py
run_suite "Cloud Benchmark Start Accounting" python3 scripts/tests/cloudbench-start-accounting.test.py
run_suite "Cloud Benchmark Archived Machine Reuse" python3 scripts/tests/cloudbench-archived-machine-reuse.test.py
run_suite "Cloud Benchmark Unused Reservations" python3 scripts/tests/cloudbench-unused-reservations.test.py
run_suite "Cloud Benchmark Parked Reservations" python3 scripts/tests/cloudbench-parked-reservations.test.py
run_suite "Cloud Benchmark Reservation Reconciliation" python3 scripts/tests/cloudbench-reconcile-reservations.test.py
run_suite "Cloud Benchmark Incomplete Reservations" python3 scripts/tests/cloudbench-incomplete-reservations.test.py
run_suite "Cloud Benchmark Recovered Reservations" python3 scripts/tests/cloudbench-recovered-reservations.test.py
run_suite "Cloud Benchmark Closed Transition Reservations" python3 scripts/tests/cloudbench-closed-transition-reservations.test.py
run_suite "Cloud Benchmark Pre-Reservation Preparation" python3 scripts/tests/cloudbench-prepare-admission.test.py
run_suite "Cloud Benchmark Reuse Index" python3 scripts/tests/cloudbench-reuse-index.test.py
run_suite "Cloud Benchmark Guest pidfd Interpreter" python3 scripts/tests/pidfd-interpreter.test.py
run_suite "Cloud Benchmark Registered Orphan Drain" python3 scripts/tests/cloudbench-controller-orphan-drain.test.py
run_suite "Cloud Benchmark Relay Bootstrap Retirement" python3 scripts/tests/cloudbench-controller-relay-retire.test.py
run_suite "Cloud Benchmark Recovered Controller Export" python3 scripts/tests/cloudbench-resume-controller-export.test.py
run_suite "Cloud Benchmark Archived Cloud Transport" python3 scripts/tests/cloudbench-archived-transport.test.py
run_suite "Cloud Benchmark Archived Reuse Stream Transport" python3 scripts/tests/cloudbench-archived-reuse-transport.test.py
run_suite "Cloud Benchmark Isolated Generation" python3 scripts/tests/cloudbench-isolated-generation.test.py
run_suite "Cloud Benchmark Archived Owner Stop" python3 scripts/tests/cloudbench-archived-owner-stop.test.py
run_suite "Cloud Benchmark Forensic Resource Closure" python3 scripts/tests/cloudbench-forensic-resource-closure.test.py
run_suite "Cloud Benchmark Local Forensic Closure" python3 scripts/tests/cloudbench-local-forensic-closure.test.py
run_suite "Cloud Benchmark Status Readiness Observability" python3 scripts/tests/cloudbench-status-readiness-observability.test.py
run_suite "Cloud Benchmark Pre-Terminal Infra Release" python3 scripts/tests/cloudbench-preterminal-infra-release.test.py
run_suite "Controller Operator Preflight" python3 scripts/tests/cloudbench-operator-preflight.test.py
run_suite "Playwright Browser Bootstrap" python3 scripts/tests/playwright-browser-bootstrap.test.py
run_suite "Cloud Benchmark Recovery Descriptor Custody" python3 scripts/tests/cloudbench-recovery-fd.test.py
run_suite "Cloud Benchmark Inventory Stdlib Startup" python3 scripts/tests/cloudbench-inventory-site-startup.test.py
run_suite "Cloud Benchmark Poll Stdlib Startup" python3 scripts/tests/cloudbench-poll-site-startup.test.py
run_suite "Cloud Benchmark Composite Root Cleanup" python3 scripts/tests/cloudbench-exact-session-multi-root.test.py
run_suite "Cloud Benchmark Quiesced Forensic Retirement" python3 scripts/tests/cloudbench-forensic-quiesced.test.py
run_suite "Cloud Benchmark Staged Boot" python3 scripts/tests/cloudbench-staged-boot.test.py
run_suite "Cloud Benchmark Static Service Observation" python3 scripts/tests/cloudbench-static-service-observation.test.py
run_suite "Cloud Benchmark Native Linux Runner" python3 scripts/tests/cloudbench-controller-linux.test.py
run_suite "Existing Backend Replay Gate" bash scripts/tests/blackbox-existing-replay-gate.test.sh
run_suite "Blackbox Backend Teardown" bash scripts/tests/blackbox-backend-teardown.test.sh
run_suite "Agent Workflow Surface Hash" bash scripts/tests/agent-surface-hash.test.sh
run_suite "Fly Cutover Clone Recovery" bash scripts/tests/deploy-agent-clone-recovery.test.sh
run_suite "Mac App Release Drift" bash scripts/tests/mac-app-release-drift.test.sh
run_suite "CAPTCHA Probe Verdicts" agents/venv/bin/python -m pytest -q agents/benchmarks/run_captcha_probe_test.py
run_suite "Benchmark Run Merge" agents/venv/bin/python -m pytest -q agents/benchmarks/merge_run_contexts_test.py
if auto_rca_changed '^(scripts/(run\.sh|run-in-new-session\.py|run-bench|run-bench-cloud|run-bench-fleet|run-cloudbench-controller-gate|run-predeploy-(cloud|local)|create-worktree-patch\.sh|cloudbench-|lib/cloudbench-|tests/cloudbench-)|agents/benchmarks/(cloud_batch_cleanup_test|cloudbench_(dependency_sync|recovery_review|codex_auth)_test|run_benchmark|wall_clock_backstop_test)\.py)'; then
  run_suite "Cloud Benchmark Environment" bash scripts/tests/cloudbench-env.test.sh
  run_suite "Cloud Benchmark Controller GitHub Token" bash scripts/tests/cloudbench-controller-github-token.test.sh
  run_suite "Cloud Benchmark Mandatory Autoscale" bash scripts/tests/cloudbench-acceptance-autoscale.test.sh
  run_suite "Benchmark Execution Backstop" agents/venv/bin/python -m pytest -q agents/benchmarks/wall_clock_backstop_test.py
  run_suite "Cloud Benchmark Lifecycle" agents/venv/bin/python -m pytest -q agents/benchmarks/cloud_batch_cleanup_test.py agents/benchmarks/cloudbench_dependency_sync_test.py agents/benchmarks/cloudbench_recovery_review_test.py agents/benchmarks/cloudbench_codex_auth_test.py
  run_suite "Cloud Benchmark Git Fetch" bash scripts/tests/cloudbench-fetch-ref.test.sh
  run_suite "Cloud Benchmark GitHub Token" bash scripts/tests/cloudbench-github-token.test.sh
  run_suite "Cloud Benchmark Explicit Idle Admission" python3 scripts/tests/cloudbench-explicit-idle-admission.test.py
  run_suite "Cloud Benchmark Fixed Native Worker" python3 scripts/tests/cloudbench-fixed-native-worker.test.py
  run_suite "Cloud Benchmark Cleanup Admission Scans" python3 scripts/tests/cloudbench-cleanup-admission-scans.test.py
  run_suite "Cloud Benchmark Cleanup Admission Parallel" python3 scripts/tests/cloudbench-cleanup-admission-parallel.test.py
  run_suite "Cloud Benchmark Cleanup Admission Tickets" python3 scripts/tests/cloudbench-cleanup-admission-tickets.test.py
  run_suite "Cloud Benchmark Cohort Stale Reconciliation" python3 scripts/tests/cloudbench-cohort-reconcile.test.py
  run_suite "Cloud Benchmark Shared Relay" python3 scripts/tests/cloudbench-shared-transport-integration.test.py
  run_suite "Cloud Benchmark Cleanup Ticket Campaign" python3 scripts/tests/cloudbench-cleanup-ticket-campaign.test.py
  run_suite "Cloud Benchmark Clone Rate Response" python3 scripts/tests/cloudbench-clone-rate-response.test.py
  run_suite "Cloud Benchmark Controller Client" python3 scripts/tests/cloudbench-controller-client-path.test.py
  run_suite "Cloud Benchmark Controller Gate flyctl Bounds" python3 scripts/tests/cloudbench-controller-gate-flyctl-bounds.test.py
  run_suite "Cloud Benchmark Disposable Hub Finalization" python3 scripts/tests/cloudbench-disposable-hub-finalize.test.py
  run_suite "Cloud Benchmark Disposable Controller" python3 scripts/tests/cloudbench-disposable-controller.test.py
  run_suite "Cloud Benchmark Disposable Volume Backups" python3 scripts/tests/cloudbench-disposable-volume.test.py
  run_suite "Cloud Benchmark Parallel Mutation Admission" python3 scripts/tests/cloudbench-parallel-mutation.test.py
  run_suite "Cloud Benchmark Disposable Volume CLI" python3 scripts/tests/cloudbench-disposable-volume-cli.test.py
  run_suite "Cloud Benchmark Original 600 Supervisor" python3 scripts/tests/cloudbench-original600-supervisor.test.py
  run_suite "Cloud Benchmark Disposable Recovery" python3 scripts/tests/cloudbench-disposable-recovery.test.py
  run_suite "Cloud Benchmark Replaced Preconfiguration" python3 scripts/tests/cloudbench-replaced-preconfig.test.py
  run_suite "Cloud Benchmark Configured Old Member Capture" python3 scripts/tests/cloudbench-configured-old-capture.test.py
  run_suite "Cloud Benchmark Disposable Decisions" python3 scripts/tests/cloudbench-disposable-lifecycle.test.py
  run_suite "Cloud Benchmark Retained Successor Completion" python3 scripts/tests/cloudbench-retained-successor.test.py
  run_suite "Cloud Benchmark Disposable Outer Lifecycle" env CLOUDBENCH_TEST_DISPOSABLE_ONLY=1 bash scripts/tests/cloudbench-multi-workstream.test.sh
  run_suite "Cloud Benchmark App Stop All" python3 scripts/tests/cloudbench-stop-all.test.py
  run_suite "Cloud Benchmark Reclaim Stopped Machines" python3 scripts/tests/cloudbench-reclaim-stopped.test.py
  run_suite "Cloud Benchmark Unstaged Worker Recovery" python3 scripts/tests/cloudbench-unstaged-worker-recovery.test.py
  run_suite "Cloud Benchmark Protected Resource Union" python3 scripts/tests/cloudbench-protected-resources.test.py
  run_suite "Cloud Benchmark Pool Run Token" python3 scripts/tests/cloudbench-pool-run-token.test.py
  run_suite "Cloud Benchmark Live Primary Return" python3 scripts/tests/cloudbench-live-primary-return.test.py
  run_suite "Cloud Benchmark Exact Shape Reuse" python3 scripts/tests/cloudbench-primary-exact-shape-reuse.test.py
  run_suite "Cloud Benchmark Maintenance Env" python3 scripts/tests/cloudbench-maintenance-env.test.py
  run_suite "Cloud Benchmark Multi-Workstream" bash scripts/tests/cloudbench-multi-workstream.test.sh
  run_suite "Fleet Infra Canary" bash scripts/tests/fleet-infra-canary.test.sh
  run_suite "Cloud Benchmark App-Env Lock" bash scripts/tests/cloudbench-app-env-lock.test.sh
  run_suite "Cloud Benchmark Seed Budget" bash scripts/tests/cloudbench-seed-budget.test.sh
  run_suite "Cloud Benchmark Restore Readiness" bash scripts/tests/cloudbench-restore-readiness.test.sh
  run_suite "Cloud Benchmark Orphan-Proxy Reaper" bash scripts/tests/fleet-orphan-proxy-reaper.test.sh
  run_suite "Cloud Benchmark Status-Service Shutdown" python3 scripts/tests/run-cloudbench-controller-linux.py --fixture status-service-shutdown
fi
if auto_rca_changed '^(scripts/(seed-|setup-db|cloud-build)|back-end/(prisma/|scripts/seed))'; then
  run_suite "Seed-Dump Cache Decision" bash scripts/tests/seed-cache-decision.test.sh
  run_suite "Canonical Seed WhatsApp Content" bash scripts/tests/canonical-seed-whatsapp-content.test.sh
  run_suite "Seed-Dump Toolchain Compatibility" bash scripts/tests/seed-dump-toolchain.test.sh
fi
if auto_rca_changed '^(scripts/(run\.sh|setup-db|seed-|fast-mode)|back-end/)'; then
  run_suite "Fast-Mode Cache Schema Retry" bash scripts/tests/fast-mode-cache-schema-retry.test.sh
fi
if auto_rca_changed '^scripts/run\.sh$'; then
  run_suite "System Postgres Pool Budget" bash scripts/tests/run-system-pg-pool-budget.test.sh
fi
run_suite "Local Port Probe Without lsof" bash scripts/tests/port-probe.test.sh
run_suite "Workspace Dependency Preflight" bash scripts/tests/workspace-dependencies.test.sh

# ── Build checks (run in parallel with blackbox tests) ──
BUILD_PIDS=()
BUILD_NAMES=()
BUILD_LOGS=()

# Reap any background builds / bg_suite processes still running when the
# script exits (e.g. if the semantic-test preflight fails with `exit 1`).
# Without this, `vite build` / benchmark subprocesses get orphaned.
cleanup_bg() {
  local pid
  # ${arr[@]+"${arr[@]}"} is the set -u-safe way to iterate possibly-empty arrays.
  for pid in ${BUILD_PIDS[@]+"${BUILD_PIDS[@]}"} ${BG_PIDS[@]+"${BG_PIDS[@]}"}; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup_bg EXIT

if should_run "front-end" && ! $SMOKE && ! $AUTO_RCA_MODE; then
  FE_BUILD_LOG="$TMPDIR_BASE/fe_build.log"
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" \
    bash -c "cd front-end && npx vite build" > "$FE_BUILD_LOG" 2>&1 &
  BUILD_PIDS+=($!)
  BUILD_NAMES+=("Frontend Build")
  BUILD_LOGS+=("$FE_BUILD_LOG")
fi

if should_run "mac-app" && $IS_MAC; then
  MAC_BUILD_LOG="$TMPDIR_BASE/mac_build.log"
  bash -c "cd mac-app && npx vite build && npx tsc -p tsconfig.main.json" > "$MAC_BUILD_LOG" 2>&1 &
  BUILD_PIDS+=($!)
  BUILD_NAMES+=("Mac App Build")
  BUILD_LOGS+=("$MAC_BUILD_LOG")
fi

# ── Blackbox tests (parallel) ──

if should_run "agents"; then
  if $AUTO_RCA_MODE; then
    run_suite "Agents Structural" bash scripts/tests/agents-structural.test.sh
    run_suite "Agents Coverage and Blackbox" bash -c "cd agents && source venv/bin/activate && AGENTS_COVERAGE_CONCURRENCY=3 bash scripts/run-coverage.sh"
  else
    bg_suite "Agents Structural" bash scripts/tests/agents-structural.test.sh

    if [ -n "$DOMAIN" ] && [ "$REPO" = "agents" ]; then
      bg_suite "Agents Blackbox ($DOMAIN)" bash -c "cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py $DOMAIN"
    else
      bg_suite "Agents Blackbox" bash -c "cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py"
    fi
  fi
fi

if should_run "back-end"; then
  if $AUTO_RCA_MODE; then
    run_suite "Backend Structural" bash -c "cd back-end && npm run test:structural"
    run_suite "Backend Coverage and Blackbox" bash -c "cd back-end && npm run test:coverage"
  else
    bg_suite "Backend Structural" bash -c "cd back-end && npm run test:structural"

    if [ -n "$DOMAIN" ] && [ "$REPO" = "back-end" ]; then
      bg_suite "Backend Blackbox ($DOMAIN)" bash -c "cd back-end && bash scripts/run-blackbox-tests.sh $DOMAIN"
    else
      bg_suite "Backend Blackbox" bash -c "cd back-end && bash scripts/run-blackbox-tests.sh"
    fi
  fi
fi

if should_run "front-end"; then
  if $AUTO_RCA_MODE; then
    run_suite "Frontend Coverage and Blackbox" bash -c "cd front-end && npm run test:coverage -- --maxWorkers=2"
    run_suite "Frontend Build" bash -c "cd front-end && NODE_OPTIONS=--max-old-space-size=4096 npx vite build"
  else
    bg_suite "Frontend Structural" bash -c "cd front-end && npx vitest run src/tests/structural"

    if [ -n "$DOMAIN" ] && [ "$REPO" = "front-end" ]; then
      bg_suite "Frontend Blackbox ($DOMAIN)" bash -c "cd front-end && bash scripts/run-blackbox-tests.sh $DOMAIN"
    else
      bg_suite "Frontend Blackbox" bash -c "cd front-end && bash scripts/run-blackbox-tests.sh"
    fi
  fi
fi

if should_run "mac-app"; then
  if $AUTO_RCA_MODE; then
    run_suite "Mac App Coverage and Blackbox" bash -c "cd mac-app && npm run test:coverage -- --maxWorkers=1"
  else
    bg_suite "Mac App Structural" bash -c "cd mac-app && npm run test:structural"

    if [ -n "$DOMAIN" ] && [ "$REPO" = "mac-app" ]; then
      bg_suite "Mac App Blackbox ($DOMAIN)" bash -c "cd mac-app && bash scripts/run-blackbox-tests.sh $DOMAIN"
    else
      bg_suite "Mac App Blackbox" bash -c "cd mac-app && bash scripts/run-blackbox-tests.sh"
    fi
  fi
fi


# ── Wait for all blackbox suites ──
collect_bg_suites

# ── Smoke tests (parallel, only if --smoke --port=N; --full targets prod) ──
if $SMOKE; then
  if $FULL; then
    # Pass the concurrency as a positional arg (not string interpolation) so a
    # hostile/typo'd env value can never be word-split or executed by bash -c.
    bg_suite "Full Benchmarks (prod)" bash -c 'cd agents && source venv/bin/activate && python benchmarks/run_benchmark.py --suite all --prod --ci --parallel --max-concurrency "$1"' _ "$FULL_MAX_CONCURRENCY"
    collect_bg_suites
  else
    # Frontend semantic tests require a running frontend — guard BEFORE any
    # background smoke process spawns, so a missing frontend can't leave
    # orphaned benchmark runs behind.
    SEMANTIC_BACKEND_PORT="$PORT"
    SEMANTIC_FRONTEND_PORT="$((PORT + 1))"
    if ! curl -sf "http://localhost:$SEMANTIC_FRONTEND_PORT" > /dev/null 2>&1; then
      echo "ERROR: semantic tests require frontend on port $SEMANTIC_FRONTEND_PORT (start it or pass --no-smoke to skip)."
      exit 1
    fi

    if [ -z "${CONDUCTOR_WORKSPACE_NAME:-}" ]; then
      echo "ERROR: CONDUCTOR_WORKSPACE_NAME not set — cannot derive Temporal task queue for smoke benchmarks."
      exit 1
    fi
    SMOKE_TASK_QUEUE="navi-agent-tasks-${CONDUCTOR_WORKSPACE_NAME}"
    bg_suite "Smoke Benchmarks" bash -c "cd agents && source venv/bin/activate && TEMPORAL_TASK_QUEUE=$SMOKE_TASK_QUEUE ALLOW_TEMPORAL_CLEANUP=true python benchmarks/run_benchmark.py --suite smoke --port $PORT --ci --parallel"
    # Planner memory A/B: real planner LLM calls, memory off vs on, on 30+
    # scenarios derived from archived runs (agents/benchmarks/memory_scenarios.json).
    # Runs against the same local backend; never archives its planner calls.
    bg_suite "Planner Memory Scenarios (real LLM)" bash -c "cd agents && source venv/bin/activate && TRACE_ARCHIVE_ENABLED=0 python benchmarks/run_memory_scenarios.py --port $PORT --no-open"
    # Memory compressor on real completed transcripts (one per benchmark task + the
    # largest completed runs); generic transcript-grounded assertions, reads R2.
    bg_suite "Planner Memory Compressor (real LLM)" bash -c "cd agents && source venv/bin/activate && TRACE_ARCHIVE_ENABLED=0 python benchmarks/run_memory_compressor_bench.py"
    # Write-lock approval replay: real planner / EXECUTE / browser-use calls at the
    # checkout review page; the browser agent must click the commit control that
    # raises the approval prompt (agents/benchmarks/write_lock_approval_scenarios.json).
    bg_suite "Write-Lock Approval Replay (real LLM)" bash -c "cd agents && source venv/bin/activate && TRACE_ARCHIVE_ENABLED=0 python benchmarks/run_write_lock_approval_scenarios.py"
    bg_suite "Frontend Semantic (Playwright)" bash -c "cd front-end && BACKEND_PORT=$SEMANTIC_BACKEND_PORT FRONTEND_PORT=$SEMANTIC_FRONTEND_PORT bash scripts/run-semantic-tests.sh"
    # Steel cloud-browser load-time gate through a real bot wall (Cloudflare
    # Turnstile + reCAPTCHA on order.toasttab.com). Ratchets median time-to-
    # usable; the constant lives in the benchmark (TIME_TO_USABLE_RATCHET_SECONDS,
    # ratchets DOWN only). 1 run keeps smoke fast (~2min); observed spread <1s.
    bg_suite "Steel Bot-Challenge Load" bash -c "cd agents && source venv/bin/activate && python tests/e2e/steel_bot_challenge_benchmark.py --runs 1"

    collect_bg_suites
  fi
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
  : > "$TMPDIR_BASE/failed-suites.txt"
  echo ""
  for i in "${!SUITE_NAMES[@]}"; do
    if [ "${SUITE_STATUSES[$i]}" = "fail" ]; then
      printf '%s\n' "${SUITE_NAMES[$i]}" >> "$TMPDIR_BASE/failed-suites.txt"
      echo "── ${SUITE_NAMES[$i]} failures ──"
      # Extract failure summaries: ❌ lines, FAIL lines, assertion diffs (no stack traces)
      grep -Ei '❌|^--- FAIL|^  FAIL|^FAILURES|^FAIL:|Expected.*got|Received|assert.*failed|(^|[[:space:]])error:' "${SUITE_LOGS[$i]}" | head -40 || true
      echo "  → full log: ${SUITE_LOGS[$i]}"
      echo ""
    fi
  done
fi

echo ""
echo "All logs for this run: $TMPDIR_BASE/"
echo "  (latest always at: $REPO_ROOT/.test-logs/latest/)"

[ $FAIL_COUNT -eq 0 ]
