/**
 * Regression for the 2026-08-03 incident: a cleanup script TERMINATED 16 live
 * production agent workflows. A day later, measured against prod Temporal and
 * the prod API, the rows were still 3 ACTIVE / 5 PAUSED / 8 COST_LIMIT_REACHED
 * and 0 FAILED — because every terminal status write originates inside the
 * workflow, and TERMINATE runs no workflow code.
 *
 * See docs/rca/cases/2026-08-04-no-liveness-reconciler-for-externally-closed-workflows.md
 *
 * The safety property matters as much as the repair: an inconclusive Temporal
 * read must NEVER seal a row, or the reconciler becomes the thing that kills
 * live agents.
 */

import {
  assert,
  createAnonymousSession,
  prisma,
  randomUUID,
  test,
  trackedAgentIds,
  withTransientDbRetry,
} from './agents-blackbox-harness';
import {
  RECONCILED_STATUS_MESSAGE,
  reconcileWorkflowLiveness,
} from '../../providers/workflowLivenessReconciler';

/**
 * Seed a workflow-backed row without HTTP create. createTestAgent starts a
 * chat-mode LLM whose later status/workflow writes can overwrite the fixture
 * after makeEligible and drop the row from the candidate set (PAUSED is the
 * typical loser).
 */
async function seedLivenessAgent(
  userId: string,
  label: string,
  status: 'ACTIVE' | 'PAUSED' | 'COST_LIMIT_REACHED'
): Promise<{ agentId: string; workflowId: string }> {
  const agentId = randomUUID();
  const workflowId = `wf-${randomUUID()}`;
  trackedAgentIds.add(agentId);
  await withTransientDbRetry(`create-liveness-${label}`, async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal: `liveness ${label}`,
        status,
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
        temporalWorkflowId: workflowId,
      },
    });
  });
  return { agentId, workflowId };
}

/** Force eligibility past any late background write. */
async function makeEligible(agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) {
    await prisma.$executeRaw`UPDATE "Agent" SET "updatedAt" = '2020-01-01T00:00:00.000Z' WHERE id = ${agentId}`;
  }
}

async function statusOf(agentId: string): Promise<string> {
  const row = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { status: true },
  });
  return String(row?.status);
}

test('reconciler seals ACTIVE/PAUSED/COST_LIMIT_REACHED agents whose workflow is TERMINATED', async () => {
  const session = await createAnonymousSession('liveness-seal');
  const statuses = ['ACTIVE', 'PAUSED', 'COST_LIMIT_REACHED'] as const;

  const agents = [];
  for (const status of statuses) {
    const seeded = await seedLivenessAgent(session.user.id, status, status);
    agents.push({ ...seeded, status });
  }
  const workflowIds = new Set(agents.map((a) => a.workflowId));
  await makeEligible(agents.map((a) => a.agentId));

  // Unknown workflows report RUNNING, so a wide batch cannot disturb other tests'
  // agents — only the three created here are eligible to be sealed.
  await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (workflowId: string) =>
      workflowIds.has(workflowId) ? 'WORKFLOW_EXECUTION_STATUS_TERMINATED' : 'RUNNING',
  });

  for (const { agentId, status } of agents) {
    assert(
      (await statusOf(agentId)) === 'FAILED',
      `agent previously ${status} should be sealed FAILED, got ${await statusOf(agentId)}`
    );
  }

  const sealed = await prisma.agent.findUnique({
    where: { id: agents[0].agentId },
    select: { statusMessage: true },
  });
  assert(
    sealed?.statusMessage === RECONCILED_STATUS_MESSAGE,
    `sealed agent should explain why, got ${sealed?.statusMessage}`
  );
});

test('reconciler leaves an agent alone when Temporal reports RUNNING', async () => {
  const session = await createAnonymousSession('liveness-running');
  const { agentId, workflowId } = await seedLivenessAgent(session.user.id, 'running', 'ACTIVE');

  await makeEligible([agentId]);
  await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id: string) =>
      id === workflowId ? 'WORKFLOW_EXECUTION_STATUS_RUNNING' : 'RUNNING',
  });

  assert((await statusOf(agentId)) === 'ACTIVE', 'a running workflow must never be sealed');
});

test('reconciler does not seal a replacement generation from a stale candidate', async () => {
  const session = await createAnonymousSession('liveness-replacement-race');
  const { agentId, workflowId } = await seedLivenessAgent(
    session.user.id,
    'replacement-race',
    'ACTIVE'
  );
  const replacementWorkflowId = `${workflowId}:replacement:${randomUUID()}`;

  await makeEligible([agentId]);
  const summary = await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id: string) => {
      if (id !== workflowId) return 'RUNNING';
      // Race the candidate snapshot: a deploy claims a replacement generation
      // after discovery but before the old workflow's closed result is applied.
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: replacementWorkflowId },
      });
      return 'WORKFLOW_EXECUTION_STATUS_TERMINATED';
    },
  });

  const row = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { status: true, temporalWorkflowId: true },
  });
  assert(row?.status === 'ACTIVE', 'a stale liveness candidate must not fail its replacement');
  assert(
    row?.temporalWorkflowId === replacementWorkflowId,
    'the replacement workflow identity must remain current'
  );
  assert(summary.sealed === 0, 'a stale liveness candidate must not count as sealed');
});

test('reconciler leaves an agent alone when the Temporal read is inconclusive', async () => {
  const session = await createAnonymousSession('liveness-error');
  const { agentId, workflowId } = await seedLivenessAgent(session.user.id, 'error', 'ACTIVE');

  await makeEligible([agentId]);
  const summary = await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id: string) => {
      if (id === workflowId) throw new Error('Temporal unavailable');
      return 'RUNNING';
    },
  });

  assert(
    (await statusOf(agentId)) === 'ACTIVE',
    'an inconclusive read must never seal a live agent'
  );
  assert(summary.inconclusive >= 1, 'inconclusive reads should be counted, not swallowed');
});

test('reconciler seals an agent whose workflow no longer exists', async () => {
  const session = await createAnonymousSession('liveness-notfound');
  const { agentId, workflowId } = await seedLivenessAgent(session.user.id, 'notfound', 'ACTIVE');

  await makeEligible([agentId]);
  await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id: string) => (id === workflowId ? 'NOT_FOUND' : 'RUNNING'),
  });

  assert(
    (await statusOf(agentId)) === 'FAILED',
    'a workflow Temporal cannot find is closed as far as the row is concerned'
  );
});

test('reconciler releases browser sessions even when interrupted-tool cleanup fails', async () => {
  const session = await createAnonymousSession('liveness-cleanup-failure');
  const { agentId, workflowId } = await seedLivenessAgent(
    session.user.id,
    'cleanup-failure',
    'ACTIVE'
  );
  let releasedAgentId: string | null = null;

  await makeEligible([agentId]);
  let cleanupRejected = false;
  try {
    await reconcileWorkflowLiveness({
      batchSize: 1000,
      describeStatus: async (id: string) => (id === workflowId ? 'TERMINATED' : 'RUNNING'),
      finalizeInterruptedTools: async () => {
        throw new Error('tool cleanup failed');
      },
      releaseBrowserSessions: async (id: string) => {
        releasedAgentId = id;
      },
    });
  } catch (error) {
    cleanupRejected = error instanceof Error && error.message === 'tool cleanup failed';
  }

  assert(cleanupRejected, 'expected interrupted-tool cleanup failure to remain observable');
  assert(
    releasedAgentId === agentId,
    `browser release must run after the row is sealed (released=${String(releasedAgentId)})`
  );
  assert(
    (await statusOf(agentId)) === 'FAILED',
    'the row should remain sealed after cleanup fails'
  );
});

test('reconciler is idempotent and never re-transitions a settled agent', async () => {
  const session = await createAnonymousSession('liveness-idempotent');
  const { agentId, workflowId } = await seedLivenessAgent(session.user.id, 'idempotent', 'ACTIVE');

  const describeStatus = async (id: string) =>
    id === workflowId ? 'WORKFLOW_EXECUTION_STATUS_TERMINATED' : 'RUNNING';

  await makeEligible([agentId]);
  const first = await reconcileWorkflowLiveness({ batchSize: 1000, describeStatus });
  const second = await reconcileWorkflowLiveness({ batchSize: 1000, describeStatus });

  assert(first.sealed >= 1, 'first pass should seal the agent');
  assert((await statusOf(agentId)) === 'FAILED', 'agent should remain FAILED after a second pass');
  assert(
    second.sealed === 0 || first.sealed >= second.sealed,
    'a settled agent must not be sealed twice'
  );
});
