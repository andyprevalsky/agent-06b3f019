/** Native responses are real HTTP fixtures; the auxiliary semantic model is always mocked. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { revokePhoneFixtureIdentity } from './iphone-test-user';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { setupState, sealSetup } from '../../providers/phoneSetupState';
import type { ImessageAuthLossResult } from '../../providers/phoneAuthLoss';
import { freshSetup } from './iphone-control.setup-fixtures';
import type { Harness } from './iphone-control.fixtures';
import type { Case } from './iphone-control.cases';

const result = (status: ImessageAuthLossResult['status']): ImessageAuthLossResult => ({
  status,
  usage: {
    model: 'synthetic-imessage-auth',
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    totalCostCents: 0,
  },
});
async function prepared(h: Harness, app = 'com.apple.MobileSMS') {
  const f = await freshSetup(h);
  h.launchResult = 'com.apple.MobileSMS';
  const launch = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
    method: 'POST',
    body: {
      operationId: randomUUID(),
      operation: 'apps.launch',
      args: { name: app, fresh: false },
      expectedCursor: 0,
      setupAttemptId: f.setup.attemptId,
      setupRevision: f.setup.revision,
    },
  });
  assert.equal(launch.data.operation?.status, 'SUCCEEDED');
  return { ...f, cursor: (launch.data.operation as unknown as { cursor: number }).cursor };
}
function screen(h: Harness, f: Awaited<ReturnType<typeof prepared>>, id = randomUUID()) {
  return h.request(f.userId, `/leases/${f.leaseId}/operations`, {
    method: 'POST',
    body: {
      operationId: id,
      operation: 'screen.text',
      args: {},
      expectedCursor: f.cursor,
      setupAttemptId: f.setup.attemptId,
      setupRevision: f.setup.revision,
    },
  });
}
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Semantic fixture did not enter')), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const basic: Case[] = (
  [
    ['native signed-out affordance', 'signed_out'],
    ['conversation quote', 'unknown'],
    ['ordinary screen', 'not_observed'],
  ] as const
).map(([kind, status]) => [
  `semantic iMessage auth loss handles ${kind} without a content literal decision`,
  async (h) => {
    const f = await prepared(h);
    let calls = 0;
    h.observationResult = [
      {
        text:
          kind === 'conversation quote'
            ? 'A message quotes "iMessage is Signed Out"; OTP 732918'
            : 'iMessage is Signed Out\nVerification code 732918 for owner@example.invalid',
        x: 10,
        y: 20,
        w: 200,
        h: 40,
        confidence: 0.99,
        source: 'vision',
      },
    ];
    h.authLossVerifier = async (input) => {
      calls++;
      const text = JSON.stringify(input.evidence[1].result);
      assert.ok(!text.includes('732918'));
      assert.ok(!text.includes('owner@example.invalid'));
      assert.ok(input.timeoutMs > 0 && input.timeoutMs <= 300000);
      return result(status);
    };
    const id = randomUUID();
    const response = await screen(h, f, id);
    assert.equal(response.data.operation?.status, 'SUCCEEDED');
    assert.equal(calls, 1);
    assert.ok(
      JSON.stringify(response.data.operation?.result).includes('732918'),
      'primary observation unchanged'
    );
    const dto = await h.request(f.userId, '/connection', { actor: 'user' });
    assert.equal(dto.data.status === 'needs_reauth', status === 'signed_out');
    const row = await prisma.iPhoneOperation.findUniqueOrThrow({
      where: { leaseId_requestKey: { leaseId: f.leaseId, requestKey: id } },
    });
    assert.equal(
      await prisma.toolUsage.count({ where: { operationKey: 'iphone-auth-loss:' + row.id } }),
      1
    );
    await h.request(f.userId, `/leases/${f.leaseId}/operations/${id}`);
    assert.equal(calls, 1);
  },
]);
const fences = [
  'profile',
  'phone',
  'cursor',
  'epoch',
  'privacy',
  'workflow',
  'firstRun',
  'lease',
] as const;
async function mutate(f: Awaited<ReturnType<typeof prepared>>, kind: (typeof fences)[number]) {
  if (kind === 'profile') {
    const d = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
    const s = setupState(d.setupEncrypted);
    s.profileRevision++;
    await prisma.iPhoneDevice.update({
      where: { id: d.id },
      data: { setupEncrypted: sealSetup(s) },
    });
  } else if (kind === 'phone') await revokePhoneFixtureIdentity(f.userId);
  else if (kind === 'cursor')
    await prisma.iPhoneLease.update({
      where: { id: f.leaseId },
      data: { actionCursor: { increment: 1 } },
    });
  else if (kind === 'epoch')
    await prisma.iPhoneDevice.update({
      where: { id: f.deviceId },
      data: { providerEpoch: { increment: 1 } },
    });
  else if (kind === 'privacy')
    await prisma.iPhoneDevice.update({
      where: { id: f.deviceId },
      data: { privateInputEncrypted: sealPhoneValue({ version: 1, active: true, values: [] }) },
    });
  else if (kind === 'workflow')
    await prisma.agent.update({
      where: { id: f.agentId },
      data: { temporalWorkflowId: randomUUID() },
    });
  else if (kind === 'firstRun')
    await prisma.agent.update({
      where: { id: f.agentId },
      data: { temporalFirstExecutionRunId: randomUUID() },
    });
  else
    await prisma.iPhoneLease.update({
      where: { id: f.leaseId },
      data: { releaseRequestedAt: new Date() },
    });
}
const held: Case[] = fences.map((kind) => [
  `semantic iMessage auth loss cannot cross ${kind} fence or release its original slot early`,
  async (h) => {
    const f = await prepared(h);
    h.observationResult = [
      {
        text: 'iMessage is Signed Out',
        x: 10,
        y: 20,
        w: 200,
        h: 40,
        confidence: 0.99,
        source: 'vision',
      },
    ];
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    h.authLossVerifier = async () => {
      enter();
      await wait;
      return result('signed_out');
    };
    const pending = screen(h, f);
    try {
      await within(entered);
      const active = await prisma.iPhoneOperation.findFirstOrThrow({
        where: { leaseId: f.leaseId, operation: 'screen.text' },
      });
      assert.equal(active.state, 'RUNNING');
      assert.equal(active.activeDeviceId, f.deviceId);
      const before = h.calls.length;
      const blocked = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'input.tap',
          args: { x: 1, y: 1 },
          expectedCursor: active.cursor,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        },
      });
      assert.equal(blocked.status, 409);
      assert.equal(h.calls.length, before, 'blocked mutation did not reach provider');
      await mutate(f, kind);
    } finally {
      release();
      await pending;
    }
    const state = setupState(
      (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupEncrypted
    );
    assert.notEqual(state.attempt?.reasonCode, 'observed_signed_out');
  },
]);
export const authLossCases: Case[] = [
  ...basic,
  ...(['absent', 'wrong-app'] as const).map((witness): Case => [
    `semantic iMessage auth loss does not classify with ${witness} native app witness`,
    async (h) => {
      const f =
        witness === 'absent'
          ? { ...(await freshSetup(h)), cursor: 0 }
          : await prepared(h, 'com.apple.mobilesafari');
      h.observationResult = { text: 'iMessage is Signed Out' };
      let calls = 0;
      h.authLossVerifier = async () => {
        calls++;
        return result('signed_out');
      };
      const response = await screen(h, f);
      assert.equal(response.data.operation?.status, 'SUCCEEDED');
      assert.equal(calls, 0);
      assert.notEqual(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'needs_reauth'
      );
    },
  ]),
  ...held,
  [
    'unavailable semantic auth loss leaves original read successful and asserts no auth state',
    async (h) => {
      const f = await prepared(h);
      h.observationResult = { text: 'iMessage is Signed Out' };
      let calls = 0;
      h.authLossVerifier = async () => {
        calls++;
        throw new Error('Synthetic unavailable classifier');
      };
      const response = await screen(h, f);
      assert.equal(response.data.operation?.status, 'SUCCEEDED');
      assert.equal(calls, 1);
      assert.notEqual(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'needs_reauth'
      );
    },
  ],
];
