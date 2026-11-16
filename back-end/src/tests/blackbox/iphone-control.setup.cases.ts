import { setupVerifierCases } from './iphone-control.setup-verifier.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { fixture } from './auth-assistance.native-fixtures';
import type { Case } from './iphone-control.cases';
import type { Harness } from './iphone-control.fixtures';
import {
  authorizeSyntheticSetup,
  freshSetup,
  proveSettings,
  setupPost,
  type SetupDto,
  type SetupFixture,
} from './iphone-control.setup-fixtures';
import { setupAfterAttention, setupState } from '../../providers/phoneSetupState';

type Checks = Record<string, { current: boolean; status: string; observedAt?: string }>;
const KEPT = ['portrait_lock', 'apple_account', 'icloud_messages', 'imessage'];
async function checksFor(h: Harness, userId: string, taskId: string) {
  const view = await h.request(userId, `/interactions/${taskId}`);
  assert.equal(view.status, 200);
  return (view.data.setup as { verification: { checks: Checks } }).verification.checks;
}
/** Prove part of first setup, then hand the phone to `nextAgentId` on a fresh lease (prod
 * 2026-11-15 agent 1772a64a: lease 45543f2e released, 7c1dd8c6 re-acquired by the same setup
 * actor and task, and the new attempt id discarded proofs verified on the earlier lease). */
async function reacquire(h: Harness, f: SetupFixture, nextAgentId?: string, restartRun = false) {
  await proveSettings(h, f, true, true, true, false, false);
  const before = await checksFor(h, f.userId, f.taskId);
  for (const target of KEPT) assert.equal(before[target]?.current, true, target);
  await release(h, f.userId, f.leaseId);
  if (restartRun)
    await prisma.agent.update({
      where: { id: f.agentId },
      data: { temporalFirstExecutionRunId: randomUUID() },
    });
  const agentId = nextAgentId ?? f.agentId;
  const next = await h.acquire(f.userId, agentId);
  assert.equal(next.status, 'ACTIVE');
  assert.notEqual(next.id, f.leaseId);
  const taskId = nextAgentId
    ? (
        await prisma.browserSession.create({
          data: {
            contextId: (await prisma.browserSession.findUniqueOrThrow({ where: { id: f.taskId } }))
              .contextId,
            agentId,
            sessionId: randomUUID(),
          },
        })
      ).id
    : f.taskId;
  await prisma.iPhoneLease.update({ where: { id: next.id }, data: { browserTaskId: taskId } });
  return { before, taskId, leaseId: next.id };
}
async function release(h: Harness, userId: string, leaseId: string) {
  h.cleanupComplete = true;
  try {
    const released = await h.request(userId, `/leases/${leaseId}/release`, { method: 'POST' });
    assert.equal(released.status, 200);
  } finally {
    h.cleanupComplete = false;
  }
}
async function progress(h: Harness, userId: string) {
  const view = await h.request(userId, '/connection', { actor: 'user' });
  assert.equal(view.status, 200);
  const steps = (view.data.setupProgress as { steps: { key: string; status: string }[] }).steps;
  return Object.fromEntries(steps.map((step) => [step.key, step.status]));
}

export const setupCases: Case[] = [
  ...setupVerifierCases,
  [
    'same setup actor on a re-acquired lease keeps verified first-setup steps without promoting',
    async (h) => {
      const f = await freshSetup(h);
      const { before, taskId, leaseId } = await reacquire(h, f);
      const after = await checksFor(h, f.userId, taskId);
      for (const target of KEPT) {
        assert.equal(after[target]?.current, true, `New lease discarded verified ${target}`);
        assert.equal(after[target]?.status, 'confirmed', target);
        assert.equal(after[target]?.observedAt, before[target]?.observedAt, 'Re-observed');
      }
      // Never-observed steps and the bounded runtime proof are not promoted.
      assert.equal(after.gmail?.current, false);
      assert.equal(after.runtime?.current, false);
      const steps = await progress(h, f.userId);
      assert.equal(steps.portrait_lock, 'done', 'Orientation step reset on new lease');
      assert.equal(steps.apple_account, 'done', 'Apple ID step reset on new lease');
      assert.equal(steps.icloud, 'done');
      assert.notEqual(steps.gmail, 'done');
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.notEqual(device.setupState, 'ready');
      const state = setupState(device.setupEncrypted);
      assert.equal(state.attempt?.leaseId, leaseId);
      assert.equal(state.verification?.checks.apple_account?.attemptId, state.attempt?.id);
      // A later sign-out re-observes a carried proof; the setup state must stay readable.
      const view = await h.request(f.userId, `/interactions/${taskId}`);
      const lease = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: leaseId } });
      const blocked = await setupPost(
        h,
        { ...f, taskId },
        {
          action: 'block',
          reasonCode: 'observed_signed_out',
          attemptId: (view.data.setup as SetupDto).attemptId,
          expectedRevision: (view.data.setup as SetupDto).revision,
          expectedCursor: lease.actionCursor,
          requestKey: randomUUID(),
        }
      );
      assert.equal(blocked.status, 200);
      assert.equal((await h.request(f.userId, `/interactions/${taskId}`)).status, 200);
      assert.equal((await h.request(f.userId, '/connection', { actor: 'user' })).status, 200);
    },
  ],
  ...(['another agent', 'a restarted execution run'] as const).map((actor): Case => [
    `${actor} on a new lease starts first setup fresh`,
    async (h) => {
      const f = await freshSetup(h);
      const other = actor === 'another agent' ? (await h.createAgent(f.userId)).id : undefined;
      const { taskId } = await reacquire(h, f, other, actor !== 'another agent');
      const after = await checksFor(h, f.userId, taskId);
      for (const target of KEPT)
        assert.equal(after[target]?.current, false, `${actor} inherited ${target}`);
    },
  ]),
  [
    'proofs stale on the earlier lease (attention floor) must be re-verified on the new lease',
    async (h) => {
      const f = await freshSetup(h);
      await proveSettings(h, f, true, true, true, false, false);
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const floor = setupState(device.setupEncrypted).attempt!.floorCursor;
      const [clock] = await prisma.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() + interval '1 second' AS now`;
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: {
          setupEncrypted: setupAfterAttention(device.setupEncrypted, f.leaseId, floor, clock.now),
        },
      });
      const stale = await checksFor(h, f.userId, f.taskId);
      for (const target of KEPT) assert.equal(stale[target]?.current, false, target);
      await release(h, f.userId, f.leaseId);
      const next = await h.acquire(f.userId, f.agentId);
      await prisma.iPhoneLease.update({
        where: { id: next.id },
        data: { browserTaskId: f.taskId },
      });
      const after = await checksFor(h, f.userId, f.taskId);
      for (const target of KEPT)
        assert.equal(after[target]?.current, false, `New lease revived stale ${target}`);
    },
  ],
  [
    'first phone task exposes setup and journals original input as terminal preexecution rejection',
    async (h) => {
      const f = await fixture(h);
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { setupState: 'not_started', setupEncrypted: null },
      });
      await authorizeSyntheticSetup(f);
      const interaction = await h.request(f.userId, `/interactions/${f.taskId}`);
      const setup = interaction.data.setup as {
        required: boolean;
        attemptId: string;
        revision: number;
      };
      assert.ok(setup?.required && setup.attemptId, 'Active task has no durable setup requirement');
      const operationId = randomUUID(),
        before = h.calls.length;
      const send = () =>
        h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId, operation: 'input.tap', args: { x: 1, y: 2 }, expectedCursor: 0 },
        });
      const first = await send();
      assert.equal(first.status, 200);
      assert.equal(first.data.operation?.status, 'FAILED');
      assert.equal(first.data.operation?.errorCode, 'phone_setup_required');
      assert.equal(h.calls.length, before, 'Initial task input crossed setup boundary');
      assert.equal((await send()).data.operation?.status, 'FAILED');
      assert.equal(h.calls.length, before);
    },
  ],
  [
    'setup profile route is internal-only and configured identity stays out of global capability',
    async (h) => {
      const f = await fixture(h);
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { setupState: 'not_started', setupEncrypted: null },
      });
      const body = {
        expectedProfileRevision: 0,
        expectedAppleIdentity: `synthetic-${randomUUID()}@example.invalid`,
      };
      assert.equal(
        (await h.request(f.userId, '/device/setup-profile', { method: 'PUT', actor: 'user', body }))
          .status,
        403
      );
      const configured = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body,
      });
      assert.equal(configured.status, 200, 'Missing internal setup profile configuration route');
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.ok(
        !JSON.stringify(device).includes(body.expectedAppleIdentity),
        'Setup identity persisted plaintext'
      );
      assert.ok(
        !JSON.stringify((await h.request(f.userId, '/capability')).data).includes(
          body.expectedAppleIdentity
        )
      );
    },
  ],
];
