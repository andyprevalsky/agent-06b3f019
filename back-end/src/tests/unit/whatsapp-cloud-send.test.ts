#!/usr/bin/env tsx
/**
 * Unit tests for sendWhatsAppMessage — the outbound Meta Cloud API send that
 * delivers Rose's WhatsApp replies. Mocks global fetch (never hits Meta) to pin
 * the request shape and the {success, messageSid, error, definitiveFailure}
 * contract the SMS supervisor's delivery loop depends on.
 */
import assert from 'node:assert';
import { sendWhatsAppMessage } from '../../providers/whatsappCloud';

type FetchArgs = { url: string; init: RequestInit };

async function withMockedFetch(
  impl: (args: FetchArgs) => Response | Promise<Response>,
  env: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<FetchArgs[]> {
  const calls: FetchArgs[] = [];
  const originalFetch = globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    originalEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const args = { url: String(input), init: init ?? {} };
    calls.push(args);
    return impl(args);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return calls;
}

const CONFIGURED = {
  WHATSAPP_PHONE_NUMBER_ID: '111222333',
  WHATSAPP_ACCESS_TOKEN: 'tok_test',
  WHATSAPP_GRAPH_API_VERSION: 'v21.0',
};

async function testSendSuccess(): Promise<void> {
  const calls = await withMockedFetch(
    () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    CONFIGURED,
    async () => {
      const result = await sendWhatsAppMessage('+15551234567', 'hello from rose');
      assert.strictEqual(result.success, true, 'success flag');
      assert.strictEqual(result.messageSid, 'wamid.ABC', 'messageSid from messages[0].id');
    }
  );
  assert.strictEqual(calls.length, 1, 'exactly one Graph API call');
  assert.ok(
    calls[0].url === 'https://graph.facebook.com/v21.0/111222333/messages',
    `endpoint uses version + phone number id, got ${calls[0].url}`
  );
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.strictEqual(body.messaging_product, 'whatsapp', 'messaging_product');
  assert.strictEqual(body.to, '15551234567', "recipient strips the leading '+'");
  assert.strictEqual(body.type, 'text', 'text message');
  assert.deepStrictEqual(body.text, { preview_url: false, body: 'hello from rose' }, 'text body');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.strictEqual(headers.Authorization, 'Bearer tok_test', 'bearer token');
}

async function testSendApiError(): Promise<void> {
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: { message: 'bad', code: 131030 } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    CONFIGURED,
    async () => {
      const result = await sendWhatsAppMessage('+15551234567', 'hi');
      assert.strictEqual(result.success, false, 'non-2xx is a failure');
      assert.strictEqual(result.definitiveFailure, true, 'API error is definitive');
      assert.ok(String(result.error).includes('400'), 'error names the status');
    }
  );
}

async function testTransientNotDefinitive(): Promise<void> {
  // 429 (throttle) and 5xx (Meta outage) are transient — NOT definitive — so the
  // supervisor's delivery loop may retry rather than drop the message.
  for (const status of [429, 500, 502, 503]) {
    await withMockedFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'x', code: 131000 } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      CONFIGURED,
      async () => {
        const result = await sendWhatsAppMessage('+15551234567', 'hi');
        assert.strictEqual(result.success, false, `status ${status} is a failure`);
        assert.notStrictEqual(
          result.definitiveFailure,
          true,
          `status ${status} must be transient, not definitive`
        );
      }
    );
  }
  // A non-429 4xx (e.g. 400 bad request) IS definitive.
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ error: { message: 'x', code: 100 } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    CONFIGURED,
    async () => {
      const result = await sendWhatsAppMessage('+15551234567', 'hi');
      assert.strictEqual(result.definitiveFailure, true, '400 is definitive');
    }
  );
}

async function testNotConfigured(): Promise<void> {
  const calls = await withMockedFetch(
    () => new Response('{}', { status: 200 }),
    { WHATSAPP_PHONE_NUMBER_ID: undefined, WHATSAPP_ACCESS_TOKEN: undefined },
    async () => {
      const result = await sendWhatsAppMessage('+15551234567', 'hi');
      assert.strictEqual(result.success, false, 'missing creds -> failure');
      assert.strictEqual(result.definitiveFailure, true, 'missing creds is definitive');
      assert.ok(String(result.error).includes('not configured'), 'names the misconfig');
    }
  );
  assert.strictEqual(calls.length, 0, 'never calls Meta when unconfigured');
}

async function testRecipientUnreachableCodes(): Promise<void> {
  // Meta deliverability codes → recipientUnreachable (stop mirroring to this number).
  for (const code of [131026, 131030, 131047, 470]) {
    await withMockedFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'x', code } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      CONFIGURED,
      async () => {
        const result = await sendWhatsAppMessage('+15551234567', 'hi');
        assert.strictEqual(result.success, false, `code ${code} is a failure`);
        assert.strictEqual(
          result.recipientUnreachable,
          true,
          `code ${code} must flag recipientUnreachable`
        );
      }
    );
  }
  // Auth/other errors are NOT a recipient-reachability signal.
  for (const code of [190, 131056, 368]) {
    await withMockedFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'x', code } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      CONFIGURED,
      async () => {
        const result = await sendWhatsAppMessage('+15551234567', 'hi');
        assert.notStrictEqual(
          result.recipientUnreachable,
          true,
          `code ${code} must NOT flag recipientUnreachable`
        );
      }
    );
  }
}

async function testNetworkThrow(): Promise<void> {
  await withMockedFetch(
    () => {
      throw new Error('ECONNRESET');
    },
    CONFIGURED,
    async () => {
      const result = await sendWhatsAppMessage('+15551234567', 'hi');
      assert.strictEqual(result.success, false, 'thrown fetch -> failure');
      assert.ok(String(result.error).includes('ECONNRESET'), 'surfaces the underlying error');
    }
  );
}

async function main(): Promise<void> {
  await testSendSuccess();
  await testSendApiError();
  await testRecipientUnreachableCodes();
  await testTransientNotDefinitive();
  await testNotConfigured();
  await testNetworkThrow();
  process.stdout.write('PASS sendWhatsAppMessage request shape + result contract\n');
}

void main();
