/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mock } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { LinqSupervisorHandlers } from '../../domains/linq-webhook/types';

const owner = '+12025551234';
const sender = '+12025559876';
const key = Buffer.from('test-standard-webhooks-secret-32!');
const secret = `whsec_${key.toString('base64')}`;
function payload(text = 'hello') {
  return {
    event_type: 'message.received',
    event_id: 'event-1',
    webhook_version: '2026-02-03',
    data: {
      chat: { id: 'chat-1', is_group: false, owner_handle: { handle: owner, is_me: true } },
      id: 'message-1',
      direction: 'inbound',
      sender_handle: { handle: sender, is_me: false },
      parts: [{ type: 'text', value: text }],
      service: 'iMessage',
    },
  };
}
function signed(rawBody: Buffer = Buffer.from(JSON.stringify(payload()))) {
  const headers = {
    id: 'delivery-1',
    timestamp: String(Math.floor(Date.now() / 1000)),
    signature: '',
  };
  headers.signature = `v1,${createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.`).update(rawBody).digest('base64')}`;
  return { rawBody, headers };
}

async function main() {
  const claims = new Map<string, string>();
  let calls: string[] = [];
  const errors: string[] = [];
  let created = false;
  let failure = '';
  let tokenIndex = 0;
  const maybeFail = (step: string) => {
    calls.push(step);
    if (failure === step) throw new Error(`failed ${step}`);
  };
  await mock.module('../../providers/sharedState', {
    namedExports: {
      acquireLease: async (namespace: string, id: string, ttl: number) => {
        calls.push('acquire');
        assert.equal(namespace, 'linq-inbound-message');
        assert.equal(ttl, 600000);
        if (claims.has(id)) return null;
        const token = String(++tokenIndex);
        claims.set(id, token);
        return token;
      },
      releaseLease: async (_namespace: string, id: string, token: string) => {
        maybeFail('release');
        if (claims.get(id) === token) claims.delete(id);
        return true;
      },
      renewLease: async (_namespace: string, id: string, token: string, ttl: number) => {
        maybeFail('settle');
        assert.equal(ttl, 86400000);
        assert.equal(claims.get(id), token);
        return true;
      },
    },
  });
  await mock.module('../../domains/linq-webhook/repo', {
    namedExports: {
      provisionUserByPhone: async (phone: string) => {
        assert.equal(phone, sender);
        maybeFail('provision');
        return { user: { userId: 'user-1' }, created };
      },
    },
  });
  await mock.module('../../providers/linq', {
    namedExports: {
      isLinqEnabled: (phone?: string) =>
        process.env.SMS_PROVIDER === 'linq' &&
        (phone === undefined ||
          process.env.LINQ_RECIPIENTS === undefined ||
          process.env.LINQ_RECIPIENTS === phone),
      rememberLinqChat: async (phone: string, chat: unknown) => {
        assert.equal(phone, sender);
        assert.deepEqual(chat, { chatId: 'chat-1', service: 'iMessage' });
        maybeFail('remember');
      },
    },
  });
  await mock.module('../../providers/credits', {
    namedExports: {
      createSignupBonusCredit: async (id: string) => {
        assert.equal(id, 'user-1');
        maybeFail('bonus');
      },
    },
  });
  await mock.module('../../providers/logger', {
    namedExports: {
      createLogger: () => ({
        info: () => {},
        warn: () => {},
        error: (message: string) => {
          errors.push(message);
        },
      }),
    },
  });
  const { handleInboundLinq, InvalidSignatureError, InvalidPayloadError, WebhookUnavailableError } =
    await import('../../domains/linq-webhook/service');
  const { createLinqWebhookRouter } = await import('../../domains/linq-webhook/routes');
  const supervisor: LinqSupervisorHandlers = {
    routeToSupervisor: async (userId, message, start) => {
      assert.equal(userId, 'user-1');
      assert.equal(message.messageId, 'message-1');
      assert.equal(message.fromPhone, sender);
      assert.ok(Date.now() - start < 1000);
      maybeFail('route');
    },
    handleClearCommand: async (userId, phone) => {
      assert.equal(userId, 'user-1');
      assert.equal(phone, sender);
      maybeFail('clear');
    },
  };
  let count = 0;
  async function test(name: string, fn: () => Promise<void>) {
    claims.clear();
    calls = [];
    failure = '';
    created = false;
    delete process.env.LINQ_RECIPIENTS;
    Object.assign(process.env, {
      LINQ_WEBHOOK_SECRET: secret,
      LINQ_FROM_PHONE: owner,
      SMS_PROVIDER: 'linq',
    });
    await fn();
    count++;
    console.log(`PASS ${name}`);
  }
  await test('rejects unsigned, tampered, and missing-body requests before all side effects', async () => {
    await assert.rejects(
      handleInboundLinq({ rawBody: undefined, headers: signed().headers }, supervisor),
      InvalidSignatureError
    );
    const input = signed();
    input.headers.signature = 'v1,bogus';
    await assert.rejects(handleInboundLinq(input, supervisor), InvalidSignatureError);
    assert.deepEqual(calls, []);
  });
  await test('missing secret fails closed in development, test, and production', async () => {
    const previous = process.env.NODE_ENV;
    try {
      delete process.env.LINQ_WEBHOOK_SECRET;
      for (const env of ['development', 'test', 'production']) {
        process.env.NODE_ENV = env;
        await assert.rejects(handleInboundLinq(signed(), supervisor), InvalidSignatureError);
      }
      assert.deepEqual(calls, []);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  await test('disabled transport and absent active line cannot run supervisor', async () => {
    for (const provider of ['surge', 'LINQ', '']) {
      process.env.SMS_PROVIDER = provider;
      await assert.rejects(handleInboundLinq(signed(), supervisor), WebhookUnavailableError);
    }
    process.env.SMS_PROVIDER = 'linq';
    delete process.env.LINQ_FROM_PHONE;
    await assert.rejects(handleInboundLinq(signed(), supervisor), WebhookUnavailableError);
    assert.deepEqual(calls, []);
  });
  await test('authenticated malformed JSON is rejected without side effects', async () => {
    await assert.rejects(
      handleInboundLinq(signed(Buffer.from('{')), supervisor),
      InvalidPayloadError
    );
    assert.deepEqual(calls, []);
  });
  await test('signed groups, own echoes, other lines, and delivery receipts are acknowledged without writes', async () => {
    const ignored = [payload(), payload(), payload(), payload()];
    ignored[0].data.chat.is_group = true;
    ignored[1].data.direction = 'outbound';
    ignored[2].data.chat.owner_handle.handle = '+12025550000';
    ignored[3].event_type = 'message.delivered';
    for (const body of ignored)
      assert.deepEqual(
        await handleInboundLinq(signed(Buffer.from(JSON.stringify(body))), supervisor),
        { ok: true }
      );
    assert.deepEqual(calls, []);
  });
  await test('sender excluded by the Linq recipient rollout cannot provision or route', async () => {
    process.env.LINQ_RECIPIENTS = '+12025550000';
    assert.deepEqual(await handleInboundLinq(signed(), supervisor), { ok: true });
    assert.deepEqual(calls, []);
    process.env.LINQ_RECIPIENTS = sender;
    await handleInboundLinq(signed(), supervisor);
    assert.equal(calls.filter((step) => step === 'route').length, 1);
  });
  await test('signed delivery failures are surfaced without provisioning or supervisor work', async () => {
    errors.length = 0;
    const raw = Buffer.from(
      JSON.stringify({
        event_type: 'message.failed',
        data: { message_id: 'failed-id', code: 4005, reason: 'Unsupported type' },
      })
    );
    await handleInboundLinq(signed(raw), supervisor);
    assert.ok(errors.includes('Linq message delivery failed'));
    assert.deepEqual(calls, []);
  });
  await test('new phone remembers chat before provisioning, credits, and shared SMS routing', async () => {
    created = true;
    await handleInboundLinq(signed(), supervisor);
    assert.deepEqual(calls, ['acquire', 'remember', 'provision', 'bonus', 'route', 'settle']);
  });
  await test('existing phone gets no signup bonus and returns promptly after handoff', async () => {
    assert.deepEqual(await handleInboundLinq(signed(), supervisor), { ok: true });
    assert.deepEqual(calls, ['acquire', 'remember', 'provision', 'route', 'settle']);
  });
  await test('same message with a new delivery and event ID is deduplicated', async () => {
    await handleInboundLinq(signed(), supervisor);
    const body = payload();
    body.event_id = 'another-event';
    await handleInboundLinq(signed(Buffer.from(JSON.stringify(body))), supervisor);
    assert.equal(calls.filter((x) => x === 'route').length, 1);
    assert.equal(calls.filter((x) => x === 'remember').length, 1);
  });
  await test('concurrent redelivery starts one supervisor run', async () => {
    await Promise.all(Array.from({ length: 10 }, () => handleInboundLinq(signed(), supervisor)));
    assert.equal(calls.filter((x) => x === 'route').length, 1);
    assert.equal(calls.filter((x) => x === 'provision').length, 1);
  });
  await test('chat persistence, provisioning, and routing failures release reservation for retry', async () => {
    for (const step of ['remember', 'provision', 'route']) {
      claims.clear();
      calls = [];
      failure = step;
      await assert.rejects(handleInboundLinq(signed(), supervisor), new RegExp(`failed ${step}`));
      assert.equal(calls.at(-1), 'release');
      assert.equal(claims.size, 0);
      failure = '';
      await handleInboundLinq(signed(), supervisor);
      assert.equal(calls.at(-1), 'settle');
    }
  });
  await test('signup bonus failure is nonfatal and does not duplicate routing', async () => {
    created = true;
    failure = 'bonus';
    await handleInboundLinq(signed(), supervisor);
    assert.deepEqual(calls, ['acquire', 'remember', 'provision', 'bonus', 'route', 'settle']);
  });
  await test('settlement failure keeps processed reservation and does not fail webhook', async () => {
    failure = 'settle';
    await handleInboundLinq(signed(), supervisor);
    await handleInboundLinq(signed(), supervisor);
    assert.equal(calls.filter((x) => x === 'route').length, 1);
    assert.ok(!calls.includes('release'));
  });
  await test('/clear uses shared SMS teardown after remembering chat and deduplicates it', async () => {
    await handleInboundLinq(signed(Buffer.from(JSON.stringify(payload('/CLEAR')))), supervisor);
    await handleInboundLinq(signed(Buffer.from(JSON.stringify(payload('/CLEAR')))), supervisor);
    assert.deepEqual(calls, ['acquire', 'remember', 'provision', 'clear', 'settle', 'acquire']);
  });
  await test('real HTTP router authenticates raw bytes and exposes correct error statuses', async () => {
    const app = express();
    app.use('/api/linq', createLinqWebhookRouter(supervisor));
    app.use(express.json());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/linq/webhook`;
    async function post(input: ReturnType<typeof signed>, contentType = 'application/json') {
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'webhook-id': input.headers.id,
          'webhook-timestamp': input.headers.timestamp,
          'webhook-signature': input.headers.signature,
        },
        body: input.rawBody,
      });
    }
    try {
      const body = payload();
      body.event_type = 'message.read';
      const raw = Buffer.from(`  ${JSON.stringify(body, null, 2)}\n`);
      assert.equal((await post(signed(raw))).status, 200);
      const altered = signed(raw);
      altered.rawBody = Buffer.from(JSON.stringify(body));
      assert.equal((await post(altered)).status, 403);
      assert.equal((await post(signed(Buffer.from('{')))).status, 400);
      assert.equal((await post(signed(), 'text/plain')).status, 403);
      delete process.env.LINQ_WEBHOOK_SECRET;
      assert.equal((await post(signed())).status, 403);
      process.env.LINQ_WEBHOOK_SECRET = secret;
      process.env.SMS_PROVIDER = 'surge';
      assert.equal((await post(signed())).status, 503);
      assert.deepEqual(calls, []);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  console.log(`linq-webhook-service: ${count} tests passed`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
