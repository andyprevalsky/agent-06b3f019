import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  const chats = new Map<string, unknown>();
  await mock.module('../../providers/sharedState', {
    namedExports: {
      getEphemeral: async (_namespace: string, key: string) => chats.get(key),
      deleteEphemeral: async (_namespace: string, key: string) => {
        chats.delete(key);
      },
      withSerializedLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
      putEphemeral: async (_namespace: string, key: string, value: unknown) => {
        chats.set(key, value);
      },
    },
  });
  await mock.module('../../providers/benchmarkAgent', {
    namedExports: { isBenchmarkAgent: async (id: string) => id === 'benchmark' },
  });
  await mock.module('../../providers/traceArchive', {
    namedExports: { archiveJson: async () => undefined },
  });
  const { sendLinqMessage, rememberLinqChat, sendLinqReaction, startLinqTyping, isLinqEnabled } =
    await import('../../providers/linq');
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    LINQ_TOKEN: 'test-token',
    LINQ_FROM_PHONE: '+12054015445',
    SMS_PROVIDER: 'linq',
    ALLOW_LIVE_MESSAGING: '1',
  });
  let requests: Array<{ url: string; body: Record<string, unknown>; method?: string }> = [];
  let status = 200;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
      method: init?.method,
    });
    return new Response(
      JSON.stringify(
        status === 200 ? { chat_id: 'chat', message: { id: 'message' } } : { error: 'failure' }
      ),
      { status }
    );
  }) as typeof fetch;
  try {
    const first = await sendLinqMessage('+19729777432', 'Hello');
    assert.equal(first.messageSid, 'message');
    const firstMessage = requests[0].body.message as { idempotency_key: string };
    assert.match(
      firstMessage.idempotency_key,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    assert.match(requests[0].url, /\/v3\/messages$/);
    assert.deepEqual(requests[0].body, {
      to: ['+19729777432'],
      message: {
        parts: [{ type: 'text', value: 'Hello' }],
        idempotency_key: firstMessage.idempotency_key,
      },
    });
    await rememberLinqChat('+19729777432', { chatId: 'chat', service: 'iMessage' });
    await sendLinqMessage('+19729777432', 'Reply', {
      replyToMessageId: 'incoming',
      idempotencyKey: 'reply-operation',
    });
    assert.match(requests.at(-1)!.url, /\/chats\/chat\/messages$/);
    assert.deepEqual(requests.at(-1)!.body.message, {
      parts: [{ type: 'text', value: 'Reply' }],
      reply_to: { message_id: 'incoming' },
      idempotency_key: 'reply-operation',
    });
    await sendLinqReaction('incoming', '❤️');
    assert.match(requests.at(-1)!.url, /\/messages\/incoming\/reactions$/);
    assert.equal(requests.at(-1)!.body.type, 'custom');
    const stopTyping = await startLinqTyping('+19729777432');
    assert.match(requests.at(-1)!.url, /\/chats\/chat\/typing$/);
    assert.equal(requests.at(-1)!.method, 'POST');
    await stopTyping();
    assert.equal(requests.at(-1)!.method, 'DELETE');
    process.env.LINQ_RECIPIENTS = '+19729777432';
    assert.equal(isLinqEnabled('+19729777432'), true);
    assert.equal(
      isLinqEnabled('1 (972) 977-7432'),
      true,
      'legacy stored phone formats match the rollout'
    );
    assert.equal(isLinqEnabled('+15550000000'), false, 'unmigrated users retain Surge');
    delete process.env.LINQ_RECIPIENTS;
    const beforeAbort = requests.length;
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await sendLinqMessage('+19729777432', 'cancelled', { abortSignal: controller.signal }))
        .definitiveFailure,
      true
    );
    assert.equal(requests.length, beforeAbort, 'cancelled sends never reach the provider');
    status = 422;
    assert.equal((await sendLinqMessage('+19729777432', 'rejected')).definitiveFailure, true);
    status = 503;
    assert.equal((await sendLinqMessage('+19729777432', 'uncertain')).definitiveFailure, false);
    requests = [];
    await sendLinqMessage('+19729777432', 'benchmark', { archiveRootAgentId: 'benchmark' });
    assert.equal(requests.length, 0, 'benchmark agents never send live messages');
    delete process.env.ALLOW_LIVE_MESSAGING;
    process.env.NODE_ENV = 'test';
    await sendLinqMessage('+19729777432', 'local');
    await sendLinqReaction('incoming', '❤️');
    assert.equal(requests.length, 0, 'non-production never sends messages or reactions');
    process.stdout.write('linq-send: passed\n');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
