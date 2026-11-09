/** Owner device status/live frame, stale-hold recovery, queue views and setup progress. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { setupState, sealSetup } from '../../providers/phoneSetupState';
import { SETUP_REQUIREMENTS_VERSION } from '../../providers/phoneSetupVerification';
import { USER_CONTROL_TIMEOUT_MS } from '../../providers/phoneAccountPolicy';
import type { Case } from './iphone-control.cases';
import { Harness, PNG } from './iphone-control.fixtures';

const user = { actor: 'user' as const };
const STEP_KEYS = [
  'session',
  'portrait_lock',
  'apple_account',
  'icloud',
  'imessage',
  'gmail',
  'passcode',
];
const STEP_LABELS = [
  'Phone booted',
  'Orientation locked',
  'Apple ID signed in',
  'iCloud connected',
  'iMessage on',
  'Gmail connected',
  'Passcode set',
];

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function bootSession(h: Harness, userId: string, leaseId: string) {
  const read = await h.request(userId, `/leases/${leaseId}/operations`, {
    method: 'POST',
    body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
  });
  assert.equal(object(read.data.operation).status, 'SUCCEEDED', 'Fixture session boot');
  const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { userId } });
  assert.equal(device.providerState, 'READY');
  return device;
}
async function leaseSnapshot(id: string) {
  const lease = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id } });
  return {
    status: lease.status,
    expires: lease.leaseExpiresAt?.getTime(),
    revision: lease.revision,
    controlOwner: lease.controlOwner,
  };
}
function sessionCalls(h: Harness, start: number) {
  return h.calls
    .slice(start)
    .filter((c) => c.method === 'DELETE' || (c.method === 'POST' && c.path === '/sessions'));
}
async function pendingAuth(userId: string, agentId: string) {
  return prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId,
      workflowId: agentId,
      question: 'Synthetic phone sign-in approval',
    },
  });
}

export const deviceCases: Case[] = [
  [
    'device status reports holder and FIFO waiters without allocating or starting a session',
    async (h) => {
      const f = await h.fixture();
      const first = await h.acquire(f.userId, (await h.createAgent(f.userId)).id);
      const second = await h.acquire(f.userId, (await h.createAgent(f.userId)).id);
      assert.equal(second.status, 'WAITING');
      const before = await Promise.all([f.leaseId, first.id, second.id].map(leaseSnapshot));
      const calls = h.calls.length;
      const leaseCount = await prisma.iPhoneLease.count({ where: { userId: f.userId } });
      const status = await h.request(f.userId, '/device', user);
      assert.equal(status.status, 200);
      assert.deepEqual(Object.keys(status.data).sort(), [
        'enabled',
        'holder',
        'providerState',
        'setupState',
        'waiting',
      ]);
      assert.equal(status.data.enabled, true);
      assert.equal(status.data.setupState, 'ready');
      assert.equal(status.data.providerState, 'IDLE');
      const holder = object(status.data.holder);
      assert.deepEqual(Object.keys(holder).sort(), ['agentId', 'controlOwner', 'leaseId', 'since']);
      assert.equal(holder.agentId, f.agentId);
      assert.equal(holder.leaseId, f.leaseId);
      assert.equal(holder.controlOwner, 'agent');
      assert.ok(Number.isFinite(Date.parse(String(holder.since))));
      const waiting = status.data.waiting as Array<Record<string, unknown>>;
      assert.deepEqual(
        waiting.map((w) => [w.leaseId, w.position]),
        [
          [first.id, 1],
          [second.id, 2],
        ]
      );
      assert.equal(waiting[0].agentId, first.agentId);
      assert.ok(Number.isFinite(Date.parse(String(waiting[0].queueDeadlineAt))));
      assert.deepEqual(
        await Promise.all([f.leaseId, first.id, second.id].map(leaseSnapshot)),
        before,
        'Device status changed lease custody'
      );
      assert.equal(await prisma.iPhoneLease.count({ where: { userId: f.userId } }), leaseCount);
      assert.equal(h.calls.length, calls, 'Device status touched the provider');
      const internal = await h.request(f.userId, '/device');
      assert.equal(internal.status, 200, 'Internal key + user scope reads device status');
      const other = await h.fixture();
      const foreign = await h.request(other.userId, '/device', user);
      assert.equal(object(foreign.data.holder).leaseId, other.leaseId, 'Owner scope only');
    },
  ],
  [
    'paused agent with unanswered phone auth releases the phone and the next waiter is admitted',
    async (h) => {
      const f = await h.fixture();
      const waiter = await h.acquire(f.userId, (await h.createAgent(f.userId)).id);
      assert.equal(waiter.status, 'WAITING');
      const attention = await pendingAuth(f.userId, f.agentId);
      await prisma.iPhoneLease.update({
        where: { id: f.leaseId },
        data: { attentionRequestId: attention.id, controlOwner: 'user' },
      });
      await prisma.agent.update({ where: { id: f.agentId }, data: { status: 'PAUSED' } });
      const status = await h.request(f.userId, '/device', user);
      assert.equal(status.status, 200);
      assert.equal(status.data.holder, null, 'Paused agent still holds the phone');
      assert.equal(
        (await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } })).status,
        'RELEASED'
      );
      assert.equal(
        (await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: waiter.id } })).status,
        'WAITING',
        'Device status must not allocate a lease'
      );
      const promoted = await h.request(f.userId, `/leases/${waiter.id}`);
      assert.equal(object(promoted.data.lease).status, 'ACTIVE', 'Next waiter was not admitted');
    },
  ],
  [
    'user control and unanswered phone auth expire after the bounded user-control grace',
    async (h) => {
      const stale = new Date(Date.now() - USER_CONTROL_TIMEOUT_MS - 60_000);
      const recent = new Date(Date.now() - 5 * 60_000);
      const controlled = await h.fixture();
      await prisma.iPhoneLease.update({
        where: { id: controlled.leaseId },
        data: { controlOwner: 'user', leaseExpiresAt: recent },
      });
      const within = await h.request(controlled.userId, `/leases/${controlled.leaseId}`);
      assert.equal(object(within.data.lease).status, 'ACTIVE', 'User control lost within grace');
      await prisma.iPhoneLease.update({
        where: { id: controlled.leaseId },
        data: { leaseExpiresAt: stale },
      });
      const expired = await h.request(controlled.userId, `/leases/${controlled.leaseId}`);
      assert.equal(object(expired.data.lease).status, 'EXPIRED', 'User control held forever');

      const auth = await h.fixture();
      const attention = await pendingAuth(auth.userId, auth.agentId);
      await prisma.iPhoneLease.update({
        where: { id: auth.leaseId },
        data: { attentionRequestId: attention.id, controlOwner: 'user', leaseExpiresAt: recent },
      });
      const pending = await h.request(auth.userId, `/leases/${auth.leaseId}`);
      assert.equal(object(pending.data.lease).status, 'ACTIVE', 'Pending auth lost within grace');
      assert.equal(object(pending.data.lease).attentionRequestId, attention.id);
      await prisma.iPhoneLease.update({
        where: { id: auth.leaseId },
        data: { leaseExpiresAt: stale },
      });
      const status = await h.request(auth.userId, '/device', user);
      assert.equal(status.data.holder, null, 'Unanswered auth held the phone forever');
      assert.equal(
        (await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: auth.leaseId } })).status,
        'EXPIRED'
      );
    },
  ],
  [
    'waiting lease views expose the active holder and 1-based queue position',
    async (h) => {
      const f = await h.fixture();
      const first = await h.acquire(f.userId, (await h.createAgent(f.userId)).id);
      const second = await h.acquire(f.userId, (await h.createAgent(f.userId)).id);
      const view = await h.request(f.userId, `/leases/${second.id}`);
      assert.equal(view.status, 200);
      assert.deepEqual(view.data.holder, {
        agentId: f.agentId,
        leaseId: f.leaseId,
        controlOwner: 'agent',
      });
      assert.equal(view.data.queuePosition, 2);
      assert.equal((await h.request(f.userId, `/leases/${first.id}`)).data.queuePosition, 1);
      const active = await h.request(f.userId, `/leases/${f.leaseId}`);
      assert.equal(active.data.holder, null);
      assert.equal(active.data.queuePosition, null);

      // Task-bound interaction routes carry the same queue context.
      const context = await prisma.browserContext.upsert({
        where: { userId: f.userId },
        create: { userId: f.userId, contextId: randomUUID() },
        update: {},
      });
      const browser = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: first.agentId, sessionId: randomUUID() },
      });
      const ensured = await h.request(f.userId, `/interactions/${browser.id}`, {
        method: 'POST',
        body: { requestKey: randomUUID() },
      });
      assert.equal(ensured.status, 200);
      assert.equal(object(ensured.data.lease).status, 'WAITING');
      assert.equal(object(ensured.data.holder).leaseId, f.leaseId);
      assert.equal(ensured.data.queuePosition, 3);
      const read = await h.request(f.userId, `/interactions/${browser.id}`, user);
      assert.equal(object(read.data.holder).agentId, f.agentId);
      assert.equal(read.data.queuePosition, 3);
    },
  ],
  [
    'device frame shows the live screen while another agent holds the lease without custody',
    async (h) => {
      const f = await h.fixture();
      const device = await bootSession(h, f.userId, f.leaseId);
      const before = await leaseSnapshot(f.leaseId);
      const operations = await prisma.iPhoneOperation.count({ where: { deviceId: device.id } });
      const start = h.calls.length;
      const frame = await h.request(f.userId, '/device/frame', user);
      assert.equal(frame.status, 200, 'Owner frame refused beside an agent holder');
      assert.deepEqual(Buffer.from(frame.bytes), PNG);
      assert.equal(frame.headers.get('cache-control'), 'private, no-store');
      assert.equal(frame.headers.get('content-type')?.split(';')[0], 'image/png');
      assert.equal((await h.request(f.userId, '/device/frame')).status, 200);
      assert.deepEqual(await leaseSnapshot(f.leaseId), before, 'Frame changed lease custody');
      assert.equal(
        await prisma.iPhoneOperation.count({ where: { deviceId: device.id } }),
        operations,
        'Frame entered the command journal'
      );
      assert.deepEqual(sessionCalls(h, start), [], 'Frame started or stopped a session');
      const after = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: device.id } });
      assert.equal(after.providerState, 'READY');
      assert.equal(after.providerEpoch, device.providerEpoch);
    },
  ],
  [
    'device frame serves a READY session with no holder and never boots an idle phone',
    async (h) => {
      const f = await h.fixture();
      await bootSession(h, f.userId, f.leaseId);
      await prisma.iPhoneLease.update({
        where: { id: f.leaseId },
        data: { status: 'RELEASED', activeDeviceId: null },
      });
      const status = await h.request(f.userId, '/device', user);
      assert.equal(status.data.holder, null);
      assert.equal(status.data.providerState, 'READY');
      assert.equal((await h.request(f.userId, '/device/frame', user)).status, 200);

      const idle = await h.fixture();
      const start = h.calls.length;
      const refused = await h.request(idle.userId, '/device/frame', user);
      assert.equal(refused.status, 409);
      assert.equal(refused.data.state, 'IDLE');
      assert.equal(typeof refused.data.error, 'string');
      assert.equal(h.calls.length, start, 'Idle frame contacted the provider');
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({
        where: { userId: idle.userId },
      });
      assert.equal(device.providerState, 'IDLE');
      assert.equal(device.providerStartKey, null, 'Idle frame reserved a session');
    },
  ],
  [
    'device frame shows the owner a private phase but refuses internal callers and in-flight operations',
    async (h) => {
      const f = await h.fixture();
      const device = await bootSession(h, f.userId, f.leaseId);
      const held = h.holdRead();
      const reading = h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
      });
      try {
        await held.entered;
        const busy = await h.request(f.userId, '/device/frame', user);
        assert.equal(busy.status, 409);
        assert.equal(busy.data.state, 'busy');
      } finally {
        held.release();
        await reading;
      }
      await prisma.iPhoneDevice.update({
        where: { id: device.id },
        data: {
          privateInputEncrypted: sealPhoneValue({
            version: 1,
            active: true,
            values: ['synthetic-private'],
          }),
        },
      });
      const start = h.calls.length;
      // Same boundary as the lease frame: the owner keeps their own PNG during a private phase;
      // internal (agent/model) callers are refused before any provider read.
      const hidden = await h.request(f.userId, '/device/frame');
      assert.equal(hidden.status, 409);
      assert.equal(hidden.data.state, 'private');
      assert.equal(h.calls.length, start, 'Private internal frame contacted the provider');
      const owner = await h.request(f.userId, '/device/frame', user);
      assert.equal(owner.status, 200, 'Owner lost their own screen during a private phase');
    },
  ],
  [
    'connection setupProgress maps stored setup checks and the setup task',
    async (h) => {
      const ready = await h.fixture();
      const done = await h.request(ready.userId, '/connection', user);
      assert.equal(done.data.status, 'ready');
      const doneSteps = object(done.data.setupProgress).steps as Array<Record<string, unknown>>;
      assert.deepEqual(
        doneSteps.map((s) => [s.key, s.label, s.status]),
        STEP_KEYS.map((key, i) => [key, STEP_LABELS[i], 'done'])
      );
      assert.equal(done.data.setupTaskId, null);

      const f = await h.fixture();
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      const setupAgent = await h.createAgent(f.userId);
      const context = await prisma.browserContext.upsert({
        where: { userId: f.userId },
        create: { userId: f.userId, contextId: randomUUID() },
        update: {},
      });
      const setupTask = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: setupAgent.id, sessionId: randomUUID() },
      });
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const state = setupState(device.setupEncrypted);
      assert.ok(state.attempt, 'Synthetic configuration attempt');
      const proof = (status: 'confirmed' | 'disabled') => ({
        status,
        observedAt: new Date().toISOString(),
        evidenceDigest: 'synthetic-progress',
        requirementsVersion: SETUP_REQUIREMENTS_VERSION,
        floorCursor: state.attempt!.floorCursor,
        attemptId: state.attempt!.id,
        profileRevision: state.profileRevision,
        workflowId: state.attempt!.workflowId,
        providerEpoch: device.providerEpoch,
        expectedPhone: state.expectedPhone ?? null,
      });
      state.verification = {
        requirementsVersion: SETUP_REQUIREMENTS_VERSION,
        checks: {
          portrait_lock: proof('confirmed'),
          apple_account: proof('confirmed'),
          icloud_messages: proof('confirmed'),
          icloud_keychain: proof('confirmed'),
          icloud_contacts: proof('confirmed'),
          imessage: proof('disabled'),
          receive_address: proof('confirmed'),
        },
      };
      delete state.completedConfiguration;
      state.connection = {
        agentId: setupAgent.id,
        requestKeyHash: createHash('sha256').update(randomUUID()).digest('hex'),
        profileRevision: state.profileRevision,
        revision: state.claimRevision,
      };
      await prisma.iPhoneDevice.update({
        where: { id: device.id },
        data: { setupState: 'in_progress', setupEncrypted: sealSetup(state) },
      });
      const progress = await h.request(f.userId, '/connection', user);
      assert.equal(progress.status, 200);
      assert.equal(progress.data.status, 'setting_up');
      assert.equal(progress.data.setupAgentId, setupAgent.id);
      assert.equal(progress.data.setupTaskId, setupTask.id);
      const steps = object(progress.data.setupProgress).steps as Array<Record<string, unknown>>;
      assert.deepEqual(
        steps.map((s) => [s.key, s.status]),
        [
          ['session', 'done'],
          ['portrait_lock', 'done'],
          ['apple_account', 'done'],
          ['icloud', 'done'],
          ['imessage', 'failed'],
          ['gmail', 'in_progress'],
          ['passcode', 'pending'],
        ]
      );
      await prisma.iPhoneDevice.update({ where: { id: device.id }, data: { enabled: false } });
      const disconnected = await h.request(f.userId, '/connection', user);
      assert.equal(disconnected.data.status, 'not_connected');
      assert.equal(disconnected.data.setupProgress, null);
      assert.equal(disconnected.data.setupTaskId, null);
    },
  ],
];

/** Fresh setup (no stored checks) starts at the boot step. */
deviceCases.push([
  'connection setupProgress starts at the boot step before any setup observation',
  async (h) => {
    const f = await h.fixture();
    await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
    const setupAgent = await h.createAgent(f.userId);
    const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
    const state = setupState(device.setupEncrypted);
    delete state.verification;
    delete state.completedConfiguration;
    state.connection = {
      agentId: setupAgent.id,
      requestKeyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      profileRevision: state.profileRevision,
      revision: state.claimRevision,
    };
    await prisma.iPhoneDevice.update({
      where: { id: device.id },
      data: { setupState: 'in_progress', setupEncrypted: sealSetup(state) },
    });
    const progress = await h.request(f.userId, '/connection', user);
    assert.equal(progress.data.status, 'setting_up');
    assert.equal(progress.data.setupTaskId, null, 'No setup browser task is known');
    assert.deepEqual(
      (object(progress.data.setupProgress).steps as Array<Record<string, unknown>>).map(
        (s) => s.status
      ),
      ['in_progress', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']
    );
  },
]);
