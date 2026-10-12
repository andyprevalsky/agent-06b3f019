/**
 * Regression for agent 2dd470aa (2026-10-12): a root agent COMPLETED, the user
 * sent a follow-up 50 seconds later, and chat restarted the agent under the
 * SAME Temporal workflow id (root workflow id === agent id). The terminal
 * transition had already queued a TemporalWorkflowCleanup obligation for the
 * finished chain with a 5-minute grace. When the grace expired the cleanup cron
 * matched the agent row by workflow id alone, so it sealed the live follow-up
 * chain, rewrote its running browser chips to "new code version deployed,
 * retry this tool", and terminated only the already-closed first chain. The
 * live run then looped on fenced tool calls until the liveness reconciler
 * marked the agent FAILED ("Workflow ended without reporting a result").
 *
 * See docs/rca/cases/2026-10-12-terminal-cleanup-obligation-sealed-reused-workflow-id.md
 */

import {
  assert,
  createAnonymousSession,
  prisma,
  randomUUID,
  sleep,
  test,
  trackedAgentIds,
  withTransientDbRetry,
} from './agents-blackbox-harness';
import { clearWorkflowForTerminalAgent, updateAgent } from '../../domains/agents/repoMutations';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  acceptChatWorkflowExecution,
} from '../../providers/workflowGeneration';
import { cleanupTerminalAgentWorkflowZombies } from '../../providers/workflowTerminalCleanup';
import { reconcileWorkflowLiveness } from '../../providers/workflowLivenessReconciler';
import type { TemporalWorkflowExecutionRef } from '../../providers/temporal';

interface FollowUpFixture {
  agentId: string;
  liveRunId: string;
  liveToolCallId: string;
}

/**
 * How the follow-up chain is installed under the reused workflow id:
 * - `chat`: chat escalation commits it with acceptChatWorkflowExecution.
 * - `start-agent`: the workflow-id-only write POST /:id/start-agent made
 *   before it recorded run ids. Rows written that way are still in the
 *   database, so neither chain's run id is known.
 */
type FollowUpRestart = 'chat' | 'start-agent';

/**
 * Replay the production sequence through the real trigger and the real
 * follow-up reactivation/acceptance writes. Only Temporal is simulated.
 */
async function completeThenFollowUp(
  label: string,
  firstRunId: string | null,
  restart: FollowUpRestart = 'chat'
): Promise<FollowUpFixture> {
  const session = await createAnonymousSession(label);
  const agentId = randomUUID();
  const liveRunId = `follow-up-run-${randomUUID()}`;
  const liveToolCallId = `call_${randomUUID()}`;
  trackedAgentIds.add(agentId);
  await withTransientDbRetry(`create-${label}`, async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'compare SOC 2 platforms',
        status: 'ACTIVE',
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
        temporalWorkflowId: agentId,
        temporalFirstExecutionRunId: firstRunId,
      },
    });
  });

  // First chain finishes: the schema trigger queues its cleanup obligation.
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
  const queued = await prisma.temporalWorkflowCleanup.findMany({ where: { agentId } });
  assert(
    queued.length === 1,
    `terminal transition must queue one obligation, got ${queued.length}`
  );
  assert(queued[0].workflowId === agentId, 'the obligation names the reused root workflow id');

  // Follow-up message: POST /:id/messages reactivates, then a new chain that
  // Temporal started under the same workflow id is committed to the row.
  const cleared = await clearWorkflowForTerminalAgent(agentId, 'COMPLETED', agentId, firstRunId);
  assert(cleared.count === 1, 'follow-up must reactivate the completed agent');
  if (restart === 'chat') {
    const accepted = await acceptChatWorkflowExecution(agentId, {
      workflowId: agentId,
      firstExecutionRunId: liveRunId,
    });
    assert(accepted, 'chat must accept the follow-up chain');
  } else {
    await updateAgent(agentId, { temporalWorkflowId: agentId });
  }

  // The follow-up is mid-way through a browser step when the grace expires.
  await prisma.message.create({
    data: {
      agentId,
      role: 'TOOL',
      text: '',
      workflowGeneration: agentId,
      metadata: {
        toolName: 'spawn_browser_agent',
        toolStatus: 'IN_PROGRESS',
        toolCallId: liveToolCallId,
        workflowGeneration: agentId,
      },
    },
  });
  return { agentId, liveRunId, liveToolCallId };
}

/** Temporal as it really is: the first chain closed, the follow-up is running. */
function temporalWithLiveFollowUp(liveRunId: string, terminated: string[]) {
  return {
    resolveExecution: async (workflowId: string): Promise<TemporalWorkflowExecutionRef> => ({
      workflowId,
      firstExecutionRunId: liveRunId,
    }),
    terminate: async (execution: TemporalWorkflowExecutionRef) => {
      terminated.push(execution.firstExecutionRunId);
    },
  };
}

async function assertFollowUpUntouched(
  fixture: FollowUpFixture,
  terminated: string[],
  restart: FollowUpRestart = 'chat'
): Promise<void> {
  const { agentId, liveRunId, liveToolCallId } = fixture;
  // Run the next liveness tick as prod would. Temporal runs the live chain
  // under the agent id; a sealed sentinel id does not exist there.
  await prisma.$executeRaw`UPDATE "Agent" SET "updatedAt" = '2020-01-01T00:00:00.000Z' WHERE id = ${agentId}`;
  await reconcileWorkflowLiveness({
    batchSize: 1000,
    describeStatus: async (workflowId: string) =>
      workflowId.startsWith(`${agentId}:`) ? 'NOT_FOUND' : 'RUNNING',
  });
  const row = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { status: true, temporalWorkflowId: true, temporalFirstExecutionRunId: true },
  });
  assert(
    row.temporalWorkflowId === agentId,
    `the live follow-up generation must not be sealed, got ${row.temporalWorkflowId}`
  );
  const expectedRunId = restart === 'chat' ? liveRunId : null;
  assert(
    row.temporalFirstExecutionRunId === expectedRunId,
    `the live follow-up chain identity must remain current, got ${row.temporalFirstExecutionRunId}`
  );
  assert(row.status === 'ACTIVE', `the follow-up must stay ACTIVE, got ${row.status}`);
  assert(
    !terminated.includes(liveRunId),
    `cleanup for the finished chain must never terminate the live follow-up (${terminated.join(',')})`
  );
  const interrupted = await prisma.message.count({
    where: { agentId, role: 'TOOL', text: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
  });
  assert(
    interrupted === 0,
    `the live browser step must not be rewritten as a deploy interruption (${interrupted} rows)`
  );
  const live = await prisma.message.findFirstOrThrow({
    where: { agentId, metadata: { path: ['toolCallId'], equals: liveToolCallId } },
    orderBy: { createdAt: 'desc' },
  });
  const status = (live.metadata as Record<string, unknown>).toolStatus;
  assert(status === 'IN_PROGRESS', `the live browser chip must stay IN_PROGRESS, got ${status}`);
  const pending = await prisma.temporalWorkflowCleanup.count({ where: { agentId } });
  assert(pending === 0, `the superseded obligation must be discharged, ${pending} remain`);
}

test('terminal cleanup after a follow-up leaves the live chain under the reused workflow id', async () => {
  const fixture = await completeThenFollowUp(
    'followup-cleanup-chat-start',
    `first-run-${randomUUID()}`
  );
  const terminated: string[] = [];
  await cleanupTerminalAgentWorkflowZombies(
    temporalWithLiveFollowUp(fixture.liveRunId, terminated),
    {
      agentIds: [fixture.agentId],
      ignoreGrace: true,
    }
  );
  await assertFollowUpUntouched(fixture, terminated);
});

test('terminal cleanup of a direct-start chain never resolves onto the live follow-up', async () => {
  // Direct plan/execute starts record only the workflow id, so their obligation
  // has no first-run id and cleanup would describe whichever chain is open now.
  const fixture = await completeThenFollowUp('followup-cleanup-direct-start', null);
  const terminated: string[] = [];
  await cleanupTerminalAgentWorkflowZombies(
    temporalWithLiveFollowUp(fixture.liveRunId, terminated),
    {
      agentIds: [fixture.agentId],
      ignoreGrace: true,
    }
  );
  await assertFollowUpUntouched(fixture, terminated);
});

test('terminal cleanup never seals a Start-agent follow-up when no run id is known', async () => {
  // Direct start, then a Start-agent follow-up written before start-agent
  // recorded run ids: the obligation and the live row both carry only the
  // workflow id, so their run ids are equal (both unknown).
  const fixture = await completeThenFollowUp('followup-cleanup-start-agent', null, 'start-agent');
  const terminated: string[] = [];
  const summary = await cleanupTerminalAgentWorkflowZombies(
    temporalWithLiveFollowUp(fixture.liveRunId, terminated),
    {
      agentIds: [fixture.agentId],
      ignoreGrace: true,
    }
  );
  assert(
    summary.superseded === 1 && summary.sealed === 0,
    `the live agent's obligation is left alone, got ${JSON.stringify(summary)}`
  );
  await assertFollowUpUntouched(fixture, terminated, 'start-agent');
});

test('terminal cleanup between runs never resolves onto the next run (agent 572da2a5)', async () => {
  // A direct start records no run id. The user then reopens the agent: the row
  // is ACTIVE with no workflow, and its next run starts under the agent id.
  // If Temporal already runs that chain before chat commits it, describing the
  // workflow id returns the new run, which an unknown-run cleanup must not kill.
  const session = await createAnonymousSession('followup-cleanup-between-runs');
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-followup-cleanup-between-runs', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'find a manga by its plot',
        status: 'ACTIVE',
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
        temporalWorkflowId: agentId,
        temporalFirstExecutionRunId: null,
      },
    });
  });
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
  const cleared = await clearWorkflowForTerminalAgent(agentId, 'COMPLETED', agentId, null);
  assert(cleared.count === 1, 'the follow-up message must reopen the completed agent');

  const nextRunId = `next-run-${randomUUID()}`;
  const terminated: string[] = [];
  await cleanupTerminalAgentWorkflowZombies(temporalWithLiveFollowUp(nextRunId, terminated), {
    agentIds: [agentId],
    ignoreGrace: true,
  });
  assert(
    !terminated.includes(nextRunId),
    `cleanup must not terminate the next run starting under the agent id (${terminated.join(',')})`
  );
  const row = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { status: true, temporalWorkflowId: true },
  });
  assert(
    row.status === 'ACTIVE' && row.temporalWorkflowId === null,
    `the reopened agent must stay ready for its next run, got ${row.status}/${row.temporalWorkflowId}`
  );
  const pending = await prisma.temporalWorkflowCleanup.count({ where: { agentId } });
  assert(pending === 0, `the finished chain's obligation is discharged, ${pending} remain`);
});

test('a follow-up that also ended before the sweep gets its own exact cleanup', async () => {
  const fixture = await completeThenFollowUp(
    'followup-cleanup-rebind',
    `first-run-${randomUUID()}`
  );
  const { agentId, liveRunId } = fixture;
  // The follow-up finishes too. Obligations are keyed by (agent, workflow id),
  // so its terminal transition merges into the first chain's pending row.
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
  await prisma.temporalWorkflowCleanup.updateMany({
    where: { agentId },
    data: { notBefore: new Date(Date.now() - 1_000) },
  });

  const terminated: string[] = [];
  const temporal = temporalWithLiveFollowUp(liveRunId, terminated);
  await cleanupTerminalAgentWorkflowZombies(temporal, { agentIds: [agentId] });
  const rebound = await prisma.temporalWorkflowCleanup.findUniqueOrThrow({
    where: { agentId_workflowId: { agentId, workflowId: agentId } },
  });
  assert(
    rebound.firstExecutionRunId === liveRunId,
    `the obligation must follow the follow-up chain, got ${rebound.firstExecutionRunId}`
  );
  assert(
    rebound.notBefore.getTime() > Date.now(),
    'the follow-up keeps its own grace for final-summary tail work'
  );
  const graced = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { temporalWorkflowId: true },
  });
  assert(graced.temporalWorkflowId === agentId, 'nothing is sealed before that grace expires');
  assert(terminated.length === 0, `nothing is terminated yet (${terminated.join(',')})`);

  await cleanupTerminalAgentWorkflowZombies(temporal, { agentIds: [agentId], ignoreGrace: true });
  assert(
    terminated.length === 1 && terminated[0] === liveRunId,
    `only the follow-up chain is terminated, got ${terminated.join(',')}`
  );
  const sealed = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { temporalWorkflowId: true },
  });
  assert(
    sealed.temporalWorkflowId?.includes(':deployment-sealed:') === true,
    `the ended follow-up chain is sealed, got ${sealed.temporalWorkflowId}`
  );
  const pending = await prisma.temporalWorkflowCleanup.count({ where: { agentId } });
  assert(pending === 0, `the rebound obligation is discharged, ${pending} remain`);
});

test('terminal cleanup and a concurrent follow-up reactivation never deadlock', async () => {
  // A follow-up reactivation writes the Agent row, and the schema trigger then
  // upserts the obligation row in the same transaction. Cleanup must take the
  // Agent row before the obligation row, and read the agent only after that
  // write commits.
  const session = await createAnonymousSession('followup-cleanup-lock-order');
  const agentId = randomUUID();
  const firstRunId = `first-run-${randomUUID()}`;
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-followup-cleanup-lock-order', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'compare SOC 2 platforms',
        status: 'ACTIVE',
        model: 'rose-labs/rose-1-ultra',
        busId: agentId,
        temporalWorkflowId: agentId,
        temporalFirstExecutionRunId: firstRunId,
      },
    });
  });
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });

  let signalLocked = (): void => undefined;
  const agentLocked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const followUp = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM "Agent" WHERE id = ${agentId} FOR UPDATE`;
      signalLocked();
      await sleep(1_500);
      // The same write clearWorkflowForTerminalAgent performs.
      await tx.$executeRaw`UPDATE "Agent" SET "temporalWorkflowId" = NULL, "temporalFirstExecutionRunId" = NULL, status = 'ACTIVE' WHERE id = ${agentId} AND status = 'COMPLETED'`;
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
  await agentLocked;
  const terminated: string[] = [];
  const sweep = cleanupTerminalAgentWorkflowZombies(
    temporalWithLiveFollowUp(`unused-${randomUUID()}`, terminated),
    { agentIds: [agentId], ignoreGrace: true }
  );
  const [followUpResult, sweepResult] = await Promise.allSettled([followUp, sweep]);
  assert(
    followUpResult.status === 'fulfilled',
    `the follow-up reactivation must commit, got ${String((followUpResult as PromiseRejectedResult).reason)}`
  );
  assert(
    sweepResult.status === 'fulfilled',
    `the cleanup sweep must complete, got ${String((sweepResult as PromiseRejectedResult).reason)}`
  );
  const row = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { status: true, temporalWorkflowId: true, temporalCleanupPending: true },
  });
  assert(
    row.status === 'ACTIVE' && row.temporalWorkflowId === null,
    `the reactivated agent must stay ready for its follow-up chain, got ${row.status}/${row.temporalWorkflowId}`
  );
  assert(
    terminated.length === 1 && terminated[0] === firstRunId,
    `only the finished chain is terminated, got ${terminated.join(',')}`
  );
  const pending = await prisma.temporalWorkflowCleanup.count({ where: { agentId } });
  assert(
    pending === 0 && !row.temporalCleanupPending,
    `the finished chain's obligation is discharged, ${pending} remain`
  );
});
