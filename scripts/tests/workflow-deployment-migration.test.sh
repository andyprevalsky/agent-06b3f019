#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DEPLOY="$ROOT/.claude/commands/deploy.md"
SCRIPT="$ROOT/back-end/scripts/migrate-open-agent-workflows.ts"
PREFLIGHT="$ROOT/back-end/src/domains/agents/agentRestartPreflight.ts"
MANIFEST="$ROOT/back-end/src/providers/workflowDeploymentManifest.ts"
PROD_VALIDATOR="$ROOT/back-end/scripts/validate-prod-workflow-migration.ts"
CANDIDATE_VALIDATOR="$ROOT/back-end/scripts/validate-candidate-workflow-image.ts"
HISTORY_METRICS="$ROOT/back-end/src/providers/workflowHistoryMetrics.ts"
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

require_file() {
  [ -f "$1" ] || fail "$2"
}

require_text() {
  local file=$1 pattern=$2 message=$3
  grep -Fq -- "$pattern" "$file" || fail "$message"
}

# The deploy command doc (deploy.md) is one-line `scripts/deploy ...` steps and
# carries no inline cutover scripts; the behavior below is executed by
# `scripts/deploy production` (deploy_prod.py, lane planning + fly lane) and
# run_deploy_pipeline.py (merged-change classification, exact-job verification).
# Assert those executing sources, and deploy.md only for its stated rules.
PROD="$ROOT/scripts/deploy_prod.py"
PIPELINE="$ROOT/scripts/run_deploy_pipeline.py"
DEPLOY_CLI="$ROOT/scripts/deploy_cli.py"

# This suite cements itself: deploy.md carries no gate list, so the registry that
# `scripts/deploy gates` runs must name it exactly once with this command.
python3 -B - "$ROOT/scripts/run-deploy-structural-gates.py" <<'PY' || fail "workflow-deployment-migration must be registered exactly once in the structural-gate registry"
import re
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
pattern = r'Gate\(\s*"workflow-deployment-migration",\s*\("bash", "scripts/tests/workflow-deployment-migration.test.sh"\)'
raise SystemExit(0 if len(re.findall(pattern, source)) == 1 else 1)
PY

# Classification of the merged change set: both the lane planner and the
# production gate use the executable runtime classifier on the exact merge
# commit's own diff, and one canonical condition drives the Fly cutover lane and
# the replacement matrix.
require_text "$PROD" "CLASSIFY = Path('scripts') / 'classify-agent-runtime-changes.sh'" "/deploy must use the executable runtime classifier"
require_text "$PIPELINE" 'CLASSIFY_AGENT_RUNTIME = Path("scripts") / "classify-agent-runtime-changes.sh"' "production gate must use the executable runtime classifier"
require_text "$DEPLOY_CLI" "'--json', 'mergeCommit', '--jq', '.mergeCommit.oid'" "/deploy must capture the exact PR merge commit"
require_text "$PROD" "io.capture(['git', 'diff', '--name-only', f'{sha}^1', sha], root, environ)" "/deploy must freeze the exact merged change set before cutover"
require_text "$PIPELINE" '["git", "diff", "--name-only", f"{merged_sha}^1", merged_sha]' "production gate must classify the exact merged change set"
require_text "$PIPELINE" 'changed = merged_changes(merged_sha, root)' "production gate must derive agent classification from the frozen merged change set"
require_text "$PIPELINE" 'cutover = agent_cutover_required(changed, root)' "production gate must classify the merged change set before waiting for cutover"
require_text "$PIPELINE" 'workflow = AGENTS_WORKFLOW_PATH in changed' "production gate must include deploy-workflow-only changes in cutover classification"
require_text "$PIPELINE" '"required": bool(runtime or workflow)' "production gate cutover classification must match GitHub activation inputs"
require_text "$PROD" "fly_reason = '; '.join(filter(None, ['agent runtime files: '" "lane planner must derive cutover from the classified runtime files"
require_text "$PROD" "f'{AGENTS_WORKFLOW_PATH} changed' if workflow else ''" "lane planner must include deploy-workflow-only changes in cutover classification"
# One canonical cutover condition: the Fly cutover lane and the production
# replacement matrix (old Steps 13 and 13ac) are applicable on the same
# `fly_reason`, never on a runtime-only or latest-main condition.
[[ $(grep -Fc "bool(fly_reason)" "$PROD") -eq 2 ]] ||
  fail "the Fly cutover lane and the workflow replacement matrix must use the same canonical agent cutover condition"
if grep -Fq 'git rev-parse origin/main' "$PROD" "$DEPLOY_CLI" "$PIPELINE"; then
  fail "/deploy must not classify whichever commit happens to be latest on origin/main"
fi
python3 - "$ROOT" <<'PY' || fail "agent cutover classification must follow the activation-gated change set"
import sys
from pathlib import Path

sys.dont_write_bytecode = True
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
import deploy_prod as dp
import run_deploy_pipeline as rp

mac = {"ship": "false", "reason": "test", "label": "false"}
runtime = ["agents/helpers/messages.py"]
cases = [
    (runtime + ["agents/tests/test_x.py"], runtime, True),           # shipped runtime code
    ([".github/workflows/deploy-agents.yml"], [], True),             # deploy workflow only
    (["agents/tests/test_x.py", "agents/README.md"], [], False),     # additive tests/docs only
    (["docs/api/agents.mdx"], [], False),
]
for changed, runtime_files, required in cases:
    plan = dp.plan_lanes(changed, runtime_files, mac)
    assert plan["fly"].applicable == plan["workflow-migration"].applicable == required, (changed, plan["fly"], plan["workflow-migration"])
    gate = rp.agent_cutover_required(changed, root)
    assert gate["required"] == required, (changed, gate)
    assert gate["workflow_changed"] == (".github/workflows/deploy-agents.yml" in changed), (changed, gate)
# The production gate and the planner classify the same runtime files.
assert rp.agent_cutover_required(runtime + ["agents/tests/test_x.py"], root)["runtime_files"] == runtime
# The matrix follows the cutover; endpoint probes follow Render; semantics wait for every live surface.
assert dp.DEPENDS["workflow-migration"] == ("fly",), dp.DEPENDS
assert dp.DEPENDS["backend-probes"] == ("render",), dp.DEPENDS
assert set(dp.DEPENDS["semantic"]) == {"render", "vercel", "fly"}, dp.DEPENDS
PY
# The exact workflow job and attempt are bound by the verifier, and the
# deployment token is the exact GitHub run attempt.
require_text "$PIPELINE" 'deployment_token=f"{run_id}-{attempt}" if attempt else None' "/deploy must scope the job to its GitHub run attempt"
require_text "$PIPELINE" 'source_commit, attempt = identity["sourceCommit"], identity["attempt"]' "/deploy must verify the merged source and attempt of the job"
require_text "$PIPELINE" 'if source_commit != merged_sha or attempt != fly["deployment_token"]' "/deploy must verify the merged source and the exact workflow attempt"
require_text "$PIPELINE" '"scripts/worker-deployment-queue.ts", "read", "--job-id", job_id' "/deploy must bind its verification to the durable job"
# Live-at-boot (REQUIRE_ACTIVATION=0): workers never poll navi-agent-candidate-*,
# so validate-candidate-workflow-image / verify-agent-candidate-fleet hang. Cooperative
# cutover proof is monitor --verify (pointer + old-queue drain), not standby seals.
if grep -Eq 'validate-candidate-workflow-image|verify-agent-candidate-fleet' "$PROD" "$PIPELINE" "$DEPLOY_CLI" "$ROOT/.claude/commands/deploy.md"; then
  fail "/deploy must not run validate-candidate-workflow-image or verify-agent-candidate-fleet under live-at-boot (hangs on unpolled candidate queue)"
fi
# monitor --verify is the authoritative cooperative-cutover proof: its failure
# blocks the production gate before any dependent lane can run.
require_text "$PIPELINE" 'receipt["cutover_verify"] = cutover_verify(fly, merged_sha, expected, root=root)' \
  "/deploy must treat monitor --verify as the cooperative cutover proof"
require_text "$PIPELINE" 'monitor-cooperative-cutover.ts --verify failed (exit' \
  "a failed monitor --verify must block the production gate"
require_text "$PIPELINE" '"scripts/monitor-cooperative-cutover.ts", "--job-id", job_id,' \
  "/deploy must use monitor-cooperative-cutover.ts for handover verification"
require_text "$PIPELINE" '"--expected-hash", expected_hash, "--verify"' \
  "handover verification must run monitor --verify against the expected surface hash"
# DOC GAP (reported, not edited): the executable Render old-instance drain wait
# (RENDER_OLD_INSTANCE_DRAIN_SECONDS default/minimum 375 s measured from the exact
# live producer deploy's finishedAt) existed only in the retired inline script
# (the former /deploy skill "First managed deployment"). No CLI code runs it; deploy.md
# keeps the rule, so assert the stated rule.
require_text "$DEPLOY" 'old instances have drained for at least 375 s' "/deploy must wait through Render's maximum old-instance shutdown window plus margin"
# Replacement matrix: executed by the production lane for the exact merge commit
# and deployment attempt, with its explicit production-validation opt-in.
require_text "$PROD" "MIGRATION_ARGV = ['npx', 'tsx', 'scripts/validate-prod-workflow-migration.ts', '--execute']" "/deploy must execute the production replacement matrix"
require_text "$PROD" "{'PRODUCTION_WORKFLOW_MIGRATION_VALIDATION': '1'," "/deploy must explicitly opt in to production validation"
require_text "$PROD" "'TEMPORAL_WORKER_BUILD_ID': sha," "/deploy production matrix must identify the exact candidate build"
require_text "$PROD" "'TEMPORAL_WORKER_DEPLOYMENT_TOKEN': token}" "/deploy production matrix must identify the exact deployment attempt"
require_text "$PROD" "extra=migration_env(ctx.sha, token))" "the production matrix must run with the exact merged SHA and deployment token"
require_text "$PROD" "token = (ctx.production_receipt().get('fly') or {}).get('deployment_token')" "the production matrix must take the token from the cutover receipt"
# Cooperative handoff semantics: long-running work stays on its bank; a drain
# timeout retains the job and bank instead of force-terminating (also pinned in
# cooperative-cutover-monitor.test.sh). The doc states the same stop rule.
require_text "$ROOT/scripts/worker_pool_cutover.py" 'raise PoolCapacityPending("Old bank remains served' "cooperative handoff must retain unfinished work on its bank"
require_text "$DEPLOY" 'force-migrate workflows' "/deploy must forbid forced workflow migration for an interrupted cutover"

require_text "$CANDIDATE_VALIDATOR" "process.argv.includes('--execute')" "candidate validator must require explicit execution mode"
require_text "$CANDIDATE_VALIDATOR" "kind: 'validation'" "candidate validator must run the real workflow in validation mode"
require_text "$CANDIDATE_VALIDATOR" "deployment_initialized_query" "candidate validator must wait through common initialization"
require_text "$CANDIDATE_VALIDATOR" "workflowTaskFailedEventAttributes" "candidate validator must reject nondeterministic workflow tasks"
require_text "$CANDIDATE_VALIDATOR" "workflowTaskFailedEventAttributes != null" "candidate validator must ignore protobuf nulls while rejecting real workflow-task failures"
require_text "$CANDIDATE_VALIDATOR" "activityTaskScheduledEventAttributes != null" "candidate validator must count only real initialization activities"
# Prod validator delegates history counting to workflowHistoryMetrics so cold/
# handoff gates share one protobuf-null-safe implementation (Temporal may emit
# attributes as explicit null). The helper must reject both null and undefined.
require_text "$PROD_VALIDATOR" "summarizeWorkflowHistory" "production validator must summarize history via shared helper"
require_text "$HISTORY_METRICS" "event.workflowTaskFailedEventAttributes !== null" "production validator must ignore protobuf nulls while rejecting real workflow-task failures"
require_text "$HISTORY_METRICS" "event.workflowTaskFailedEventAttributes !== undefined" "history metrics must also ignore missing workflow-task-failure attributes"
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

require_text "$PROD_VALIDATOR" "for (const signal of ['SIGTERM', 'SIGINT'] as const)" "production validator must clean up its fixtures when it is terminated"
require_text "$PROD_VALIDATOR" "cleanupInterruptedRun()" "production validator must remove a terminated run's fixtures by its run-unique user and queue"
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

# First managed deployment and interrupted cutovers: deploy.md states the rule
# (the executable drain wait of the retired inline script is a DOC GAP, see
# above); the resume of the exact saved job is executed by lane_fly.
require_text "$DEPLOY" 'Keep automatic worker deploys off for the first managed deployment' "first managed deployment requires complete producer rollout"
require_text "$DEPLOY" 'old instances have drained' "first publication cannot race legacy producers"
require_text "$DEPLOY" 'An interrupted Fly cutover resumes the same job' "interrupted preparation must retain its ownership"
require_text "$DEPLOY" 'release reservations on a timer' "an interrupted cutover must not release its reservations"
require_text "$PROD" "resumed = ctx.sh('fly', resume_argv(job), cwd=ctx.root / 'back-end', env_file='back-end')" "an interrupted cutover must resume the exact saved job"
require_text "$PIPELINE" '"scripts/monitor-cooperative-cutover.ts", "--job-id", job_id,' "post-merge verification must read the durable job"
if grep -Fq 'migrate-open-agent-workflows' "$PROD" "$PIPELINE" "$DEPLOY_CLI" "$DEPLOY"; then
  fail "routine cutover must not force-migrate unfinished production work"
fi

WORKFLOW="$ROOT/.github/workflows/deploy-agents.yml"
COOP="$ROOT/scripts/deploy-agents-cooperative-cutover.sh"
WORKER="$ROOT/agents/worker.py"
python3 - "$WORKFLOW" <<'PY'
import fnmatch
import os
import re
import subprocess
import sys
import textwrap

import yaml

with open(sys.argv[1]) as source:
    workflow = source.read()
# BaseLoader keeps the YAML key "on" a string instead of YAML 1.1's boolean.
config = yaml.load(workflow, Loader=yaml.BaseLoader)
path_filters = config["on"]["push"]["paths"]
assert isinstance(path_filters, list) and all(isinstance(value, str) for value in path_filters)
assert "agents/**" in path_filters, "worker runtime changes must trigger deployment"
last_runtime_include = max(i for i, value in enumerate(path_filters) if value == "agents/**")
for excluded in ("!agents/tests/**", "!agents/benchmarks/**"):
    assert excluded in path_filters, f"additive worker inputs must be excluded: {excluded}"
    assert path_filters.index(excluded) > last_runtime_include, excluded

patterns = path_filters

def triggers_worker_deploy(path):
    included = False
    for pattern in patterns:
        if fnmatch.fnmatchcase(path, pattern.lstrip("!")):
            included = not pattern.startswith("!")
    return included

for path in (
    "scripts/worker_pool_cutover.py",
    "scripts/agents-image-context.sh",
    "scripts/worker_pool_runtime.py",
    "scripts/retained_agent_machine.py",
    "back-end/src/providers/workerDeploymentQueue.ts",
    "back-end/src/providers/workerDeploymentRetention.ts",
    "back-end/src/providers/workerDeploymentMachineAdmission.ts",
    "back-end/src/providers/workerDeploymentPollers.ts",
):
    assert triggers_worker_deploy(path), f"worker runtime change is not deployed: {path}"
for path in (
    "scripts/tests/worker-pool-cutover.test.py",
    "back-end/src/tests/unit/worker-deployment-pollers.test.ts",
    "agents/tests/blackbox/worker.blackbox.py",
    "docs/rca/cases/worker-routing.md",
):
    assert not triggers_worker_deploy(path), f"non-runtime change deploys workers: {path}"
dispatch = re.search(r"(?ms)^  workflow_dispatch:\n(.*?)^  push:", workflow)
assert dispatch, "worker deployment needs a manual recovery entry point"
assert "      expected_sha:" in dispatch[1] and "        required: true" in dispatch[1]
guard = re.search(
    r"(?ms)^    steps:\n      - name: Verify manual deployment source\n(.*?)^      - uses:",
    workflow,
)
assert guard, "dispatch source guard must precede checkout and all deployment steps"
assert "if: github.event_name == 'workflow_dispatch'" in guard[1]
assert "EXPECTED_SHA: ${{ inputs.expected_sha }}" in guard[1]
body = re.search(r"run: \|\n((?:          .*\n)+)", guard[1])
assert body, "manual source guard must have an executable shell body"
sha = "a" * 40
for ref, expected, allowed in [
    ("refs/heads/main", sha, True),
    ("refs/heads/main", "b" * 40, False),
    ("refs/heads/feature", sha, False),
]:
    result = subprocess.run(
        ["bash", "-euo", "pipefail", "-c", textwrap.dedent(body[1])],
        env={**os.environ, "GITHUB_REF": ref, "GITHUB_SHA": sha, "EXPECTED_SHA": expected},
        capture_output=True, text=True,
    )
    assert (result.returncode == 0) is allowed, (ref, expected, result)
PY
require_text "$WORKFLOW" 'BUILD_ID: ${{ github.sha }}' "Fly deploy must identify the exact candidate SHA"
require_text "$WORKFLOW" 'DEPLOYMENT_TOKEN: ${{ github.run_id }}-${{ github.run_attempt }}' "Fly deploy must identify the exact deployment attempt"
require_text "$WORKFLOW" 'deploy-agents-cooperative-cutover.sh' "Fly deploy must run the cooperative cutover script"
POOL_DRIVER="$ROOT/scripts/worker_pool_cutover.py"
POOL_HELPER="$ROOT/scripts/retained_agent_machine.py"
require_text "$POOL_HELPER" '"TEMPORAL_WORKER_REQUIRE_ACTIVATION": "0"' "prepared workers must be live before pointer publication"
require_text "$POOL_HELPER" '"TEMPORAL_WORKER_BUILD_ID": args.build' "pool reuse must stamp the exact build"
require_text "$POOL_HELPER" '"TEMPORAL_WORKER_DEPLOYMENT_TOKEN": args.token' "pool reuse must stamp the exact attempt"
require_text "$POOL_HELPER" '"AUTOSCALER_ACTUATE": "0"' "the controller exclusively owns pool Machine lifecycles"
if grep -qE '^concurrency:|group: deploy-agents-production' "$WORKFLOW"; then
  fail "GitHub pending-run replacement cannot implement the durable FIFO"
fi
require_text "$COOP" 'worker-deployment-queue.ts run' "all deployers must use the durable lease-owning runner"
require_text "$WORKFLOW" 'Resolve Fly app name from fly.toml' "deploy must read Fly app from fly.toml (not a missing secret)"
require_text "$WORKFLOW" 'steps.flyapp.outputs.name' "cutover step must use fly.toml-resolved app name"
if grep -qE 'secrets\.FLY_APP_NAME \|\| secrets\.FAS_APP_NAME' "$WORKFLOW"; then
  fail "deploy must not use unsupported secret || fallback for APP (GitHub Actions leaves it empty)"
fi
require_text "$COOP" 'agents/fly.toml' "cutover script must fall back to fly.toml when APP is unset"
require_text "$WORKFLOW" 'Cooperative Fly deploy + generation cutover' "agent deploy workflow must hold serialization through cooperative cutover"
require_text "$WORKFLOW" 'RELEASE_CONTEXT: agent-cutover/${{ github.run_id }}-${{ github.run_attempt }}' "deploy lock release must be scoped to the exact run attempt"
DOCKERIGNORE="$ROOT/agents/.dockerignore"
require_text "$DOCKERIGNORE" $'\nbenchmarks/\n' "Fly build context must exclude benchmarks/ (ledger history blew past 100MB and timed out Depot)"
require_text "$DOCKERIGNORE" $'\ntests/\n' "Fly build context must exclude tests/ (not shipped in the Temporal worker image)"
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

# Lane ordering (retired: "13a health < 13ab cutover < 13ac matrix < 13b semantic"
# doc-heading order). The production lanes now run concurrently as a dependency
# DAG in deploy_prod.py: the matrix waits for the cutover and the endpoint probes
# wait for Render (asserted above through DEPENDS); semantics wait for Render,
# Vercel and the cutover, but no longer for the probes or the matrix.

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
require_text "$POOL_HELPER" '"TEMPORAL_WORKER_SURFACE_HASH": args.hash' \
  "deploy-agents cutover must pass the surface hash so workers poll their generation queue"

require_text "$WORKER_GENERATION" 'def resolve_production_task_queue' \
  "worker must resolve a generation-scoped production queue"

require_text "$TEMPORAL" 'getCurrentAgentQueue' \
  "workflow start must resolve the routing pointer (so respawns land on the current generation)"

require_text "$POOL_DRIVER" 'set-agent-queue-pointer.ts' "controller must publish routing only after readiness"
require_text "$POOL_DRIVER" '"--expected-current-queue"' "pointer publication must compare the prior generation"
require_text "$POOL_DRIVER" 'ledger.assert_owned()' "native mutations must retain shared lease ownership"
require_text "$POOL_DRIVER" 'initialize-managed-worker-queue.ts' "fresh queues require producer coverage before use"
require_text "$POOL_DRIVER" '"--verify-retired"' "recycled banks require their exact queue retirement certificate"
require_text "$POOL_DRIVER" '"RETIRED" if managed else "RETAINED_LEGACY"' "legacy retention must not pretend retirement"
require_text "$DEPLOY_AGENTS_WORKFLOW" 'secrets.PROD_DATABASE_URL' "shared control plane must use the production DB"
# Cutover coalescing and the rollback guard need ancestry proofs: bounded history
# (never the ~2.6 GB full benchmark history) plus the opted-in GitHub compare.
require_text "$DEPLOY_AGENTS_WORKFLOW" 'fetch-depth: 64' "deploy checkout must carry bounded history for ancestry proofs"
require_text "$DEPLOY_AGENTS_WORKFLOW" 'WORKER_DEPLOYMENT_ANCESTRY_GITHUB: "1"' "deploy cutover must opt into GitHub ancestry proofs"
if grep -Eq 'fetch-depth: 0' "$DEPLOY_AGENTS_WORKFLOW"; then
  fail "deploy-agents checkout must never fetch the full history"
fi
if grep -qE 'force-clear-generation-queue.ts|migrate-open-agent-workflows.ts' "$POOL_DRIVER" "$COOP"; then
  fail "routine pool cutover must not terminate unfinished work"
fi
# Verification of a completed job reads it and runs the monitor; it never
# re-drives the cutover (only lane_fly resumes a job that is not SUCCEEDED).
python3 - "$ROOT" <<'PY' || fail "verification must not independently redrive a completed job"
import inspect
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
import run_deploy_pipeline as rp

body = inspect.getsource(rp.cutover_verify)
assert '"read", "--job-id"' in body and "monitor-cooperative-cutover.ts" in body, body
for forbidden in ("worker_pool_cutover", '"run", "--job-id"', "--allow-abort", "force-clear", "migrate-open"):
    assert forbidden not in body, forbidden
PY

# The self-driving cutover installs back-end deps in CI. back-end is an npm
# workspace and the root lockfile is not committed, so a plain `npm ci` in the
# workspace fails (EUSAGE) — it must pin to the committed back-end lockfile.
require_text "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" 'npm ci --workspaces=false' \
  "self-driving cutover must install back-end deps with --workspaces=false (root lockfile is not committed)"
if grep -qE '^\s+npm ci\s*$' "$DEPLOY_AGENTS_WORKFLOW" "$ROOT/scripts/deploy-agents-cooperative-cutover.sh"; then
  fail "self-driving cutover must not use a bare 'npm ci' (fails in the back-end workspace without the root lockfile)"
fi
# release() posts an agent-cutover commit status, which needs statuses: write.
require_text "$DEPLOY_AGENTS_WORKFLOW" 'statuses: write' \
  "deploy-agents must grant statuses: write so the self-driving cutover can post its release status"

# Same replay hash still receives a new job queue; every physical bank must be drainable.
require_text "$POOL_DRIVER" 'sha256(job_id.encode())' "queue identity must bind each immutable deployment"
if grep -q 'Surface unchanged' "$COOP"; then
  fail "same-code deploy cannot bypass the bank lifecycle with an untracked rolling update"
fi
if grep -q 'activate-agent-worker-build.ts' "$DEPLOY_AGENTS_WORKFLOW"; then
  fail "managed banks must not depend on an unrelated standby activation marker"
fi

echo "workflow deployment migration structural tests: PASS"

# ── Reusable bank cutover: exact native retirement, never timeout-based destruction ──
require_text "$DEPLOY_AGENTS_WORKFLOW" 'deploy-agents-cooperative-cutover.sh' \
  "deploy-agents must use the durable controller entry point"
require_text "$POOL_DRIVER" 'DRAIN_TIMEOUT_SECONDS = 2700' \
  "a bounded observation window must retain unfinished work for resumption"
# Keep the explicit, separate recovery tools validated; the normal path never calls them.
require_text "$ROOT/back-end/scripts/force-clear-generation-queue.ts" '--execute' \
  "generation force-clear must require --execute"
require_text "$ROOT/back-end/scripts/force-clear-generation-queue.ts" 'clearSupersededGenerationWorkflow' \
  "generation force-clear must replace stragglers via clearSupersededGenerationWorkflow"
require_text "$ROOT/back-end/src/providers/generationQueueCutover.ts" 'restartAgent' \
  "generation cutover stragglers must be replaced, not marked FAILED"
if grep -n "status: 'FAILED'" "$ROOT/back-end/scripts/force-clear-generation-queue.ts" \
  | grep -v 'summary.failed' >/dev/null; then
  fail "force-clear must not mark owned agents FAILED"
fi
require_text "$COOP" '--image-label' "worker builds must resolve their registry image"
require_text "$COOP" 'registry.fly.io' "worker image must be in the production registry"
require_text "$COOP" '--build-only' "build must not replace an existing Machine"
require_text "$COOP" '--local-only' "build must not allocate a Fly builder Machine"
require_text "$COOP" '@${IMAGE_DIGEST}' "queued images must be pinned to an immutable digest"
require_text "$ROOT/agents/fly.toml" 'kill_timeout = "5m"' \
  "Fly kill_timeout must stay within the Machines 5m stop_config.timeout cap"
require_text "$POOL_DRIVER" 'MACHINE_STOP_TIMEOUT_SECONDS = 120' "native stop observation must be bounded"
require_text "$POOL_DRIVER" '"--retire"' "native stop requires qualified queue retirement first"
require_text "$ROOT/agents/worker.py" 'graceful_shutdown_timeout' \
  "Temporal worker must wait for in-flight activities on shutdown"
require_text "$ROOT/agents/loop/run_agent.py" 'generation_handoff' \
  "run_agent must yield generation_handoff at the pre-LLM checkpoint"
require_text "$ROOT/agents/workflows/agent_workflow.py" 'task_queue=' \
  "workflow must continue_as_new onto the live generation queue"
require_file "$ROOT/back-end/scripts/count-open-workflows-on-queue.ts" \
  "open-queue counter used by the 45m drain loop must exist"
require_file "$ROOT/back-end/scripts/monitor-cooperative-cutover.ts" \
  "cooperative cutover monitor used by /deploy post-merge verification must exist"
require_file "$ROOT/back-end/src/domains/agent-queue-pointer/routes.ts" \
  "live pointer HTTP route must exist for run_agent checkpoints"

# Behavioral: run the real cutover script against Fly fakes (clone adoption,
# fresh provisioning, transient Machines API update failures).
bash "$ROOT/scripts/tests/deploy-agent-clone-recovery.test.sh" ||
  fail "pool entry must enqueue an immutable image without allocating Machines"
python3 "$ROOT/scripts/tests/retained-agent-machine.test.py" ||
  fail "retained worker reuse must preserve native ownership, custody, config and leases"

python3 "$ROOT/scripts/tests/worker-pool-cutover.test.py" ||
  fail "pool cutover must preserve ownership, readiness and positive retirement across resumption"
