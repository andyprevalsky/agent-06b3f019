import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { fixture } from './auth-assistance.native-fixtures';
import type { Harness } from './iphone-control.fixtures';
export interface SetupDto {
  required: boolean;
  state: string;
  attemptId: string;
  revision: number;
  profileRevision: number;
  expectedAccountIdentifier?: string;
  lastRequest?: { requestKey: string; status: string };
}
export const verifierUsage = {
  model: 'synthetic-setup-model',
  promptTokens: 100,
  completionTokens: 5,
  totalTokens: 105,
  totalCostCents: 1,
};
export async function freshSetup(h: Harness, configureGoogle = true) {
  const f = await fixture(h);
  await prisma.iPhoneDevice.update({
    where: { id: f.deviceId },
    data: { setupState: 'not_started', setupEncrypted: null },
  });
  const identity = `synthetic-${randomUUID()}@example.invalid`;
  assert.equal(
    (
      await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: 0,
          expectedAppleIdentity: identity,
          ...(configureGoogle ? { expectedGoogleIdentity: `google-${identity}` } : {}),
        },
      })
    ).status,
    200
  );
  const state = await h.request(f.userId, `/interactions/${f.taskId}`);
  return { ...f, identity, setup: state.data.setup as SetupDto };
}
export type SetupFixture = Awaited<ReturnType<typeof freshSetup>>;
export async function observe(h: Harness, f: SetupFixture, setup = f.setup) {
  const id = randomUUID();
  const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
    method: 'POST',
    body: {
      operationId: id,
      operation: 'screen.text',
      args: {},
      setupAttemptId: setup.attemptId,
      setupRevision: setup.revision,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.operation?.status, 'SUCCEEDED');
  return { id, cursor: (response.data.operation as unknown as { cursor: number }).cursor };
}
export function setupPost(h: Harness, f: SetupFixture, body: Record<string, unknown>) {
  return h.request(f.userId, `/interactions/${f.taskId}/setup`, { method: 'POST', body });
}

/** Prove explicit settings through the real route; caller may leave identity for its own assertions. */
export async function proveSettings(
  h: Harness,
  f: SetupFixture,
  includeIdentity = true,
  includePortrait = true,
  includeContacts = true,
  includeGmail = true,
  includePasscode = true
) {
  const prior = h.setupVerifier;
  h.setupVerifier = async () => ({
    identityConfirmed: true,
    status: 'confirmed',
    usage: verifierUsage,
  });
  try {
    for (const verificationTarget of [
      'icloud_messages',
      'icloud_keychain',
      ...(includeContacts ? ['icloud_contacts'] : []),
      'imessage',
      'receive_address',
      ...(includePortrait ? ['portrait_lock'] : []),
      ...(includePasscode ? ['device_passcode'] : []),
      ...(includeGmail ? ['gmail'] : []),
      ...(includeIdentity ? ['apple_account'] : []),
    ]) {
      h.observationResult = {
        text: `Explicit synthetic ${verificationTarget} On/enabled and signed in ${f.identity}; selected receive address ${f.phone}`,
      };
      const evidence = await observe(h, f);
      const response = await setupPost(h, f, {
        action: 'verify',
        verificationTarget,
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: evidence.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [evidence.id],
      });
      assert.equal(response.status, 200);
      f.setup = response.data.setup as SetupDto;
    }
  } finally {
    h.setupVerifier = prior;
  }
}
