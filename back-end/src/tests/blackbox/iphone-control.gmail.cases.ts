import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import {
  freshSetup,
  authorizeSyntheticSetup,
  observe,
  setupPost,
  proveSettings,
  verifierUsage,
  type SetupDto,
} from './iphone-control.setup-fixtures';
import type { Case } from './iphone-control.cases';
export const gmailCases: Case[] = [
  [
    'Gmail verification without configured Google identity rejects before semantic work',
    async (h) => {
      const f = await freshSetup(h, false);
      let calls = 0;
      h.setupVerifier = async () => {
        calls++;
        return { identityConfirmed: true, status: 'confirmed', usage: verifierUsage };
      };
      const read = await observe(h, f);
      const result = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'gmail',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: read.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [read.id],
      });
      assert.equal(result.status, 409);
      assert.equal(calls, 0);
    },
  ],

  [
    'Gmail startup uses separately configured Google identity and requires installed signed-in account proof',
    async (h) => {
      const f = await freshSetup(h);
      const google = `google-${randomUUID()}@example.invalid`;
      const configured = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: f.setup.profileRevision,
          expectedAppleIdentity: f.identity,
          expectedGoogleIdentity: google,
        },
      });
      assert.equal(configured.status, 200);
      await authorizeSyntheticSetup(f);
      f.setup = (await h.request(f.userId, `/interactions/${f.taskId}`)).data.setup as SetupDto;
      assert.equal(
        (f.setup as SetupDto & { expectedGoogleAccountIdentifier: string })
          .expectedGoogleAccountIdentifier,
        google
      );
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.ok(!JSON.stringify(device).includes(google));
      assert.equal(
        openPhoneValue<{ expectedGoogleIdentity: string }>(device.setupEncrypted!)
          .expectedGoogleIdentity,
        google
      );
      assert.ok(!JSON.stringify((await h.request(f.userId, '/capability')).data).includes(google));
      await proveSettings(h, f, true, true, true, false);
      assert.notEqual(f.setup.state, 'ready', 'OthersevenchecksnotGmailproof');
      let status: 'confirmed' | 'disabled' | 'unknown' = 'unknown';
      h.setupVerifier = async (input) => {
        assert.equal(input.expectedGoogleIdentity, google);
        assert.equal(input.expectedAppleIdentity, f.identity);
        return { identityConfirmed: false, status, usage: verifierUsage };
      };
      const submit = async () => {
        const read = await observe(h, f);
        const result = await setupPost(h, f, {
          action: 'verify',
          verificationTarget: 'gmail',
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: read.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [read.id],
        });
        assert.equal(result.status, 200);
        f.setup = result.data.setup as SetupDto;
      };
      h.observationResult = { text: 'Gmail installed. Sign in' };
      await submit();
      assert.notEqual(f.setup.state, 'ready');
      status = 'confirmed';
      h.observationResult = { text: `Gmail account menu signed in ${google}` };
      await submit();
      assert.equal(f.setup.state, 'ready');
      assert.equal(
        (f.setup as SetupDto & { verification: { checks: { gmail: { status: string } } } })
          .verification.checks.gmail.status,
        'confirmed'
      );
      status = 'disabled';
      h.observationResult = { text: 'Gmail signed in wrong@example.invalid' };
      await submit();
      assert.notEqual(f.setup.state, 'ready');
      h.cleanupComplete = true;
      assert.equal(
        (await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' })).status,
        200
      );
      const inactive = (await h.request(f.userId, `/interactions/${f.taskId}`)).data.setup;
      assert.equal(
        Object.hasOwn(inactive ?? {}, 'expectedGoogleAccountIdentifier'),
        false,
        'Inactive setup DTO exposed configured Google identifier'
      );
    },
  ],
];
