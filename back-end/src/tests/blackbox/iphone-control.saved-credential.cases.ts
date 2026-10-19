import { googleCredentialCases } from './iphone-control.google-credential.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { useSavedPaymentFixture, encryptSavedFixture } from './iphone-control.saved-key-fixture';
import { freshSetup, observe } from './iphone-control.setup-fixtures';
import type { Case } from './iphone-control.cases';
export const savedCredentialCases: Case[] = [
  ...googleCredentialCases,
  [
    'saved credential uses owner shared store once, masks provider echo and preserves redaction',
    async (h) => {
      const f = await freshSetup(h, false);
      const restorePayment = useSavedPaymentFixture();
      const secret = `unregistered-saved-${randomUUID()}`;
      const unrelated = Array.from({ length: 33 }, (_, index) => ({
        id: randomUUID(),
        userId: f.userId,
        origin: `https://unrelated-${index}.example`,
        username: f.identity,
        encryptedPassword: encryptSavedFixture('unrelated-fixture'),
        browserSource: 'fixture',
        dateLastUsed: BigInt(Date.now()),
      }));
      await prisma.browserPassword.createMany({ data: unrelated });

      const row = await prisma.browserPassword.create({
        data: {
          userId: f.userId,
          origin: 'https://appleid.apple.com',
          username: f.identity,
          encryptedPassword: encryptSavedFixture(secret),
          browserSource: 'fixture',
          dateLastUsed: BigInt(Date.now()),
        },
      });
      try {
        let verifies = 0;
        h.echoInputResult = true;
        h.credentialVerifier = async () => {
          verifies++;
          return { allowed: true, x: 50, y: 70 };
        };
        await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'screen.bounds',
            args: {},
            setupAttemptId: f.setup.attemptId,
            setupRevision: f.setup.revision,
          },
        });
        const observation = await observe(h, f);
        const body = {
          operationId: randomUUID(),
          operation: 'credentials.fill_saved',
          args: {},
          expectedCursor: observation.cursor,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        };
        const send = () =>
          h.request(f.userId, `/leases/${f.leaseId}/operations`, { method: 'POST', body });
        const result = await send();
        assert.equal(result.data.operation?.status, 'SUCCEEDED');
        assert.deepEqual(result.data.operation?.result, {
          success: true,
          private: true,
          credentialStatus: 'filled',
        });
        assert.equal(
          h.physicalOperations.filter((op) => op.op === 'input.text' && op.kw.s === secret).length,
          1,
          'Saved password was not typed through the backend-owned shared-store flow'
        );
        assert.equal(JSON.stringify(result.data).includes(secret), false);
        const replay = await send();
        assert.equal(replay.data.operation?.status, 'SUCCEEDED');
        assert.deepEqual(replay.data.operation?.result, {
          success: true,
          private: true,
          credentialStatus: 'filled',
        });
        assert.equal(verifies, 1);
        assert.equal(h.physicalOperations.filter((op) => op.op === 'input.text').length, 1);
        h.observationResult = { text: secret };
        const next = await observe(h, f);
        const receipt = await h.request(f.userId, `/leases/${f.leaseId}/operations/${next.id}`);
        assert.equal(JSON.stringify(receipt.data).includes(secret), false);
        const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        assert.equal(JSON.stringify(device).includes(secret), false);
      } finally {
        restorePayment();
        await prisma.browserPassword.delete({ where: { id: row.id } });
        await prisma.browserPassword.deleteMany({
          where: { id: { in: unrelated.map((r) => r.id) } },
        });
      }
    },
  ],
];
for (const mode of [
  'pricing',
  'missing',
  'foreign',
  'wrong-ui',
  'stale',
  'expired',
  'start-race',
  'unknown',
] as const) {
  savedCredentialCases.push([
    `saved credential ${mode} fails closed without replay or secret echo`,
    async (h) => {
      const f = await freshSetup(h, false);
      const restorePayment = useSavedPaymentFixture();
      const secret = `private-fixture-${randomUUID()}`;
      const other = mode === 'foreign' ? await freshSetup(h, false) : null;
      const row =
        mode === 'missing'
          ? null
          : await prisma.browserPassword.create({
              data: {
                userId: other?.userId ?? f.userId,
                origin: 'https://appleid.apple.com',
                username: f.identity,
                encryptedPassword: encryptSavedFixture(secret),
                browserSource: 'fixture',
                dateLastUsed: BigInt(Date.now()),
              },
            });
      try {
        await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'screen.bounds',
            args: {},
            setupAttemptId: f.setup.attemptId,
            setupRevision: f.setup.revision,
          },
        });
        const read = await observe(h, f);
        let verifies = 0;
        h.credentialVerifier = async () => {
          verifies++;
          if (mode === 'pricing') throw new Error('phone_verifier_pricing_unavailable');
          if (mode === 'expired')
            await prisma.iPhoneOperation.updateMany({
              where: { leaseId: f.leaseId, operation: 'credentials.fill_saved' },
              data: { deadlineAt: new Date(0) },
            });
          if (mode === 'stale') {
            await prisma.agent.update({
              where: { id: f.agentId },
              data: { temporalWorkflowId: randomUUID() },
            });
            await h.request(f.userId, `/interactions/${f.taskId}`);
          }
          return { allowed: mode !== 'wrong-ui', x: 50, y: 70 };
        };
        if (mode === 'start-race')
          h.beforeSavedExecute = async () => {
            await prisma.agent.update({
              where: { id: f.agentId },
              data: { temporalWorkflowId: randomUUID() },
            });
            await h.request(f.userId, `/interactions/${f.taskId}`);
          };
        if (mode === 'unknown') h.inputMode = 'unknown';
        const body = {
          operationId: randomUUID(),
          operation: 'credentials.fill_saved',
          args: {},
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
          expectedCursor: read.cursor,
        };
        const send = () =>
          h.request(f.userId, `/leases/${f.leaseId}/operations`, { method: 'POST', body });
        const result = await send();
        assert.equal(result.data.operation?.status, mode === 'unknown' ? 'UNKNOWN' : 'FAILED');
        if (mode === 'pricing')
          assert.equal(result.data.operation?.errorCode, 'phone_credential_verifier_unavailable');
        const expected = {
          success: false,
          private: true,
          credentialStatus: mode === 'unknown' ? 'unknown' : 'unavailable',
        };
        assert.deepEqual(result.data.operation?.result, expected);
        assert.deepEqual((await send()).data.operation?.result, expected);
        assert.equal(JSON.stringify(result.data).includes(secret), false);
        assert.equal(
          (await send()).data.operation?.status,
          mode === 'unknown' ? 'UNKNOWN' : 'FAILED'
        );
        assert.equal(verifies, 1);
        assert.equal(h.physicalOperations.filter((op) => op.op === 'input.text').length, 0);
        if (mode === 'expired' || mode === 'start-race') {
          const { privacyState } = await import('../../providers/phoneInputPrivacy');
          const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
          assert.equal(
            privacyState(device.privateInputEncrypted).active,
            false,
            'Rejected start left self-created privacy phase active'
          );
        }
        if (mode === 'unknown') {
          const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
          const { privacyState } = await import('../../providers/phoneInputPrivacy');
          const privacy = privacyState(device.privateInputEncrypted);
          assert.equal(privacy.active, true);
          assert.ok(
            privacy.values.includes(secret),
            'Private vault was not committed before physical RPC'
          );
        }
      } finally {
        restorePayment();
        if (row) await prisma.browserPassword.delete({ where: { id: row.id } });
      }
    },
  ]);
}
