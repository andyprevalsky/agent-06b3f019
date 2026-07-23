#!/usr/bin/env tsx

import { config } from 'dotenv';
import {
  prepareAgentWorkflowReplacement,
  startPreparedAgentWorkflowReplacement,
  type PreparedAgentWorkflowReplacement,
} from '../src/domains/agents/agentRestartService';
import { preflightAgentWorkflowReplacement } from '../src/domains/agents/agentRestartPreflight';
import { prisma } from '../src/providers/database';
import {
  activateTemporalWorkerBuild,
  cleanupSupersededWorkerActivationMarkers,
  workerDeploymentActivationWorkflowId,
} from '../src/providers/temporal';
import {
  assertNoUnsafeOpenDescendantWorkflows,
  runWorkflowDeploymentCutover,
  snapshotOpenRootWorkflows,
  waitForWorkflowReplacementBootstrap,
  type WorkflowDeploymentCandidate,
  type WorkflowDeploymentOutcome,
} from '../src/providers/workflowDeploymentMigration';
import {
  assertNoPendingTerminalAgentWorkflowCleanup,
  cleanupTerminalAgentWorkflowZombies,
  discoverRunningTerminalWorkflowCleanupObligations,
} from '../src/providers/workflowTerminalCleanup';
import { drainPendingDescendantWorkflowStarts } from '../src/providers/descendantWorkflowStart';
import {
  acquireWorkflowDeploymentLease,
  type WorkflowDeploymentLease,
} from '../src/providers/workflowDeploymentLease';
import {
  completeWorkflowDeploymentManifest,
  loadOrCreateWorkflowDeploymentManifest,
} from '../src/providers/workflowDeploymentManifest';

config();

const startDeadlines = new Map<string, number>();
let cutoverDeadlineAtMs = Number.POSITIVE_INFINITY;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function candidateDeadline(): number {
  const candidateTimeoutMs = positiveInteger(
    process.env.WORKFLOW_MIGRATION_CANDIDATE_TIMEOUT_MS,
    300_000
  );
  return Math.min(Date.now() + candidateTimeoutMs, cutoverDeadlineAtMs);
}

async function prepareOne(candidate: WorkflowDeploymentCandidate) {
  const result = await prepareAgentWorkflowReplacement(candidate.agentId, undefined, {
    expectedWorkflowId: candidate.workflowId,
    deadlineAtMs: candidateDeadline(),
  });
  if ('error' in result) {
    throw new Error(`${candidate.agentId}: ${result.error}`);
  }
  if ('skipped' in result && result.skipped === true) {
    return { outcome: 'skipped' as const };
  }
  return { outcome: 'prepared' as const, prepared: result };
}

async function preflightOne(candidate: WorkflowDeploymentCandidate) {
  const result = await preflightAgentWorkflowReplacement(candidate.agentId, undefined, {
    expectedWorkflowId: candidate.workflowId,
    deadlineAtMs: candidateDeadline(),
  });
  if (result.outcome === 'failed') {
    throw new Error(`${candidate.agentId}: ${result.error}`);
  }
  return result;
}

async function startOne(
  candidate: WorkflowDeploymentCandidate,
  prepared: PreparedAgentWorkflowReplacement
): Promise<{ workflowId: string }> {
  const deadlineAtMs = candidateDeadline();
  startDeadlines.set(candidate.agentId, deadlineAtMs);
  const result = await startPreparedAgentWorkflowReplacement({ ...prepared, deadlineAtMs });
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(
      `${candidate.agentId}: workflow migration deadline expired before durable readiness`
    );
  }
  return { workflowId: result.workflow_id };
}

async function waitUntilReady(
  candidate: WorkflowDeploymentCandidate,
  workflowId: string
): Promise<void> {
  const deadlineAtMs = startDeadlines.get(candidate.agentId);
  if (deadlineAtMs === undefined) {
    throw new Error(`${candidate.agentId}: candidate start deadline was lost`);
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`${candidate.agentId}: candidate deadline expired before durable readiness`);
  }
  await waitForWorkflowReplacementBootstrap(candidate.agentId, workflowId, {
    timeoutMs: Math.min(
      remainingMs,
      positiveInteger(process.env.WORKFLOW_MIGRATION_BOOTSTRAP_TIMEOUT_MS, 120_000)
    ),
    requireInitialized: candidate.status === 'ACTIVE',
  });
  startDeadlines.delete(candidate.agentId);
}

function printFailures(outcomes: WorkflowDeploymentOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.outcome === 'failed') {
      process.stderr.write(`FAILED ${outcome.agentId} ${outcome.workflowId}: ${outcome.error}\n`);
    }
  }
}

async function executeLeasedCutover(params: {
  concurrency: number;
  canaryCount: number;
  buildId: string;
  deploymentToken: string;
  lease: WorkflowDeploymentLease;
}): Promise<void> {
  const { concurrency, canaryCount, buildId, deploymentToken, lease } = params;
  const loaded = await loadOrCreateWorkflowDeploymentManifest(
    buildId,
    deploymentToken,
    async () => {
      const snapshotAt = new Date();
      return {
        snapshotAt,
        candidates: await snapshotOpenRootWorkflows(snapshotAt),
      };
    }
  );
  const snapshotAt = new Date(loaded.manifest.snapshotAt);
  const candidates = loaded.manifest.candidates;
  const expectedCandidateMs = positiveInteger(
    process.env.WORKFLOW_MIGRATION_EXPECTED_CANDIDATE_MS,
    5_000
  );
  const estimatedMs = Math.ceil(candidates.length / concurrency) * expectedCandidateMs;
  if (Date.now() + estimatedMs >= cutoverDeadlineAtMs) {
    throw new Error(
      `Refusing to seal ${candidates.length} workflows: estimated ${estimatedMs}ms cutover exceeds the absolute deployment deadline`
    );
  }
  process.stdout.write(
    `${loaded.reused ? 'Reused' : 'Frozen'} ${candidates.length} open root workflow(s) at ${snapshotAt.toISOString()}; concurrency=${concurrency}; estimatedMs=${estimatedMs}\n`
  );

  const assertLease = () => lease.assertOwned();
  const cutover = await runWorkflowDeploymentCutover(
    candidates,
    {
      preflight: async (candidate) => {
        await assertLease();
        return preflightOne(candidate);
      },
      prepare: async (candidate) => {
        await assertLease();
        return prepareOne(candidate);
      },
      activate: async () => {
        await assertLease();
        const rootAgentIds = candidates.map((candidate) => candidate.agentId);
        await drainPendingDescendantWorkflowStarts(
          rootAgentIds,
          {},
          {
            timeoutMs: positiveInteger(
              process.env.WORKFLOW_MIGRATION_PENDING_START_TIMEOUT_MS,
              120_000
            ),
          }
        );
        const terminalCleanupTimeoutMs = positiveInteger(
          process.env.WORKFLOW_MIGRATION_TERMINAL_CLEANUP_TIMEOUT_MS,
          900_000
        );
        const discoveredTerminalObligations =
          await discoverRunningTerminalWorkflowCleanupObligations();
        process.stdout.write(
          `Seeded ${discoveredTerminalObligations} running terminal/deleted cleanup obligation(s)\n`
        );
        const terminalCleanup = await cleanupTerminalAgentWorkflowZombies(
          {},
          {
            deadlineAtMs: Math.min(Date.now() + terminalCleanupTimeoutMs, cutoverDeadlineAtMs),
            maxConcurrency: positiveInteger(
              process.env.WORKFLOW_MIGRATION_TERMINAL_CLEANUP_CONCURRENCY,
              32
            ),
            ignoreGrace: true,
          }
        );
        process.stdout.write(
          `Reconciled terminal/deleted Temporal cleanup obligations: ${JSON.stringify(terminalCleanup)}\n`
        );
        await assertNoPendingTerminalAgentWorkflowCleanup();
        await assertNoUnsafeOpenDescendantWorkflows(rootAgentIds);
        await assertLease();
        const marker = await activateTemporalWorkerBuild(buildId, deploymentToken);
        process.stdout.write(
          `Activated standby Temporal worker deployment ${buildId}:${deploymentToken} via ${marker}\n`
        );
      },
      start: async (candidate, prepared) => {
        await assertLease();
        return startOne(candidate, prepared);
      },
      waitUntilReady: async (candidate, workflowId) => {
        await waitUntilReady(candidate, workflowId);
        await assertLease();
      },
    },
    { concurrency, canaryCount }
  );
  printFailures(cutover.outcomes);
  if (cutover.haltedAfter === 'preflight') {
    throw new Error(
      'Workflow migration preflight failed; no candidate workflow generation was claimed or terminated'
    );
  }
  if (cutover.haltedAfter === 'prepare') {
    throw new Error(
      'Workflow migration preparation failed; candidate workers remain standby and no old history was exposed'
    );
  }
  if (cutover.haltedAfter === 'activation') {
    throw new Error(`Workflow migration activation failed: ${cutover.activationError}`);
  }
  if (cutover.haltedAfter === 'canary') {
    throw new Error('Workflow migration canary failed; refusing to start the prepared bulk set');
  }
  process.stdout.write('Canary durable READY phase passed\n');

  const summary = { prepared: 0, migrated: 0, skipped: 0, failed: 0 };
  for (const outcome of cutover.outcomes) summary[outcome.outcome] += 1;
  if (summary.failed === 0 && summary.prepared === 0) {
    await assertLease();
    const currentMarker = workerDeploymentActivationWorkflowId(buildId, deploymentToken);
    const retiredMarkers = await cleanupSupersededWorkerActivationMarkers(currentMarker);
    process.stdout.write(`Retired ${retiredMarkers} superseded activation marker(s)\n`);
    await completeWorkflowDeploymentManifest(buildId, deploymentToken);
  }
  process.stdout.write(
    `${JSON.stringify({
      snapshotAt: snapshotAt.toISOString(),
      buildId,
      deploymentToken,
      total: cutover.outcomes.length,
      ...summary,
    })}\n`
  );
  if (summary.failed > 0 || summary.prepared > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--execute')) {
    throw new Error('Refusing to mutate workflows without --execute');
  }
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'navi-agent-tasks';
  if (taskQueue !== 'navi-agent-tasks') {
    throw new Error(`Refusing production migration on non-production task queue ${taskQueue}`);
  }
  const concurrency = positiveInteger(process.env.WORKFLOW_MIGRATION_CONCURRENCY, 16);
  const canaryCount = positiveInteger(process.env.WORKFLOW_MIGRATION_CANARY_COUNT, 4);
  const buildId = process.env.TEMPORAL_WORKER_BUILD_ID;
  if (buildId === undefined) {
    throw new Error('TEMPORAL_WORKER_BUILD_ID is required for an exact-build workflow cutover');
  }
  const deploymentToken = process.env.TEMPORAL_WORKER_DEPLOYMENT_TOKEN;
  if (deploymentToken === undefined) {
    throw new Error(
      'TEMPORAL_WORKER_DEPLOYMENT_TOKEN is required for an exact-deployment workflow cutover'
    );
  }
  cutoverDeadlineAtMs =
    Date.now() + positiveInteger(process.env.WORKFLOW_MIGRATION_TOTAL_TIMEOUT_MS, 5_400_000);
  const lease = await acquireWorkflowDeploymentLease();
  try {
    await executeLeasedCutover({
      concurrency,
      canaryCount,
      buildId,
      deploymentToken,
      lease,
    });
  } finally {
    await lease.release();
  }
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
