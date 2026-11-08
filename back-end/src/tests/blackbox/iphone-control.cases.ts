import { fixtureGenerationCases } from './iphone-control.fixture-generation.cases';
import { continuityCases } from './iphone-control.continuity.cases';
import { authLossCases } from './iphone-control.auth-loss.cases';
import { portraitCases } from './iphone-control.portrait.cases';
import { connectionCases } from './iphone-control.connection.cases';
import { messageCases } from './iphone-control.messages.cases';
import { savedCredentialCases } from './iphone-control.saved-credential.cases';
import { rolloutCases } from './iphone-control.rollout.cases';
import { setupCases } from './iphone-control.setup.cases';
import { privacyCases } from './iphone-control.privacy.cases';
import { viewCases } from './iphone-control.view.cases';
import { cleanupCases } from './iphone-control.cleanup.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { Harness, CANARY_KEY, CANARY_TOKEN, CANARY_PASSWORD, PNG } from './iphone-control.fixtures';

export type Case = [string, (h: Harness) => Promise<void>];
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function operation(data: unknown) {
  return object(object(data).operation);
}
function lease(data: unknown) {
  return object(object(data).lease);
}
function noSecrets(value: unknown, password = false) {
  const text = JSON.stringify(value);
  for (const secret of [
    CANARY_KEY,
    CANARY_TOKEN,
    '/iphone/c/',
    ...(password ? [CANARY_PASSWORD] : []),
  ]) {
    assert.ok(!text.includes(secret), 'Private phone capability or input leaked');
  }
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Phone fixture barrier did not settle')), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function send(
  h: Harness,
  userId: string,
  leaseId: string,
  operationId = randomUUID(),
  name = 'screen.text',
  args: Record<string, unknown> = {},
  userApiKey?: string
) {
  return h.request(userId, `/leases/${leaseId}/operations`, {
    method: 'POST',
    body: { operationId, operation: name, args },
    ...(userApiKey === undefined ? {} : { actor: 'user' as const, userApiKey }),
  });
}
async function queued(h: Harness, userId: string) {
  const a = await h.createAgent(userId);
  const waiter = await h.acquire(userId, a.id);
  assert.equal(waiter.status, 'WAITING');
  return waiter;
}
export const cases: Case[] = [
  ...fixtureGenerationCases,
  ...continuityCases,
  ...authLossCases,
  ...connectionCases,
  ...messageCases,
  ...savedCredentialCases,
  ...rolloutCases,
  ...setupCases,
  ...portraitCases,
  ...privacyCases,
  ...cleanupCases,
  ...viewCases,
  [
    'invalid lease requests and queued input cannot trigger cleanup for a pending phone',
    async (h) => {
      const f = await h.fixture();
      const waiter = await queued(h, f.userId);
      h.inputMode = 'unknown';
      const unknown = await send(h, f.userId, f.leaseId, randomUUID(), 'input.tap', { x: 1, y: 1 });
      assert.equal(operation(unknown.data).status, 'UNKNOWN');
      await prisma.iPhoneOperation.updateMany({
        where: { leaseId: f.leaseId },
        data: { deadlineAt: new Date(0) },
      });
      const before = h.calls.length;
      const nonexistent = randomUUID();
      assert.equal((await send(h, f.userId, nonexistent)).status, 404);
      assert.equal((await h.request(f.userId, `/leases/${nonexistent}`)).status, 404);
      assert.equal(
        (await h.request(f.userId, `/leases/${nonexistent}/release`, { method: 'POST' })).status,
        404
      );
      assert.equal((await send(h, f.userId, waiter.id)).status, 409);
      assert.equal(h.calls.length, before, 'Denied request initiated provider cleanup');
    },
  ],
  [
    'denied queued, foreign, missing and disabled operations never reach the provider',
    async (h) => {
      const f = await h.fixture(),
        other = await h.fixture();
      const waiter = await queued(h, f.userId);
      const before = h.calls.length;
      assert.equal((await send(h, f.userId, waiter.id)).status, 409);
      assert.equal((await send(h, other.userId, f.leaseId)).status, 404);
      assert.equal((await send(h, f.userId, randomUUID())).status, 404);
      await prisma.iPhoneDevice.update({ where: { id: f.deviceId }, data: { enabled: false } });
      assert.equal((await send(h, f.userId, f.leaseId)).status, 403);
      assert.equal(h.calls.length, before, 'Denied actions accessed the provider');
      assert.equal(await prisma.agentAttentionRequest.count({ where: { userId: f.userId } }), 0);
    },
  ],
  [
    'happy observations select the mapped iPhone and keep grants and commands encrypted',
    async (h) => {
      assert.equal(
        await h.probeProvider(),
        404,
        'Unrelated port probes must remain outside the provider contract'
      );
      const f = await h.fixture();
      const read = await send(h, f.userId, f.leaseId);
      assert.equal(read.status, 200);
      assert.equal(operation(read.data).status, 'SUCCEEDED');
      assert.deepEqual(operation(read.data).result, { text: 'Visible screen observation' });
      const create = h.calls.filter((c) => c.method === 'POST' && c.path === '/sessions').at(-1);
      assert.ok(create);
      const body = object(create.body);
      assert.equal(body.platform, 'ios');
      assert.equal(body.kind, 'device');
      assert.equal(body.device_id, f.providerDeviceId);
      assert.ok(create.idempotencyKey && /^[A-Za-z0-9_-]{16,128}$/.test(create.idempotencyKey));
      assert.equal(create.authorization, `Bearer ${CANARY_KEY}`);
      const tap = await send(h, f.userId, f.leaseId, randomUUID(), 'input.tap', { x: 10, y: 20 });
      assert.equal(operation(tap.data).status, 'SUCCEEDED');
      const typed = await send(h, f.userId, f.leaseId, randomUUID(), 'input.text', {
        s: CANARY_PASSWORD,
      });
      assert.equal(operation(typed.data).status, 'SUCCEEDED');
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.ok(device.providerSessionEncrypted, 'Session grant was not durably encrypted');
      const commands = await prisma.iPhoneOperation.findMany({ where: { leaseId: f.leaseId } });
      assert.equal(commands.length, 3);
      for (const command of commands) {
        assert.ok(command.requestEncrypted && command.resultEncrypted);
        noSecrets(command, true);
      }
      noSecrets(device, true);
      noSecrets(read.data, true);
      noSecrets(typed.data, true);
      const publicLease = await h.request(f.userId, `/leases/${f.leaseId}`);
      noSecrets(publicLease.data, true);
      const frame = await h.request(f.userId, `/leases/${f.leaseId}/frame`);
      assert.equal(frame.status, 200);
      assert.deepEqual(Buffer.from(frame.bytes), PNG);
      assert.match(frame.headers.get('cache-control') ?? '', /private/);
      assert.match(frame.headers.get('cache-control') ?? '', /no-store/);
      assert.equal(frame.headers.get('content-type')?.split(';')[0], 'image/png');
      noSecrets(Object.fromEntries(frame.headers.entries()), true);
      const controlCalls = h.calls.filter((c) => c.path.includes('/iphone/c/'));
      assert.ok(controlCalls.length >= 4);
      assert.ok(controlCalls.every((c) => c.authorization === `Bearer ${CANARY_TOKEN}`));
    },
  ],
  [
    'stable operation IDs canonicalize argument keys, reject changes and survive release',
    async (h) => {
      const f = await h.fixture(),
        other = await h.fixture();
      const id = randomUUID(),
        start = h.physicalOperations.length;
      const first = await send(h, f.userId, f.leaseId, id, 'input.tap', { x: 2, y: 3 });
      assert.equal(operation(first.data).status, 'SUCCEEDED');
      const again = await send(h, f.userId, f.leaseId, id, 'input.tap', { y: 3, x: 2 });
      assert.equal(again.status, 200);
      assert.deepEqual(again.data.operation, first.data.operation);
      assert.equal(h.physicalOperations.length, start + 1);
      assert.equal(
        (await send(h, f.userId, f.leaseId, id, 'input.tap', { x: 4, y: 3 })).status,
        409
      );
      assert.equal(
        (await send(h, f.userId, f.leaseId, id, 'input.text', { s: 'different' })).status,
        409
      );
      assert.equal(
        (await h.request(other.userId, `/leases/${f.leaseId}/operations/${id}`)).status,
        404
      );
      assert.equal(
        (await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' })).status,
        200
      );
      const cached = await h.request(f.userId, `/leases/${f.leaseId}/operations/${id}`);
      assert.equal(cached.status, 200);
      assert.deepEqual(cached.data.operation, first.data.operation);
    },
  ],
  [
    'concurrent duplicate input executes once and competing input and takeover are fenced',
    async (h) => {
      const f = await h.fixture(),
        id = randomUUID(),
        hold = h.holdOperation();
      const before = h.physicalOperations.length;
      const first = send(h, f.userId, f.leaseId, id, 'input.tap', { x: 4, y: 5 });
      try {
        await within(hold.entered);
        const same = await within(send(h, f.userId, f.leaseId, id, 'input.tap', { y: 5, x: 4 }));
        assert.equal(same.status, 200);
        assert.equal(
          h.physicalOperations.length,
          before + 1,
          'Duplicate concurrent input executed twice'
        );
        assert.equal(
          (await send(h, f.userId, f.leaseId, randomUUID(), 'input.text', { s: 'next' })).status,
          409
        );
        assert.equal(
          (
            await h.request(f.userId, `/leases/${f.leaseId}/control`, {
              method: 'POST',
              body: { mode: 'user' },
            })
          ).status,
          409
        );
        const attention = await prisma.agentAttentionRequest.create({
          data: {
            userId: f.userId,
            agentId: f.agentId,
            workflowId: randomUUID(),
            question: 'Synthetic sign in',
          },
        });
        assert.equal(
          (
            await h.request(f.userId, `/leases/${f.leaseId}/awaiting-auth`, {
              method: 'POST',
              body: { attentionRequestId: attention.id },
            })
          ).status,
          409
        );
      } finally {
        hold.release();
        await within(first);
      }
      assert.equal(h.physicalOperations.length, before + 1);
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/control`, {
            method: 'POST',
            body: { mode: 'user' },
          })
        ).status,
        200
      );
      const forged = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'input.tap',
          args: {},
          actor: 'user',
          isInternal: false,
        },
      });
      assert.equal(forged.status, 409, 'Agent impersonated the user via body');
      const userAction = await send(
        h,
        f.userId,
        f.leaseId,
        randomUUID(),
        'input.tap',
        { x: 1, y: 1 },
        f.userApiKey
      );
      assert.equal(operation(userAction.data).status, 'SUCCEEDED');
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        userApiKey: f.userApiKey,
        method: 'POST',
        body: { mode: 'agent' },
      });
      const forgedUser = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        actor: 'user',
        userApiKey: f.userApiKey,
        body: {
          operationId: randomUUID(),
          operation: 'input.tap',
          args: {},
          actor: 'agent',
          isInternal: true,
        },
      });
      assert.equal(forgedUser.status, 409, 'Frontend actor forged internal identity');
    },
  ],
];

for (const mode of ['unknown', 'disconnect'] as const) {
  cases.push([
    `ambiguous ${mode} input is never replayed and cleanup proof alone admits FIFO`,
    async (h) => {
      const f = await h.fixture(),
        waiter = await queued(h, f.userId),
        id = randomUUID();
      const callStart = h.calls.length;
      h.inputMode = mode;
      const count = h.physicalOperations.length;
      const result = await send(h, f.userId, f.leaseId, id, 'input.text', { s: CANARY_PASSWORD });
      assert.equal(result.status, 200);
      assert.equal(operation(result.data).status, 'UNKNOWN');
      noSecrets(result.data, true);
      const repeat = await send(h, f.userId, f.leaseId, id, 'input.text', { s: CANARY_PASSWORD });
      assert.equal(operation(repeat.data).status, 'UNKNOWN');
      assert.equal(h.physicalOperations.length, count + 1);
      assert.equal(
        (await send(h, f.userId, f.leaseId, randomUUID(), 'input.tap', { x: 1, y: 1 })).status,
        409
      );
      assert.equal((await h.request(f.userId, `/leases/${f.leaseId}/frame`)).status, 200);
      const release = await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      assert.equal(release.status, 200);
      assert.equal(
        lease((await h.request(f.userId, `/leases/${waiter.id}`)).data).status,
        'WAITING',
        'DELETE acknowledgement admitted waiter'
      );
      assert.ok(
        h.calls.slice(callStart).some((call) => call.method === 'DELETE'),
        'No exact session closure attempted'
      );
      const saved = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const receipts = h.calls
        .slice(callStart)
        .filter((call) => call.path.startsWith('/sessions/requests/'));
      assert.ok(
        receipts.every((call) => call.path.endsWith(encodeURIComponent(saved.providerStartKey!)))
      );
      h.cleanupComplete = true;
      const admitted = await h.request(f.userId, `/leases/${waiter.id}`);
      assert.equal(lease(admitted.data).status, 'ACTIVE');
      assert.notEqual(
        lease((await h.request(f.userId, `/leases/${f.leaseId}`)).data).status,
        'ACTIVE'
      );
    },
  ]);
}

cases.push(
  [
    'unsupported input fails visibly and frees the command slot without fallback',
    async (h) => {
      const f = await h.fixture();
      h.inputMode = 'unsupported';
      const before = h.physicalOperations.length;
      const rejected = await send(h, f.userId, f.leaseId, randomUUID(), 'input.tap', {
        x: 1,
        y: 2,
      });
      assert.equal(rejected.status, 200);
      assert.equal(operation(rejected.data).status, 'FAILED');
      assert.equal(operation(rejected.data).errorCode, 'unsupported');
      assert.equal(h.physicalOperations.length, before + 1);
      h.inputMode = 'success';
      const next = await send(h, f.userId, f.leaseId, randomUUID(), 'input.tap', { x: 3, y: 4 });
      assert.equal(operation(next.data).status, 'SUCCEEDED');
      assert.equal(h.physicalOperations.length, before + 2, 'Unexpected local fallback or replay');
    },
  ],
  [
    'provider error echoes cannot expose credentials or raw password input',
    async (h) => {
      const f = await h.fixture();
      h.inputMode = 'echo-error';
      const result = await send(h, f.userId, f.leaseId, randomUUID(), 'input.text', {
        s: CANARY_PASSWORD,
      });
      assert.equal(result.status, 200);
      assert.equal(operation(result.data).status, 'FAILED');
      noSecrets(result.data, true);
      const rows = await prisma.iPhoneOperation.findMany({ where: { leaseId: f.leaseId } });
      assert.equal(rows.length, 1);
      assert.ok(rows[0].resultEncrypted);
      noSecrets(rows, true);
      const status = await h.request(
        f.userId,
        `/leases/${f.leaseId}/operations/${rows[0].requestKey}`
      );
      noSecrets(status.data, true);
    },
  ],
  [
    'missing provider configuration is a visible failed receipt with no provider input',
    async (h) => {
      const f = await h.fixture();
      h.missingCredentials = true;
      const before = h.calls.length;
      const result = await send(h, f.userId, f.leaseId);
      assert.equal(result.status, 200);
      assert.equal(operation(result.data).status, 'FAILED');
      assert.equal(operation(result.data).errorCode, 'missing_credentials');
      assert.equal(object(operation(result.data).result).success, false);
      assert.equal(h.calls.length, before);
      noSecrets(result.data, true);
    },
  ],
  [
    'ambiguous admitted start recovers the same key and waits for ready before input',
    async (h) => {
      const f = await h.fixture(),
        start = h.calls.length,
        physical = h.physicalOperations.length;
      h.createUnknown = true;
      h.sessionState = 'provisioning';
      const readiness = h.holdReadiness();
      const running = send(h, f.userId, f.leaseId, randomUUID(), 'input.tap', { x: 1, y: 1 });
      try {
        await within(readiness.entered);
        assert.equal(h.physicalOperations.length, physical, 'Input ran before readiness');
        const creates = h.calls
          .slice(start)
          .filter((c) => c.method === 'POST' && c.path === '/sessions');
        assert.equal(creates.length, 1);
        const key = creates[0].idempotencyKey;
        assert.ok(key);
        const receipts = h.calls
          .slice(start)
          .filter((c) => c.path.startsWith('/sessions/requests/'));
        assert.ok(receipts.length >= 2, 'Admitted unknown create was not recovered');
        assert.ok(receipts.every((c) => c.path.endsWith(encodeURIComponent(key))));
      } finally {
        readiness.release();
      }
      const result = await within(running);
      assert.equal(operation(result.data).status, 'SUCCEEDED');
      assert.equal(h.physicalOperations.length, physical + 1);
      assert.equal(
        h.calls.slice(start).filter((c) => c.method === 'POST' && c.path === '/sessions').length,
        1
      );
    },
  ],
  [
    'missing receipt after ambiguous start keeps original identity and does not authorize a fresh phone',
    async (h) => {
      const f = await h.fixture(),
        id = randomUUID(),
        start = h.calls.length,
        physical = h.physicalOperations.length;
      h.createUnknown = true;
      h.hideReceipt = true;
      const pending = await send(h, f.userId, f.leaseId, id, 'input.tap', { x: 8, y: 9 });
      assert.equal(pending.status, 200);
      assert.equal(operation(pending.data).status, 'FAILED');
      assert.equal(operation(pending.data).errorCode, 'phone_connection_not_ready');
      assert.equal(object(operation(pending.data).result).outcome, 'rejected');
      assert.equal(h.physicalOperations.length, physical);
      const created = h.calls
        .slice(start)
        .filter((c) => c.method === 'POST' && c.path === '/sessions');
      assert.equal(created.length, 1);
      const saved = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.equal(saved.providerStartKey, created[0].idempotencyKey);
      h.hideReceipt = false;
      const resumed = await send(h, f.userId, f.leaseId, id, 'input.tap', { y: 9, x: 8 });
      assert.equal(operation(resumed.data).status, 'FAILED');
      assert.equal(h.physicalOperations.length, physical, 'Failed intent replayed input');
      const ready = await send(h, f.userId, f.leaseId, randomUUID(), 'input.tap', { x: 8, y: 9 });
      assert.equal(operation(ready.data).status, 'SUCCEEDED');
      assert.equal(h.physicalOperations.length, physical + 1);
      const original = await h.request(f.userId, `/leases/${f.leaseId}/operations/${id}`);
      assert.deepEqual(original.data.operation, pending.data.operation);
      const starts = h.calls
        .slice(start)
        .filter((c) => c.method === 'POST' && c.path === '/sessions');
      assert.equal(starts.length, 1, 'Recovery allocated another phone');
      assert.equal(starts[0].idempotencyKey, saved.providerStartKey);
    },
  ],
  [
    'frame authorization refuses queued, foreign and disabled leases before control transport',
    async (h) => {
      const f = await h.fixture(),
        other = await h.fixture(),
        waiter = await queued(h, f.userId);
      await send(h, f.userId, f.leaseId);
      const before = h.calls.length;
      assert.equal((await h.request(f.userId, `/leases/${waiter.id}/frame`)).status, 409);
      assert.equal((await h.request(other.userId, `/leases/${f.leaseId}/frame`)).status, 404);
      await prisma.iPhoneDevice.update({ where: { id: f.deviceId }, data: { enabled: false } });
      assert.equal((await h.request(f.userId, `/leases/${f.leaseId}/frame`)).status, 403);
      assert.equal(h.calls.length, before, 'Rejected frame read reached provider');
    },
  ]
);
for (const cause of ['worker-deadline', 'lease-expiry', 'terminal-agent'] as const) {
  cases.push([
    `${cause} retains in-flight reservation until cleanup proof and fences late completion`,
    async (h) => {
      const f = await h.fixture(),
        waiter = await queued(h, f.userId),
        id = randomUUID(),
        hold = h.holdOperation();
      const callStart = h.calls.length;
      const running = send(h, f.userId, f.leaseId, id, 'input.tap', { x: 5, y: 6 });
      try {
        await within(hold.entered);
        if (cause === 'worker-deadline')
          await prisma.iPhoneOperation.updateMany({
            where: { leaseId: f.leaseId, requestKey: id },
            data: { deadlineAt: new Date(0) },
          });
        else if (cause === 'lease-expiry')
          await prisma.iPhoneLease.update({
            where: { id: f.leaseId },
            data: { leaseExpiresAt: new Date(0) },
          });
        else await prisma.agent.update({ where: { id: f.agentId }, data: { status: 'FAILED' } });
        const pending = await h.request(f.userId, `/leases/${waiter.id}`);
        assert.equal(
          lease(pending.data).status,
          'WAITING',
          'Unconfirmed physical input lost device reservation'
        );
        if (cause === 'lease-expiry') {
          // A live command retains the device despite heartbeat expiry. Cancellation
          // then needs exact cleanup proof before another owner can use the phone.
          await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
        }
        assert.ok(
          h.calls.slice(callStart).some((c) => c.method === 'DELETE'),
          'Exact provider cleanup was not requested'
        );
        const old = await prisma.iPhoneOperation.findUniqueOrThrow({
          where: {
            leaseId_requestKey: { leaseId: f.leaseId, requestKey: id },
          },
        });
        assert.equal(
          old.activeDeviceId,
          f.deviceId,
          'Slot cleared on DELETE acknowledgement alone'
        );
        h.cleanupComplete = true;
        const promoted = await h.request(f.userId, `/leases/${waiter.id}`);
        assert.equal(lease(promoted.data).status, 'ACTIVE');
        const afterCleanup = await prisma.iPhoneDevice.findUniqueOrThrow({
          where: { id: f.deviceId },
        });
        hold.release();
        const late = await within(running);
        assert.equal(operation(late.data).status, 'UNKNOWN', 'Late worker rewrote fenced receipt');
        const afterLate = await prisma.iPhoneDevice.findUniqueOrThrow({
          where: { id: f.deviceId },
        });
        assert.equal(afterLate.providerEpoch, afterCleanup.providerEpoch);
        assert.equal(afterLate.providerSessionEncrypted, afterCleanup.providerSessionEncrypted);
        assert.equal(
          lease((await h.request(f.userId, `/leases/${waiter.id}`)).data).status,
          'ACTIVE'
        );
        assert.notEqual(
          lease((await h.request(f.userId, `/leases/${f.leaseId}`)).data).status,
          'ACTIVE'
        );
        const cached = await h.request(f.userId, `/leases/${f.leaseId}/operations/${id}`);
        assert.equal(operation(cached.data).status, 'UNKNOWN');
      } finally {
        hold.release();
        await within(running);
      }
    },
  ]);
}
