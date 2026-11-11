/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { canonicalPhone } from '../../providers/phoneAccountLookup';

// Execute the actual provider with isolated collaborators and a synthetic env;
// these tests never alter process.env, read credentials, or perform live I/O.
const source = readFileSync(resolve(__dirname, '../../providers/linq.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireNode = createRequire(__filename);
type Request = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: { message: Record<string, unknown>; [key: string]: unknown };
};
function fixture() {
  const env: Record<string, string | undefined> = {
    SMS_PROVIDER: 'linq',
    LINQ_FROM_PHONE: '+12054015445',
    LINQ_TOKEN: 'test-only',
  };
  const calls: Request[] = [];
  const chats = new Map<string, { chatId: string; service: string }>();
  let mockReason: string | null = null;
  let throwTransport = false;
  let status = 202;
  let response: unknown = {
    from: env.LINQ_FROM_PHONE,
    chat_id: 'chat-1',
    message: { id: 'message-1', service: 'iMessage' },
  };
  const dependencies: Record<string, unknown> = {
    './logger': { createLogger: () => ({ warn() {}, info() {} }) },
    './sharedState': {
      getEphemeral: async (_ns: string, key: string) => chats.get(key),
      putEphemeral: async (
        _ns: string,
        key: string,
        value: { chatId: string; service: string }
      ) => {
        chats.set(key, value);
      },
    },
    './smsTransportMock': { shouldMockMessagingSend: async () => mockReason },
    './traceArchive': { archiveJson: async () => {} },
    './phoneAccountLookup': { canonicalPhone },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (name: string) => (name.startsWith('node:') ? requireNode(name) : dependencies[name]),
    process: { env },
    Buffer,
    URL,
    AbortSignal,
    fetch: async (
      url: string,
      options: { method: string; headers: Record<string, string>; body?: string }
    ) => {
      calls.push({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      if (throwTransport) throw new Error('connection reset after acceptance');
      return { ok: status >= 200 && status < 300, status, json: async () => response };
    },
    setInterval,
    clearInterval,
  });
  return {
    api: exports as typeof import('../../providers/linq'),
    calls,
    chats,
    env,
    setResponse: (value: unknown, code = 202) => {
      response = value;
      status = code;
    },
    setMock: (value: string | null) => {
      mockReason = value;
    },
    setThrow: (value = true) => {
      throwTransport = value;
    },
  };
}
let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${String(error)}`);
  }
}
async function main() {
  await test('first-contact URL notification is one complete managed send without greeting', async () => {
    const f = fixture();
    const text = 'Completed your task: https://roselabs.ai/?agent-id=abc';
    assert.equal((await f.api.sendLinqMessage('+19729777432', text)).success, true);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].url, /\/v3\/messages$/);
    assert.equal(f.calls[0].body?.from, undefined);
    assert.deepEqual(f.calls[0].body?.to, ['+19729777432']);
    assert.deepEqual(f.calls[0].body?.message.parts, [{ type: 'text', value: text }]);
  });
  await test('caller operation key is in message body, retained on caller reattempts', async () => {
    const f = fixture();
    const options = { idempotencyKey: 'operation-123' };
    await f.api.sendLinqMessage('+19729777432', 'same text', options);
    await f.api.sendLinqMessage('+19729777432', 'same text', options);
    assert.equal(f.calls[0].body?.message.idempotency_key, 'operation-123');
    assert.equal(f.calls[1].body?.message.idempotency_key, 'operation-123');
  });
  await test('distinct identical sends generate distinct operation keys', async () => {
    const f = fixture();
    await f.api.sendLinqMessage('+19729777432', 'same');
    await f.api.sendLinqMessage('+19729777432', 'same');
    const keys = f.calls.map((call) => call.body?.message.idempotency_key);
    assert.equal(typeof keys[0], 'string');
    assert.notEqual(keys[0], keys[1]);
  });
  await test('documented nested creation service is cached', async () => {
    const f = fixture();
    f.setResponse({
      chat: { id: 'chat-nested', service: 'iMessage', message: { id: 'message-nested' } },
    });
    assert.equal(
      (await f.api.sendLinqMessage('+19729777432', 'hello')).messageSid,
      'message-nested'
    );
    assert.deepEqual(JSON.parse(JSON.stringify(await f.api.getLinqChat('+19729777432'))), {
      chatId: 'chat-nested',
      service: 'iMessage',
    });
  });
  await test('existing chats retain native reply and media with the supplied key', async () => {
    const f = fixture();
    await f.api.rememberLinqChat('+19729777432', { chatId: 'known-chat', service: 'iMessage' });
    const result = await f.api.sendLinqMessage('+19729777432', 'reply', {
      replyToMessageId: 'incoming',
      mediaUrl: 'https://rose.example/image.png',
      idempotencyKey: 'native-1',
    });
    assert.equal(result.success, true);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].url, /chats\/known-chat\/messages$/);
    assert.deepEqual(f.calls[0].body?.message, {
      parts: [
        { type: 'text', value: 'reply' },
        { type: 'media', url: 'https://rose.example/image.png' },
      ],
      reply_to: { message_id: 'incoming' },
      idempotency_key: 'native-1',
    });
    assert.equal(f.calls[0].headers['Idempotency-Key'], undefined);
  });
  await test('invalid caller keys fail before any transport attempt', async () => {
    for (const idempotencyKey of ['', 'a'.repeat(256)]) {
      const f = fixture();
      const result = await f.api.sendLinqMessage('+19729777432', 'reply', { idempotencyKey });
      assert.equal(result.definitiveFailure, true);
      assert.equal(f.calls.length, 0);
    }
  });
  await test('ambiguous network failure is returned without automatic resend or fallback', async () => {
    const f = fixture();
    f.setThrow();
    const result = await f.api.sendLinqMessage('+19729777432', 'reply', {
      idempotencyKey: 'operation-reset',
    });
    assert.equal(result.success, false);
    assert.equal(result.definitiveFailure, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body?.message.idempotency_key, 'operation-reset');
  });
  await test('HTTP rejection versus server failure retains definitive/ambiguous classification', async () => {
    for (const status of [400, 408, 422, 503]) {
      const f = fixture();
      f.setResponse({ error: 'failure' }, status);
      const result = await f.api.sendLinqMessage('+19729777432', 'reply');
      assert.equal(result.success, false);
      assert.equal(result.definitiveFailure, status === 400 || status === 422);
      assert.equal(f.calls.length, 1);
    }
  });
  await test('nonproduction and benchmark mocks never call network or cache', async () => {
    for (const reason of ['non_production_runtime', 'benchmark_agent']) {
      const f = fixture();
      f.setMock(reason);
      const result = await f.api.sendLinqMessage('+19729777432', 'reply');
      assert.equal(result.success, true);
      assert.equal(f.calls.length, 0);
      assert.equal(f.chats.size, 0);
    }
  });
  await test('aborted sends fail before transport; preexisting message key is preserved without mutation', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await f.api.sendLinqMessage('+19729777432', 'reply', { abortSignal: controller.signal }))
        .definitiveFailure,
      true
    );
    assert.equal(f.calls.length, 0);
    const message = { parts: [{ type: 'text', value: 'hello' }], idempotency_key: 'body-key' };
    await f.api.sendLinqPayload('+19729777432', message);
    assert.equal(f.calls[0].body?.message.idempotency_key, 'body-key');
    assert.deepEqual(message, {
      parts: [{ type: 'text', value: 'hello' }],
      idempotency_key: 'body-key',
    });
  });
  await test('stable operation key survives an ambiguous caller reattempt without auto retry', async () => {
    const f = fixture();
    f.setThrow();
    const first = await f.api.sendLinqMessage('+19729777432', 'reply', {
      idempotencyKey: 'operation-retry',
    });
    assert.equal(first.definitiveFailure, false);
    assert.equal(f.calls.length, 1);
    f.setThrow(false);
    await f.api.sendLinqMessage('+19729777432', 'reply', { idempotencyKey: 'operation-retry' });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(
      f.calls.map((call) => call.body?.message.idempotency_key),
      ['operation-retry', 'operation-retry']
    );
  });
  await test('managed response caches its real service and selected configured chat', async () => {
    const f = fixture();
    f.setResponse({
      from: '+12054015445',
      chat_id: 'managed-chat',
      service: 'RCS',
      message: { id: 'managed-message' },
    });
    assert.equal(
      (await f.api.sendLinqMessage('+19729777432', 'https://roselabs.ai')).success,
      true
    );
    assert.deepEqual(JSON.parse(JSON.stringify(await f.api.getLinqChat('+19729777432'))), {
      chatId: 'managed-chat',
      service: 'RCS',
    });
  });
  await test('accepted send on another managed line is never retried or cached as the configured line', async () => {
    const f = fixture();
    f.setResponse({
      from: '+15555550000',
      chat_id: 'other-line',
      message: { id: 'accepted-message' },
    });
    assert.equal(
      (await f.api.sendLinqMessage('+19729777432', 'https://roselabs.ai')).success,
      true
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.chats.size, 0);
  });
  console.log(`linq-send-contract: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
