import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Every outbound SMS/WhatsApp transport must refuse to reach its provider
 * outside production. A stubbed fetch records provider calls; the production
 * row proves each sender really would have sent, so the zero-call rows are
 * not vacuous.
 */

const POLICY_KEYS = [
  'NODE_ENV',
  'ALLOW_LIVE_MESSAGING',
  'IS_PULL_REQUEST',
  'BENCHMARK_MODE',
  'BENCHMARK_ISOLATED_RUN',
  'BLACKBOX_TEST_CAPTURE_OUTBOUND',
  'BLACKBOX_TEST_FAKE_SURGE',
  'BLACKBOX_TEST_FAKE_WHATSAPP',
  'BLACKBOX_TEST_FAKE_AGENTPHONE',
  'BLACKBOX_TEST_FAKE_TWILIO',
] as const;

const PROVIDER_HOSTS = new Set([
  'api.surge.app',
  'graph.facebook.com',
  'verify.twilio.com',
  'api.agentphone.ai',
]);

// Synthetic credentials: a guard bypass reaches the stub, never a config error.
process.env.SURGE_API_KEY = 'unit-surge-key';
process.env.SURGE_ACCOUNT_ID = 'unit-surge-account';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'unit-whatsapp-number';
process.env.WHATSAPP_ACCESS_TOKEN = 'unit-whatsapp-token';
process.env.TWILIO_ACCOUNT_SID = 'ACunit';
process.env.TWILIO_AUTH_TOKEN = 'unit-twilio-token';
process.env.TWILIO_VERIFY_SERVICE_SID = 'VAunit';
process.env.AGENTPHONE_API_KEY = 'unit-agentphone-key';
delete process.env.AGENTPHONE_BASE_URL;

const providerCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (!PROVIDER_HOSTS.has(host)) {
    throw new Error(`unexpected outbound fetch in live-messaging guard test: ${host}`);
  }
  providerCalls.push(host);
  return new Response(
    JSON.stringify({
      id: 'live-provider-id',
      status: 'sent',
      channel: 'sms',
      from_number: '+19125550100',
      to_number: '+15555550199',
      conversation_id: 'conv-live',
      messages: [{ id: 'wamid.live' }],
      sid: 'VElive',
    }),
    { status: 201, headers: { 'content-type': 'application/json' } }
  );
}) as typeof fetch;

function setRuntime(env: Partial<Record<(typeof POLICY_KEYS)[number], string>>) {
  for (const key of POLICY_KEYS) delete process.env[key];
  Object.assign(process.env, env);
}

async function run() {
  const saved = Object.fromEntries(POLICY_KEYS.map((key) => [key, process.env[key]]));
  const { prisma } = await import('../../providers/database');
  const { sendSms, sendMms } = await import('../../providers/smsQueue');
  const { sendWhatsAppMessage, sendWhatsAppTemplate } =
    await import('../../providers/whatsappCloud');
  const { sendTwilioVerifyOTP } = await import('../../domains/auth/service.twilio');
  const { sendOutboundAgentPhoneMessage } = await import('../../domains/agent-phone/service');
  const { markMessagingFetchFakesInstalled } = await import('../../providers/smsTransportMock');

  const userId = `live-messaging-guard-${randomUUID()}`;
  const agentId = `live-messaging-guard-agent-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.agentIdentity.create({
    data: {
      userId,
      email: `${userId}@example.test`,
      phone: '+19125550100',
      phoneProvider: 'agentphone',
      phoneProviderAgentId: 'unit-provider-agent',
      phoneProviderNumberId: 'unit-number',
    },
  });
  await prisma.agent.create({ data: { id: agentId, userId, goal: 'live messaging guard' } });

  const to = '+15555550199';
  let sequence = 0;
  const senders: Array<{ name: string; send: () => Promise<{ success: boolean }> }> = [
    { name: 'surge sms', send: () => sendSms(to, 'guard sms') },
    {
      name: 'surge mms',
      send: () => sendMms(to, 'guard mms', 'https://example.test/card.vcf'),
    },
    { name: 'whatsapp text', send: () => sendWhatsAppMessage(to, 'guard whatsapp') },
    {
      name: 'whatsapp template',
      send: () => sendWhatsAppTemplate(to, 'onboarding_welcome', 'en_US', ['Guard']),
    },
    { name: 'twilio verify otp', send: () => sendTwilioVerifyOTP(to) },
    {
      name: 'agentphone sms',
      send: async () => {
        sequence += 1;
        const receipt = await sendOutboundAgentPhoneMessage({
          userId,
          agentId,
          idempotencyKey: `guard-${sequence}`,
          phoneNumber: to,
          message: 'guard agentphone',
        });
        return { success: receipt.success === true };
      },
    },
  ];

  async function expectProviderCalls(label: string, expected: number) {
    for (const sender of senders) {
      const before = providerCalls.length;
      const result = await sender.send();
      assert.equal(result.success, true, `${label}: ${sender.name} did not report success`);
      assert.equal(
        providerCalls.length - before,
        expected,
        `${label}: ${sender.name} made ${providerCalls.length - before} provider calls`
      );
    }
  }

  let passed = 0;
  try {
    setRuntime({ NODE_ENV: 'test' });
    await expectProviderCalls('dev runtime', 0);
    passed += 1;

    setRuntime({ NODE_ENV: 'production', BLACKBOX_TEST_CAPTURE_OUTBOUND: '1' });
    await expectProviderCalls('production build under test capture', 0);
    passed += 1;

    setRuntime({
      NODE_ENV: 'production',
      BENCHMARK_ISOLATED_RUN: 'true',
      ALLOW_LIVE_MESSAGING: '1',
    });
    await expectProviderCalls('isolated benchmark cannot opt in', 0);
    passed += 1;

    setRuntime({ NODE_ENV: 'test', BENCHMARK_MODE: 'true', ALLOW_LIVE_MESSAGING: '1' });
    await expectProviderCalls('local benchmark cannot opt in', 0);
    passed += 1;

    setRuntime({ NODE_ENV: 'production', IS_PULL_REQUEST: 'true', ALLOW_LIVE_MESSAGING: '1' });
    await expectProviderCalls('PR preview cannot opt in', 0);
    passed += 1;

    setRuntime({ NODE_ENV: 'production' });
    await expectProviderCalls('production', 1);
    passed += 1;

    setRuntime({ NODE_ENV: 'test', ALLOW_LIVE_MESSAGING: '1' });
    await expectProviderCalls('explicit dev opt-in', 1);
    passed += 1;

    setRuntime({
      NODE_ENV: 'test',
      BLACKBOX_TEST_FAKE_SURGE: '1',
      BLACKBOX_TEST_FAKE_WHATSAPP: '1',
      BLACKBOX_TEST_FAKE_AGENTPHONE: '1',
      BLACKBOX_TEST_FAKE_TWILIO: '1',
    });
    await expectProviderCalls('fake flags without installed fetch capture', 0);
    passed += 1;

    markMessagingFetchFakesInstalled();
    await expectProviderCalls('installed fetch-boundary fakes own the request', 1);
    passed += 1;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.toolSideEffect.deleteMany({
      where: { request: { path: ['user_id'], equals: userId } },
    });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.agentIdentity.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }

  process.stdout.write(`live-messaging-guard: ${passed} passed, 0 failed\n`);
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
