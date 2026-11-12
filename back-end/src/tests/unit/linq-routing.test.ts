import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  const migrated = '+19729777432';
  const linqCalls: Array<{ phone: string; message: string; options?: Record<string, unknown> }> =
    [];
  await mock.module('../../providers/database', { namedExports: { prisma: {} } });
  await mock.module('../../providers/linq', {
    namedExports: {
      isLinqEnabled: (phone: string) => phone === migrated,
      sendLinqMessage: async (
        phone: string,
        message: string,
        options?: Record<string, unknown>
      ) => {
        linqCalls.push({ phone, message, options });
        return { success: true, messageSid: 'linq-id' };
      },
    },
  });
  const { sendSms, sendMms } = await import('../../providers/smsQueue');
  const { sendOnChannel } = await import('../../providers/smsSupervisor/channelDelivery');
  const originalFetch = globalThis.fetch;
  let surgeCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    assert.match(String(url), /^https:\/\/api\.surge\.app\//);
    surgeCalls++;
    return new Response(JSON.stringify({ id: 'surge-id' }));
  }) as typeof fetch;
  Object.assign(process.env, {
    ALLOW_LIVE_MESSAGING: '1',
    SURGE_API_KEY: 'fixture',
    SURGE_ACCOUNT_ID: 'fixture',
  });
  try {
    assert.equal((await sendSms(migrated, 'Hello')).messageSid, 'linq-id');
    assert.equal(
      (await sendMms(migrated, 'Receipt', 'https://rose.example/receipt.png')).messageSid,
      'linq-id'
    );
    assert.equal(linqCalls[1].options?.mediaUrl, 'https://rose.example/receipt.png');
    await sendOnChannel('SMS', migrated, 'Reply', {
      replyToMessageId: 'c7b3b2ba-6681-4900-9aa6-b9a0a3f8bb39',
      quotedMessage: { role: 'user', content: 'Question' },
    });
    assert.equal(linqCalls[2].message, 'Reply', 'native threading does not prepend an SMS quote');
    assert.equal(linqCalls[2].options?.replyToMessageId, 'c7b3b2ba-6681-4900-9aa6-b9a0a3f8bb39');
    await sendOnChannel('SMS', migrated, 'Legacy reply', {
      replyToMessageId: 'msg_old_surge',
      quotedMessage: { role: 'user', content: 'Old question' },
    });
    assert.match(linqCalls[3].message, /Replying to your message:/);
    assert.equal(linqCalls[3].options?.replyToMessageId, undefined);
    assert.equal((await sendSms('+15555550100', 'Legacy')).messageSid, 'surge-id');
    assert.equal(surgeCalls, 1, 'only unmigrated recipients use Surge');
    process.stdout.write('linq-routing: passed\n');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
