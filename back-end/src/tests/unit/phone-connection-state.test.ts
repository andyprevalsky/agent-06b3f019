import { authLossObservation } from '../../providers/phoneAuthLossPrivacy';
import { nativeMessagesWitness } from '../../providers/phoneNativeAppWitness';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootstrapAuthorized,
  connectionAgentHash,
  continuationAuthorized,
  connectionAgentId,
  connectionDto,
  reserveConnection,
} from '../../providers/phoneConnectionState';
import { CONFIG_TARGETS, SETUP_REQUIREMENTS_VERSION } from '../../providers/phoneSetupVerification';
import type { SetupState } from '../../providers/phoneSetupState';

function state(): SetupState {
  return {
    version: 1,
    profileRevision: 2,
    claimRevision: 3,
    expectedAppleIdentity: 'owner@example.invalid',
    expectedGoogleIdentity: 'google@example.invalid',
    expectedPhone: '+15550000000',
  };
}
const device = { enabled: true, setupState: 'not_started', providerEpoch: 7 };
test('disabled and unconfigured expose five public fields and no identities', () => {
  const dto = connectionDto(null, null, false, false);
  assert.deepEqual(
    Object.keys(dto).sort(),
    ['configured', 'connectionRevision', 'enabled', 'setupAgentId', 'status'].sort()
  );
  assert.equal(dto.status, 'not_connected');
  assert.equal(dto.enabled, false);
  assert.equal(connectionDto(device, state(), false, false).setupAgentId, null);
});
test('claim revision CAS and identical retry reserve one owner/profile agent', () => {
  const setup = state();
  const first = reserveConnection(setup, 'owner', 'device', 3, 'request-a', false);
  assert.equal(setup.claimRevision, 4);
  assert.equal(first.reused, false);
  assert.deepEqual(
    reserveConnection(setup, 'owner', 'device', 3, 'request-a', true).reservation,
    first.reservation
  );
  assert.deepEqual(
    reserveConnection(setup, 'owner', 'device', 4, 'request-b', true).reservation,
    first.reservation
  );
  assert.equal(setup.claimRevision, 4);
  assert.throws(
    () => reserveConnection(setup, 'owner', 'device', 3, 'stale-tab', true),
    /connection changed/
  );
  assert.notEqual(connectionAgentId('foreign', 'device', 2, 4), first.reservation.agentId);
  assert.notEqual(connectionAgentId('owner', 'other-device', 2, 4), first.reservation.agentId);
});
test('missing trusted profile cannot reserve or mint configuration', () => {
  const setup = state();
  delete setup.expectedAppleIdentity;
  assert.throws(
    () => reserveConnection(setup, 'owner', 'device', 3, 'request', false),
    /configuration is unavailable/
  );
  assert.equal(setup.connection, undefined);
  assert.equal(setup.claimRevision, 3);
});
test('signout invalidation and profile changes revoke stale reservations', () => {
  const setup = state();
  reserveConnection(setup, 'owner', 'device', 3, 'first', false);
  delete setup.connection;
  setup.claimRevision++;
  assert.throws(
    () => reserveConnection(setup, 'owner', 'device', 3, 'first', false),
    /connection changed/
  );
  const next = reserveConnection(setup, 'owner', 'device', 5, 'second', false);
  assert.equal(connectionDto(device, setup, true, true).status, 'setting_up');
  setup.profileRevision++;
  assert.equal(connectionDto(device, setup, true, true).setupAgentId, null);
  assert.notEqual(
    connectionAgentId('owner', 'device', setup.profileRevision, 7),
    next.reservation.agentId
  );
});
test('ready needs current complete configuration including portrait lock', () => {
  const setup = state();
  setup.attempt = {
    id: 'attempt',
    revision: 3,
    leaseId: 'lease',
    taskId: 'task',
    agentId: 'agent',
    workflowId: 'workflow',
    firstExecutionRunId: 'run',
    floorCursor: 0,
    floorAt: new Date(0).toISOString(),
  };
  setup.verified = { at: new Date().toISOString(), profileRevision: 2 };
  const proof = {
    status: 'confirmed' as const,
    observedAt: new Date().toISOString(),
    evidenceDigest: 'd',
    requirementsVersion: SETUP_REQUIREMENTS_VERSION,
    attemptId: 'attempt',
    profileRevision: 2,
    workflowId: 'workflow',
    providerEpoch: 7,
    expectedPhone: setup.expectedPhone!,
    floorCursor: 0,
  };
  setup.verification = {
    requirementsVersion: SETUP_REQUIREMENTS_VERSION,
    checks: Object.fromEntries(CONFIG_TARGETS.map((k) => [k, { ...proof }])),
  };
  assert.equal(
    connectionDto({ ...device, setupState: 'ready' }, setup, true, false).status,
    'ready'
  );
  delete setup.verification.checks.portrait_lock;
  assert.notEqual(
    connectionDto({ ...device, setupState: 'ready' }, setup, true, false).status,
    'ready'
  );
  setup.attempt.reasonCode = 'observed_signed_out';
  assert.equal(
    connectionDto({ ...device, setupState: 'blocked' }, setup, true, false).status,
    'needs_reauth'
  );
});

test('bootstrap requires server hash and exact current owner/profile/workflow reservation', () => {
  const setup = state();
  const r = reserveConnection(setup, 'owner', 'device', 3, 'key', false).reservation;
  r.workflowId = 'workflow';
  r.firstExecutionRunId = 'run';
  const h = connectionAgentHash('owner', 'device', r);
  assert.equal(
    bootstrapAuthorized(setup, 'owner', 'device', r.agentId, h, 'workflow', 'run'),
    true
  );
  for (const [owner, deviceId, agent, hash, workflow] of [
    ['foreign', 'device', r.agentId, h, 'workflow'],
    ['owner', 'foreign', r.agentId, h, 'workflow'],
    ['owner', 'device', 'foreign', h, 'workflow'],
    ['owner', 'device', r.agentId, 'forged', 'workflow'],
    ['owner', 'device', r.agentId, h, 'stale-workflow'],
  ])
    assert.equal(bootstrapAuthorized(setup, owner, deviceId, agent, hash, workflow, 'run'), false);
  setup.profileRevision++;
  assert.equal(
    bootstrapAuthorized(setup, 'owner', 'device', r.agentId, h, 'workflow', 'run'),
    false
  );
});
test('continuation cannot admit another task or survive lease/profile/epoch/workflow revocation', () => {
  const setup = state();
  const binding = {
    leaseId: 'lease',
    taskId: 'task',
    agentId: 'agent',
    workflowId: 'workflow',
    firstExecutionRunId: 'run',
    profileRevision: 2,
    providerEpoch: 7,
  };
  setup.readinessAdmission = binding;
  setup.attempt = {
    ...binding,
    id: 'attempt',
    revision: 3,
    floorCursor: 0,
    floorAt: new Date(0).toISOString(),
  };
  const context = { ...binding, active: true };
  assert.equal(continuationAuthorized(setup, context), true);
  for (const change of [
    { leaseId: 'other' },
    { taskId: 'other' },
    { agentId: 'other' },
    { workflowId: 'other' },
    { firstExecutionRunId: 'other-run' },
    { providerEpoch: 8 },
    { active: false },
  ])
    assert.equal(continuationAuthorized(setup, { ...context, ...change }), false);
  setup.attempt.reasonCode = 'observed_signed_out';
  assert.equal(continuationAuthorized(setup, context), false);
  delete setup.attempt.reasonCode;
  setup.profileRevision++;
  assert.equal(continuationAuthorized(setup, context), false);
});

test('native app witness only routes observations and never classifies conversation text', () => {
  assert.equal(
    nativeMessagesWitness(
      'apps.launch',
      { args: { name: 'com.apple.MobileSMS', fresh: false } },
      'com.apple.MobileSMS'
    ),
    true
  );
  for (const [operation, request, result] of [
    ['apps.launch', { args: { name: 'com.apple.mobilesafari' } }, 'com.apple.MobileSMS'],
    ['apps.launch', { args: { name: 'com.apple.MobileSMS' } }, 'com.apple.mobilesafari'],
    ['apps.open', { args: { name: 'com.apple.MobileSMS' } }, 'com.apple.MobileSMS'],
    ['apps.launch', { args: { name: 'com.apple.MobileSMS' } }, { bundleid: 'com.apple.MobileSMS' }],
  ] as const)
    assert.equal(nativeMessagesWitness(operation, request, result), false);
});

test('secondary auth-loss verifier masks fresh codes and identifiers without changing primary OCR or geometry', () => {
  const primary = [
    {
      text: 'iMessage is Signed Out\nVerification code 123456 for owner@example.invalid',
      x: 123456,
      y: 20,
      w: 200,
      h: 30,
      confidence: 0.95,
      source: 'vision',
    },
  ];
  const filtered = authLossObservation(primary) as typeof primary;
  assert.ok(!filtered[0].text.includes('123456'));
  assert.ok(!filtered[0].text.includes('owner@example.invalid'));
  assert.ok(filtered[0].text.includes('iMessage is Signed Out'));
  assert.equal(filtered[0].x, 123456);
  assert.equal(filtered[0].confidence, 0.95);
  assert.ok(
    primary[0].text.includes('123456'),
    'primary code-retrieval observation remains unchanged'
  );
  const quote = authLossObservation({
    text: 'Conversation quotes "iMessage is Signed Out" and OTP 654321',
  }) as { text: string };
  assert.ok(quote.text.includes('Conversation quotes'));
  assert.ok(!quote.text.includes('654321'));
});
