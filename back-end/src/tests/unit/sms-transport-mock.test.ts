import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildMockAgentPhoneNumber,
  buildMockAgentPhoneSendResult,
  buildMockSurgeSendResult,
  buildMockWhatsAppSendResult,
  isLocalBenchmarkAgentPhoneMockEnabled,
  isLocalBenchmarkSmsTransportMockEnabled,
  isLocalBenchmarkWhatsAppTransportMockEnabled,
  isLiveMessagingRuntime,
  isMessagingTransportFakedAtFetchBoundary,
  markMessagingFetchFakesInstalled,
  mockAgentPhoneMessageId,
  mockSurgeMessageId,
  mockWhatsAppMessageId,
  shouldMockMessagingSend,
  transportMockArchiveContext,
} from '../../providers/smsTransportMock';

async function run() {
  const oldFakeSurge = process.env.BLACKBOX_TEST_FAKE_SURGE;
  const oldFakeAgentPhone = process.env.BLACKBOX_TEST_FAKE_AGENTPHONE;
  const oldFakeWhatsApp = process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
  const oldNodeEnv = process.env.NODE_ENV;
  const oldBenchmarkIsolatedRun = process.env.BENCHMARK_ISOLATED_RUN;

  delete process.env.BLACKBOX_TEST_FAKE_SURGE;
  delete process.env.BLACKBOX_TEST_FAKE_AGENTPHONE;
  delete process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
  assert.equal(isLocalBenchmarkSmsTransportMockEnabled(), false);
  assert.equal(isLocalBenchmarkAgentPhoneMockEnabled(), false);
  assert.equal(isLocalBenchmarkWhatsAppTransportMockEnabled(), false);

  process.env.BLACKBOX_TEST_FAKE_SURGE = '1';
  assert.equal(isLocalBenchmarkSmsTransportMockEnabled(), true);

  process.env.BLACKBOX_TEST_FAKE_AGENTPHONE = '1';
  assert.equal(isLocalBenchmarkAgentPhoneMockEnabled(), true);
  process.env.NODE_ENV = 'production';
  delete process.env.BENCHMARK_ISOLATED_RUN;
  assert.equal(
    isLocalBenchmarkAgentPhoneMockEnabled(),
    false,
    'a production backend cannot enable synthetic AgentPhone identities by flag alone'
  );
  process.env.BENCHMARK_ISOLATED_RUN = 'true';
  assert.equal(
    isLocalBenchmarkAgentPhoneMockEnabled(),
    true,
    'an explicitly isolated benchmark may use the provider mock'
  );
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
  if (oldBenchmarkIsolatedRun === undefined) delete process.env.BENCHMARK_ISOLATED_RUN;
  else process.env.BENCHMARK_ISOLATED_RUN = oldBenchmarkIsolatedRun;

  process.env.BLACKBOX_TEST_FAKE_WHATSAPP = '1';
  assert.equal(isLocalBenchmarkWhatsAppTransportMockEnabled(), true);

  const surgeId = mockSurgeMessageId('seed-a');
  assert.match(surgeId, /^msg_01[0-9a-f]{26}$/);
  assert.equal(mockSurgeMessageId('seed-a'), surgeId);

  const agentPhoneId = mockAgentPhoneMessageId('seed-b');
  assert.match(agentPhoneId, /^ap_msg_[0-9a-f]{12}$/);

  const agentPhoneNumber = buildMockAgentPhoneNumber('benchmark-user');
  assert.match(agentPhoneNumber.agentId, /^ap_agent_[0-9a-f]{12}$/);
  assert.match(agentPhoneNumber.numberId, /^ap_num_[0-9a-f]{12}$/);
  assert.match(agentPhoneNumber.phoneNumber, /^\+1555\d{7}$/);
  assert.deepEqual(buildMockAgentPhoneNumber('benchmark-user'), agentPhoneNumber);
  assert.notEqual(
    buildMockAgentPhoneNumber('other-user').phoneNumber,
    agentPhoneNumber.phoneNumber
  );

  const whatsappId = mockWhatsAppMessageId('seed-c');
  assert.match(whatsappId, /^wamid\.[0-9a-f]{16}$/);

  const mockSurge = await buildMockSurgeSendResult({
    phoneNumber: '+19729777432',
    message: 'Started: "Find coffee"',
    seed: 'bench-send',
    reason: 'benchmark_agent',
  });
  assert.equal(mockSurge.success, true);
  assert.equal(mockSurge.mocked, true);
  assert.equal(mockSurge.reason, 'benchmark_agent');
  assert.equal(mockSurge.messageSid, mockSurgeMessageId('bench-send'));

  const mockAgentPhone = buildMockAgentPhoneSendResult({
    fromNumber: '+19125550100',
    toNumber: '+19729777432',
    seed: 'agent-phone-send',
    reason: 'benchmark_agent',
  });
  assert.equal(mockAgentPhone.status, 'sent');
  assert.equal(mockAgentPhone.channel, 'sms');
  assert.equal(mockAgentPhone.id, mockAgentPhoneMessageId('agent-phone-send'));

  const mockWhatsApp = await buildMockWhatsAppSendResult({
    phoneNumber: '+19729777432',
    seed: 'whatsapp-send',
    reason: 'non_production_runtime',
  });
  assert.equal(mockWhatsApp.success, true);
  assert.equal(mockWhatsApp.reason, 'non_production_runtime');
  assert.equal(mockWhatsApp.messageSid, mockWhatsAppMessageId('whatsapp-send'));

  assert.deepEqual(transportMockArchiveContext('benchmark_agent'), {
    benchmark_transport_mock: true,
    transport_mock_reason: 'benchmark_agent',
  });
  assert.deepEqual(transportMockArchiveContext('non_production_runtime'), {
    benchmark_transport_mock: false,
    transport_mock_reason: 'non_production_runtime',
  });

  const liveRuntimeCases: Array<[string, NodeJS.ProcessEnv, boolean]> = [
    ['production', { NODE_ENV: 'production' }, true],
    ['test NODE_ENV', { NODE_ENV: 'test' }, false],
    ['unset NODE_ENV', {}, false],
    ['test capture', { NODE_ENV: 'production', BLACKBOX_TEST_CAPTURE_OUTBOUND: '1' }, false],
    ['PR preview', { NODE_ENV: 'production', IS_PULL_REQUEST: 'true' }, false],
    ['local benchmark', { NODE_ENV: 'production', BENCHMARK_MODE: 'true' }, false],
    ['isolated benchmark', { NODE_ENV: 'production', BENCHMARK_ISOLATED_RUN: 'true' }, false],
    ['run.sh non-benchmark stack', { NODE_ENV: 'production', BENCHMARK_MODE: 'false' }, true],
    ['dev opt-in', { NODE_ENV: 'test', ALLOW_LIVE_MESSAGING: '1' }, true],
    [
      'opt-in under capture',
      { BLACKBOX_TEST_CAPTURE_OUTBOUND: '1', ALLOW_LIVE_MESSAGING: '1' },
      true,
    ],
    [
      'opt-in cannot override a benchmark',
      { BENCHMARK_MODE: '1', ALLOW_LIVE_MESSAGING: '1' },
      false,
    ],
    [
      'opt-in cannot override a PR preview',
      { IS_PULL_REQUEST: 'true', ALLOW_LIVE_MESSAGING: '1' },
      false,
    ],
    ['only the exact opt-in value counts', { ALLOW_LIVE_MESSAGING: 'true' }, false],
  ];
  for (const [label, env, expected] of liveRuntimeCases) {
    assert.equal(isLiveMessagingRuntime(env), expected, `isLiveMessagingRuntime: ${label}`);
  }

  const fakedEnv = { BLACKBOX_TEST_FAKE_TWILIO: '1', BLACKBOX_TEST_FAKE_SURGE: '1' };
  assert.equal(
    isMessagingTransportFakedAtFetchBoundary('twilio-verify', fakedEnv),
    false,
    'a fake flag means nothing until fetch capture is installed'
  );
  const policyKeys = [
    'NODE_ENV',
    'ALLOW_LIVE_MESSAGING',
    'IS_PULL_REQUEST',
    'BENCHMARK_MODE',
    'BENCHMARK_ISOLATED_RUN',
    'BLACKBOX_TEST_CAPTURE_OUTBOUND',
    'BLACKBOX_TEST_FAKE_TWILIO',
    'BLACKBOX_TEST_FAKE_AGENTPHONE',
  ];
  const savedPolicyEnv = policyKeys.map((key) => [key, process.env[key]] as const);
  for (const key of policyKeys) delete process.env[key];
  process.env.NODE_ENV = 'test';
  assert.equal(await shouldMockMessagingSend('twilio-verify'), 'non_production_runtime');
  assert.equal(await shouldMockMessagingSend('surge', '   '), 'non_production_runtime');
  process.env.NODE_ENV = 'production';
  assert.equal(await shouldMockMessagingSend('twilio-verify'), null);

  markMessagingFetchFakesInstalled();
  assert.equal(isMessagingTransportFakedAtFetchBoundary('twilio-verify', fakedEnv), true);
  assert.equal(isMessagingTransportFakedAtFetchBoundary('whatsapp', fakedEnv), false);
  process.env.NODE_ENV = 'test';
  process.env.BLACKBOX_TEST_FAKE_TWILIO = '1';
  assert.equal(
    await shouldMockMessagingSend('twilio-verify'),
    null,
    'an installed fetch-boundary fake owns the request'
  );
  assert.equal(await shouldMockMessagingSend('agentphone'), 'non_production_runtime');

  for (const [key, value] of savedPolicyEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  // Shape mirrors captured supervisor provider ids (msg_01…).
  assert.equal(
    mockSurgeMessageId('fixture').slice(0, 7),
    'msg_01' + createHash('sha256').update('fixture').digest('hex').slice(0, 1)
  );

  if (oldFakeSurge === undefined) delete process.env.BLACKBOX_TEST_FAKE_SURGE;
  else process.env.BLACKBOX_TEST_FAKE_SURGE = oldFakeSurge;
  if (oldFakeAgentPhone === undefined) delete process.env.BLACKBOX_TEST_FAKE_AGENTPHONE;
  else process.env.BLACKBOX_TEST_FAKE_AGENTPHONE = oldFakeAgentPhone;
  if (oldFakeWhatsApp === undefined) delete process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
  else process.env.BLACKBOX_TEST_FAKE_WHATSAPP = oldFakeWhatsApp;
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
  if (oldBenchmarkIsolatedRun === undefined) delete process.env.BENCHMARK_ISOLATED_RUN;
  else process.env.BENCHMARK_ISOLATED_RUN = oldBenchmarkIsolatedRun;

  process.stdout.write('sms-transport-mock: 42 passed, 0 failed\n');
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
