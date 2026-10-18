/** Browser-task discovery and durable observation cursors through real routes and DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { Harness } from './iphone-control.fixtures';

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function main() {
  const h = await Harness.start();
  const contexts: string[] = [];
  let passed = 0;
  let total = 0;
  const task = async () => {
    const f = await h.fixture();
    await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
    const context = await prisma.browserContext.create({
      data: { userId: f.userId, contextId: randomUUID() },
    });
    contexts.push(context.id);
    const browser = await prisma.browserSession.create({
      data: { contextId: context.id, agentId: f.agentId, sessionId: randomUUID() },
    });
    return { ...f, taskId: browser.id };
  };
  const check = async (name: string, run: () => Promise<void>) => {
    total++;
    await run();
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  };
  const ensure = (userId: string, taskId: string, requestKey: string) =>
    h.request(userId, `/interactions/${taskId}`, { method: 'POST', body: { requestKey } });
  try {
    const f = await task();
    let leaseId = '';
    await check('empty owned lookup allocates neither lease nor provider session', async () => {
      const before = h.calls.length;
      const result = await h.request(f.userId, `/interactions/${f.taskId}`);
      assert.equal(result.status, 200);
      assert.equal(result.data.lease, null);
      assert.equal(result.data.cursor, 0);
      assert.equal(result.data.lastOperation, null);
      assert.equal(h.calls.length, before);
    });
    await check(
      'browsers without phone interactions do not contend on the phone lock',
      async () => {
        let release!: () => void;
        let locked!: () => void;
        const lockReady = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const owner = runTransactionWithRetry(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "IPhoneDevice" WHERE id = ${f.deviceId} FOR UPDATE`;
          locked();
          await released;
        });
        await lockReady;
        const read = h.request(f.userId, `/interactions/${f.taskId}`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            read,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Unused browser waited for the shared phone lock')),
                2500
              );
            }),
          ]);
          assert.equal(result.status, 200);
          assert.equal(result.data.lease, null);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          release();
          await owner;
          await read;
        }
      }
    );
    const originalKey = randomUUID(),
      aliasKey = randomUUID();
    await check(
      'parallel ensure reuses one task lease and records every acquire intent',
      async () => {
        const results = await Promise.all(
          [originalKey, aliasKey, originalKey, randomUUID()].map((key) =>
            ensure(f.userId, f.taskId, key)
          )
        );
        assert.ok(results.every((r) => r.status === 200));
        const ids = results.map((r) => object(r.data.lease).id);
        assert.equal(new Set(ids).size, 1);
        leaseId = String(ids[0]);
        assert.equal(await prisma.iPhoneLease.count({ where: { browserTaskId: f.taskId } }), 1);
        assert.equal(object(results[0].data.lease).agentId, f.agentId);
      }
    );
    const operationId = randomUUID();
    let first: unknown;
    await check(
      'command advances persisted cursor and exact retry returns its receipt',
      async () => {
        const body = {
          operationId,
          operation: 'input.tap',
          args: { x: 1, y: 2 },
          expectedCursor: 0,
        };
        const before = h.physicalOperations.length;
        const result = await h.request(f.userId, `/leases/${leaseId}/operations`, {
          method: 'POST',
          body,
        });
        assert.equal(result.status, 200);
        first = result.data.operation;
        assert.equal(object(first).cursor, 1);
        assert.equal(object(first).operation, 'input.tap');
        const replay = await h.request(f.userId, `/leases/${leaseId}/operations`, {
          method: 'POST',
          body,
        });
        assert.deepEqual(replay.data.operation, first);
        assert.equal(h.physicalOperations.length, before + 1);
      }
    );
    await check('stale cursor cannot submit new physical input', async () => {
      const before = h.physicalOperations.length;
      const stale = await h.request(f.userId, `/leases/${leaseId}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'input.tap', args: {}, expectedCursor: 0 },
      });
      assert.equal(stale.status, 409);
      assert.equal(h.physicalOperations.length, before);
      assert.equal(await prisma.iPhoneOperation.count({ where: { leaseId } }), 1);
    });
    await check('fresh lookup recovers durable receipt before the next decision', async () => {
      const read = await h.request(f.userId, `/interactions/${f.taskId}`);
      assert.equal(read.status, 200);
      assert.equal(read.data.cursor, 1);
      assert.deepEqual(read.data.lastOperation, first);
      assert.ok(!JSON.stringify(read.data).includes('requestEncrypted'));
      assert.ok(!JSON.stringify(read.data).includes('providerSession'));
    });
    await check('competing decisions from one cursor admit only one observation', async () => {
      const before = h.physicalOperations.length;
      const outcomes = await Promise.all(
        [0, 1].map(() =>
          h.request(f.userId, `/leases/${leaseId}/operations`, {
            method: 'POST',
            body: {
              operationId: randomUUID(),
              operation: 'screen.text',
              args: {},
              expectedCursor: 1,
            },
          })
        )
      );
      assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
      assert.equal(h.physicalOperations.length, before + 1);
    });
    await check(
      'release and reacquire preserve old acquire intents including aliases',
      async () => {
        h.cleanupComplete = true;
        await h.request(f.userId, `/leases/${leaseId}/release`, { method: 'POST' });
        h.cleanupComplete = false;
        for (const key of [originalKey, aliasKey]) {
          const old = await ensure(f.userId, f.taskId, key);
          assert.equal(object(old.data.lease).id, leaseId);
          assert.equal(object(old.data.lease).status, 'RELEASED');
        }
        const next = await ensure(f.userId, f.taskId, randomUUID());
        assert.equal(next.status, 200);
        assert.notEqual(object(next.data.lease).id, leaseId);
        assert.equal(object(next.data.lease).status, 'ACTIVE');
        assert.equal(next.data.cursor, 0);
        assert.equal(next.data.lastOperation, null);
        assert.equal(object((await ensure(f.userId, f.taskId, aliasKey)).data.lease).id, leaseId);
      }
    );
    await check('foreign and missing tasks fail before provider access', async () => {
      const other = await task();
      const before = h.calls.length;
      for (const id of [f.taskId, randomUUID()]) {
        assert.equal((await h.request(other.userId, `/interactions/${id}`)).status, 404);
        assert.equal((await ensure(other.userId, id, randomUUID())).status, 404);
      }
      assert.equal(h.calls.length, before);
    });
    await check('revoked device cannot discover or allocate an interaction', async () => {
      await prisma.iPhoneDevice.update({ where: { id: f.deviceId }, data: { enabled: false } });
      const before = h.calls.length;
      assert.equal((await h.request(f.userId, `/interactions/${f.taskId}`)).status, 403);
      assert.equal((await ensure(f.userId, f.taskId, randomUUID())).status, 403);
      assert.equal(h.calls.length, before);
    });
    await check('cursor validation rejects negative fractional and string inputs', async () => {
      const fresh = await task();
      const ensured = await ensure(fresh.userId, fresh.taskId, randomUUID());
      for (const expectedCursor of [-1, 0.5, '0']) {
        const bad = await h.request(fresh.userId, `/leases/${ensured.data.lease!.id}/operations`, {
          method: 'POST',
          body: { operationId: randomUUID(), operation: 'input.tap', args: {}, expectedCursor },
        });
        assert.equal(bad.status, 400);
      }
    });
    await check(
      'live frames never expose transient operation IDs or change task cursor history',
      async () => {
        const fresh = await task();
        const ensured = await ensure(fresh.userId, fresh.taskId, randomUUID());
        const id = ensured.data.lease!.id;
        const held = h.holdFrame();
        const frame = h.request(fresh.userId, `/leases/${id}/frame`, { actor: 'user' });
        try {
          await held.entered;
          const state = await h.request(fresh.userId, `/interactions/${fresh.taskId}`);
          assert.equal(
            state.data.pendingOperation,
            null,
            'Ephemeral frame escaped as a recoverable operation'
          );
          assert.equal(state.data.lastOperation, null);
          assert.equal(state.data.cursor, 0);
          held.release();
          assert.equal((await frame).status, 200);
          assert.equal(
            await prisma.iPhoneOperation.count({ where: { leaseId: id } }),
            0,
            'Frame journal rows accumulated'
          );
        } finally {
          held.release();
          await frame;
        }
      }
    );
    await check('later observations retain the receipt for an uncertain mutation', async () => {
      const fresh = await task();
      const ensured = await ensure(fresh.userId, fresh.taskId, randomUUID());
      const currentLease = ensured.data.lease!.id;
      const uncertainId = randomUUID();
      h.inputMode = 'unknown';
      const uncertain = await h.request(fresh.userId, `/leases/${currentLease}/operations`, {
        method: 'POST',
        body: { operationId: uncertainId, operation: 'input.tap', args: {}, expectedCursor: 0 },
      });
      assert.equal(object(uncertain.data.operation).status, 'UNKNOWN');
      h.inputMode = 'success';
      const observed = await h.request(fresh.userId, `/leases/${currentLease}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {}, expectedCursor: 1 },
      });
      assert.equal(object(observed.data.operation).status, 'SUCCEEDED');
      const state = await h.request(fresh.userId, `/interactions/${fresh.taskId}`);
      assert.equal(object(state.data.pendingOperation).id, uncertainId);
      assert.equal(object(state.data.pendingOperation).status, 'UNKNOWN');
      assert.equal(object(state.data.lastOperation).status, 'SUCCEEDED');
    });
  } finally {
    if (contexts.length > 0) {
      await prisma.browserSession.deleteMany({ where: { contextId: { in: contexts } } });
      await prisma.browserContext.deleteMany({ where: { id: { in: contexts } } });
    }
    await h.close();
    await prisma.$disconnect();
  }
  process.stdout.write(`Passed ${passed}/${total} iphone interaction cases\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : 'Interaction test failed'}\n`);
  process.exitCode = 1;
});
