import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main(): Promise<void> {
  type Result = {
    success: boolean;
    messageSid?: string;
    error?: string;
    definitiveFailure?: boolean;
  };
  const accepted: Result = { success: true, messageSid: 'text-anchor' };
  let service: string | undefined = 'iMessage';
  let enabled = true;
  let cardResult: Result = { success: true, messageSid: 'card' };
  let throwCard = false;
  let textResult = accepted;
  const texts: Array<{ channel: string; text: string; media?: string }> = [];
  const cards: Array<Record<string, unknown>> = [];
  const transcripts: Array<{ text: string; sid: string }> = [];
  const attempts: string[] = [];
  const phones: string[] = [];
  const sendText = async (
    channel: string,
    _phone: string,
    text: string,
    options?: { onDeliveryAttempt?: () => void },
    media?: string
  ) => {
    attempts.push('text');
    options?.onDeliveryAttempt?.();
    texts.push({ channel, text, media });
    return textResult;
  };
  await mock.module('../../providers/logger', {
    namedExports: {
      createLogger: () => ({ info() {}, warn() {}, error() {} }),
    },
  });
  await mock.module('../../providers/smsQueue', {
    namedExports: {
      getUserPhone: async () => '+15555550100',
      sendSms: async (phone: string, text: string, options?: object) =>
        sendText('SMS', phone, text, options),
      sendMms: async (phone: string, text: string, media: string, options?: object) =>
        sendText('SMS', phone, text, options, media),
    },
  });
  await mock.module('../../providers/smsSupervisor/channelDelivery', {
    namedExports: {
      sendOnChannel: sendText,
    },
  });
  await mock.module('../../providers/linq', {
    namedExports: {
      isLinqEnabled: (phone: string) => {
        phones.push(phone);
        return enabled;
      },
      getLinqChat: async () => (service ? { chatId: 'chat', service } : undefined),
      sendLinqPayload: async (
        _phone: string,
        payload: Record<string, unknown>,
        options: {
          archiveRootAgentId?: string;
          archiveContext?: Record<string, unknown>;
          abortSignal?: AbortSignal;
        }
      ) => {
        attempts.push('card');
        assert.ok(options.abortSignal, 'card send has a bounded signal');
        cards.push(payload);
        if (throwCard) throw new Error('timeout');
        return cardResult;
      },
    },
  });
  await mock.module('../../providers/whatsappReachability', {
    namedExports: {
      markWhatsAppReachable: async () => undefined,
      markWhatsAppUnreachable: async () => undefined,
    },
  });
  await mock.module('../../providers/storage', {
    namedExports: {
      uploadToStorage: async () => ({ storage_path: 'image' }),
      getSignedUrl: async () => 'https://rose.example/receipt.png',
    },
  });
  await mock.module('../../providers/smsSupervisor/sessionStore', {
    namedExports: {
      appendLifecycleSms: async (_user: string, text: string, sid: string) => {
        transcripts.push({ text, sid });
      },
    },
  });
  await mock.module('../../providers/smsSupervisor/notificationLlm', {
    namedExports: {
      SMS_NOTIFICATION_SYSTEM_PROMPT: 'test',
      rewriteNotification: async () => {
        throw new Error('Unexpected LLM rewrite');
      },
    },
  });
  const lifecycle = await import('../../providers/smsSupervisor/outboundEvents');
  const { getAgentUrl } = await import('../../providers/smsTemplates');
  const agent = {
    id: 'agent+signed/identity',
    goal: 'Find a present',
    treeCostCents: 100,
    priceLimitCents: 100,
  };
  const url = getAgentUrl(agent.id);
  const reset = () => {
    texts.length = 0;
    cards.length = 0;
    transcripts.length = 0;
    attempts.length = 0;
  };
  const params = () =>
    (cards[0] as { experience: { params: Record<string, string> } }).experience.params;

  await lifecycle.notifyAgentStarted('user', agent);
  assert.deepEqual(attempts, ['text', 'card']);
  assert.equal(params().url, url);
  assert.equal(params().button, 'View on RoseLabs');
  assert.equal(params().title, 'Rose is working');
  assert.deepEqual(transcripts, [{ text: texts[0].text, sid: 'text-anchor' }]);
  assert.deepEqual(phones, ['+15555550100'], 'rollout allowlist must receive the actual phone');
  reset();
  await lifecycle.notifyCompletion('user', agent, 'Ordered the present', [
    { key: 'receipt', value: 'R123' },
  ]);
  assert.equal(params().title, 'Rose finished the task');
  assert.match(texts[0].text, /Receipt: R123/);
  reset();
  await lifecycle.notifyAuthAssistance('user', agent, 'Store', 'browser', 'attention');
  assert.equal(params().url, getAgentUrl(agent.id, 'browser', 'attention'));
  reset();
  const setupUrl = 'https://cards.example/setup?signed=a%2Bb&session=123';
  await lifecycle.notifyAgentCardSetup('user', agent, setupUrl);
  assert.equal(params().url, setupUrl);
  assert.ok(texts[0].text.includes(setupUrl));
  reset();
  const secondLink = 'https://example.com/result?id=2';
  await lifecycle.notifyPlannerMessage('user', agent, `Read ${setupUrl} and ${secondLink}`, true);
  assert.equal(params().url, setupUrl);
  assert.ok(texts[0].text.includes(setupUrl) && texts[0].text.includes(secondLink));
  reset();
  await lifecycle.notifyPlannerMessage('user', agent, 'Still working', false);
  assert.equal(cards.length, 0);
  reset();
  await lifecycle.notifyCostLimit('user', agent);
  assert.ok(texts[0].text.includes(url));
  assert.match(texts[0].text, /Reply with the amount/);
  assert.equal(params().url, url);
  reset();

  const paymentMetadata = {
    requestPaymentCard: {
      merchant: 'Store',
      currency: 'USD',
      lineItems: [
        {
          name: 'Present',
          quantity: 1,
          unitPriceCents: 4999,
          lineTotalCents: 4999,
          rating: 4.7,
          reviewCount: 1284,
        },
      ],
      fees: [{ label: 'Tax', amountCents: 625 }],
      subtotalCents: 4999,
      totalCents: 5624,
    },
  };
  let deliveryAttempts = 0;
  await lifecycle.notifyWriteLock(
    'user',
    agent,
    'Approve purchase?',
    'attention',
    'workflow',
    paymentMetadata,
    ['SMS'],
    () => {
      deliveryAttempts++;
    }
  );
  assert.equal(
    params().url,
    url,
    'approval card must preserve the existing authorized destination'
  );
  assert.equal(params().title, 'Payment approval needed');
  assert.equal(params().button, 'Review on RoseLabs');
  for (const text of [
    'Store',
    'Present',
    'Price: $49.99',
    'Subtotal: $49.99',
    'Tax: $6.25',
    'Total: $56.24',
    'Rating: 4.7',
    'Reviews: 1,284',
  ]) {
    assert.ok(texts[0].text.includes(text), `full financial details retained: ${text}`);
  }
  assert.equal(deliveryAttempts, 1);
  assert.doesNotMatch(JSON.stringify(cards), /agentpay|approve_card|checkout_url/);
  reset();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
  try {
    await lifecycle.notifyWriteLock('user', agent, 'Approve?', 'attention', 'workflow', {
      writeLockNotification: { media: [{ url: 'https://example.com/photo.png' }] },
    });
    assert.equal(texts[0].media, 'https://rose.example/receipt.png');
    assert.equal(cards.length, 1, 'MMS notifications also get the companion card');
  } finally {
    globalThis.fetch = originalFetch;
  }
  reset();

  for (const capability of ['RCS', 'SMS', undefined]) {
    service = capability;
    await lifecycle.notifyAgentStarted('user', agent);
    assert.equal(texts.length, 1);
    assert.equal(cards.length, capability === 'RCS' ? 1 : 0);
    if (capability === 'RCS') assert.deepEqual(cards[0], { parts: [{ type: 'link', value: url }] });
    reset();
  }
  service = 'iMessage';
  for (const result of [
    { success: false, definitiveFailure: true, error: '4005 unsupported' },
    { success: false, definitiveFailure: false, error: 'timeout' },
  ]) {
    cardResult = result;
    await lifecycle.notifyAgentStarted('user', agent);
    assert.equal(texts.length, 1, 'failed companion never resends accepted text');
    assert.equal(transcripts[0].sid, 'text-anchor');
    reset();
  }
  throwCard = true;
  await lifecycle.notifyAgentStarted('user', agent);
  assert.equal(texts.length, 1);
  reset();
  throwCard = false;
  enabled = false;
  await lifecycle.notifyAgentStarted('user', agent);
  assert.equal(cards.length, 0, 'non-rollout recipients retain normal delivery');
  reset();
  enabled = true;
  await lifecycle.notifyAgentStarted('user', agent, ['WHATSAPP']);
  assert.equal(cards.length, 0);
  assert.equal(texts[0].channel, 'WHATSAPP');
  reset();
  textResult = { success: false, definitiveFailure: false, error: 'text timeout' };
  await assert.rejects(lifecycle.notifyAgentStarted('user', agent), /text timeout/);
  assert.equal(cards.length, 0, 'failed text cannot be masked by a successful card');
  process.stdout.write(
    'PASS Linq outbound lifecycle: all notification types, payment receipt, media, capability gates, safe failures\n'
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
