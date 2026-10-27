#!/usr/bin/env tsx
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createTestHarness, observeUntil } from './trace-archive-test-utils'; // pragma: allowlist secret

const baseUrl = process.env.DATABASE_URL ?? '';
assert(baseUrl !== '', 'DATABASE_URL is required');
const separator = baseUrl.includes('?') ? '&' : '?';
// The lock transaction plus exactly one nested query. A short pool timeout makes a
// starved nested query fail in seconds instead of after three 30-second waits.
process.env.DATABASE_URL = `${baseUrl}${separator}connection_limit=2&pool_timeout=4`;

const { test, finish } = createTestHarness('archive manifest lock pool tests');
async function main(): Promise<void> {
  const { prisma } = await import('../../providers/database');
  const { archiveManifestLockWaiters, withArchiveManifestLock } =
    await import('../../providers/traceArchiveManifest');

  await test('a same-root waiter cannot starve the lock holder of pool connections', async () => {
    const rootAgentId = `manifest-lock-pool-${randomUUID()}`;
    const order: string[] = [];
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withArchiveManifestLock(rootAgentId, async () => {
      markEntered();
      await released;
      // Finalization's derived-index writes run on the global client under this lock.
      await prisma.$queryRaw`SELECT 1`;
      order.push('holder');
      return 'holder';
    });
    void holder.catch(() => {});
    await entered;
    const waiter = withArchiveManifestLock(rootAgentId, async () => {
      order.push('waiter');
      return 'waiter';
    });
    void waiter.catch(() => {});
    await observeUntil(async () => archiveManifestLockWaiters() >= 1);
    release();
    const [holderResult, waiterResult] = await Promise.allSettled([holder, waiter]);
    assert.strictEqual(
      holderResult.status,
      'fulfilled',
      `the holder's nested query must obtain a connection: ${
        holderResult.status === 'rejected' ? String(holderResult.reason) : ''
      }`
    );
    assert.strictEqual(waiterResult.status, 'fulfilled', 'the waiter acquires after release');
    assert.deepStrictEqual(order, ['holder', 'waiter'], 'the lock still serializes one root');
  });

  await prisma.$disconnect();
  finish();
}

void main();
