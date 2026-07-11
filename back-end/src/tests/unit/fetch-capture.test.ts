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

async function run(): Promise<void> {
  assert.strictEqual(shouldBypassOutboundReplay('https://api.e2b.app/sandboxes'), true);
  assert.strictEqual(shouldBypassOutboundReplay('https://api.onkernel.com/profiles'), true);
  assert.strictEqual(shouldBypassOutboundReplay('https://api.example.com/data'), false);

  const originalFetch = globalThis.fetch;
  const oldFakeSurge = process.env.BLACKBOX_TEST_FAKE_SURGE;
  const upstreamCalls: Array<{ url: string; bodyType: string }> = [];
  process.env.BLACKBOX_TEST_FAKE_SURGE = '1';

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

    const all = await readCaptures(baseUrl);
    assert.strictEqual(all.captures.length, 5);
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
    assert.deepStrictEqual(
      upstreamCalls.map((call) => call.bodyType),
      ['FormData', 'none', 'none', 'none']
    );

    const afterFirst = await readCaptures(baseUrl, '?after=1');
    assert.strictEqual(afterFirst.captures.length, 4);

    const cleared = await fetch(`${baseUrl}/captures`, { method: 'DELETE' });
    assert.strictEqual(cleared.status, 200);
    const afterClear = await readCaptures(baseUrl);
    assert.strictEqual(afterClear.captures.length, 0);

    const cacheClear = await fetch(`${baseUrl}/captures/cache`, { method: 'DELETE' });
    assert.strictEqual(cacheClear.status, 200);

    writeLine('fetch-capture passthrough/capture tests passed');
  } finally {
    await close(server);
    globalThis.fetch = originalFetch;
    if (oldFakeSurge === undefined) delete process.env.BLACKBOX_TEST_FAKE_SURGE;
    else process.env.BLACKBOX_TEST_FAKE_SURGE = oldFakeSurge;
  }
}

run().catch((error: unknown) => {
  writeErrorLine(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
