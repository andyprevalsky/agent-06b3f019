import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { openPhoneValue, sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { PhoneHarnessSession } from '../../providers/phoneHarness';
import type { Case } from './iphone-control.cases';
import { Harness, PNG } from './iphone-control.fixtures';

async function task(h: Harness) {
  const f = await h.fixture();
  const context = await prisma.browserContext.create({
    data: { userId: f.userId, contextId: randomUUID() },
  });
  const browser = await prisma.browserSession.create({
    data: { contextId: context.id, agentId: f.agentId, sessionId: randomUUID() },
  });
  await prisma.iPhoneLease.update({
    where: { id: f.leaseId },
    data: { browserTaskId: browser.id },
  });
  return { ...f, taskId: browser.id };
}
function user() {
  return { actor: 'user' as const };
}
async function command(h: Harness, userId: string, leaseId: string, operation = 'screen.text') {
  return h.request(userId, `/leases/${leaseId}/operations`, {
    method: 'POST',
    body: { operationId: randomUUID(), operation, args: {} },
  });
}
function lease(data: Record<string, unknown>) {
  return data.lease as Record<string, unknown>;
}

export const viewCases: Case[] = [
  [
    'task-bound readonly frame is cursor neutral and takeover reads actual point bounds',
    async (h) => {
      const f = await task(h);
      h.screenBounds = { x: 12, y: 34, w: 393, h: 852, id: 7 };
      const frame = await h.request(f.userId, `/leases/${f.leaseId}/frame`, user());
      assert.equal(frame.status, 200, 'Readonly frame could not bootstrap');
      assert.deepEqual(Buffer.from(frame.bytes), PNG);
      assert.equal(frame.headers.get('cache-control'), 'private, no-store');
      assert.equal(frame.headers.get('content-type')?.split(';')[0], 'image/png');
      const interaction = await h.request(f.userId, `/interactions/${f.taskId}`, user());
      assert.equal(interaction.data.cursor, 0, 'Passive frames advanced decision cursor');
      assert.equal(interaction.data.lastOperation, null);
      assert.equal(lease(interaction.data).controlOwner, 'agent');
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        ...user(),
        method: 'POST',
        body: { mode: 'user' },
      });
      const bounds = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        ...user(),
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'screen.bounds',
          args: {},
          expectedCursor: 0,
        },
      });
      assert.equal(bounds.status, 200);
      assert.deepEqual((bounds.data.operation as Record<string, unknown>).result, h.screenBounds);
      assert.ok(h.physicalOperations.some((op) => op.op === 'screen.bounds'));
      assert.equal(await prisma.agentAttentionRequest.count({ where: { userId: f.userId } }), 0);
      assert.ok(!JSON.stringify(bounds.data).includes('/iphone/c/'));
    },
  ],
  [
    'frame alone cold bootstraps and expired control grant refreshes the same session key',
    async (h) => {
      const f = await task(h);
      assert.equal(
        (await h.request(f.userId, `/leases/${f.leaseId}/frame`, user())).status,
        200,
        'Cold frame did not bootstrap'
      );
      const before = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const saved = openPhoneValue<PhoneHarnessSession>(before.providerSessionEncrypted!);
      saved.control!.expiresAt = Math.floor(Date.now() / 1000) - 1;
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { providerSessionEncrypted: sealPhoneValue(saved) },
      });
      const start = h.calls.length;
      assert.equal(
        (await h.request(f.userId, `/leases/${f.leaseId}/frame`, user())).status,
        200,
        'Expired grant was not refreshed'
      );
      assert.ok(h.calls.slice(start).some((c) => c.path.startsWith('/sessions/requests/')));
      assert.ok(
        !h.calls
          .slice(start)
          .some((c) => c.method === 'DELETE' || (c.method === 'POST' && c.path === '/sessions'))
      );
      assert.equal(
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
          .providerStartKey,
        before.providerStartKey
      );
    },
  ],
  [
    'user cannot allocate raw agent IDs or frame a lease without its owned browser task',
    async (h) => {
      const f = await h.fixture();
      const start = h.calls.length;
      const allocated = await h.request(f.userId, '/leases', {
        ...user(),
        method: 'POST',
        body: { agentId: f.agentId, requestKey: randomUUID() },
      });
      assert.equal(allocated.status, 403, 'User selected an internal agent allocation');
      assert.equal((await h.request(f.userId, `/leases/${f.leaseId}/frame`, user())).status, 404);
      assert.equal((await h.request(f.userId, `/leases/${f.leaseId}/view`, user())).status, 404);
      assert.equal(h.calls.length, start);
    },
  ],
  [
    'live frame fences handback input and release until exact cleanup proof',
    async (h) => {
      const f = await task(h);
      await command(h, f.userId, f.leaseId);
      const held = h.holdFrame();
      const frame = h.request(f.userId, `/leases/${f.leaseId}/frame`, user());
      try {
        await held.entered;
        assert.equal(
          (
            await h.request(f.userId, `/leases/${f.leaseId}/control`, {
              ...user(),
              method: 'POST',
              body: { mode: 'user' },
            })
          ).status,
          409,
          'Control changed during frame RPC'
        );
        assert.equal(
          (await command(h, f.userId, f.leaseId, 'input.tap')).status,
          409,
          'Mutation ran parallel to frame'
        );
        const released = await h.request(f.userId, `/leases/${f.leaseId}/release`, {
          ...user(),
          method: 'POST',
        });
        assert.equal(lease(released.data).status, 'ACTIVE', 'In-flight frame lost logical custody');
        assert.equal(
          (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
            .providerState,
          'CLOSING'
        );
        h.cleanupComplete = true;
        await h.request(f.userId, `/leases/${f.leaseId}`);
        held.release();
        assert.equal((await frame).status, 409, 'Late frame escaped confirmed cleanup fence');
      } finally {
        held.release();
        await frame;
      }
    },
  ],
  [
    'user control survives agent heartbeat expiry and cannot be reclaimed by the internal actor',
    async (h) => {
      const f = await task(h);
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/control`, {
            ...user(),
            method: 'POST',
            body: { mode: 'user' },
          })
        ).status,
        200
      );
      await prisma.iPhoneLease.update({
        where: { id: f.leaseId },
        data: { leaseExpiresAt: new Date(0) },
      });
      const heartbeat = await h.request(f.userId, `/leases/${f.leaseId}/heartbeat`, {
        method: 'POST',
      });
      assert.equal(heartbeat.status, 200, 'Agent heartbeat expired active user control');
      assert.equal(lease(heartbeat.data).status, 'ACTIVE');
      assert.equal(lease(heartbeat.data).controlOwner, 'user');
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/control`, {
            method: 'POST',
            body: { mode: 'agent' },
          })
        ).status,
        409,
        'Agent stole user control'
      );
      const handback = await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        ...user(),
        method: 'POST',
        body: { mode: 'agent' },
      });
      assert.equal(handback.status, 200);
      assert.equal(lease(handback.data).controlOwner, 'agent');
      assert.ok(Date.parse(String(lease(handback.data).leaseExpiresAt)) > Date.now());
    },
  ],
];

viewCases.push([
  'normal commands refresh expired control grants without replacing a fresh session',
  async (h) => {
    const f = await task(h);
    await command(h, f.userId, f.leaseId);
    const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
    const saved = openPhoneValue<PhoneHarnessSession>(device.providerSessionEncrypted!);
    saved.control!.expiresAt = 0;
    await prisma.iPhoneDevice.update({
      where: { id: f.deviceId },
      data: { providerSessionEncrypted: sealPhoneValue(saved) },
    });
    const start = h.calls.length;
    const result = await command(h, f.userId, f.leaseId);
    assert.equal(
      result.data.operation?.status,
      'SUCCEEDED',
      'Fresh session reused expired control grant'
    );
    assert.ok(h.calls.slice(start).some((c) => c.path.startsWith('/sessions/requests/')));
    assert.ok(
      !h.calls
        .slice(start)
        .some((c) => c.method === 'DELETE' || (c.method === 'POST' && c.path === '/sessions'))
    );
  },
]);
viewCases.push([
  'cleanup confirmation fences a supplemental read beside an unknown mutation',
  async (h) => {
    const f = await task(h);
    h.inputMode = 'unknown';
    assert.equal(
      (await command(h, f.userId, f.leaseId, 'input.tap')).data.operation?.status,
      'UNKNOWN'
    );
    const held = h.holdRead();
    const reading = command(h, f.userId, f.leaseId);
    try {
      await held.entered;
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      h.cleanupComplete = true;
      await h.request(f.userId, `/leases/${f.leaseId}`);
      held.release();
      const late = await reading;
      assert.equal(
        late.data.operation?.status,
        'UNKNOWN',
        'Late supplemental read escaped cleanup fence'
      );
    } finally {
      held.release();
      await reading;
    }
  },
]);

viewCases.push([
  'expired session enters durable closing before stop and never replaces before proof',
  async (h) => {
    const f = await task(h);
    await command(h, f.userId, f.leaseId);
    const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
    const saved = openPhoneValue<PhoneHarnessSession>(device.providerSessionEncrypted!);
    saved.expiresAt = 0;
    await prisma.iPhoneDevice.update({
      where: { id: f.deviceId },
      data: { providerSessionEncrypted: sealPhoneValue(saved) },
    });
    let closingAtStop = false;
    h.beforeStop = async () => {
      closingAtStop =
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
          .providerState === 'CLOSING';
    };
    const id = randomUUID();
    const post = (operationId = id) =>
      h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId, operation: 'input.tap', args: { x: 1, y: 1 } },
      });
    const before = h.physicalOperations.length;
    assert.equal((await post()).data.operation?.status, 'FAILED');
    assert.ok(closingAtStop, 'Expired-session stop preceded durable closing fence');
    assert.equal(
      (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).providerStartKey,
      device.providerStartKey
    );
    assert.equal(h.physicalOperations.length, before);
    h.cleanupComplete = true;
    await h.request(f.userId, `/leases/${f.leaseId}/frame`, user());
    h.cleanupComplete = false;
    assert.equal((await post()).data.operation?.status, 'FAILED');
    const readyIntent = randomUUID();
    const completed = await post(readyIntent);
    assert.equal(completed.data.operation?.status, 'SUCCEEDED');
    assert.equal(h.physicalOperations.length, before + 1, 'Recovered operation replayed input');
    assert.equal((await post(readyIntent)).data.operation?.status, 'SUCCEEDED');
    assert.equal(h.physicalOperations.length, before + 1);
  },
]);
viewCases.push([
  'device revocation during frame RPC rejects the returned pixels',
  async (h) => {
    const f = await task(h);
    await command(h, f.userId, f.leaseId);
    const held = h.holdFrame();
    const frame = h.request(f.userId, `/leases/${f.leaseId}/frame`, user());
    try {
      await held.entered;
      await prisma.iPhoneDevice.update({ where: { id: f.deviceId }, data: { enabled: false } });
      held.release();
      assert.equal((await frame).status, 409, 'Revoked phone exposed late frame');
    } finally {
      held.release();
      await frame;
    }
  },
]);

for (const cause of ['account', 'task', 'terminal-agent'] as const) {
  viewCases.push([
    `${cause} revocation during frame RPC rejects late pixels`,
    async (h) => {
      const f = await task(h);
      await command(h, f.userId, f.leaseId);
      const held = h.holdFrame();
      const frame = h.request(f.userId, `/leases/${f.leaseId}/frame`, user());
      try {
        await held.entered;
        if (cause === 'account')
          await prisma.user.update({
            where: { userId: f.userId },
            data: { phone: '+15550008888' },
          });
        else if (cause === 'task') await prisma.browserSession.delete({ where: { id: f.taskId } });
        else await prisma.agent.update({ where: { id: f.agentId }, data: { status: 'COMPLETED' } });
        held.release();
        assert.equal((await frame).status, 409, 'Revoked owner exposed late frame');
      } finally {
        held.release();
        await frame;
      }
    },
  ]);
}

viewCases.push([
  'duplicate CONNECTING requests do not run parallel provider readiness RPCs',
  async (h) => {
    const f = await task(h);
    h.sessionState = 'provisioning';
    const firstReady = h.holdReadiness();
    const id = randomUUID();
    const post = () =>
      h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId: id, operation: 'screen.text', args: {} },
      });
    const first = post();
    let duplicate: ReturnType<typeof post> | undefined;
    let secondReady: ReturnType<Harness['holdReadiness']> | undefined;
    try {
      await firstReady.entered;
      secondReady = h.holdReadiness();
      const before = h.calls.length;
      duplicate = post();
      // A duplicate must return the durable CONNECTING receipt promptly. An
      // erroneous second provider readiness request reaches the held barrier.
      const outcome = await Promise.race([
        duplicate.then((result) => ({ duplicate: result })),
        secondReady.entered.then(() => ({ parallel: true })),
      ]);
      assert.ok(
        'duplicate' in outcome,
        'Duplicate CONNECTING request launched a parallel readiness RPC'
      );
      assert.equal(h.calls.length, before);
      firstReady.release();
      assert.equal((await first).data.operation?.status, 'SUCCEEDED');
    } finally {
      firstReady.release();
      secondReady?.release();
      await first;
      await duplicate;
    }
  },
]);

viewCases.push([
  'settled pre-execution pending becomes terminal for status-only clients without replay',
  async (h) => {
    const f = await task(h);
    const physical = h.physicalOperations.length;
    const start = h.calls.length;
    h.createUnknown = true;
    h.hideReceipt = true;
    const id = randomUUID();
    const post = () =>
      h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId: id, operation: 'input.tap', args: { x: 3, y: 4 } },
      });
    const first = await post();
    assert.equal(
      first.data.operation?.status,
      'FAILED',
      'Settled preparation stranded a CONNECTING intent'
    );
    assert.equal(first.data.operation?.errorCode, 'phone_connection_not_ready');
    assert.deepEqual(first.data.operation?.result, {
      success: false,
      outcome: 'rejected',
      error: 'Phone connection is still being prepared',
    });
    assert.equal(h.physicalOperations.length, physical, 'Input ran before connection readiness');
    h.hideReceipt = false;
    const status = await h.request(f.userId, `/leases/${f.leaseId}/operations/${id}`);
    assert.equal(status.data.operation?.status, 'FAILED');
    assert.equal((await h.request(f.userId, `/leases/${f.leaseId}/frame`, user())).status, 200);
    assert.equal(
      (await post()).data.operation?.status,
      'FAILED',
      'Status recovery replayed original input'
    );
    assert.equal(h.physicalOperations.length, physical);
    assert.equal(
      h.calls.slice(start).filter((c) => c.method === 'POST' && c.path === '/sessions').length,
      1,
      'Recovery allocated a replacement session'
    );
    const ready = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
      method: 'POST',
      body: { operationId: randomUUID(), operation: 'input.tap', args: { x: 3, y: 4 } },
    });
    assert.equal(ready.data.operation?.status, 'SUCCEEDED');
    assert.equal(h.physicalOperations.length, physical + 1);
    assert.deepEqual(
      (await post()).data.operation,
      first.data.operation,
      'Original failed intent was not terminal forever'
    );
    assert.equal(h.physicalOperations.length, physical + 1);
    assert.equal(
      await prisma.iPhoneOperation.count({
        where: { deviceId: f.deviceId, state: { in: ['CONNECTING', 'RUNNING'] } },
      }),
      0
    );
  },
]);
