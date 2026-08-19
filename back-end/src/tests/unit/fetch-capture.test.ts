#!/usr/bin/env tsx

import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import { installFetchCapture, shouldBypassOutboundReplay } from '../../providers/fetchCapture';

interface CaptureResponse {
  captures: Array<{
    url: string;
    method: string;
    requestHeaders: Record<string, string>;
    requestBody: string | null;
    responseStatus: number | null;
    responseBody: string | null;
    error: string | null;
    cached: boolean;
  }>;
  nextId: number;
}

const writeLine = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const writeErrorLine = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address !== null && typeof address === 'object');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readCaptures(baseUrl: string, query = ''): Promise<CaptureResponse> {
  const response = await fetch(`${baseUrl}/captures${query}`);
  assert.strictEqual(response.status, 200);
  return (await response.json()) as CaptureResponse;
}

async function readCaptureStatus(
  baseUrl: string
): Promise<{ captureEnabled: boolean; replayEnabled: boolean }> {
  const response = await fetch(`${baseUrl}/captures/status`);
  assert.strictEqual(response.status, 200);
  return (await response.json()) as { captureEnabled: boolean; replayEnabled: boolean };
}

async function run(): Promise<void> {
  assert.strictEqual(shouldBypassOutboundReplay('https://api.e2b.app/sandboxes'), true);
  assert.strictEqual(shouldBypassOutboundReplay('https://api.onkernel.com/profiles'), true);
  assert.strictEqual(shouldBypassOutboundReplay('https://api.example.com/data'), false);
  assert.strictEqual(
    shouldBypassOutboundReplay('https://api.example.com/data?next=https://api.onkernel.com'),
    false
  );
  assert.strictEqual(
    shouldBypassOutboundReplay('https://api.onkernel.com.example.net/data'),
    false
  );
  assert.strictEqual(shouldBypassOutboundReplay('not-a-url-api.onkernel.com'), false);

  const originalFetch = globalThis.fetch;
  const oldFakeSurge = process.env.BLACKBOX_TEST_FAKE_SURGE;
  const oldReplayOutbound = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  const upstreamCalls: Array<{ url: string; bodyType: string }> = [];
  let mutableVersion = 0;
  let agentCardCalls = 0;
  process.env.BLACKBOX_TEST_FAKE_SURGE = '1';
  delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      return originalFetch(input, init);
    }
    const body = init?.body;
    upstreamCalls.push({
      url,
      bodyType: body === undefined || body === null ? 'none' : body.constructor.name,
    });
    if (url.includes('error.e2b.app')) {
      throw new Error('e2b unavailable');
    }
    if (url.includes('api.example.com/mutable')) {
      mutableVersion += 1;
      return new Response(JSON.stringify({ version: mutableVersion }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('agentcard.sh')) {
      agentCardCalls += 1;
      return new Response(JSON.stringify({ revision: agentCardCalls }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('upstream-ok', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'text/plain' },
    });
  }) as typeof fetch;

  const app = express();
  app.use('/captures', installFetchCapture());
  const { server, baseUrl } = await listen(app);

  try {
    assert.deepStrictEqual(await readCaptureStatus(baseUrl), {
      captureEnabled: true,
      replayEnabled: false,
    });

    const form = new FormData();
    form.append('file', new Blob(['audio-bytes'], { type: 'audio/wav' }), 'voice.wav');
    const multipart = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { Authorization: 'Bearer elevenlabs-secret' },
      body: form,
    });
    assert.strictEqual(multipart.status, 201);

    const e2b = await fetch('https://sandbox.e2b.app/health');
    assert.strictEqual(e2b.status, 201);

    const kernel = await fetch('https://api.onkernel.com/profiles');
    assert.strictEqual(kernel.status, 201);

    await assert.rejects(fetch('https://error.e2b.app/health'), /e2b unavailable/);

    const surge = await fetch('https://api.surge.app/accounts/acct/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer surge-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '+15555550100', body: 'hello' }),
    });
    assert.strictEqual(surge.status, 200);
    const surgeBody = (await surge.json()) as { id?: string };
    assert.strictEqual(surgeBody.id, 'blackbox-surge-message-5');

    const agentCardBody = JSON.stringify({
      method: 'tools/call',
      params: { name: 'list_transfers' },
    });
    const agentCardResponses: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch('https://api.agentcard.sh/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer agentcard-secret' },
        body: agentCardBody,
      });
      agentCardResponses.push(((await response.json()) as { revision: number }).revision);
    }
    assert.deepStrictEqual(agentCardResponses, [1, 2]);

    const all = await readCaptures(baseUrl);
    assert.strictEqual(all.captures.length, 7);
    assert.strictEqual(all.captures[0].requestBody, '[non-string body]');
    assert.strictEqual(all.captures[0].responseStatus, 201);
    assert.strictEqual(all.captures[1].url, 'https://sandbox.e2b.app/health');
    assert.strictEqual(all.captures[1].requestBody, null);
    assert.strictEqual(all.captures[2].url, 'https://api.onkernel.com/profiles');
    assert.strictEqual(all.captures[2].cached, false);
    assert.strictEqual(all.captures[3].error, 'e2b unavailable');
    assert.strictEqual(
      all.captures[4].requestHeaders.Authorization,
      'Bearer surge-sec...[redacted]'
    );
    assert.strictEqual(all.captures[4].responseBody, '{"id":"blackbox-surge-message-5"}');
    assert.strictEqual(all.captures[4].cached, false);
    assert.strictEqual(all.captures[5].cached, false);
    assert.strictEqual(all.captures[6].cached, false);
    assert.strictEqual(
      all.captures[5].requestHeaders.Authorization,
      'Bearer agentcard...[redacted]'
    );
    assert.deepStrictEqual(
      upstreamCalls.map((call) => call.bodyType),
      ['FormData', 'none', 'none', 'none', 'String', 'String']
    );

    const afterFirst = await readCaptures(baseUrl, '?after=1');
    assert.strictEqual(afterFirst.captures.length, 6);

    const cleared = await fetch(`${baseUrl}/captures`, { method: 'DELETE' });
    assert.strictEqual(cleared.status, 200);
    const afterClear = await readCaptures(baseUrl);
    assert.strictEqual(afterClear.captures.length, 0);

    const cacheClear = await fetch(`${baseUrl}/captures/cache`, { method: 'DELETE' });
    assert.strictEqual(cacheClear.status, 200);

    const mutableFirst = (await (await fetch('https://api.example.com/mutable')).json()) as {
      version: number;
    };
    const mutableSecond = (await (await fetch('https://api.example.com/mutable')).json()) as {
      version: number;
    };
    assert.deepStrictEqual([mutableFirst.version, mutableSecond.version], [1, 2]);
    assert.strictEqual(
      upstreamCalls.filter((call) => call.url === 'https://api.example.com/mutable').length,
      2
    );

    writeLine('fetch-capture passthrough/capture tests passed');
  } finally {
    await close(server);
    globalThis.fetch = originalFetch;
    if (oldFakeSurge === undefined) delete process.env.BLACKBOX_TEST_FAKE_SURGE;
    else process.env.BLACKBOX_TEST_FAKE_SURGE = oldFakeSurge;
    if (oldReplayOutbound === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = oldReplayOutbound;
  }
}

// Isolated coverage for the WhatsApp Cloud API fake (BLACKBOX_TEST_FAKE_WHATSAPP):
// a graph.facebook.com /messages POST must be short-circuited to a fake success,
// and the `__BLACKBOX_WA_UNREACHABLE__` sentinel to a 131026 deliverability error,
// so onboarding/lifecycle mirrors never make a real Meta send during blackbox runs.
async function runWhatsAppFakeTest(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldFakeWhatsApp = process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
  const oldReplayOutbound = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  let realCalls = 0;
  process.env.BLACKBOX_TEST_FAKE_WHATSAPP = '1';
  delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      return originalFetch(input, init);
    }
    realCalls += 1; // any graph.facebook.com hit here means the fake failed to short-circuit
    return new Response('should-not-be-reached', { status: 500 });
  }) as typeof fetch;

  const app = express();
  app.use('/captures', installFetchCapture());
  const { server } = await listen(app);

  try {
    const ok = await fetch('https://graph.facebook.com/v21.0/111/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer wa-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '15551234567', type: 'template' }),
    });
    assert.strictEqual(ok.status, 200, 'faked WhatsApp send returns 200');
    const okBody = (await ok.json()) as { messages?: { id: string }[] };
    assert.ok(
      okBody.messages?.[0]?.id?.startsWith('blackbox-wa-message-'),
      'fake returns a synthetic message id'
    );

    const unreachable = await fetch('https://graph.facebook.com/v21.0/111/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '15551234567', text: { body: '__BLACKBOX_WA_UNREACHABLE__' } }),
    });
    assert.strictEqual(unreachable.status, 400, 'sentinel forces a 400');
    const errBody = (await unreachable.json()) as { error?: { code?: number } };
    assert.strictEqual(
      errBody.error?.code,
      131026,
      'sentinel forces a 131026 deliverability error'
    );

    assert.strictEqual(realCalls, 0, 'never makes a real graph.facebook.com call');
    writeLine('fetch-capture WhatsApp fake tests passed');
  } finally {
    await close(server);
    globalThis.fetch = originalFetch;
    if (oldFakeWhatsApp === undefined) delete process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
    else process.env.BLACKBOX_TEST_FAKE_WHATSAPP = oldFakeWhatsApp;
    if (oldReplayOutbound === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = oldReplayOutbound;
  }
}

run()
  .then(runWhatsAppFakeTest)
  .catch((error: unknown) => {
    writeErrorLine(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
