import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { Case } from './iphone-control.cases';
import { ineligiblePhoneFixtureNumber } from './phone-fixture-users';
import {
  freshSetup,
  proveSettings,
  observe,
  setupPost,
  verifierUsage,
  type SetupDto,
} from './iphone-control.setup-fixtures';
export const setupRaceCases: Case[] = [
  [
    'setup physical input rejected when generation changes during provider readiness',
    async (h) => {
      const f = await freshSetup(h);
      h.sessionState = 'provisioning';
      const barrier = h.holdReadiness();
      const body = {
        operationId: randomUUID(),
        operation: 'input.tap',
        args: { x: 12, y: 34 },
        setupAttemptId: f.setup.attemptId,
        setupRevision: f.setup.revision,
      };
      const send = () =>
        h.request(f.userId, `/leases/${f.leaseId}/operations`, { method: 'POST', body });
      const pending = send();
      await barrier.entered;
      try {
        await prisma.agent.update({
          where: { id: f.agentId },
          data: { temporalWorkflowId: randomUUID() },
        });
        const fresh = (await h.request(f.userId, `/interactions/${f.taskId}`)).data
          .setup as SetupDto;
        assert.notEqual(fresh.attemptId, f.setup.attemptId);
      } finally {
        barrier.release();
      }
      const result = await pending;
      assert.equal(
        h.physicalOperations.filter((op) => op.op === 'input.tap').length,
        0,
        'Obsolete setup command reached physical input after readiness'
      );
      assert.equal(result.data.operation?.status, 'FAILED');
      assert.equal(result.data.operation?.errorCode, 'phone_setup_stale');
      assert.equal((await send()).data.operation?.status, 'FAILED');
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: { ...body, args: { x: 11, y: 20 } },
          })
        ).status,
        409,
        'Revocation replay admitted changed input'
      );
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 0);
      assert.equal(
        (
          await prisma.iPhoneOperation.findFirstOrThrow({
            where: { leaseId: f.leaseId, requestKey: body.operationId },
          })
        ).activeDeviceId,
        null
      );
    },
  ],

  ...(['epoch', 'generation', 'task', 'private', 'phone'] as const).map((change): Case => [
    `held setup verdict cannot mark ready after ${change} changes`,
    async (h) => {
      const f = await freshSetup(h);
      const observation = await observe(h, f);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      h.setupVerifier = async () => {
        enter();
        await held;
        return { identityConfirmed: true, usage: verifierUsage };
      };
      const pending = setupPost(h, f, {
        action: 'verify',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: observation.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [observation.id],
      });
      await entered;
      try {
        if (change === 'phone')
          await prisma.user.update({
            where: { userId: f.userId },
            // Run-unique: a hardcoded number collides with an interrupted run's leftover user.
            data: { phone: ineligiblePhoneFixtureNumber() },
          });
        if (change === 'epoch')
          await prisma.iPhoneDevice.update({
            where: { id: f.deviceId },
            data: { providerEpoch: { increment: 1 } },
          });
        if (change === 'generation')
          await prisma.agent.update({
            where: { id: f.agentId },
            data: { temporalWorkflowId: randomUUID() },
          });
        if (change === 'task') await prisma.browserSession.delete({ where: { id: f.taskId } });
        if (change === 'private')
          await prisma.iPhoneDevice.update({
            where: { id: f.deviceId },
            data: {
              privateInputEncrypted: sealPhoneValue({ version: 1, active: true, values: [] }),
            },
          });
      } finally {
        release();
      }
      await pending;
      assert.notEqual(
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupState,
        'ready'
      );
      assert.equal(
        (
          await prisma.iPhoneOperation.findFirstOrThrow({
            where: { leaseId: f.leaseId, operation: 'setup.verify' },
          })
        ).state,
        'FAILED'
      );
    },
  ]),
  [
    'unconfirmed setup blocks and completed configuration remains ready across normal session cleanup',
    async (h) => {
      const f = await freshSetup(h);
      h.setupVerifier = async () => ({ identityConfirmed: false, usage: verifierUsage });
      const first = await observe(h, f);
      const submit = (setup: SetupDto, evidence: typeof first) =>
        setupPost(h, f, {
          action: 'verify',
          attemptId: setup.attemptId,
          expectedRevision: setup.revision,
          expectedCursor: evidence.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [evidence.id],
        });
      const denied = await submit(f.setup, first);
      assert.notEqual((denied.data.setup as SetupDto).state, 'ready');
      h.setupVerifier = async () => ({ identityConfirmed: true, usage: verifierUsage });
      const setup = denied.data.setup as SetupDto;
      const proof = await observe(h, f, setup);
      f.setup = (await submit(setup, proof)).data.setup as SetupDto;
      assert.equal((f.setup as SetupDto & { identityVerified: boolean }).identityVerified, true);
      await proveSettings(h, f);
      assert.equal(f.setup.state, 'ready');
      h.cleanupComplete = true;
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      const agent = await h.createAgent(f.userId);
      const lease = await h.acquire(f.userId, agent.id);
      const context = await prisma.browserContext.findUniqueOrThrow({
        where: { userId: f.userId },
      });
      const task = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: agent.id, sessionId: randomUUID() },
      });
      await prisma.iPhoneLease.update({
        where: { id: lease.id },
        data: { browserTaskId: task.id },
      });
      h.setupVerifier = async () => {
        throw new Error('Observing successor must not silently invoke verifier');
      };
      const next = (await h.request(f.userId, `/interactions/${task.id}`)).data.setup as SetupDto;
      assert.equal(next.required, false);
      assert.equal(next.state, 'ready');
      assert.equal((next as SetupDto & { identityVerified: boolean }).identityVerified, true);
      assert.equal(
        next.expectedAccountIdentifier,
        undefined,
        'Ready consumers do not need the private setup identifier'
      );
    },
  ],
];
