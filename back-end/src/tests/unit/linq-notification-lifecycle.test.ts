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
  let textResult = accepted;
  const texts: Array<{ channel: string; text: string; media?: string }> = [];
  const transcripts: Array<{ text: string; sid: string }> = [];
  const attempts: string[] = [];
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
  let composeError: Error | null = null;
  const composed: Array<Record<string, unknown>> = [];
  await mock.module('../../providers/smsSupervisor/notificationLlm', {
    namedExports: {
      SMS_NOTIFICATION_SYSTEM_PROMPT: 'test',
      rewriteNotification: async () => {
        throw new Error('Unexpected LLM rewrite');
      },
      composeLifecycleNotification: async (input: Record<string, unknown>) => {
        composed.push(input);
        if (composeError) throw composeError;
        return input.event === 'agent_started'
          ? `On it, finding a present.\n${String(input.link)}`
          : `Done, present ordered (receipt R123).\n${String(input.link)}`;
      },
    },
  });
  const lifecycle = await import('../../providers/smsSupervisor/outboundEvents');
  const { getAgentShareUrl, getAgentUrl } = await import('../../providers/smsTemplates');
  const agent = {
    id: 'agent+signed/identity',
    goal: 'Find a present. Do not reset anything or message anyone else.',
    treeCostCents: 100,
    priceLimitCents: 100,
  };
  const url = getAgentUrl(agent.id);
  const shareUrl = getAgentShareUrl(agent.id);
  const reset = () => {
    texts.length = 0;
    transcripts.length = 0;
    attempts.length = 0;
    composed.length = 0;
  };
  const noCompanion = (label: string) =>
    assert.deepEqual(attempts, ['text'], `${label}: one text message, never a Linq card`);

  // Start: one composed sentence, the share link alone on the last line.
  await lifecycle.notifyAgentStarted('user', agent);
  noCompanion('start');
  assert.equal(texts[0].text, `On it, finding a present.\n${shareUrl}`);
  assert.equal(composed[0].event, 'agent_started');
  assert.equal(composed[0].goal, agent.goal);
  assert.deepEqual(transcripts, [{ text: texts[0].text, sid: 'text-anchor' }]);
  reset();

  // A messaging-agent kickoff keeps its own short text; nothing is composed.
  await lifecycle.notifyAgentStarted('user', { ...agent, notificationMessage: 'On it!' });
  assert.equal(texts[0].text, `On it!\n${shareUrl}`);
  assert.equal(composed.length, 0);
  reset();

  // Completion: composed from the summary and bounded result lines.
  await lifecycle.notifyCompletion('user', agent, 'Ordered the present', [
    { key: 'receipt', value: 'R123' },
    { key: 'huge_blob', value: 'x'.repeat(5000) },
  ]);
  noCompanion('completion');
  assert.equal(texts[0].text, `Done, present ordered (receipt R123).\n${shareUrl}`);
  const results = composed[0].results as string[];
  assert.ok(results.includes('Receipt: R123'));
  assert.ok(
    results.every((line) => line.length <= 200),
    'massive results are bounded before the model'
  );
  reset();

  // An accepted final answer is sent unchanged.
  await lifecycle.notifyCompletion('user', agent, 'x', undefined, ['SMS'], 'Here is the answer.');
  assert.equal(texts[0].text, 'Here is the answer.');
  assert.equal(composed.length, 0);
  reset();

  // A model outage never drops the notice: the template is sent instead.
  composeError = new Error('model down');
  await lifecycle.notifyAgentStarted('user', agent);
  assert.ok(texts[0].text.includes(shareUrl) && texts[0].text.includes('Find a present'));
  await lifecycle.notifyCompletion('user', agent, 'Ordered the present', []);
  assert.ok(texts[1].text.startsWith('I finished the task: Ordered the present'));
  composeError = null;
  reset();

  // Other notices keep their full text and deep link, still with no card.
  await lifecycle.notifyAuthAssistance('user', agent, 'Store', 'browser', 'attention');
  noCompanion('auth');
  assert.ok(texts[0].text.includes(getAgentUrl(agent.id, 'browser', 'attention')));
  reset();
  const setupUrl = 'https://cards.example/setup?signed=a%2Bb&session=123';
  await lifecycle.notifyAgentCardSetup('user', agent, setupUrl);
  noCompanion('agentcard setup');
  assert.ok(texts[0].text.includes(setupUrl));
  reset();
  const secondLink = 'https://example.com/result?id=2';
  await lifecycle.notifyPlannerMessage('user', agent, `Read ${setupUrl} and ${secondLink}`, true);
  noCompanion('planner');
  assert.ok(texts[0].text.includes(setupUrl) && texts[0].text.includes(secondLink));
  reset();
  await lifecycle.notifyCostLimit('user', agent);
  noCompanion('cost limit');
  assert.ok(texts[0].text.includes(url));
  assert.match(texts[0].text, /Reply with the amount/);
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
  noCompanion('approval');
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
  assert.ok(texts[0].text.includes(url));
  assert.equal(deliveryAttempts, 1);
  reset();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
  try {
    await lifecycle.notifyWriteLock('user', agent, 'Approve?', 'attention', 'workflow', {
      writeLockNotification: { media: [{ url: 'https://example.com/photo.png' }] },
    });
    assert.equal(texts[0].media, 'https://rose.example/receipt.png');
    noCompanion('approval with media');
  } finally {
    globalThis.fetch = originalFetch;
  }
  reset();

  await lifecycle.notifyAgentStarted('user', agent, ['WHATSAPP']);
  assert.equal(texts[0].channel, 'WHATSAPP');
  reset();
  textResult = { success: false, definitiveFailure: false, error: 'text timeout' };
  await assert.rejects(lifecycle.notifyAgentStarted('user', agent), /text timeout/);
  process.stdout.write(
    'PASS Linq outbound lifecycle: concise start/finish with trailing share link, no Linq cards, template fallback, full approval text\n'
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
