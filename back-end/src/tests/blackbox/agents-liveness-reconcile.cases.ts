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
  STUCK_CHAT_STATUS_MESSAGE,
  reconcileWorkflowLiveness,
} from '../../providers/workflowLivenessReconciler';

import {
  claimWorkflowReplacement,
  recordWorkflowReplacementStartAcceptance,
} from '../../providers/workflowReplacementState';

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
  await reconcileWorkflowLiveness({
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
  // Do not assert summary.sealed === 0. The same tick may seal unrelated quiet
  // chat-mode zombies (ACTIVE + null workflow + messageCount 0). The contract
  // is that THIS replacement row is untouched.
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

test('reconciler restores a retryable row and continues after one cleanup fails', async () => {
  const session = await createAnonymousSession('liveness-cleanup-failure');
  const { agentId: failedAgentId, workflowId: failedWorkflowId } = await seedLivenessAgent(
    session.user.id,
    'cleanup-failure',
    'ACTIVE'
  );
  const { agentId: healthyAgentId, workflowId: healthyWorkflowId } = await seedLivenessAgent(
    session.user.id,
    'cleanup-continues',
    'ACTIVE'
  );
  const releasedAgentIds = new Set<string>();
  let cleanupAttempts = 0;

  await makeEligible([failedAgentId, healthyAgentId]);
  const first = await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id: string) =>
      id === failedWorkflowId || id === healthyWorkflowId ? 'TERMINATED' : 'RUNNING',
    finalizeInterruptedTools: async (id: string) => {
      if (id === failedAgentId) {
        cleanupAttempts++;
        throw new Error('tool cleanup failed');
      }
      return { candidates: 0, interrupted: 0 };
    },
    releaseBrowserSessions: async (id: string) => {
      releasedAgentIds.add(id);
      return 0;
    },
  });

  assert(
    releasedAgentIds.has(failedAgentId),
    'browser release must still run after interrupted-tool cleanup rejects'
  );
  assert(
    releasedAgentIds.has(healthyAgentId),
    'one cleanup failure must not abandon the next candidate in the worker cursor'
  );
  assert(
    (await statusOf(failedAgentId)) === 'ACTIVE',
    'cleanup failure must restore the row so a later reconciliation can retry it'
  );
  assert(
    (await statusOf(healthyAgentId)) === 'FAILED',
    'the later healthy candidate should still be sealed'
  );
  assert(first.inconclusive >= 1, 'the restored cleanup failure should be counted inconclusive');
  assert(first.sealed >= 1, 'the healthy candidate should be counted sealed');

  await makeEligible([failedAgentId]);
  const retry = await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id: string) => (id === failedWorkflowId ? 'TERMINATED' : 'RUNNING'),
    finalizeInterruptedTools: async () => {
      cleanupAttempts++;
      return { candidates: 0, interrupted: 0 };
    },
    releaseBrowserSessions: async (id: string) => {
      releasedAgentIds.add(id);
      return 0;
    },
  });
  assert(cleanupAttempts === 2, `expected cleanup to retry once, got ${cleanupAttempts} attempts`);
  assert(retry.sealed >= 1, 'the successful retry should seal the restored row');
  assert(
    (await statusOf(failedAgentId)) === 'FAILED',
    'the row should seal after cleanup succeeds'
  );
});

async function seedStuckChatAgent(
  userId: string,
  label: string,
  overrides: { messageCount?: number } = {}
): Promise<string> {
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry(`create-stuck-chat-${label}`, async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal: `stuck chat ${label}`,
        status: 'ACTIVE',
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
        temporalWorkflowId: null,
        messageCount: overrides.messageCount ?? 0,
      },
    });
    await prisma.message.create({
      data: {
        agentId,
        role: 'USER',
        text: 'help me check this tests and validate the cheaper one',
        timestamp: new Date('2026-09-18T20:57:25.321Z'),
      },
    });
    await prisma.message.create({
      data: {
        agentId,
        role: 'ASSISTANT',
        text: 'The user is asking for a comparison and validation of medical test options, including location choices. This requires multi-step research and planning, not a simple direct answer or current fact lookup.',
        timestamp: new Date('2026-09-18T20:57:26.252Z'),
      },
    });
  });
  return agentId;
}

async function seedStuckChatUser(label: string): Promise<string> {
  const userId = randomUUID();
  await withTransientDbRetry(`create-stuck-chat-user-${label}`, async () => {
    await prisma.user.create({
      data: { userId, isAnonymous: true, name: `stuck-chat-${label}` },
    });
  });
  return userId;
}

test('reconciler seals a quiet chat-mode agent whose escalation never started a workflow', async () => {
  const userId = await seedStuckChatUser('null-workflow');
  const agentId = await seedStuckChatAgent(userId, 'null-workflow');
  await makeEligible([agentId]);

  const summary = await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async () => 'RUNNING',
  });

  assert(
    (await statusOf(agentId)) === 'FAILED',
    `stuck chat escalation must be sealed FAILED, got ${await statusOf(agentId)}`
  );
  const row = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { statusMessage: true, temporalWorkflowId: true },
  });
  assert(
    row?.statusMessage === STUCK_CHAT_STATUS_MESSAGE,
    `stuck chat seal must explain the missing workflow, got ${row?.statusMessage}`
  );
  assert(row?.temporalWorkflowId === null, 'seal must not invent a workflow id');
  assert(summary.sealed >= 1, 'stuck chat candidate should count as sealed');
});

test('reconciler leaves a completed chat-mode agent with a null workflow alone', async () => {
  const userId = await seedStuckChatUser('completed-turn');
  const agentId = await seedStuckChatAgent(userId, 'completed-turn', { messageCount: 4 });
  await makeEligible([agentId]);

  await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async () => 'RUNNING',
  });

  assert(
    (await statusOf(agentId)) === 'ACTIVE',
    'a finished chat turn (messageCount > 0, no workflow) must not be sealed'
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

test('reconciler preserves a durable prepared replacement until Temporal start acceptance', async () => {
  const session = await createAnonymousSession('liveness-prepared');
  const { agentId } = await seedLivenessAgent(session.user.id, 'prepared', 'PAUSED');
  const claim = await claimWorkflowReplacement(agentId);
  const before = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  await makeEligible([agentId]);
  await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id) => (id === claim.plannedWorkflowId ? 'NOT_FOUND' : 'RUNNING'),
  });
  const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(after.status === 'STARTING_UP', 'NOT_FOUND must not seal a durably planned execution');
  assert(after.workflowReplacementToken === claim.token, 'exact claim custody must survive');
  assert(
    JSON.stringify(after.workflowReplacementState) ===
      JSON.stringify(before.workflowReplacementState),
    'liveness must preserve the original no-loss resume snapshot'
  );
  assert(after.temporalFirstExecutionRunId === null, 'planning is not execution acceptance');
  assert(
    await recordWorkflowReplacementStartAcceptance(claim, {
      workflowId: claim.plannedWorkflowId,
      firstExecutionRunId: randomUUID(),
    }),
    'the same prepared claim must still accept its actual start'
  );
});

test('reconciler seals real closed prepared candidates and accepted missing chains', async () => {
  const session = await createAnonymousSession('liveness-prepared-closed');
  for (const temporalStatus of ['TERMINATED', 'FAILED', 'NOT_FOUND']) {
    const { agentId } = await seedLivenessAgent(session.user.id, temporalStatus, 'PAUSED');
    const claim = await claimWorkflowReplacement(agentId);
    if (temporalStatus === 'NOT_FOUND') {
      await recordWorkflowReplacementStartAcceptance(claim, {
        workflowId: claim.plannedWorkflowId,
        firstExecutionRunId: randomUUID(),
      });
    }
    await makeEligible([agentId]);
    await reconcileWorkflowLiveness({
      batchSize: 1000,
      describeStatus: async (id) => (id === claim.plannedWorkflowId ? temporalStatus : 'RUNNING'),
    });
    assert(
      (await statusOf(agentId)) === 'FAILED',
      `${temporalStatus} of an actual execution must still seal`
    );
  }
});

test('reconciler rejects a missing-chain observation raced by exact start acceptance', async () => {
  const session = await createAnonymousSession('liveness-prepared-accept-race');
  const { agentId } = await seedLivenessAgent(session.user.id, 'accept-race', 'PAUSED');
  const claim = await claimWorkflowReplacement(agentId);
  const firstExecutionRunId = randomUUID();
  await makeEligible([agentId]);
  await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (id) => {
      if (id !== claim.plannedWorkflowId) return 'RUNNING';
      assert(
        await recordWorkflowReplacementStartAcceptance(claim, {
          workflowId: id,
          firstExecutionRunId,
        }),
        'concurrent exact start should be accepted'
      );
      return 'NOT_FOUND';
    },
  });
  const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(row.status === 'STARTING_UP', 'a pre-acceptance NOT_FOUND cannot seal the accepted chain');
  assert(
    row.temporalFirstExecutionRunId === firstExecutionRunId,
    'exact execution receipt must survive'
  );
});
