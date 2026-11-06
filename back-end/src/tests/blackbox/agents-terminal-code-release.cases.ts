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
