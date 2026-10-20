import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  freshSetup,
  observe,
  verifierUsage,
  type SetupDto,
  setupPost,
} from './iphone-control.setup-fixtures';
import { useSavedPaymentFixture, encryptSavedFixture } from './iphone-control.saved-key-fixture';
import type { Case } from './iphone-control.cases';
export const identityBindingCases: Case[] = [
  [
    'vaulted configured identifier stays publicly private but fresh internal form binding permits saved fill',
    async (h) => {
      const f = await freshSetup(h);
      const identity = `google-${f.identity}`,
        password = `private-password-${randomUUID()}`;
      const restore = useSavedPaymentFixture();
      await prisma.browserPassword.create({
        data: {
          userId: f.userId,
          origin: 'https://accounts.google.com',
          username: identity,
          encryptedPassword: encryptSavedFixture(password),
          browserSource: 'fixture',
          dateLastUsed: BigInt(Date.now()),
        },
      });
      try {
        assert.equal(
          (
            await h.request(f.userId, `/leases/${f.leaseId}/control`, {
              actor: 'user',
              method: 'POST',
              body: { mode: 'user' },
            })
          ).status,
          200
        );
        for (const s of [identity, password]) {
          const receipt = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            actor: 'user',
            method: 'POST',
            body: { operationId: randomUUID(), operation: 'input.text', args: { s } },
          });
          assert.equal(receipt.status, 200);
          assert.ok(!JSON.stringify(receipt.data).includes(s));
        }
        assert.equal(
          (
            await h.request(f.userId, `/leases/${f.leaseId}/control`, {
              actor: 'user',
              method: 'POST',
              body: { mode: 'agent' },
            })
          ).status,
          200
        );
        h.observationResult = {
          text: `Google Account password form ${identity}; incidental private echo ${password}`,
        };
        const read = await observe(h, f);
        const publicRead = await h.request(f.userId, `/leases/${f.leaseId}/operations/${read.id}`);
        assert.ok(!JSON.stringify(publicRead.data).includes(identity));
        assert.ok(!JSON.stringify(publicRead.data).includes(password));
        h.credentialVerifier = async (input) => {
          assert.ok(
            JSON.stringify(input.evidence).includes(identity),
            'Configured identifier lost before internal form binding'
          );
          assert.ok(
            !JSON.stringify(input.evidence).includes(password),
            'Password exposed to form verifier'
          );
          return { allowed: true, credentialRealm: 'google', x: 50, y: 70 };
        };
        const filled = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'credentials.fill_saved',
            args: {},
            expectedCursor: read.cursor,
            setupAttemptId: f.setup.attemptId,
            setupRevision: f.setup.revision,
          },
        });
        assert.equal(filled.data.operation?.status, 'SUCCEEDED');
        assert.ok(!JSON.stringify(filled.data).includes(password));
        const ocr = await observe(h, f);
        let calls = 0;
        h.setupVerifier = async (input) => {
          calls++;
          assert.ok(
            JSON.stringify(input.evidence).includes(identity),
            'Configured identifier lost before internal setup verifier'
          );
          assert.ok(!JSON.stringify(input.evidence).includes(password));
          return { identityConfirmed: false, status: 'confirmed', usage: verifierUsage };
        };
        const verified = await setupPost(h, f, {
          action: 'verify',
          verificationTarget: 'gmail',
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: ocr.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [ocr.id],
        });
        assert.equal(verified.status, 200);
        assert.equal(calls, 1);
        assert.equal((verified.data.setup as SetupDto).state, 'in_progress');
        f.setup = verified.data.setup as SetupDto;
        const appleRead = await observe(h, f);
        let unrelatedIdentityObserved = false;
        h.setupVerifier = async (input) => {
          unrelatedIdentityObserved = JSON.stringify(input.evidence).includes(identity);
          assert.ok(!JSON.stringify(input.evidence).includes(password));
          return { identityConfirmed: true, usage: verifierUsage };
        };
        const appleVerified = await setupPost(h, f, {
          action: 'verify',
          verificationTarget: 'apple_account',
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: appleRead.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [appleRead.id],
        });
        assert.equal(appleVerified.status, 200);
        assert.equal(
          unrelatedIdentityObserved,
          false,
          'Non-Gmail verifier received the privately entered Google identifier'
        );
      } finally {
        restore();
        await prisma.browserPassword.deleteMany({ where: { userId: f.userId } });
      }
    },
  ],
];
