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
  mockAgentPhoneMessageId,
  mockSurgeMessageId,
  mockWhatsAppMessageId,
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
  });
  assert.equal(mockSurge.success, true);
  assert.equal(mockSurge.mocked, true);
  assert.equal(mockSurge.reason, 'benchmark_transport_mock');
  assert.equal(mockSurge.messageSid, mockSurgeMessageId('bench-send'));

  const mockAgentPhone = buildMockAgentPhoneSendResult({
    fromNumber: '+19125550100',
    toNumber: '+19729777432',
    seed: 'agent-phone-send',
  });
  assert.equal(mockAgentPhone.status, 'sent');
  assert.equal(mockAgentPhone.channel, 'sms');
  assert.equal(mockAgentPhone.id, mockAgentPhoneMessageId('agent-phone-send'));

  const mockWhatsApp = await buildMockWhatsAppSendResult({
    phoneNumber: '+19729777432',
    seed: 'whatsapp-send',
  });
  assert.equal(mockWhatsApp.success, true);
  assert.equal(mockWhatsApp.messageSid, mockWhatsAppMessageId('whatsapp-send'));

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

  process.stdout.write('sms-transport-mock: 18 passed, 0 failed\n');
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
