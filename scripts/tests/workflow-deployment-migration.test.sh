#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DEPLOY="$ROOT/.claude/commands/deploy.md"
SCRIPT="$ROOT/back-end/scripts/migrate-open-agent-workflows.ts"
PREFLIGHT="$ROOT/back-end/src/domains/agents/agentRestartPreflight.ts"
MANIFEST="$ROOT/back-end/src/providers/workflowDeploymentManifest.ts"
PROD_VALIDATOR="$ROOT/back-end/scripts/validate-prod-workflow-migration.ts"
CANDIDATE_VALIDATOR="$ROOT/back-end/scripts/validate-candidate-workflow-image.ts"
CLASSIFIER="$ROOT/scripts/classify-agent-runtime-changes.sh"
FLEET_GATE="$ROOT/scripts/verify-agent-candidate-fleet.sh"
MIGRATION_SQL="$ROOT/back-end/prisma/migrations/20260723000000_add_workflow_iteration_offset/migration.sql"
DESCENDANT_START="$ROOT/back-end/src/providers/descendantWorkflowStart.ts"
TEMPORAL="$ROOT/back-end/src/providers/temporal.ts"
SERVER_CRON="$ROOT/back-end/src/serverCron.ts"

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
require_text "$DEPLOY" 'FINAL_CHANGED=$(git diff --name-only "$DEPLOY_MERGED_SHA^1" "$DEPLOY_MERGED_SHA")' "/deploy must freeze the exact merged change set before cutover"
require_text "$DEPLOY" 'FINAL_CHANGED_AGENTS=$(printf' "/deploy must derive agent classification from the frozen merged change set"
require_text "$DEPLOY" 'CHANGED_DEPLOY_AGENTS_WORKFLOW=' "/deploy must include deploy-workflow-only changes in cutover classification"
require_text "$DEPLOY" 'AGENT_CUTOVER_REQUIRED=0' "/deploy must initialize one canonical agent cutover condition"
require_text "$DEPLOY" 'AGENT_CUTOVER_REQUIRED=1' "/deploy must require cutover for the activation-gated change set"
require_text "$DEPLOY" 'if [ -n "$CHANGED_AGENT_RUNTIME$CHANGED_DEPLOY_AGENTS_WORKFLOW" ]; then' "/deploy cutover classification must match GitHub activation inputs"
cutover_condition_count=$(grep -Fc 'if [ "$AGENT_CUTOVER_REQUIRED" = "1" ]; then' "$DEPLOY")
[[ $cutover_condition_count -eq 3 ]] ||
  fail "Step 13, Step 13ab, and Step 13ac must use the same canonical agent cutover condition"
if grep -Fq 'if [ -n "$CHANGED_AGENT_RUNTIME" ]; then' "$DEPLOY"; then
  fail "/deploy must not bypass the canonical cutover condition for runtime-only checks"
fi
if grep -Fq 'MERGED_SHA=$(git rev-parse origin/main)' "$DEPLOY"; then
  fail "/deploy must not classify whichever commit happens to be latest on origin/main"
fi
require_text "$DEPLOY" 'npx tsx scripts/migrate-open-agent-workflows.ts --execute' "/deploy must execute the open-workflow migration"
require_text "$DEPLOY" 'TEMPORAL_TASK_QUEUE=navi-agent-tasks' "/deploy must pin migration to the production queue"
require_text "$DEPLOY" 'TEMPORAL_WORKER_BUILD_ID="$DEPLOY_MERGED_SHA"' "/deploy must activate the exact merged worker build"
require_text "$DEPLOY" 'AGENT_DEPLOYMENT_TOKEN="${AGENT_DEPLOY_RUN_ID}-${AGENT_DEPLOY_RUN_ATTEMPT}"' "/deploy must scope activation to the exact GitHub run attempt"
require_text "$DEPLOY" 'TEMPORAL_WORKER_DEPLOYMENT_TOKEN="$AGENT_DEPLOYMENT_TOKEN"' "/deploy must pass the exact deployment token to migration"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_CONCURRENCY=' "/deploy must bound migration concurrency"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_CANARY_COUNT=' "/deploy must canary workflow cutover before bulk replacement"
require_text "$DEPLOY" 'TEMPORAL_CANDIDATE_VALIDATION_TASK_QUEUE="navi-agent-candidate-${AGENT_DEPLOYMENT_TOKEN}"' "/deploy must derive an exact-attempt candidate validation queue"
require_text "$DEPLOY" 'npx tsx scripts/validate-candidate-workflow-image.ts --execute' "/deploy must validate the exact candidate image before cutover"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_BOOTSTRAP_TIMEOUT_MS=' "/deploy must bound candidate bootstrap acknowledgement"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_CANDIDATE_TIMEOUT_MS=' "/deploy must bound each complete candidate replacement"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_PENDING_START_TIMEOUT_MS=' "/deploy must bound ambiguous descendant start draining"
require_text "$DEPLOY" 'WORKFLOW_MIGRATION_TERMINAL_CLEANUP_TIMEOUT_MS=' "/deploy must bound terminal/deleted workflow cleanup"
require_text "$DEPLOY" 'RENDER_OLD_INSTANCE_DRAIN_SECONDS="${RENDER_OLD_INSTANCE_DRAIN_SECONDS:-375}"' "/deploy must wait through Render's maximum old-instance shutdown window plus margin"
require_text "$DEPLOY" '"$RENDER_OLD_INSTANCE_DRAIN_SECONDS" -ge 375' "/deploy must reject unsafe low drain overrides"
require_text "$DEPLOY" 'RENDER_DEPLOY_FINISHED_AT=' "/deploy drain must be based on the exact live deploy timestamp"
require_text "$DEPLOY" 'Old Render instance/request drain window elapsed' "/deploy must complete the old-backend drain before cutover"
require_text "$DEPLOY" 'does not wait for a natural continue-as-new boundary' "/deploy must document immediate replacement semantics"
require_text "$DEPLOY" '## Step 13ac: Validate workflow replacement edge cases in production' "/deploy must include the production replacement matrix"
require_text "$DEPLOY" 'PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1' "/deploy must explicitly opt in to production validation"
require_text "$DEPLOY" 'TEMPORAL_WORKER_BUILD_ID="$DEPLOY_MERGED_SHA"' "/deploy production matrix must identify the exact candidate build"
require_text "$DEPLOY" 'TEMPORAL_WORKER_DEPLOYMENT_TOKEN="$AGENT_DEPLOYMENT_TOKEN"' "/deploy production matrix must identify the exact deployment attempt"
require_text "$DEPLOY" 'npx tsx scripts/validate-prod-workflow-migration.ts --execute' "/deploy must execute the production replacement matrix"

require_text "$CANDIDATE_VALIDATOR" "process.argv.includes('--execute')" "candidate validator must require explicit execution mode"
require_text "$CANDIDATE_VALIDATOR" "kind: 'validation'" "candidate validator must run the real workflow in validation mode"
require_text "$CANDIDATE_VALIDATOR" "deployment_initialized_query" "candidate validator must wait through common initialization"
require_text "$CANDIDATE_VALIDATOR" "workflowTaskFailedEventAttributes" "candidate validator must reject nondeterministic workflow tasks"
require_text "$CANDIDATE_VALIDATOR" "workflowTaskFailedEventAttributes != null" "candidate validator must ignore protobuf nulls while rejecting real workflow-task failures"
require_text "$CANDIDATE_VALIDATOR" "activityTaskScheduledEventAttributes != null" "candidate validator must count only real initialization activities"
require_text "$PROD_VALIDATOR" "workflowTaskFailedEventAttributes != null" "production validator must ignore protobuf nulls while rejecting real workflow-task failures"
require_text "$PROD_VALIDATOR" "assertSameInstant" "production validator must compare restored timestamps as instants, not format strings"
require_text "$PROD_VALIDATOR" "prisma.toolUsage.createMany" "production validator must seed durable accounting checkpoints"
require_text "$PROD_VALIDATOR" "tokenCountCheckpoint: 950" "production validator must preserve the durable context checkpoint"
require_text "$PROD_VALIDATOR" "tokensInCheckpoint: 680" "production validator must preserve the durable input-token checkpoint"
require_text "$PROD_VALIDATOR" "tokensOutCheckpoint: 270" "production validator must preserve the durable output-token checkpoint"
require_text "$PROD_VALIDATOR" "DEPLOYMENT_LEASE_WAIT_MS = 10 * 60_000" "production validator must bound deployment-lease contention"
require_text "$PROD_VALIDATOR" 'WorkflowType="RoseWorkerDeploymentActivationMarker" AND ExecutionStatus="Running"' "production validator must wait with the same visibility query used by marker cleanup"
require_text "$CANDIDATE_VALIDATOR" "toolUsage.count" "candidate validator must prove no LLM/tool usage was billed"
require_text "$CANDIDATE_VALIDATOR" "candidate_fixture_cleanup" "candidate validator must report fixture cleanup"

require_text "$SCRIPT" "process.argv.includes('--execute')" "migration script must require explicit execution mode"
require_text "$SCRIPT" "taskQueue !== 'navi-agent-tasks'" "migration script must reject non-production queues"
require_text "$SCRIPT" 'process.env.TEMPORAL_WORKER_BUILD_ID' "migration must require an exact candidate build"
require_text "$SCRIPT" 'process.env.TEMPORAL_WORKER_DEPLOYMENT_TOKEN' "migration must require an exact deployment attempt"
require_text "$SCRIPT" 'preflightAgentWorkflowReplacement' "migration must preflight every frozen workflow before sealing"
require_text "$SCRIPT" 'loadOrCreateWorkflowDeploymentManifest' "migration must persist and reuse the exact frozen generation set"
require_text "$SCRIPT" "cutover.haltedAfter === 'preflight'" "migration must halt before preparation on any preflight failure"
require_text "$SCRIPT" 'expectedWorkflowId: candidate.workflowId' "migration must fence each frozen workflow generation"
require_text "$SCRIPT" 'deploymentAttempt' "migration claims must be scoped to one exact deployment attempt"
require_text "$SCRIPT" 'prepareAgentWorkflowReplacement' "migration must seal workflow generations before activation"
require_text "$SCRIPT" 'assertNoUnsafeOpenDescendantWorkflows' "migration must fail closed on orphan descendants"
require_text "$SCRIPT" 'drainPendingDescendantWorkflowStarts' "migration must reconcile ambiguous descendant starts"
require_text "$SCRIPT" 'cleanupTerminalAgentWorkflowZombies' "migration must reconcile terminal/deleted Temporal cleanup obligations"
require_text "$SCRIPT" 'assertNoPendingTerminalAgentWorkflowCleanup' "migration must fail closed while cleanup obligations remain"
require_text "$SCRIPT" 'activateTemporalWorkerBuild' "migration must explicitly activate the standby build"
require_text "$SCRIPT" 'cleanupSupersededWorkerActivationMarkers' "successful migration must retire superseded activation markers"
require_text "$SCRIPT" 'waitForWorkflowReplacementBootstrap' "migration must wait for durable candidate readiness"
require_text "$SCRIPT" 'requireInitialized: true' "migration must validate the final restored ACTIVE state, not the frozen snapshot status"
require_text "$SCRIPT" 'Workflow migration canary failed' "migration must stop after a failed canary"
require_text "$SCRIPT" "if (summary.failed > 0 || summary.prepared > 0) process.exitCode = 1" "migration failures or unstarted claims must fail /deploy"
require_text "$PREFLIGHT" "Agent has no verifier configured" "preflight must reject malformed verifier-less roots"
require_text "$PREFLIGHT" 'captureInProgressWorkflowTools' "preflight must prove stale tool state is readable without mutation"
require_text "$PREFLIGHT" 'readAgentWorkflowLaunchConfig' "preflight must prove historical launch config is readable"
require_text "$MANIFEST" 'pg_advisory_xact_lock' "deployment manifest creation must be serialized"
require_text "$MANIFEST" 'Workflow deployment manifest contains a malformed candidate' "deployment manifest must fail closed on corrupt candidates"

require_text "$PROD_VALIDATOR" "process.argv.includes('--execute')" "production validator must require explicit execution mode"
require_text "$PROD_VALIDATOR" "process.env.PRODUCTION_WORKFLOW_MIGRATION_VALIDATION !== '1'" "production validator must require a dedicated opt-in"
require_text "$PROD_VALIDATOR" "process.env.TEMPORAL_TASK_QUEUE !== 'navi-agent-tasks'" "production validator must reject non-production target queues"
require_text "$PROD_VALIDATOR" 'const dormantQueue = `navi-prod-migration-validation-${runId}`' "production validator stale histories must use an isolated never-polled queue"
require_text "$PROD_VALIDATOR" "status: 'FAIL'" "production validator must emit failing report-card rows"
require_text "$PROD_VALIDATOR" "process.exitCode = 1" "any production validation failure must block /deploy"
require_text "$PROD_VALIDATOR" "withTimeout('fixture_cleanup', cleanup(), 120_000)" "production validation must clean up exact fixtures with a hard deadline"
require_text "$PROD_VALIDATOR" "sql_trigger_rejects_spawn_after_parent_seal" "production matrix must exercise the rolling-backend SQL fence"
require_text "$PROD_VALIDATOR" "pending_start_tombstone_wins_and_is_terminated" "production matrix must exercise the tombstone-wins race"
require_text "$PROD_VALIDATOR" "accepted_start_lost_response_is_resolved_and_terminated" "production matrix must exercise the accepted-start lost-response race"
require_text "$PROD_VALIDATOR" "current_parent_is_never_tombstoned" "production matrix must prove current parents fail closed"
require_text "$PROD_VALIDATOR" "nested_pending_child_and_grandchild_are_quiesced" "production matrix must exercise nested pending descendants"
require_text "$PROD_VALIDATOR" "termination_failure_retains_pending_for_retry" "production matrix must exercise termination retry durability"
require_text "$PROD_VALIDATOR" "post_termination_db_failure_retries_idempotently" "production matrix must exercise post-termination DB retry"
require_text "$PROD_VALIDATOR" "active_start_lease_blocks_activation_until_released" "production matrix must fail closed on active start leases"
require_text "$PROD_VALIDATOR" "accepted_child_completed_before_postvalidation" "production matrix must preserve a child that completes during start reconciliation"
require_text "$PROD_VALIDATOR" "accepted_child_failed_before_postvalidation" "production matrix must preserve a child that fails during start reconciliation"
require_text "$PROD_VALIDATOR" "concurrent_duplicate_descendant_finalization_is_idempotent" "production matrix must exercise concurrent stale-child finalization"
require_text "$PROD_VALIDATOR" "pause_after_fetch_before_atomic_finalize_wins" "production matrix must exercise the atomic bootstrap pause race"
require_text "$PROD_VALIDATOR" "resume_during_replacement_claim_wins" "production matrix must exercise the resume-during-claim race"
require_text "$PROD_VALIDATOR" "credit_restoration_during_replacement_claim_wins" "production matrix must exercise credit restoration during a replacement claim"
require_text "$PROD_VALIDATOR" "cost_limit_raise_during_replacement_claim_wins" "production matrix must exercise the cost-limit raise claim race"
require_text "$PROD_VALIDATOR" "late_approval_cannot_overwrite_deployment_terminal" "production matrix must reject approval after deployment terminalization"
require_text "$PROD_VALIDATOR" "legacy_usage_restores_exact_durable_billed_ledger" "production matrix must preserve the durable legacy billing ledger"
require_text "$PROD_VALIDATOR" "concurrent_keyed_accounting_checkpoint_is_exact_once" "production matrix must exercise exact-once accounting checkpoints"
require_text "$PROD_VALIDATOR" "provider_attempt_retries_do_not_inflate_iteration_offset" "production matrix must prove provider attempts do not become logical iterations"
require_text "$PROD_VALIDATOR" "malformed_root_preflight_leaves_healthy_peer_untouched" "production matrix must prove a malformed root cannot seal a healthy peer"
require_text "$PROD_VALIDATOR" "terminal_db_live_temporal_root_is_cleaned_exactly_once" "production matrix must clean terminal root zombies"
require_text "$PROD_VALIDATOR" "terminal_db_live_temporal_descendant_is_cleaned_exactly_once" "production matrix must clean terminal descendant zombies"
require_text "$PROD_VALIDATOR" "rapid_terminal_generations_each_keep_exact_cleanup_obligation" "production matrix must preserve every rapid cleanup generation"
require_text "$PROD_VALIDATOR" "soft_deleted_live_temporal_workflow_is_not_invisible" "production matrix must clean soft-deleted live workflows"
require_text "$PROD_VALIDATOR" "http_single_lost_201_retry_reuses_exact_child" "production matrix must exercise the real single-child HTTP retry"
require_text "$PROD_VALIDATOR" "http_batch_changed_payload_is_rejected" "production matrix must exercise real HTTP immutable payload rejection"
require_text "$PROD_VALIDATOR" "http_batch_mixed_retry_reconciles_each_child_once" "production matrix must exercise a real mixed batch retry"
require_text "$PROD_VALIDATOR" "same_sha_old_marker_is_retired_without_retiring_current_attempt" "production matrix must exercise deployment-attempt marker isolation"
require_text "$PROD_VALIDATOR" "failed_candidate_next_deploy_rotates_generation" "production matrix must rotate an accepted non-ready candidate on the next deploy"
require_text "$PROD_VALIDATOR" "late_stale_replacement_start_is_compensated" "production matrix must terminate a stale start accepted after a newer generation wins"
require_text "$PROD_VALIDATOR" "known_massive_zombie_generations_are_not_running" "production matrix must prove known zombies are gone"
require_text "$PROD_VALIDATOR" "production_fleet_has_no_stuck_cutover_state" "production matrix must prove the fleet has no stuck cutover state"

require_text "$MIGRATION_SQL" 'CREATE TRIGGER "Agent_fence_descendant_workflow_start"' "migration must install an old-backend descendant insert trigger"
require_text "$MIGRATION_SQL" 'pg_advisory_xact_lock' "SQL insert fence must share the workflow-generation lock"
require_text "$MIGRATION_SQL" 'NEW."temporalWorkflowStartPending" := true' "SQL insert fence must stamp the durable outbox marker"
require_text "$MIGRATION_SQL" 'SET "temporalCleanupPending" = true' "SQL trigger must durably mark terminal/deleted Temporal cleanup"
require_text "$MIGRATION_SQL" 'OR NEW."deletedAt" IS NOT NULL' "SQL cleanup trigger must cover soft-deleted live workflows"
require_text "$MIGRATION_SQL" 'assistant_turns AS (' "iteration backfill must count durable assistant turns"
require_text "$MIGRATION_SQL" 'message."workflowGeneration" = agent."temporalWorkflowId"' "iteration backfill must prefer the current workflow generation"
if grep -R --include='*.py' -Fq 'workflow.patched(' \
  "$ROOT/agents/workflows" "$ROOT/agents/domains"; then
  fail "agent runtime must not accumulate workflow.patched branches"
fi
require_text "$DESCENDANT_START" 'sealPendingDescendantWorkflowStart' "ambiguous starts must be DB-sealed before Temporal tombstoning"
require_text "$DESCENDANT_START" 'claimExecutionForTermination' "ambiguous starts must claim an exact Temporal chain"
require_text "$TEMPORAL" 'DESCENDANT_START_TOMBSTONE_TASK_QUEUE' "tombstones must use a dedicated never-polled queue"
require_text "$TEMPORAL" "workflowIdReusePolicy: 'REJECT_DUPLICATE'" "descendant IDs must reject closed-history reuse"
require_text "$TEMPORAL" "workflowIdConflictPolicy: 'FAIL'" "descendant IDs must fail on a running-ID conflict"
require_text "$SERVER_CRON" 'cleanupTerminalAgentWorkflowZombies' "production must continuously consume durable Temporal cleanup obligations"
require_text "$SERVER_CRON" "cron.schedule('* * * * *', runCleanup)" "Temporal cleanup obligations must retry at least every minute"
require_text "$SERVER_CRON" 'obligations retained for retry' "cleanup failures must remain durable for a later sweep"

preflight_line=$(grep -n 'preflight: async' "$SCRIPT" | cut -d: -f1)
prepare_line=$(grep -n 'prepare: async' "$SCRIPT" | cut -d: -f1)
activate_line=$(grep -n 'activate: async' "$SCRIPT" | cut -d: -f1)
start_line=$(grep -n 'start: async' "$SCRIPT" | cut -d: -f1)
[[ $preflight_line -lt $prepare_line && $prepare_line -lt $activate_line && $activate_line -lt $start_line ]] || \
  fail "cutover dependencies must read preflight → prepare → activate → start"

drain_line=$(grep -n 'drainPendingDescendantWorkflowStarts' "$SCRIPT" | tail -1 | cut -d: -f1)
terminal_cleanup_line=$(grep -n 'cleanupTerminalAgentWorkflowZombies' "$SCRIPT" | tail -1 | cut -d: -f1)
terminal_assert_line=$(grep -n 'assertNoPendingTerminalAgentWorkflowCleanup' "$SCRIPT" | tail -1 | cut -d: -f1)
assert_descendant_line=$(grep -n 'assertNoUnsafeOpenDescendantWorkflows' "$SCRIPT" | tail -1 | cut -d: -f1)
marker_line=$(grep -n 'activateTemporalWorkerBuild' "$SCRIPT" | tail -1 | cut -d: -f1)
[[ $drain_line -lt $terminal_cleanup_line && $terminal_cleanup_line -lt $terminal_assert_line && $terminal_assert_line -lt $assert_descendant_line && $assert_descendant_line -lt $marker_line ]] || \
  fail "activation must drain starts → clean terminal/deleted executions → assert gates → activate exact deployment"

render_drain_line=$(grep -n 'Old Render instance/request drain window elapsed' "$DEPLOY" | cut -d: -f1)
migration_command_line=$(grep -n 'npx tsx scripts/migrate-open-agent-workflows.ts --execute' "$DEPLOY" | tail -1 | cut -d: -f1)
[[ $render_drain_line -lt $migration_command_line ]] || \
  fail "old Render instances and in-flight requests must drain before workflow tombstones"
candidate_validation_line=$(grep -n 'npx tsx scripts/validate-candidate-workflow-image.ts --execute' "$DEPLOY" | tail -1 | cut -d: -f1)
initial_candidate_validation_line=$(grep -n 'npx tsx scripts/validate-candidate-workflow-image.ts --execute' "$DEPLOY" | head -1 | cut -d: -f1)
[[ $initial_candidate_validation_line -lt $render_drain_line ]] || \
  fail "candidate image must validate before the old-backend drain and every workflow tombstone"
fleet_recheck_line=$(grep -n 'bash "$DEPLOY_ROOT/scripts/verify-agent-candidate-fleet.sh"' "$DEPLOY" | cut -d: -f1)
lock_recheck_line=$(grep -n 'Exact production deploy lock is no longer held' "$DEPLOY" | cut -d: -f1)
# Two success-releases exist: the CI-already-cut-over short-circuit and the
# fallback local driver. The ordering invariant applies to the fallback driver
# (migrate → release), which is the last occurrence.
release_line=$(grep -n 'release_agent_cutover_lock success' "$DEPLOY" | tail -1 | cut -d: -f1)
[[ $render_drain_line -lt $fleet_recheck_line &&
   $fleet_recheck_line -lt $candidate_validation_line &&
   $candidate_validation_line -lt $lock_recheck_line &&
   $lock_recheck_line -lt $migration_command_line ]] ||
  fail "pre-seal order must be drain → exact fleet → standby workflow → deploy lock → migrate"
[[ $migration_command_line -lt $release_line ]] ||
  fail "the deploy concurrency lock must remain held through the complete workflow cutover"

WORKFLOW="$ROOT/.github/workflows/deploy-agents.yml"
WORKER="$ROOT/agents/worker.py"
require_text "$WORKFLOW" '--env TEMPORAL_WORKER_BUILD_ID="${GITHUB_SHA}"' "Fly deploy must identify the exact candidate SHA"
require_text "$WORKFLOW" '--env TEMPORAL_WORKER_DEPLOYMENT_TOKEN="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"' "Fly deploy must identify the exact deployment attempt"
require_text "$WORKFLOW" '--env TEMPORAL_WORKER_VALIDATION_TASK_QUEUE="navi-agent-candidate-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"' "Fly deploy must isolate exact-image validation by deployment attempt"
require_text "$WORKFLOW" '--env TEMPORAL_WORKER_ACTIVATION_TIMEOUT_SECONDS="7200"' "standby lifetime must cover a 10k-agent cutover"
require_text "$WORKFLOW" 'bash scripts/classify-agent-runtime-changes.sh' "Fly deploy must classify shipped runtime changes"
require_text "$WORKFLOW" '--env TEMPORAL_WORKER_REQUIRE_ACTIVATION="${REQUIRE_ACTIVATION}"' "Fly runtime deploys must be activation-gated"
require_text "$WORKFLOW" 'group: deploy-agents-production' "agent deploys must share one production concurrency group"
require_text "$WORKFLOW" 'cancel-in-progress: false' "a later agent deploy must queue without canceling the validated fleet"
require_text "$WORKFLOW" 'Hold production deploy lock until exact cutover completes' "agent deploy workflow must hold serialization through cutover"
require_text "$WORKFLOW" 'RELEASE_CONTEXT: agent-cutover/${{ github.run_id }}-${{ github.run_attempt }}' "deploy lock release must be scoped to the exact run attempt"
require_text "$WORKFLOW" 'bash scripts/verify-agent-candidate-fleet.sh' "GitHub deploy must use the canonical exact-fleet gate"
require_text "$WORKFLOW" 'if [ -z "$CHANGED_RUNTIME$CHANGED_DEPLOY_WORKFLOW" ]; then REQUIRE_ACTIVATION=0; fi' "test-only agent deploys must not park workers in standby"
require_text "$WORKFLOW" 'CHANGED_DEPLOY_WORKFLOW=' "deploy workflow changes must conservatively require activation"
require_text "$WORKFLOW" "'!agents/tests/**'" "additive agent tests must not trigger a production worker replacement"
require_text "$WORKFLOW" "'!agents/benchmarks/**'" "benchmarks must not trigger a production worker replacement"
require_text "$WORKER" 'wait_for_worker_build_activation(' "worker must wait on its exact build marker"
require_text "$WORKER" 'TEMPORAL_WORKER_DEPLOYMENT_TOKEN' "worker must require the deployment-attempt token"
require_text "$WORKER" 'TEMPORAL_WORKER_VALIDATION_TASK_QUEUE' "standby worker must poll only its exact validation queue"
require_text "$FLEET_GATE" 'select(.state != "destroyed")' "fleet gate must include retained stopped machines"
require_text "$FLEET_GATE" 'select(.state == "started")' "fleet gate must require a live candidate machine"
require_text "$FLEET_GATE" '.config.env.TEMPORAL_WORKER_BUILD_ID != $sha' "fleet gate must verify the exact build"
require_text "$FLEET_GATE" '.config.env.TEMPORAL_WORKER_DEPLOYMENT_TOKEN != $token' "fleet gate must verify the exact deployment token"
require_text "$FLEET_GATE" '.config.env.TEMPORAL_WORKER_VALIDATION_TASK_QUEUE != $validation_queue' "fleet gate must verify the exact validation queue"
require_text "$FLEET_GATE" '.config.env.TEMPORAL_WORKER_REQUIRE_ACTIVATION != $activation' "fleet gate must verify standby activation policy"
standby_line=$(grep -n 'wait_for_worker_build_activation(' "$WORKER" | tail -1 | cut -d: -f1)
poller_line=$(grep -n 'worker = Worker(' "$WORKER" | tail -1 | cut -d: -f1)
[[ $standby_line -lt $poller_line ]] || fail "worker activation must happen before Temporal poller construction"

fleet_test_dir=$(mktemp -d)
trap 'rm -rf "$fleet_test_dir"' EXIT
cat >"$fleet_test_dir/flyctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_FLEET_JSON"
EOF
chmod +x "$fleet_test_dir/flyctl"
valid_fleet='[
  {
    "id": "machine-running",
    "state": "started",
    "config": {"env": {
      "TEMPORAL_WORKER_BUILD_ID": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "123-1",
      "TEMPORAL_WORKER_VALIDATION_TASK_QUEUE": "navi-agent-candidate-123-1",
      "TEMPORAL_WORKER_ACTIVATION_TIMEOUT_SECONDS": "7200",
      "TEMPORAL_WORKER_REQUIRE_ACTIVATION": "1"
    }}
  },
  {
    "id": "machine-stopped",
    "state": "stopped",
    "config": {"env": {
      "TEMPORAL_WORKER_BUILD_ID": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "TEMPORAL_WORKER_DEPLOYMENT_TOKEN": "123-1",
      "TEMPORAL_WORKER_VALIDATION_TASK_QUEUE": "navi-agent-candidate-123-1",
      "TEMPORAL_WORKER_ACTIVATION_TIMEOUT_SECONDS": "7200",
      "TEMPORAL_WORKER_REQUIRE_ACTIVATION": "1"
    }}
  }
]'
env PATH="$fleet_test_dir:$PATH" \
  FAKE_FLEET_JSON="$valid_fleet" \
  EXPECTED_WORKER_BUILD_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  EXPECTED_WORKER_DEPLOYMENT_TOKEN=123-1 \
  EXPECTED_WORKER_VALIDATION_TASK_QUEUE=navi-agent-candidate-123-1 \
  EXPECTED_WORKER_ACTIVATION_TIMEOUT_SECONDS=7200 \
  EXPECTED_WORKER_REQUIRE_ACTIVATION=1 \
  bash "$FLEET_GATE" >/dev/null
if env PATH="$fleet_test_dir:$PATH" \
  FAKE_FLEET_JSON="$valid_fleet" \
  EXPECTED_WORKER_BUILD_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  EXPECTED_WORKER_DEPLOYMENT_TOKEN=wrong-token \
  EXPECTED_WORKER_VALIDATION_TASK_QUEUE=navi-agent-candidate-123-1 \
  EXPECTED_WORKER_ACTIVATION_TIMEOUT_SECONDS=7200 \
  EXPECTED_WORKER_REQUIRE_ACTIVATION=1 \
  bash "$FLEET_GATE" >/dev/null 2>&1; then
  fail "fleet gate must fail closed on an exact deployment-token mismatch"
fi

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

# ── Zero-downtime generation-queue cutover contract ──────────────────────────
# Each build polls a replay-surface-hashed generation queue; the deploy flips a
# routing pointer to that generation before respawning open workflows so new work
# and every respawn land on the just-activated generation with no dark-queue gap.
SURFACE_TOOL="$ROOT/scripts/agent_workflow_surface_hash.py"
POINTER_PROVIDER="$ROOT/back-end/src/providers/agentQueuePointer.ts"
POINTER_CLI="$ROOT/back-end/scripts/set-agent-queue-pointer.ts"
WORKER_GENERATION="$ROOT/agents/helpers/worker_generation.py"
DEPLOY_AGENTS_WORKFLOW="$ROOT/.github/workflows/deploy-agents.yml"

[ -f "$SURFACE_TOOL" ] || fail "replay-surface generation hash tool must exist"
[ -f "$POINTER_PROVIDER" ] || fail "agent queue pointer provider must exist"
[ -f "$POINTER_CLI" ] || fail "agent queue pointer flip CLI must exist"
[ -f "$WORKER_GENERATION" ] || fail "worker generation-queue resolver must exist"

require_text "$DEPLOY_AGENTS_WORKFLOW" 'scripts/agent_workflow_surface_hash.py' \
  "deploy-agents workflow must compute the replay-surface generation hash"
require_text "$DEPLOY_AGENTS_WORKFLOW" 'TEMPORAL_WORKER_SURFACE_HASH=' \
  "deploy-agents workflow must pass the surface hash so workers poll their generation queue"

require_text "$WORKER_GENERATION" 'def resolve_production_task_queue' \
  "worker must resolve a generation-scoped production queue"

require_text "$TEMPORAL" 'getCurrentAgentQueue' \
  "workflow start must resolve the routing pointer (so respawns land on the current generation)"

require_text "$DEPLOY" 'set-agent-queue-pointer.ts' \
  "cutover must flip the agent queue pointer to the new generation"
require_text "$DEPLOY" 'agent_workflow_surface_hash.py' \
  "cutover must compute the generation hash it flips the pointer to"
# The pointer flip must happen BEFORE the workflow migration so every respawn
# (which resolves its queue through the pointer) lands on the new generation.
pointer_flip_line=$(grep -n 'set-agent-queue-pointer.ts' "$DEPLOY" | tail -1 | cut -d: -f1)
migrate_exec_line=$(grep -n 'migrate-open-agent-workflows.ts --execute' "$DEPLOY" | tail -1 | cut -d: -f1)
[[ -n "$pointer_flip_line" && -n "$migrate_exec_line" && $pointer_flip_line -lt $migrate_exec_line ]] || \
  fail "cutover must flip the routing pointer BEFORE respawning open workflows"

# Self-driving CI cutover: the deploy workflow drives its own validate → flip →
# migrate so a bare `gh pr merge` can never strand the fleet in standby (the
# incident this redesign fixes). No external-driver hold, and a fail-safe rollback.
require_text "$DEPLOY_AGENTS_WORKFLOW" 'set-agent-queue-pointer.ts' \
  "deploy workflow must self-drive the routing-pointer flip"
require_text "$DEPLOY_AGENTS_WORKFLOW" 'migrate-open-agent-workflows.ts --execute' \
  "deploy workflow must self-drive the workflow respawn"
require_text "$DEPLOY_AGENTS_WORKFLOW" 'validate-candidate-workflow-image.ts --execute' \
  "deploy workflow must validate the candidate image before routing any traffic"
require_text "$DEPLOY_AGENTS_WORKFLOW" 'secrets.PROD_DATABASE_URL' \
  "self-driving cutover must use the prod DB secret"
require_text "$DEPLOY_AGENTS_WORKFLOW" 'rollback-' \
  "self-driving cutover must fail-safe roll the routing pointer back on failure"
if grep -Fq 'timeout-minutes: 125' "$DEPLOY_AGENTS_WORKFLOW"; then
  fail "the 125-minute external-driver hold must be gone (replaced by a self-driving cutover)"
fi
require_text "$DEPLOY" 'CI already cut over' \
  "skill cutover must short-circuit when CI already rolled over (no double-drive)"

# The CI cutover must wait for the Render backend (which reads the routing pointer)
# to be live on this exact commit BEFORE flipping — otherwise the old backend
# routes new workflow starts to the old queue while workers moved to the new
# generation, stranding those agents.
require_text "$DEPLOY_AGENTS_WORKFLOW" 'Render backend to go live' \
  "self-driving cutover must wait for the Render backend before flipping the routing pointer"
render_wait_line=$(grep -n 'Render backend to go live' "$DEPLOY_AGENTS_WORKFLOW" | head -1 | cut -d: -f1)
# The forward flip is uniquely marked by `--by "deploy-...` (rollback uses `rollback-`,
# the pre-read uses `--read`), so target it specifically.
agents_flip_line=$(grep -n 'deploy-${BUILD_ID}' "$DEPLOY_AGENTS_WORKFLOW" | head -1 | cut -d: -f1)
[[ -n "$render_wait_line" && -n "$agents_flip_line" && $render_wait_line -lt $agents_flip_line ]] || \
  fail "CI cutover must wait for the Render backend live BEFORE flipping the routing pointer"

echo "workflow deployment migration structural tests: PASS"
