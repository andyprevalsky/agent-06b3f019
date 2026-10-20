import { identityBindingCases } from './iphone-control.identity-binding.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { freshSetup, observe } from './iphone-control.setup-fixtures';
import { useSavedPaymentFixture, encryptSavedFixture } from './iphone-control.saved-key-fixture';
import type { Case } from './iphone-control.cases';
export const googleCredentialCases: Case[] = [
  ...identityBindingCases,
  [
    'dual configured accounts reject saved fill when semantic realm is absent',
    async (h) => {
      const f = await freshSetup(h);
      h.credentialVerifier = async () => ({ allowed: true, x: 50, y: 70 });
      const read = await observe(h, f);
      const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
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
      assert.equal(response.data.operation?.status, 'FAILED');
      assert.equal(h.physicalOperations.filter((op) => op.op.startsWith('input.')).length, 0);
    },
  ],

  [
    'Google realm never falls back to Apple-origin credentials with same username',
    async (h) => {
      const f = await freshSetup(h);
      const restore = useSavedPaymentFixture();
      await prisma.browserPassword.create({
        data: {
          userId: f.userId,
          origin: 'https://apple.com',
          username: `google-${f.identity}`,
          encryptedPassword: encryptSavedFixture('wrong-realm-secret'),
          browserSource: 'fixture',
          dateLastUsed: BigInt(Date.now()),
        },
      });
      try {
        h.credentialVerifier = async () => ({
          allowed: true,
          credentialRealm: 'google',
          x: 50,
          y: 70,
        });
        const read = await observe(h, f);
        const result = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
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
        assert.equal(result.data.operation?.status, 'FAILED');
        assert.equal(h.physicalOperations.filter((op) => op.op.startsWith('input.')).length, 0);
      } finally {
        restore();
        await prisma.browserPassword.deleteMany({ where: { userId: f.userId } });
      }
    },
  ],

  [
    'Google saved credential selects configured Google account and realm without using Apple credentials',
    async (h) => {
      const f = await freshSetup(h);
      const google = `google-${f.identity}`;
      const secret = `google-secret-${randomUUID()}`,
        appleSecret = `apple-secret-${randomUUID()}`;
      const restore = useSavedPaymentFixture();
      await prisma.browserPassword.createMany({
        data: [
          {
            id: randomUUID(),
            userId: f.userId,
            origin: 'https://accounts.google.com',
            username: google,
            encryptedPassword: encryptSavedFixture(secret),
            browserSource: 'fixture',
            dateLastUsed: BigInt(Date.now()),
          },
          {
            id: randomUUID(),
            userId: f.userId,
            origin: 'https://apple.com',
            username: f.identity,
            encryptedPassword: encryptSavedFixture(appleSecret),
            browserSource: 'fixture',
            dateLastUsed: BigInt(Date.now()),
          },
        ],
      });
      try {
        h.echoInputResult = true;
        h.observationResult = { text: `Google Account password ${google}` };
        h.credentialVerifier = async (input) => {
          assert.equal(input.expectedGoogleIdentity, google);
          return { allowed: true, credentialRealm: 'google', x: 50, y: 70 };
        };
        const read = await observe(h, f);
        const body = {
          operationId: randomUUID(),
          operation: 'credentials.fill_saved',
          args: {},
          expectedCursor: read.cursor,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        };
        const send = () =>
          h.request(f.userId, `/leases/${f.leaseId}/operations`, { method: 'POST', body });
        const result = await send();
        assert.equal(result.data.operation?.status, 'SUCCEEDED');
        assert.equal(
          h.physicalOperations.filter((op) => op.op === 'input.text' && op.kw.s === secret).length,
          1
        );
        assert.equal(
          h.physicalOperations.filter((op) => op.op === 'input.text' && op.kw.s === appleSecret)
            .length,
          0
        );
        assert.ok(!JSON.stringify(result.data).includes(secret));
        await send();
        assert.equal(h.physicalOperations.filter((op) => op.op === 'input.text').length, 1);
      } finally {
        restore();
        await prisma.browserPassword.deleteMany({ where: { userId: f.userId } });
      }
    },
  ],
];
