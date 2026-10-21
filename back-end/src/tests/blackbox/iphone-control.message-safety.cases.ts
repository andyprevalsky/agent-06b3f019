import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { freshSetup, observe, verifierUsage } from './iphone-control.setup-fixtures';
import type { Case } from './iphone-control.cases';
export const messageSafetyCases: Case[] = [
  [
    'message queue identity and caller fields cannot override owned approved intent',
    async (h) => {
      const f = await freshSetup(h);
      const foreign = await freshSetup(h);
      const queue = await prisma.imessageQueue.create({
        data: {
          userId: foreign.userId,
          agentId: foreign.agentId,
          transport: 'phone_harness',
          phoneBrowserTaskId: foreign.taskId,
          phoneNumber: '+15555550123',
          message: 'Foreign message',
        },
      });
      const read = await observe(h, f);
      let verifies = 0;
      h.messageVerifier = async () => {
        verifies++;
        return { status: 'allowed', x: 50, y: 70, usage: verifierUsage };
      };
      const body = {
        operationId: randomUUID(),
        operation: 'messages.send_approved',
        args: { queueId: queue.id },
        expectedCursor: read.cursor,
        setupAttemptId: f.setup.attemptId,
        setupRevision: f.setup.revision,
      };
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: { ...body, args: { queueId: queue.id, approved: true } },
          })
        ).status,
        400
      );
      const denied = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body,
      });
      assert.notEqual(denied.data.operation?.status, 'SUCCEEDED');
      assert.equal(verifies, 0);
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 0);
    },
  ],

  ...(['generation', 'epoch', 'private', 'task', 'control'] as const).map((change): Case => [
    `held message verifier cannot dispatch after ${change} custody change`,
    async (h) => {
      const f = await freshSetup(h);
      const queue = await prisma.imessageQueue.create({
        data: {
          userId: f.userId,
          agentId: f.agentId,
          transport: 'phone_harness',
          phoneBrowserTaskId: f.taskId,
          phoneNumber: '+15555550123',
          message: 'Bound message',
        },
      });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      h.messageVerifier = async () => {
        enter();
        await held;
        return { status: 'allowed', x: 50, y: 70, usage: verifierUsage };
      };
      h.observationResult = { text: 'Draft to +15555550123 Bound message Send' };
      const read = await observe(h, f);
      const pending = h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'messages.send_approved',
          args: { queueId: queue.id },
          expectedCursor: read.cursor,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        },
      });
      await entered;
      try {
        if (change === 'control')
          await prisma.iPhoneLease.update({
            where: { id: f.leaseId },
            data: { controlOwner: 'user' },
          });
        if (change === 'generation')
          await prisma.agent.update({
            where: { id: f.agentId },
            data: { temporalWorkflowId: randomUUID() },
          });
        if (change === 'epoch')
          await prisma.iPhoneDevice.update({
            where: { id: f.deviceId },
            data: { providerEpoch: { increment: 1 } },
          });
        if (change === 'private')
          await prisma.iPhoneDevice.update({
            where: { id: f.deviceId },
            data: {
              privateInputEncrypted: sealPhoneValue({ version: 1, active: true, values: [] }),
            },
          });
        if (change === 'task') await prisma.browserSession.delete({ where: { id: f.taskId } });
      } finally {
        release();
      }
      await pending;
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 0);
      assert.equal(
        (await prisma.imessageQueue.findUniqueOrThrow({ where: { id: queue.id } })).dispatchedAt,
        null
      );
    },
  ]),
  [
    'unknown approved send is never replayed and ordinary mutation is fenced',
    async (h) => {
      const f = await freshSetup(h);
      const queue = await prisma.imessageQueue.create({
        data: {
          userId: f.userId,
          agentId: f.agentId,
          transport: 'phone_harness',
          phoneBrowserTaskId: f.taskId,
          phoneNumber: '+15555550123',
          message: 'Unknown send',
        },
      });
      h.messageVerifier = async () => ({ status: 'allowed', x: 50, y: 70, usage: verifierUsage });
      h.inputMode = 'unknown';
      const read = await observe(h, f);
      const body = {
        operationId: randomUUID(),
        operation: 'messages.send_approved',
        args: { queueId: queue.id },
        expectedCursor: read.cursor,
        setupAttemptId: f.setup.attemptId,
        setupRevision: f.setup.revision,
      };
      const send = () =>
        h.request(f.userId, `/leases/${f.leaseId}/operations`, { method: 'POST', body });
      const first = await send();
      assert.equal(first.data.operation?.status, 'UNKNOWN');
      await send();
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 1);
      const mutation = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          ...body,
          operationId: randomUUID(),
          operation: 'input.tap',
          args: { x: 50, y: 70 },
          expectedCursor: read.cursor + 1,
        },
      });
      assert.equal(mutation.status, 409);
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 1);
      assert.equal(
        (await prisma.imessageQueue.findUniqueOrThrow({ where: { id: queue.id } })).sentAt,
        null
      );
    },
  ],
];
