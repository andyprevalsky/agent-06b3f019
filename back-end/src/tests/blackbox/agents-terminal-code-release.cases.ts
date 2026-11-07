import {
  BASE_URL,
  apiKeyHeaders,
  request,
  assertStatus,
  assert,
  createAnonymousSession,
  createTestAgent,
  trackedUserIds,
  test,
  prisma,
  randomUUID,
} from './agents-blackbox-harness';
import * as agentCleanup from '../../providers/agentCleanup';
import { updateAgentStatus } from '../../domains/agents/agentControlService';

/**
 * A code task rents a sandbox for as long as its row is ACTIVE. Release used to
 * hang off agent DELETION, cutover and descendant cleanup only. The normal
 * terminal transition (`PATCH /:id/status` COMPLETED/FAILED) released browsers
 * (see agents-terminal-browser-release.cases.ts) but never code tasks, so a
 * finished agent left every task ACTIVE. Prod, 2026-11-06: tasks dd8ef6a8 and
 * 631d4602 stayed ACTIVE after their root COMPLETED, and 144 ACTIVE tasks
 * (142 older than a day) still held sandbox ids.
 *
 * Local sandbox ids (`local-<task>`) exercise the same release path without E2B.
 */
async function seedActiveCodeTask(agentId: string): Promise<string> {
  const taskId = randomUUID();
  await prisma.claudeCodeSession.create({
    data: { id: taskId, agentId, sandboxId: `local-${taskId}`, goal: 'Write answer.txt' },
  });
  return taskId;
}

async function patchStatus(userId: string, agentId: string, status: string) {
  return request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify({
      status,
      statusMessage: 'blackbox terminal transition',
      progress: 1,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });
}

for (const status of ['COMPLETED', 'FAILED'] as const) {
  test(`PATCH /:id/status ${status} closes the agent's still-ACTIVE code tasks`, async () => {
    const session = await createAnonymousSession(`code-release-${status.toLowerCase()}`);
    trackedUserIds.add(session.user.id);
    const agentId = await createTestAgent(session.user.id);
    const taskId = await seedActiveCodeTask(agentId);

    const res = await patchStatus(session.user.id, agentId, status);
    assertStatus(res.status, 200, res.data);

    const task = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: taskId } });
    assert(
      task.status === 'CLOSED' && task.closedAt !== null,
      `Terminal ${status} left the code task ACTIVE (status=${task.status}); its sandbox is never released`
    );
  });
}

test('terminal code-task reconciliation releases tasks of agents that already finished', async () => {
  const session = await createAnonymousSession('code-release-reconcile');
  trackedUserIds.add(session.user.id);
  const agentId = await createTestAgent(session.user.id);
  const liveAgentId = await createTestAgent(session.user.id);
  const taskId = await seedActiveCodeTask(agentId);
  const liveTaskId = await seedActiveCodeTask(liveAgentId);
  // A COMPLETED agent whose terminal hook never ran (worker death, backend 5xx).
  await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
  await prisma.agent.update({ where: { id: liveAgentId }, data: { status: 'ACTIVE' } });

  assert(
    typeof agentCleanup.reconcileTerminalAgentCodeSessions === 'function',
    'there is no durable retry for code tasks of terminal agents'
  );
  const summary = await agentCleanup.reconcileTerminalAgentCodeSessions();
  assert(
    summary.discovered >= 1,
    `expected the finished agent to be discovered, got ${summary.discovered}`
  );

  const task = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: taskId } });
  assert(task.status === 'CLOSED', `terminal agent's code task still ${task.status}`);
  const live = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: liveTaskId } });
  assert(live.status === 'ACTIVE', 'reconciliation must never close a live agent task');
});

test('terminal code-task reconciliation isolates failures and honors its batch bound', async () => {
  assert(
    typeof agentCleanup.reconcileTerminalAgentCodeSessions === 'function',
    'there is no durable retry for code tasks of terminal agents'
  );
  const attempted: string[] = [];
  let requested = 0;
  const summary = await agentCleanup.reconcileTerminalAgentCodeSessions(
    {
      findTerminalAgentIds: async (batchSize: number) => {
        requested = batchSize;
        return ['failing-agent', 'healthy-agent'];
      },
      releaseCodeSessions: async (agentId: string) => {
        attempted.push(agentId);
        if (agentId === 'failing-agent') throw new Error('provider unavailable');
        return 3;
      },
    },
    { batchSize: 17 }
  );
  assert(requested === 17, `batch bound not forwarded: ${requested}`);
  assert(attempted.length === 2, 'one failing agent stopped the others');
  assert(summary.failed === 1 && summary.released === 3, JSON.stringify(summary));
});

test('terminal code-task reconciliation bounds a hung release and still reaches the agents behind it', async () => {
  const attempted: string[] = [];
  const startedAt = Date.now();
  const summary = await agentCleanup.reconcileTerminalAgentCodeSessions(
    {
      findTerminalAgentIds: async () => ['hung-a', 'hung-b', 'healthy-1', 'healthy-2'],
      releaseCodeSessions: async (agentId: string) => {
        attempted.push(agentId);
        if (agentId.startsWith('hung')) return new Promise<number>(() => undefined);
        return 1;
      },
    },
    { batchSize: 10, attemptTimeoutMs: 200 }
  );
  assert(
    attempted.length === 4,
    `agents behind a hung release were never attempted: ${attempted.join(',')}`
  );
  assert(
    summary.released === 2 && summary.failed === 2,
    `hung releases must fail by their budget: ${JSON.stringify(summary)}`
  );
  assert(Date.now() - startedAt < 5_000, 'a hung release held the run past its attempt budget');
});

test('terminal code-task reconciliation rotates its batch so failing agents cannot hold every slot', async () => {
  const session = await createAnonymousSession('code-release-rotation');
  trackedUserIds.add(session.user.id);
  const seeded = new Set<string>();
  for (let index = 0; index < 6; index += 1) {
    const agentId = await createTestAgent(session.user.id);
    await seedActiveCodeTask(agentId);
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    seeded.add(agentId);
  }
  // A release that always fails keeps the task ACTIVE, so the same agents are
  // selected on every tick. A fixed order would then return the same one forever.
  const firsts = new Set<string>();
  for (let tick = 0; tick < 40 && firsts.size < 2; tick += 1) {
    await agentCleanup.reconcileTerminalAgentCodeSessions(
      {
        releaseCodeSessions: async (agentId: string) => {
          firsts.add(agentId);
          throw new Error('release keeps failing');
        },
      },
      { batchSize: 1 }
    );
  }
  assert(
    firsts.size >= 2,
    `a batch of 1 always selected the same agent (${[...firsts].join(',')}); failing agents starve the rest`
  );
  for (const agentId of seeded) {
    await prisma.claudeCodeSession.updateMany({
      where: { agentId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  }
});

/**
 * Persistent-session close connects to the sandbox, checkpoints and pauses with
 * no timeout. The status row is already terminal by then, so a retried PATCH is
 * not the first terminal transition and never reruns the root-only cleanup. The
 * code release therefore runs LAST: a slow or interrupted close cannot starve
 * purchase-card cleanup (the reconciler retries the code release itself).
 */
const TERMINAL_BODY = {
  status: 'COMPLETED',
  statusMessage: 'blackbox terminal ordering',
  progress: 1,
  tokenCount: 0,
  tokensIn: 0,
  tokensOut: 0,
  contextSize: 0,
  messageCount: 1,
} as const;

test('terminal root cleanup completes before a hung code-session release', async () => {
  const session = await createAnonymousSession('code-release-order-hung');
  trackedUserIds.add(session.user.id);
  const agentId = await createTestAgent(session.user.id);

  const events: string[] = [];
  let releaseStarted: (() => void) | undefined;
  const codeReleaseStarted = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  let finishRelease: (() => void) | undefined;
  const codeReleaseMayFinish = new Promise<void>((resolve) => {
    finishRelease = resolve;
  });
  const update = updateAgentStatus(agentId, TERMINAL_BODY, {
    releaseBrowserSessions: async () => 0,
    cleanupPurchaseCards: async () => {
      events.push('purchase-cards');
    },
    releaseCodeSessions: async () => {
      events.push('code-sessions:start');
      releaseStarted?.();
      await codeReleaseMayFinish; // a sandbox close that never returns in time
      events.push('code-sessions:end');
      return 1;
    },
  });
  try {
    await codeReleaseStarted;
    assert(
      events.join() === 'purchase-cards,code-sessions:start',
      `root-only cleanup must finish before the code release starts, saw ${events.join()}`
    );
  } finally {
    finishRelease?.();
    await update;
  }
  assert(events.join() === 'purchase-cards,code-sessions:start,code-sessions:end', events.join());
});

test('a terminal child agent still releases its code sessions without root cleanup', async () => {
  const session = await createAnonymousSession('code-release-order-child');
  trackedUserIds.add(session.user.id);
  const parentId = await createTestAgent(session.user.id);
  const childId = await createTestAgent(session.user.id);
  await prisma.agent.update({ where: { id: childId }, data: { parentAgentId: parentId } });

  const events: string[] = [];
  await updateAgentStatus(childId, TERMINAL_BODY, {
    releaseBrowserSessions: async () => 0,
    cleanupPurchaseCards: async () => {
      events.push('purchase-cards');
    },
    releaseCodeSessions: async (releasedAgentId: string) => {
      events.push(`code-sessions:${releasedAgentId === childId ? 'child' : 'other'}`);
      return 0;
    },
  });
  assert(events.join() === 'code-sessions:child', `child terminal cleanup: ${events.join()}`);
});
