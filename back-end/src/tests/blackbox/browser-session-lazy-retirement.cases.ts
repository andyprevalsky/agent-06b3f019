/** Real local ledger ownership fences lazy-row retirement while native creation is unknown. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { releaseAgentBrowserSessions } from '../../providers/agentCleanup';
import { resumeBrowserSession } from '../../providers/browserSessionResume';

export async function runBrowserLazyRetirementCustodyCase() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/victoria_[\w-]+$/);
  const owner = `retire-${randomUUID()}`;
  const context = await prisma.browserContext.create({ data: { userId: owner } });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: owner,
      sessionId: null,
      status: 'PAUSED',
      provider: 'kernel',
      logicalOwnerKey: `agent:${owner}`,
      baselineCheckpointRef: 'browser-checkpoint:empty:v1',
    },
  });
  const operationKey = `steel-browser-task-lifecycle:${session.id}`;
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (() => {
    providerCalls++;
    throw new Error('No provider request is permitted');
  }) as typeof fetch;
  try {
    await prisma.toolSideEffect.create({
      data: {
        operationKey,
        operationType: 'browser_task_resume',
        status: 'STARTED',
        externalId: randomUUID(),
        request: {
          phase: 'creating',
          nativeOutstanding: true,
          expiresAt: new Date(Date.now() - 60000).toISOString(),
        },
      },
    });
    const noNative = {
      closeSession: async () => {
        throw new Error('Null row reached native close');
      },
    };
    await assert.rejects(
      releaseAgentBrowserSessions(owner, noNative, { retire: true }),
      AggregateError
    );
    const held = await prisma.browserSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(held.status, 'PAUSED');
    assert.equal(held.sessionId, null);
    const unknown = await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } });
    assert.equal(unknown.status, 'STARTED');
    assert.equal(unknown.externalId !== null, true);
    assert.equal(
      await releaseAgentBrowserSessions(`other-${owner}`, noNative, { retire: true }),
      0
    );
    // Fixture reconciliation: real provider resolution is deliberately not claimed here.
    await prisma.toolSideEffect.update({
      where: { operationKey },
      data: { status: 'RELEASED', request: { nativeOutstanding: false } },
    });
    assert.equal(await releaseAgentBrowserSessions(owner, noNative, { retire: true }), 1);
    const retired = await prisma.browserSession.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(retired.status, 'CLOSED');
    assert(retired.closedAt instanceof Date);
    await assert.rejects(resumeBrowserSession(session.id), /Retired logical browser cannot resume/);
    assert.equal(providerCalls, 0);
    console.log(
      'PASS real local custody UNKNOWN blocks retirement; reconciled row retires; owner scoped; no provider'
    );
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.toolSideEffect.deleteMany({ where: { operationKey } });
    await prisma.browserContext.delete({ where: { id: context.id } });
  }
}
