import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLinqNotificationPayload, sendLinqNotificationCard } from '../../providers/linqCards';

const card = {
  url: 'https://roselabs.ai/?agent-id=agent%2Fone&attention-request-id=request%2Btwo',
  title: 'Payment approval needed',
  subtitle: 'Review the full receipt and approve in Rose.',
  button: 'Review on RoseLabs',
};

test('iMessage URL experience uses only live-discovered fields and preserves link identity', () => {
  assert.deepEqual(buildLinqNotificationPayload(card, 'iMessage'), {
    experience: { name: 'link', action: 'open', params: card },
  });
  const defaultCard = { url: card.url, title: 'Rose is working', subtitle: 'Finding flights' };
  assert.deepEqual(buildLinqNotificationPayload(defaultCard, 'imessage'), {
    experience: {
      name: 'link',
      action: 'open',
      params: { ...defaultCard, button: 'View on RoseLabs' },
    },
  });
});

test('RCS uses a solitary link part; SMS and unknown capabilities remain text', () => {
  assert.deepEqual(buildLinqNotificationPayload(card, 'RCS'), {
    parts: [{ type: 'link', value: card.url }],
  });
  for (const service of ['SMS', 'unknown', undefined]) {
    assert.equal(buildLinqNotificationPayload(card, service), undefined);
  }
});

test('bounds affect preview copy only; unsupported and oversized URLs remain text', () => {
  const payload = buildLinqNotificationPayload(
    { ...card, title: '🙂'.repeat(70), subtitle: 'x'.repeat(130), button: 'x'.repeat(30) },
    'iMessage'
  ) as { experience: { params: typeof card } };
  assert.equal(Array.from(payload.experience.params.title).length, 64);
  assert.equal(payload.experience.params.subtitle.length, 120);
  assert.equal(payload.experience.params.button.length, 24);
  assert.equal(payload.experience.params.url, card.url);
  for (const url of [
    'http://roselabs.ai',
    'javascript:alert(1)',
    'https://user:pass@roselabs.ai',
    'not a URL',
    ' https://roselabs.ai',
    `https://roselabs.ai/${'x'.repeat(2048)}`,
  ]) {
    assert.equal(buildLinqNotificationPayload({ ...card, url }, 'iMessage'), undefined);
  }
});

test('only a definitive unsupported rejection can resend text after a card attempt', async () => {
  for (const result of [
    { success: true, messageSid: 'accepted' },
    { success: false, error: 'timeout', definitiveFailure: false },
    { success: false, error: '4005 unsupported', definitiveFailure: false },
    { success: false, error: 'unauthorized', definitiveFailure: true, statusCode: 401 },
    { success: false, error: 'rate limited', definitiveFailure: true, statusCode: 429 },
  ]) {
    let fallbacks = 0;
    assert.equal(
      await sendLinqNotificationCard({
        card,
        service: 'iMessage',
        sendPayload: async () => result,
        fallback: async () => {
          fallbacks++;
          return { success: true };
        },
      }),
      result
    );
    assert.equal(fallbacks, 0);
  }
  for (const error of ['2018', '4005', 'Recipient does not support this message type']) {
    let fallbacks = 0;
    const result = await sendLinqNotificationCard({
      card,
      service: 'iMessage',
      sendPayload: async () => ({ success: false, definitiveFailure: true, error }),
      fallback: async () => {
        fallbacks++;
        return { success: true };
      },
    });
    assert.equal(result.success, true);
    assert.equal(fallbacks, 1);
  }
});

test('ineligible cards use text without a rich send, and thrown timeouts never fall back', async () => {
  let sends = 0;
  let fallbacks = 0;
  const config = {
    card,
    service: 'SMS',
    sendPayload: async () => {
      sends++;
      throw new Error('timeout');
    },
    fallback: async () => {
      fallbacks++;
      return { success: true };
    },
  };
  assert.equal((await sendLinqNotificationCard(config)).success, true);
  assert.equal(sends, 0);
  assert.equal(fallbacks, 1);
  await assert.rejects(sendLinqNotificationCard({ ...config, service: 'iMessage' }), /timeout/);
  assert.equal(fallbacks, 1);
});
