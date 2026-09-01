import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildMockAgentPhoneSendResult,
  buildMockSurgeSendResult,
  isLocalBenchmarkAgentPhoneMockEnabled,
  isLocalBenchmarkSmsTransportMockEnabled,
  mockAgentPhoneMessageId,
  mockSurgeMessageId,
} from '../../providers/smsTransportMock';

async function run() {
  const oldFakeSurge = process.env.BLACKBOX_TEST_FAKE_SURGE;
  const oldFakeAgentPhone = process.env.BLACKBOX_TEST_FAKE_AGENTPHONE;

  delete process.env.BLACKBOX_TEST_FAKE_SURGE;
  delete process.env.BLACKBOX_TEST_FAKE_AGENTPHONE;
  assert.equal(isLocalBenchmarkSmsTransportMockEnabled(), false);
  assert.equal(isLocalBenchmarkAgentPhoneMockEnabled(), false);

  process.env.BLACKBOX_TEST_FAKE_SURGE = '1';
  assert.equal(isLocalBenchmarkSmsTransportMockEnabled(), true);

  process.env.BLACKBOX_TEST_FAKE_AGENTPHONE = '1';
  assert.equal(isLocalBenchmarkAgentPhoneMockEnabled(), true);

  const surgeId = mockSurgeMessageId('seed-a');
  assert.match(surgeId, /^msg_01[0-9a-f]{26}$/);
  assert.equal(mockSurgeMessageId('seed-a'), surgeId);

  const agentPhoneId = mockAgentPhoneMessageId('seed-b');
  assert.match(agentPhoneId, /^ap_msg_[0-9a-f]{12}$/);

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

  // Shape mirrors captured supervisor provider ids (msg_01…).
  assert.equal(
    mockSurgeMessageId('fixture').slice(0, 7),
    'msg_01' + createHash('sha256').update('fixture').digest('hex').slice(0, 1)
  );

  if (oldFakeSurge === undefined) delete process.env.BLACKBOX_TEST_FAKE_SURGE;
  else process.env.BLACKBOX_TEST_FAKE_SURGE = oldFakeSurge;
  if (oldFakeAgentPhone === undefined) delete process.env.BLACKBOX_TEST_FAKE_AGENTPHONE;
  else process.env.BLACKBOX_TEST_FAKE_AGENTPHONE = oldFakeAgentPhone;

  console.log('sms-transport-mock: 8 passed, 0 failed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
