import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { configurationAfterConfirmedStop } from '../../domains/iphone/repo.setupContinuity';
import {
  configurationState,
  configurationProvenanceBound,
  sealSetup,
  setupState,
  type SetupState,
} from '../../providers/phoneSetupState';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { CONFIG_TARGETS, SETUP_REQUIREMENTS_VERSION } from '../../providers/phoneSetupVerification';
import type { IPhoneDevice, Transaction } from '../../domains/iphone/types';
import { writeSetupOutcome } from '../../domains/iphone/repo.setupOutcome';
import { setupDto } from '../../domains/iphone/repo.setup';
import { connectionDto } from '../../providers/phoneConnectionState';

const previous = {
  enabled: process.env.CLOUD_IPHONE_ENABLED,
  key: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
};
process.env.CLOUD_IPHONE_ENABLED = '1';
process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
).toString('base64');
after(() => {
  for (const [name, value] of Object.entries({
    CLOUD_IPHONE_ENABLED: previous.enabled,
    CLAUDE_CREDENTIAL_DECRYPTION_KEY: previous.key,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fixture() {
  const user = {
    userId: 'c49b4ce3-3489-499d-bfbd-846d04ba6275',
    phone: '+15550000000',
    isAnonymous: false,
  };
  const producer = {
    id: 'producer',
    temporalWorkflowId: 'producer-workflow',
    temporalFirstExecutionRunId: 'producer-first',
  };
  const consumer = {
    id: 'consumer',
    temporalWorkflowId: 'consumer-workflow',
    temporalFirstExecutionRunId: 'consumer-first',
  };
  let producerPresent = true,
    active = true;
  const attempt = {
    id: 'setup',
    revision: 2,
    leaseId: 'setup-lease',
    taskId: 'setup-task',
    agentId: producer.id,
    workflowId: producer.temporalWorkflowId,
    firstExecutionRunId: producer.temporalFirstExecutionRunId,
    floorCursor: 0,
    floorAt: '2026-11-01T00:00:00.000Z',
  };
  const state: SetupState = {
    version: 1,
    profileRevision: 1,
    claimRevision: 2,
    expectedPhone: user.phone,
    expectedAppleIdentity: 'owner@example.invalid',
    expectedGoogleIdentity: 'google@example.invalid',
    attempt,
    verified: { at: '2026-11-01T00:01:00.000Z', profileRevision: 1 },
    verification: { requirementsVersion: SETUP_REQUIREMENTS_VERSION, checks: {} },
  };
  for (const target of [...CONFIG_TARGETS, 'runtime'] as const)
    state.verification!.checks[target] = {
      status: 'confirmed',
      observedAt: '2026-11-01T00:01:00.000Z',
      evidenceDigest: 'synthetic-observation',
      requirementsVersion: SETUP_REQUIREMENTS_VERSION,
      attemptId: attempt.id,
      floorCursor: 0,
      profileRevision: 1,
      workflowId: attempt.workflowId,
      providerEpoch: 3,
      expectedPhone: user.phone,
      ...(target === 'runtime'
        ? { runtime: { sync: 'idle', activation: 'active', reason: 'unknown' } as const }
        : {}),
    };
  state.completedConfiguration = structuredClone({
    attempt,
    verified: state.verified!,
    verification: state.verification!,
  });
  state.attempt = {
    ...attempt,
    id: 'consumer-attempt',
    leaseId: 'consumer-lease',
    taskId: 'consumer-task',
    agentId: consumer.id,
    workflowId: consumer.temporalWorkflowId,
    firstExecutionRunId: consumer.temporalFirstExecutionRunId,
  };
  state.readinessAdmission = {
    leaseId: 'consumer-lease',
    taskId: 'consumer-task',
    agentId: consumer.id,
    workflowId: consumer.temporalWorkflowId,
    firstExecutionRunId: consumer.temporalFirstExecutionRunId,
    profileRevision: 1,
    providerEpoch: 3,
  };
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => user },
    agent: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; temporalWorkflowId?: string; temporalFirstExecutionRunId?: string };
      }) => {
        const row = where.id === producer.id ? (producerPresent ? producer : null) : consumer;
        if (
          row &&
          ((where.temporalWorkflowId && row.temporalWorkflowId !== where.temporalWorkflowId) ||
            (where.temporalFirstExecutionRunId &&
              row.temporalFirstExecutionRunId !== where.temporalFirstExecutionRunId))
        )
          return null;
        return row;
      },
    },
    iPhoneLease: { findFirst: async () => (active ? { id: 'consumer-lease' } : null) },
  } as unknown as Transaction;
  const device = {
    id: 'device',
    userId: user.userId,
    enabled: true,
    setupState: 'ready',
    providerEpoch: 3,
    privateInputEncrypted: null,
    setupEncrypted: '',
  } as IPhoneDevice;
  const run = () => {
    device.setupEncrypted = sealSetup(state);
    return configurationAfterConfirmedStop(tx, device);
  };
  return {
    tx,
    user,
    producer,
    consumer,
    state,
    device,
    run,
    absent: () => {
      producerPresent = false;
    },
    released: () => {
      active = false;
    },
  };
}

test('runtime-only verification keeps completed configuration and uses current borrower runtime', async () => {
  const f = fixture();
  const original = structuredClone(f.state.completedConfiguration!);
  const now = new Date();
  let written: { setupEncrypted: string; setupState: string } | undefined;
  const tx = {
    iPhoneDevice: {
      update: async ({ data }: { data: typeof written }) => {
        written = data;
      },
    },
  } as unknown as Transaction;
  await writeSetupOutcome(
    tx,
    f.device,
    f.state,
    {
      action: 'verify',
      verificationTarget: 'runtime',
      attemptId: f.state.attempt!.id,
      expectedRevision: f.state.attempt!.revision,
      expectedCursor: 0,
      requestKey: 'runtime-refresh',
    },
    { status: 'confirmed', runtime: { sync: 'idle', activation: 'active', reason: 'unknown' } },
    now,
    true,
    null,
    'runtime-observation'
  );
  assert.ok(written);
  const next = setupState(written.setupEncrypted);
  assert.deepEqual(
    next.completedConfiguration,
    original,
    'Runtime refresh rewrote configuration provenance'
  );
  const view = setupDto({ ...f.device, ...written }, next, {
    id: 'consumer-lease',
    status: 'ACTIVE',
    releaseRequestedAt: null,
    browserTaskId: 'consumer-task',
  } as Parameters<typeof setupDto>[2]);
  assert.equal(view.required, false);
  assert.equal(view.verification.operationalStatus, 'operational');
  assert.equal(view.verification.checks.runtime.current, true);
  next.verification!.checks.runtime!.workflowId = 'revoked';
  const stale = setupDto({ ...f.device, ...written }, next, {
    id: 'consumer-lease',
    status: 'ACTIVE',
    releaseRequestedAt: null,
    browserTaskId: 'consumer-task',
  } as Parameters<typeof setupDto>[2]);
  assert.equal(stale.required, false);
  assert.equal(stale.verification.operationalStatus, 'unknown');
});

test('confirmed transport stop preserves observation provenance and both execution scopes, but expires runtime', async () => {
  const f = fixture();
  const observed = structuredClone(configurationState(f.state).verification!.checks.apple_account!);
  const next = setupState(await f.run());
  assert.equal(next.attempt?.agentId, f.consumer.id);
  assert.equal(configurationState(next).attempt?.agentId, f.producer.id);
  const proof = configurationState(next).verification!.checks.apple_account!;
  assert.equal(proof.providerEpoch, 4);
  assert.equal(proof.observedProviderEpoch, 3);
  assert.equal(proof.observedAt, observed.observedAt);
  assert.equal(proof.evidenceDigest, observed.evidenceDigest);
  assert.equal(configurationState(next).verification!.checks.runtime, undefined);
  assert.equal(next.verification!.checks.runtime, undefined);
  assert.equal(next.readinessAdmission?.providerEpoch, 4);
});
test('a released consumer receives no continuing admission', async () => {
  const f = fixture();
  f.released();
  assert.equal(setupState(await f.run()).readinessAdmission, undefined);
});
test('restarted consumer cannot inherit the old admission', async () => {
  const f = fixture();
  f.consumer.temporalFirstExecutionRunId = 'replacement';
  assert.equal(setupState(await f.run()).readinessAdmission, undefined);
});
for (const kind of [
  'phone',
  'missingProvenance',
  'private',
  'signedOut',
  'profile',
  'epoch',
  'incomplete',
  'disabled',
] as const)
  test(`confirmed stop cannot promote ${kind} configuration`, async () => {
    const f = fixture();
    if (kind === 'phone') f.user.phone = '+15550000001';
    if (kind === 'missingProvenance')
      delete f.state.completedConfiguration!.attempt.firstExecutionRunId;
    if (kind === 'private')
      f.device.privateInputEncrypted = sealPhoneValue({ version: 1, active: true, values: [] });
    if (kind === 'signedOut') f.state.attempt!.reasonCode = 'observed_signed_out';
    if (kind === 'profile') f.state.profileRevision++;
    if (kind === 'epoch') f.device.providerEpoch++;
    if (kind === 'incomplete')
      f.state.completedConfiguration!.verification.checks.imessage!.status = 'unknown';
    if (kind === 'disabled') f.device.enabled = false;
    if (kind === 'missingProvenance') {
      await assert.rejects(f.run, /Phone setup state is unavailable/);
      return;
    }
    const result = await f.run();
    assert.equal(result, f.device.setupEncrypted);
  });

// These replace the proposed v4 actor-lifetime negatives. Completed configuration
// is device/account/profile state; producer execution identity is immutable provenance.
for (const change of ['workflow', 'firstRun', 'removed'] as const)
  test(`confirmed stop preserves committed configuration after producer ${change} retirement`, async () => {
    const f = fixture();
    const original = structuredClone(f.state.completedConfiguration!);
    if (change === 'workflow') f.producer.temporalWorkflowId = 'retired';
    if (change === 'firstRun') f.producer.temporalFirstExecutionRunId = 'retired';
    if (change === 'removed') f.absent();
    const after = setupState(await f.run());
    assert.deepEqual(after.completedConfiguration?.attempt, original.attempt);
    assert.deepEqual(after.completedConfiguration?.verified, original.verified);
    assert.equal(after.completedConfiguration?.verification.checks.apple_account?.providerEpoch, 4);
    assert.equal(
      after.completedConfiguration?.verification.checks.apple_account?.observedProviderEpoch,
      3
    );
    assert.equal(
      after.completedConfiguration?.verification.checks.apple_account?.observedAt,
      original.verification.checks.apple_account?.observedAt
    );
    assert.equal(after.readinessAdmission?.agentId, f.consumer.id);
  });

for (const field of [
  'id',
  'leaseId',
  'taskId',
  'agentId',
  'workflowId',
  'firstExecutionRunId',
] as const)
  test(`legacy ready configuration fails closed without ${field} provenance`, () => {
    const f = fixture();
    const legacy = configurationState(f.state);
    assert.equal(connectionDto(f.device, legacy, true, false).status, 'ready');
    delete (legacy.attempt as unknown as Record<string, unknown>)[field];
    let parsed: SetupState;
    try {
      parsed = setupState(sealSetup(legacy));
    } catch (error) {
      assert.match((error as Error).message, /Phone setup state is unavailable/);
      return;
    }
    assert.equal(configurationProvenanceBound(parsed), false);
    assert.equal(connectionDto(f.device, parsed, true, false).status, 'not_connected');
    const view = setupDto(f.device, parsed, {
      id: 'consumer-lease',
      browserTaskId: 'consumer-task',
      status: 'ACTIVE',
      releaseRequestedAt: null,
    } as Parameters<typeof setupDto>[2]);
    assert.equal(view.required, true);
  });
