import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  freshSetup,
  observe,
  setupPost,
  proveSettings,
  verifierUsage,
  type SetupDto,
} from './iphone-control.setup-fixtures';
import type { Case } from './iphone-control.cases';
export const googleExceptionCases: Case[] = [
  [
    'Google passcode exception requires trusted opt-in before any verifier call',
    async (h) => {
      const f = await freshSetup(h);
      let calls = 0;
      h.setupVerifier = async () => {
        calls++;
        return { identityConfirmed: false, status: 'confirmed', usage: verifierUsage };
      };
      const userGrant = await h.request(f.userId, '/device/setup-profile', {
        actor: 'user',
        method: 'PUT',
        body: {
          expectedProfileRevision: f.setup.profileRevision,
          expectedAppleIdentity: f.identity,
          allowGooglePasscodeException: true,
        },
      });
      assert.equal(userGrant.status, 403);
      const read = await observe(h, f);
      const reply = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'google_passcode_exception',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: read.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [read.id],
      });
      assert.equal(reply.status, 409);
      assert.equal(calls, 0);
      const state = await h.request(f.userId, `/interactions/${f.taskId}`);
      assert.equal(
        Object.hasOwn(state.data.setup as object, 'googlePasscodeExceptionAllowed'),
        false
      );
    },
  ],
  [
    'authorized Google access exception preserves passcode truth and clears on identity change',
    async (h) => {
      const f = await freshSetup(h);
      const profile = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: f.setup.profileRevision,
          expectedAppleIdentity: f.identity,
          allowGooglePasscodeException: true,
        },
      });
      assert.equal(profile.status, 200);
      f.setup = (await h.request(f.userId, `/interactions/${f.taskId}`)).data.setup as SetupDto;
      assert.equal(
        (f.setup as unknown as { googlePasscodeExceptionAllowed: boolean })
          .googlePasscodeExceptionAllowed,
        true
      );
      const omitted = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: f.setup.profileRevision,
          expectedAppleIdentity: f.identity,
        },
      });
      assert.equal(omitted.status, 200);
      f.setup = (await h.request(f.userId, `/interactions/${f.taskId}`)).data.setup as SetupDto;
      assert.equal(
        (f.setup as unknown as { googlePasscodeExceptionAllowed: boolean })
          .googlePasscodeExceptionAllowed,
        true
      );
      await proveSettings(h, f, true, true, true, true, false);
      assert.notEqual(f.setup.state, 'ready', 'Ordinary Gmail proof waived passcode');
      for (const status of ['unknown', 'confirmed', 'disabled'] as const) {
        h.setupVerifier = async (input) => {
          assert.equal(input.verificationTarget, 'google_passcode_exception');
          return { identityConfirmed: false, status, usage: verifierUsage };
        };
        const read = await observe(h, f);
        const response = await setupPost(h, f, {
          action: 'verify',
          verificationTarget: 'google_passcode_exception',
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: read.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [read.id],
        });
        assert.equal(response.status, 200);
        f.setup = response.data.setup as SetupDto;
        assert.equal(f.setup.state === 'ready', status === 'confirmed');
        const verification = (
          f.setup as unknown as {
            verification: {
              securityDisposition: string;
              checks: { device_passcode: { status: string } };
            };
          }
        ).verification;
        assert.equal(verification.checks.device_passcode.status, 'unknown');
        assert.equal(
          verification.securityDisposition,
          status === 'confirmed' ? 'authorized_google_exception' : 'blocked'
        );
      }
      const changed = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: f.setup.profileRevision,
          expectedAppleIdentity: f.identity,
          expectedGoogleIdentity: `changed-${f.identity}`,
        },
      });
      assert.equal(changed.status, 200);
      const current = await h.request(f.userId, `/interactions/${f.taskId}`);
      assert.equal(
        Object.hasOwn(current.data.setup as object, 'googlePasscodeExceptionAllowed'),
        false
      );
      assert.notEqual((current.data.setup as SetupDto).state, 'ready');
    },
  ],
  [
    'Google exception opt-in requires an existing identity and revocation fences a held verdict',
    async (h) => {
      const missing = await freshSetup(h, false);
      const absent = await h.request(missing.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: missing.setup.profileRevision,
          expectedAppleIdentity: missing.identity,
          allowGooglePasscodeException: true,
        },
      });
      assert.equal(absent.status, 409);
      const f = await freshSetup(h);
      await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: f.setup.profileRevision,
          expectedAppleIdentity: f.identity,
          allowGooglePasscodeException: true,
        },
      });
      f.setup = (await h.request(f.userId, `/interactions/${f.taskId}`)).data.setup as SetupDto;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.setupVerifier = async () => {
        entered();
        await resume;
        return { identityConfirmed: false, status: 'confirmed', usage: verifierUsage };
      };
      const read = await observe(h, f);
      const pending = setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'google_passcode_exception',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: read.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [read.id],
      });
      await ready;
      try {
        const revoked = await h.request(f.userId, '/device/setup-profile', {
          method: 'PUT',
          body: {
            expectedProfileRevision: f.setup.profileRevision,
            expectedAppleIdentity: f.identity,
            allowGooglePasscodeException: false,
          },
        });
        assert.equal(revoked.status, 200);
      } finally {
        release();
      }
      const result = await pending;
      assert.equal(result.data.operation?.status, 'FAILED');
      assert.equal(result.data.operation?.errorCode, 'phone_setup_stale');
      assert.notEqual((result.data.setup as SetupDto).state, 'ready');
      assert.equal(
        Object.hasOwn(result.data.setup as object, 'googlePasscodeExceptionAllowed'),
        false
      );
    },
  ],
];
