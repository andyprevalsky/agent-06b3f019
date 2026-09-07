#!/usr/bin/env tsx
/**
 * Black-box coverage for idempotent BrowserSession persist with preallocated task ids.
 *
 * Prod agent 43b3a83b: stable task_id + non-idempotent create → Unique constraint on (id).
 */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { persistBrowserSessionRow } from '../../providers/browser/sessionPersist';

config();

async function testPersist_preallocatedTaskIdReclaimIsIdempotent(): Promise<void> {
  const context = await prisma.browserContext.create({
    data: {
      userId: `browser-session-persist-bb-${randomUUID()}`,
      contextId: `steel-profile-${randomUUID()}`,
    },
  });
  const taskId = randomUUID();
  const agentId = randomUUID();
  const released: string[] = [];
  try {
    await persistBrowserSessionRow({
      taskId,
      contextId: context.id,
      agentId,
      sessionId: `remote-first-${randomUUID()}`,
      debugUrl: 'https://debug.example/first',
      wsUrl: 'ws://example/first',
      provider: 'kernel',
    });
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const secondSessionId = `remote-second-${randomUUID()}`;
    const reclaimed = await persistBrowserSessionRow({
      taskId,
      contextId: context.id,
      agentId,
      sessionId: secondSessionId,
      debugUrl: 'https://debug.example/second',
      wsUrl: 'ws://example/second',
      provider: 'kernel',
      releaseRemoteSession: async (previousSessionId) => {
        released.push(previousSessionId);
      },
    });
    if (reclaimed.id !== taskId) {
      throw new Error(`Expected task id ${taskId}, got ${reclaimed.id}`);
    }
    if (reclaimed.sessionId !== secondSessionId) {
      throw new Error(`Expected session ${secondSessionId}, got ${reclaimed.sessionId}`);
    }
    if (reclaimed.status !== 'ACTIVE' || reclaimed.closedAt !== null) {
      throw new Error('Reclaimed row must be ACTIVE with cleared closedAt');
    }
    if (released.length !== 1) {
      throw new Error(`Expected one previous remote release, got ${released.length}`);
    }

    const thirdSessionId = `remote-third-${randomUUID()}`;
    const activeReclaim = await persistBrowserSessionRow({
      taskId,
      contextId: context.id,
      agentId,
      sessionId: thirdSessionId,
      debugUrl: 'https://debug.example/third',
      wsUrl: 'ws://example/third',
      provider: 'kernel',
      releaseRemoteSession: async (previousSessionId) => {
        released.push(previousSessionId);
      },
    });
    if (activeReclaim.sessionId !== thirdSessionId || activeReclaim.status !== 'ACTIVE') {
      throw new Error('ACTIVE reclaim must bind the new remote and stay ACTIVE');
    }
    if (released.length !== 2 || released[1] !== secondSessionId) {
      throw new Error(
        `Expected second release of ${secondSessionId}, got ${JSON.stringify(released)}`
      );
    }
    const rows = await prisma.browserSession.findMany({ where: { id: taskId } });
    if (rows.length !== 1) {
      throw new Error(`Expected one row for task id, got ${rows.length}`);
    }
  } finally {
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  process.stdout.write('Browser Session Persist Black-box Tests\n');
  await testPersist_preallocatedTaskIdReclaimIsIdempotent();
  process.stdout.write(
    '  PASS  persist -- preallocated task id reclaim is idempotent (CLOSED + ACTIVE)\n'
  );
  process.stdout.write('All browser-session-persist blackbox tests passed\n');
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
