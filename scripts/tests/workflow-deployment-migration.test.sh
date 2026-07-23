#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DEPLOY="$ROOT/.claude/commands/deploy.md"
SCRIPT="$ROOT/back-end/scripts/migrate-open-agent-workflows.ts"
PROD_VALIDATOR="$ROOT/back-end/scripts/validate-prod-workflow-migration.ts"
CLASSIFIER="$ROOT/scripts/classify-agent-runtime-changes.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

require_text() {
  local file=$1 pattern=$2 message=$3
  grep -Fq -- "$pattern" "$file" || fail "$message"
}

require_text "$DEPLOY" 'CHANGED_AGENT_RUNTIME=' "/deploy must classify shipped agent runtime changes"
require_text "$DEPLOY" '/scripts/classify-agent-runtime-changes.sh' "/deploy must use the executable runtime classifier"
require_text "$DEPLOY" 'DEPLOY_MERGED_SHA=$(gh pr view' "/deploy must capture the exact PR merge commit"
require_text "$DEPLOY" 'FINAL_CHANGED_AGENTS=$(git diff --name-only "$DEPLOY_MERGED_SHA^1" "$DEPLOY_MERGED_SHA"' "/deploy must classify that exact merged tree before cutover"
if grep -Fq 'MERGED_SHA=$(git rev-parse origin/main)' "$DEPLOY"; then
  fail "/deploy must not classify whichever commit happens to be latest on origin/main"
fi
require_text "$DEPLOY" 'npx tsx scripts/migrate-open-agent-workflows.ts --execute' "/deploy must execute the open-workflow migration"
require_text "$DEPLOY" 'TEMPORAL_TASK_QUEUE=navi-agent-tasks' "/deploy must pin migration to the production queue"
require_text "$DEPLOY" 'TEMPORAL_WORKER_BUILD_ID="$DEPLOY_MERGED_SHA"' "/deploy must activate the exact merged worker build"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_CONCURRENCY=' "/deploy must bound migration concurrency"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_CANARY_COUNT=' "/deploy must canary workflow cutover before bulk replacement"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_BOOTSTRAP_TIMEOUT_MS=' "/deploy must bound candidate bootstrap acknowledgement"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_CANDIDATE_TIMEOUT_MS=' "/deploy must bound each complete candidate replacement"
require_text "$DEPLOY" 'does not wait for a natural continue-as-new boundary' "/deploy must document immediate replacement semantics"
require_text "$DEPLOY" '## Step 13ac: Validate workflow replacement edge cases in production' "/deploy must include the production replacement matrix"
require_text "$DEPLOY" 'PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1' "/deploy must explicitly opt in to production validation"
require_text "$DEPLOY" 'npx tsx scripts/validate-prod-workflow-migration.ts --execute' "/deploy must execute the production replacement matrix"

require_text "$SCRIPT" "process.argv.includes('--execute')" "migration script must require explicit execution mode"
require_text "$SCRIPT" "taskQueue !== 'navi-agent-tasks'" "migration script must reject non-production queues"
require_text "$SCRIPT" 'process.env.TEMPORAL_WORKER_BUILD_ID' "migration must require an exact candidate build"
require_text "$SCRIPT" 'expectedWorkflowId: candidate.workflowId' "migration must fence each frozen workflow generation"
require_text "$SCRIPT" 'prepareAgentWorkflowReplacement' "migration must seal workflow generations before activation"
require_text "$SCRIPT" 'assertNoUnsafeOpenDescendantWorkflows' "migration must fail closed on orphan descendants"
require_text "$SCRIPT" 'activateTemporalWorkerBuild' "migration must explicitly activate the standby build"
require_text "$SCRIPT" 'waitForWorkflowReplacementBootstrap' "migration must wait for durable candidate readiness"
require_text "$SCRIPT" 'Workflow migration canary failed' "migration must stop after a failed canary"
require_text "$SCRIPT" "if (summary.failed > 0) process.exitCode = 1" "migration failures must fail /deploy"

require_text "$PROD_VALIDATOR" "process.argv.includes('--execute')" "production validator must require explicit execution mode"
require_text "$PROD_VALIDATOR" "process.env.PRODUCTION_WORKFLOW_MIGRATION_VALIDATION !== '1'" "production validator must require a dedicated opt-in"
require_text "$PROD_VALIDATOR" "process.env.TEMPORAL_TASK_QUEUE !== 'navi-agent-tasks'" "production validator must reject non-production target queues"
require_text "$PROD_VALIDATOR" 'const dormantQueue = `navi-prod-migration-validation-${runId}`' "production validator stale histories must use an isolated never-polled queue"
require_text "$PROD_VALIDATOR" "status: 'FAIL'" "production validator must emit failing report-card rows"
require_text "$PROD_VALIDATOR" "process.exitCode = 1" "any production validation failure must block /deploy"
require_text "$PROD_VALIDATOR" "await cleanup()" "production validation must clean up exact fixtures"

prepare_line=$(grep -n 'prepare: prepareOne' "$SCRIPT" | cut -d: -f1)
activate_line=$(grep -n 'activate: async' "$SCRIPT" | cut -d: -f1)
start_line=$(grep -n 'start: startOne' "$SCRIPT" | cut -d: -f1)
[[ $prepare_line -lt $activate_line && $activate_line -lt $start_line ]] || \
  fail "cutover dependencies must read prepare → activate → start"

WORKFLOW="$ROOT/.github/workflows/deploy-agents.yml"
WORKER="$ROOT/agents/worker.py"
require_text "$WORKFLOW" '--env TEMPORAL_WORKER_BUILD_ID="${GITHUB_SHA}"' "Fly deploy must identify the exact candidate SHA"
require_text "$WORKFLOW" 'bash scripts/classify-agent-runtime-changes.sh' "Fly deploy must classify shipped runtime changes"
require_text "$WORKFLOW" '--env TEMPORAL_WORKER_REQUIRE_ACTIVATION="${REQUIRE_ACTIVATION}"' "Fly runtime deploys must be activation-gated"
require_text "$WORKFLOW" 'if [ -z "$CHANGED_RUNTIME" ]; then REQUIRE_ACTIVATION=0; fi' "test-only agent deploys must not park workers in standby"
require_text "$WORKFLOW" "'!agents/tests/**'" "additive agent tests must not trigger a production worker replacement"
require_text "$WORKFLOW" "'!agents/benchmarks/**'" "benchmarks must not trigger a production worker replacement"
require_text "$WORKER" 'wait_for_worker_build_activation(' "worker must wait on its exact build marker"
standby_line=$(grep -n 'wait_for_worker_build_activation(' "$WORKER" | tail -1 | cut -d: -f1)
poller_line=$(grep -n 'worker = Worker(' "$WORKER" | tail -1 | cut -d: -f1)
[[ $standby_line -lt $poller_line ]] || fail "worker activation must happen before Temporal poller construction"

classified=$(printf '%s\n' \
  agents/tests/blackbox/workflow.blackbox.py \
  agents/benchmarks/run_benchmark.py \
  agents/scripts/run-coverage.sh \
  agents/scripts/run_blackbox_tests.py \
  agents/scripts/run_coverage_blackbox_parallel.py \
  agents/README.md \
  agents/helpers/messages.py \
  agents/workflows/agent_workflow.py |
  bash "$CLASSIFIER")
expected=$(printf '%s\n' agents/helpers/messages.py agents/workflows/agent_workflow.py)
[[ "$classified" == "$expected" ]] ||
  fail "runtime classifier must exclude additive tests/harnesses and retain shipped worker code"

health_line=$(grep -n '## Step 13a: Verify prod backend health' "$DEPLOY" | cut -d: -f1)
migration_line=$(grep -n '## Step 13ab: Replace open workflows' "$DEPLOY" | cut -d: -f1)
production_validation_line=$(grep -n '## Step 13ac: Validate workflow replacement edge cases in production' "$DEPLOY" | cut -d: -f1)
semantic_line=$(grep -n '## Step 13b: Production semantic' "$DEPLOY" | cut -d: -f1)
[[ $health_line -lt $migration_line && $migration_line -lt $production_validation_line && $production_validation_line -lt $semantic_line ]] || \
  fail "workflow migration and production matrix must run after backend health and before production semantic verification"

echo "workflow deployment migration structural tests: PASS"
