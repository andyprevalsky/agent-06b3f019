import { messageSafetyCases } from './iphone-control.message-safety.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { Case } from './iphone-control.cases';
import { freshSetup, observe, verifierUsage } from './iphone-control.setup-fixtures';
export const messageCases: Case[] = [
  ...messageSafetyCases,
  [
    'approved message dispatch is one physical send and sent requires fresh verification',
    async (h) => {
      h.messageVerifier = async () => ({ status: 'allowed', x: 50, y: 70, usage: verifierUsage });
      const f = await freshSetup(h);
      const queue = await prisma.imessageQueue.create({
        data: {
          userId: f.userId,
          agentId: f.agentId,
          transport: 'phone_harness',
          phoneBrowserTaskId: f.taskId,
          phoneNumber: '+15555550123',
          message: 'Synthetic approved body',
        },
      });
      try {
        h.observationResult = {
          text: 'Messages To +15555550123; draft Synthetic approved body; Send button',
        };
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
        const barrier = h.holdOperation();
        const pending = send();
        await barrier.entered;
        try {
          const dispatch = await prisma.imessageQueue.findUniqueOrThrow({
            where: { id: queue.id },
          });
          assert.ok(dispatch.dispatchedAt, 'Physical input crossed without durable dispatch');
          const operation = await prisma.iPhoneOperation.findUniqueOrThrow({
            where: { id: dispatch.phoneSendOperationId! },
          });
          assert.equal(operation.state, 'RUNNING');
          assert.equal(dispatch.sentAt, null);
        } finally {
          barrier.release();
        }
        const first = await pending;
        assert.equal(first.data.operation?.status, 'SUCCEEDED');
        const stored = await prisma.imessageQueue.findUniqueOrThrow({ where: { id: queue.id } });
        assert.ok(stored.dispatchedAt, 'Queue was not durably dispatched before input');
        assert.ok(stored.phoneSendOperationId);
        assert.equal(stored.sentAt, null, 'Submission falsely became sent');
        assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 1);
        await send();
        assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 1);
        const duplicate = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { ...body, operationId: randomUUID(), expectedCursor: read.cursor + 1 },
        });
        assert.notEqual(duplicate.data.operation?.status, 'SUCCEEDED');
        assert.equal(h.physicalOperations.filter((op) => op.op === 'input.tap').length, 1);
        const canary = `private-message-${randomUUID()}`;
        await prisma.iPhoneDevice.update({
          where: { id: f.deviceId },
          data: {
            privateInputEncrypted: sealPhoneValue({ version: 1, active: false, values: [canary] }),
          },
        });
        let status: 'unknown' | 'sent' = 'unknown';
        h.messageVerifier = async (input) => {
          assert.equal(input.mode, 'verify');
          assert.ok(!JSON.stringify(input).includes(canary));
          assert.ok(input.before.length > 0);
          assert.ok(input.after!.length > 0);
          return { status, usage: verifierUsage };
        };
        const verify = async () => {
          h.observationResult = {
            text: `Outgoing Synthetic approved body to +15555550123 ${canary}`,
          };
          const proof = await observe(h, f);
          return h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: {
              ...body,
              operationId: randomUUID(),
              operation: 'messages.verify_sent',
              expectedCursor: proof.cursor,
            },
          });
        };
        await verify();
        assert.equal(
          (await prisma.imessageQueue.findUniqueOrThrow({ where: { id: queue.id } })).sentAt,
          null,
          'Ambiguous old matching text marked sent'
        );
        status = 'sent';
        const verified = await verify();
        assert.equal(verified.data.operation?.status, 'SUCCEEDED');
        assert.ok(
          (await prisma.imessageQueue.findUniqueOrThrow({ where: { id: queue.id } })).sentAt
        );
        status = 'unknown';
        await verify();
        const final = await prisma.imessageQueue.findUniqueOrThrow({ where: { id: queue.id } });
        assert.ok(final.sentAt);
        assert.equal(final.lastError, null, 'Unknown verification downgraded sent');
      } finally {
        await prisma.imessageQueue.delete({ where: { id: queue.id } });
      }
    },
  ],
];
