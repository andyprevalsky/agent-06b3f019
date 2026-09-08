/**
 * Regression: preallocated BrowserSession.id must be reclaimable on retry.
 *
 * Prod agent 43b3a83b burned 5 transient-proxy retries on
 * `Unique constraint failed on the fields: (id)` because init reused a stable
 * task_id after a prior create had already inserted the row.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma as PrismaRuntime } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  BrowserSessionReclaimConflictError,
  isIdUniqueConstraint,
  persistBrowserSessionRow,
} from '../../providers/browser/sessionPersist';

async function withContext<T>(fn: (contextId: string) => Promise<T>): Promise<T> {
  const context = await prisma.browserContext.create({
    data: {
      userId: `browser-session-persist-${randomUUID()}`,
      contextId: `profile-${randomUUID()}`,
    },
  });
  try {
    return await fn(context.id);
  } finally {
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
  }
}

async function reclaimFromStatus(previousStatus: 'CLOSED' | 'ACTIVE'): Promise<void> {
  await withContext(async (contextId) => {
    const taskId = randomUUID();
    const agentId = randomUUID();
    const firstSessionId = `remote-first-${randomUUID()}`;
    const secondSessionId = `remote-second-${randomUUID()}`;
    const released: string[] = [];

    const first = await persistBrowserSessionRow({
      taskId,
      contextId,
      agentId,
      sessionId: firstSessionId,
      debugUrl: 'https://debug.example/first',
      wsUrl: 'ws://example/first',
      startUrl: 'https://example.com/',
      provider: 'kernel',
      providerProfileId: 'profile-a',
      providerProfileSource: 'kernel',
      providerProfilePersist: true,
    });
    assert.equal(first.id, taskId);
    assert.equal(first.sessionId, firstSessionId);
    assert.equal(first.status, 'ACTIVE');

    if (previousStatus === 'CLOSED') {
      await prisma.browserSession.update({
        where: { id: taskId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
    }

    const second = await persistBrowserSessionRow({
      taskId,
      contextId,
      agentId,
      sessionId: secondSessionId,
      debugUrl: 'https://debug.example/second',
      wsUrl: 'ws://example/second',
      startUrl: 'https://example.com/retry',
      provider: 'kernel',
      providerProfileId: 'profile-b',
      providerProfileSource: 'kernel',
      providerProfilePersist: true,
      releaseRemoteSession: async (sessionId) => {
        released.push(sessionId);
      },
    });

    assert.equal(second.id, taskId, 'stable task id must be preserved');
    assert.equal(second.sessionId, secondSessionId, 'row must point at the new remote');
    assert.equal(second.status, 'ACTIVE', 'reclaimed row must be ACTIVE');
    assert.equal(second.closedAt, null, 'reclaimed row must clear closedAt');
    assert.equal(second.debugUrl, 'https://debug.example/second');
    assert.deepEqual(released, [firstSessionId], 'previous remote must be released');

    const rows = await prisma.browserSession.findMany({ where: { id: taskId } });
    assert.equal(rows.length, 1, 'exactly one row for the preallocated task id');
  });
}

async function preallocatedTaskIdReclaimFromClosed(): Promise<void> {
  await reclaimFromStatus('CLOSED');
}

async function preallocatedTaskIdReclaimFromActive(): Promise<void> {
  // Temporal retry after create succeeded but activity completion was not recorded
  // leaves an ACTIVE row — reclaim must still succeed.
  await reclaimFromStatus('ACTIVE');
}

async function nonIdempotentCreateTwiceFailsWithProdError(): Promise<void> {
  // Hard-gate baseline: the buggy create-only path fails with the prod string.
  await withContext(async (contextId) => {
    const taskId = randomUUID();
    const agentId = randomUUID();
    await prisma.browserSession.create({
      data: {
        id: taskId,
        contextId,
        agentId,
        sessionId: `remote-${randomUUID()}`,
        status: 'ACTIVE',
        provider: 'kernel',
      },
    });
    let message = '';
    try {
      await prisma.browserSession.create({
        data: {
          id: taskId,
          contextId,
          agentId,
          sessionId: `remote-${randomUUID()}`,
          status: 'ACTIVE',
          provider: 'kernel',
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(
      message,
      /Unique constraint failed on the fields: \(`id`\)/,
      'buggy create-only path must fail with the prod unique-constraint string'
    );
  });
}

async function idUniqueConstraintAcceptsPkeyArrayTarget(): Promise<void> {
  const error = new PrismaRuntime.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['BrowserSession_pkey'] },
  });
  assert.equal(isIdUniqueConstraint(error), true);
  assert.equal(
    isIdUniqueConstraint(
      new PrismaRuntime.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['id'] },
      })
    ),
    true
  );
}

async function concurrentReclaimConflictThrows(): Promise<void> {
  await withContext(async (contextId) => {
    const taskId = randomUUID();
    const agentId = randomUUID();
    const firstSessionId = `remote-first-${randomUUID()}`;
    const winnerSessionId = `remote-winner-${randomUUID()}`;
    const loserSessionId = `remote-loser-${randomUUID()}`;
    const released: string[] = [];

    await persistBrowserSessionRow({
      taskId,
      contextId,
      agentId,
      sessionId: firstSessionId,
      provider: 'kernel',
    });

    // Force the CAS to observe a lost race: another reclaim already swapped
    // sessionId away from `firstSessionId` between our findUnique and updateMany.
    const originalUpdateMany = prisma.browserSession.updateMany.bind(prisma.browserSession);
    prisma.browserSession.updateMany = (async (_args) => {
      await prisma.browserSession.update({
        where: { id: taskId },
        data: {
          sessionId: winnerSessionId,
          wsUrl: 'ws://example/winner',
          status: 'ACTIVE',
          closedAt: null,
        },
      });
      return { count: 0 };
    }) as typeof prisma.browserSession.updateMany;

    try {
      await assert.rejects(
        () =>
          persistBrowserSessionRow({
            taskId,
            contextId,
            agentId,
            sessionId: loserSessionId,
            provider: 'kernel',
            releaseRemoteSession: async (sessionId) => {
              released.push(sessionId);
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof BrowserSessionReclaimConflictError);
          assert.equal(error.taskId, taskId);
          assert.equal(error.attemptedSessionId, loserSessionId);
          assert.equal(error.winningSessionId, winnerSessionId);
          return true;
        }
      );
    } finally {
      prisma.browserSession.updateMany = originalUpdateMany;
    }

    assert.deepEqual(released, [loserSessionId], 'loser remote must be released');
    const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(row.sessionId, winnerSessionId, 'winner binding must remain');
  });
}

async function main(): Promise<void> {
  await idUniqueConstraintAcceptsPkeyArrayTarget();
  await nonIdempotentCreateTwiceFailsWithProdError();
  await preallocatedTaskIdReclaimFromClosed();
  await preallocatedTaskIdReclaimFromActive();
  await concurrentReclaimConflictThrows();
  process.stdout.write('browser-session-persist: ok\n');
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
