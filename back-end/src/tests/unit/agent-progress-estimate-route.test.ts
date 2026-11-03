import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mock } from 'node:test';
import express from 'express';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import type { ProgressEstimate } from '../../utils/progressEstimate';

async function main() {
  const unsafe = nonLocalDatabaseReason(process.env.DATABASE_URL);
  assert.equal(unsafe, null, `Route tests require a local database: ${unsafe}`);
  const events: Array<{ agentId: string; updates: Record<string, unknown>; busId?: string }> = [];
  // Only the outbound realtime transport is fake: HTTP, auth, validation,
  // service, transaction fencing and persistence use their actual modules.
  await mock.module('../../providers/chat', {
    namedExports: {
      broadcastAgentUpdate: async (
        agentId: string,
        updates: Record<string, unknown>,
        busId?: string
      ) => {
        events.push({ agentId, updates, busId });
      },
    },
  });
  const { prisma } = await import('../../providers/database');
  const { default: router } = await import('../../domains/agents/routes.progressEstimate');
  const { hydrateProgressEstimates } = await import('../../providers/agentProgressEstimates');
  const originalKey = process.env.BACKEND_API_KEY;
  const internalKey = `jev-internal-${randomUUID()}`;
  const publicKey = `jev-public-${randomUUID()}`;
  process.env.BACKEND_API_KEY = internalKey;
  const agentId = randomUUID();
  const userId = `jev-route-${agentId}`;
  const app = express();
  app.set('env', 'test');
  app.use(express.json());
  app.use('/api/agents', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/agents/${agentId}/progress-estimate`;
  let checks = 0;
  const estimate: ProgressEstimate = {
    progress: 0.25,
    etaSeconds: 120,
    observedAt: '2026-10-21T12:00:00.000Z',
    sequence: 1,
    model: 'jev-1.13.0',
    promptVersion: 'route-v1',
  };
  async function request(
    body: unknown,
    status: number,
    outcome?: string,
    headers: Record<string, string> = {
      'x-api-key': internalKey,
      'x-agent-workflow-generation': agentId,
    },
    target = url
  ) {
    const response = await fetch(target, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    assert.equal(response.status, status, responseText);
    if (outcome !== undefined) {
      const result = JSON.parse(responseText) as { outcome?: string };
      assert.equal(result.outcome, outcome);
    }
    checks += 1;
  }
  try {
    await prisma.user.create({ data: { userId, isAnonymous: true } });
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal: 'JEV route tests',
        status: 'ACTIVE',
        temporalWorkflowId: agentId,
        progress: 0.4,
      },
    });
    await prisma.roseApiKey.create({ data: { userId, apiKey: publicKey } });
    await prisma.subscription.create({
      data: {
        userId,
        subscriptionTier: 1,
        stripeSubscriptionId: `test-${agentId}`,
        stripeCustomerId: `test-${agentId}`,
        currentPeriodEnd: new Date('2027-01-01T00:00:00Z'),
      },
    });
    await request({ progressEstimate: estimate }, 401, undefined, {});
    await request({ progressEstimate: estimate }, 401, undefined, { 'x-api-key': 'invalid' });
    await request({ progressEstimate: estimate }, 403, undefined, {
      'x-api-key': publicKey,
      'x-agent-workflow-generation': agentId,
    });
    await request({ progressEstimate: estimate }, 400, undefined, { 'x-api-key': internalKey });
    await request({ progressEstimate: estimate }, 400, undefined, {
      'x-api-key': internalKey,
      'x-agent-workflow-generation': '',
    });
    const invalid = [
      {},
      null,
      { progressEstimate: 'bad' },
      { progressEstimate: [] },
      ...[
        { progress: -0.1 },
        { progress: 1.1 },
        { progress: '0.5' },
        { etaSeconds: 59 },
        { etaSeconds: 31536001 },
        { observedAt: 'not-a-date' },
        { observedAt: '2026-10-21T12:00:00+01:00' },
        { sequence: -1 },
        { sequence: 0.5 },
        { model: 'other' },
        { promptVersion: null },
        { taskId: 42 },
      ].map((fields) => ({ progressEstimate: { ...estimate, ...fields } })),
    ];
    for (const body of invalid) await request(body, 400);
    assert.equal(events.length, 0, 'rejected auth/body must not broadcast');
    await request({ progressEstimate: null }, 200, 'unchanged');
    await request(
      { progressEstimate: estimate },
      404,
      'not_found',
      undefined,
      url.replace(agentId, randomUUID())
    );
    await request({ progressEstimate: estimate }, 409, 'stale_generation', {
      'x-api-key': internalKey,
      'x-agent-workflow-generation': `${agentId}:obsolete`,
    });
    await request({ progressEstimate: { ...estimate, taskId: 'unknown' } }, 409, 'unknown_task');
    await request({ progressEstimate: estimate, status: 'FAILED' }, 200, 'updated');
    const rootEvent = events.at(-1)!;
    assert.equal(rootEvent.agentId, agentId);
    assert.deepEqual(rootEvent.updates.progressEstimate, estimate);
    assert.equal(rootEvent.busId, agentId, 'accepted updates use the root tree bus');
    assert.equal(rootEvent.updates.temporalWorkflowId, agentId);
    assert.equal(typeof rootEvent.updates.updatedAt, 'string');
    let row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.equal(rootEvent.updates.updatedAt, row.updatedAt.toISOString());
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.progress, 0.4, 'JEV endpoint must not write legacy progress');
    await request({ progressEstimate: estimate }, 200, 'unchanged');
    await request(
      { progressEstimate: { ...estimate, sequence: 2, observedAt: '2026-10-21T11:00:00Z' } },
      200,
      'unchanged'
    );
    assert.equal(events.length, 1, 'stale or duplicate predictions must not broadcast');
    await request(
      { progressEstimate: { ...estimate, sequence: 2, progress: 0, etaSeconds: 60 } },
      200,
      'updated'
    );
    await request(
      { progressEstimate: { ...estimate, sequence: 3, progress: 1, etaSeconds: 31536000 } },
      200,
      'updated'
    );
    const taskId = randomUUID();
    await prisma.message.create({
      data: {
        agentId,
        workflowGeneration: agentId,
        role: 'TOOL',
        text: 'task started',
        metadata: { taskId, action_type: 'goto', toolStatus: 'FINISHED', subAgentId: taskId },
      },
    });
    await request({ progressEstimate: { ...estimate, taskId } }, 200, 'updated');
    const taskEvent = events.at(-1)!;
    assert.equal(taskEvent.updates.progressEstimate, undefined);
    assert.deepEqual(taskEvent.updates.taskProgressEstimates, {
      [taskId]: { ...estimate, taskId },
    });
    row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.equal(taskEvent.updates.updatedAt, row.updatedAt.toISOString());
    const hydrated = (await hydrateProgressEstimates([row]))[0];
    assert.equal((hydrated.progressEstimate as { sequence: number }).sequence, 3);
    assert.deepEqual(hydrated.taskProgressEstimates[taskId], { ...estimate, taskId });
    await prisma.message.create({
      data: {
        agentId,
        workflowGeneration: agentId,
        role: 'TOOL',
        text: 'task finished',
        metadata: { taskId, action_type: 'task_complete' },
      },
    });
    const beforeTerminalEvents = events.length;
    await request({ progressEstimate: { ...estimate, taskId, sequence: 99 } }, 200, 'terminal');
    for (const status of ['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'] as const) {
      await prisma.agent.update({ where: { id: agentId }, data: { status } });
      await request({ progressEstimate: { ...estimate, sequence: 99 } }, 200, 'terminal');
    }
    assert.equal(events.length, beforeTerminalEvents, 'terminal predictions must not broadcast');
    process.stdout.write(
      `JEV actual HTTP/auth/schema/persistence/realtime route: ${checks} requests passed\n`
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.roseApiKey.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
    if (originalKey === undefined) delete process.env.BACKEND_API_KEY;
    else process.env.BACKEND_API_KEY = originalKey;
    mock.restoreAll();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
