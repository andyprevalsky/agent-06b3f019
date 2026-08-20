#!/usr/bin/env tsx

import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import { installFetchCapture, shouldBypassOutboundReplay, isBinaryContentType } from '../../providers/fetchCapture';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  assert.strictEqual(isBinaryContentType('image/jpeg'), true);
  assert.strictEqual(isBinaryContentType('image/png; charset=binary'), true);
  assert.strictEqual(isBinaryContentType('application/pdf'), true);
  assert.strictEqual(isBinaryContentType('application/json'), false);
  assert.strictEqual(isBinaryContentType('text/plain'), false);

  const originalFetch = globalThis.fetch;
  const oldFakeSurge = process.env.BLACKBOX_TEST_FAKE_SURGE;
  const oldFakeWhatsApp = process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
  const oldReplayOutbound = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  const upstreamCalls: Array<{ url: string; bodyType: string }> = [];
  let mutableVersion = 0;
  let agentCardCalls = 0;
  process.env.BLACKBOX_TEST_FAKE_SURGE = '1';
  process.env.BLACKBOX_TEST_FAKE_WHATSAPP = '1';
  delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;

  const jpegFixture = readFileSync(
    resolve(__dirname, '../../../../front-end/public/test-assets/rs.jpeg')
  );
  assert.strictEqual(jpegFixture[0], 0xff);
  assert.strictEqual(jpegFixture[1], 0xd8);

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
    if (url.includes('/storage/v1/object/attachments/')) {
      return new Response(jpegFixture, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(jpegFixture.length),
        },
      });
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

    // H-02: capture must not UTF-8-corrupt binary Supabase attachment downloads.
    const attachment = await fetch(
      'https://example.supabase.co/storage/v1/object/attachments/user/rs.jpeg',
      { headers: { Authorization: 'Bearer test-token' } }
    );
    assert.strictEqual(attachment.status, 200);
    const attachmentBytes = Buffer.from(await attachment.arrayBuffer());
    assert.strictEqual(attachmentBytes.length, jpegFixture.length);
    assert.strictEqual(attachmentBytes[0], 0xff);
    assert.strictEqual(attachmentBytes[1], 0xd8);
    assert.ok(
      attachmentBytes.equals(jpegFixture),
      'fetchCapture must preserve JPEG bytes (no U+FFFD expansion)'
    );

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
    assert.strictEqual(surgeBody.id, 'blackbox-surge-message-6');

    const whatsappSuccess = await fetch(
      'https://graph.facebook.com/v21.0/blackbox-phone/messages',
      {
        method: 'POST',
        body: JSON.stringify({ text: { body: 'hello' } }),
      }
    );
    assert.strictEqual(whatsappSuccess.status, 200);
    assert.deepStrictEqual(await whatsappSuccess.json(), {
      messages: [{ id: 'blackbox-whatsapp-message-7' }],
    });

    const whatsappUnavailable = await fetch(
      'https://graph.facebook.com/v21.0/blackbox-phone/messages',
      {
        method: 'POST',
        body: JSON.stringify({ text: { body: '__BLACKBOX_WHATSAPP_503__' } }),
      }
    );
    assert.strictEqual(whatsappUnavailable.status, 503);

    const whatsappUnavailableFromRequest = await fetch(
      new Request('https://graph.facebook.com/v21.0/blackbox-phone/messages', {
        method: 'POST',
        body: JSON.stringify({ text: { body: '__BLACKBOX_WHATSAPP_503__' } }),
      })
    );
    assert.strictEqual(whatsappUnavailableFromRequest.status, 503);

    // Request-only headers must survive when init.headers is absent; init then overrides.
    const requestAuthOnly = await fetch(
      new Request('https://api.example.com/request-headers', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer request-only-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'request' }),
      })
    );
    assert.strictEqual(requestAuthOnly.status, 201);

    const requestPartialOverride = await fetch(
      new Request('https://api.example.com/request-headers-override', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer request-base-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'override' }),
      }),
      {
        headers: {
          Authorization: 'Bearer init-override-secret',
          'X-Trace': 'from-init',
        },
      }
    );
    assert.strictEqual(requestPartialOverride.status, 201);

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
    assert.strictEqual(all.captures.length, 13);
    assert.ok(all.captures[0].url.includes('/storage/v1/object/attachments/'));
    assert.strictEqual(all.captures[0].responseStatus, 200);
    assert.strictEqual(all.captures[1].requestBody, '[non-string body]');
    assert.strictEqual(all.captures[1].responseStatus, 201);
    assert.strictEqual(all.captures[2].url, 'https://sandbox.e2b.app/health');
    assert.strictEqual(all.captures[2].requestBody, null);
    assert.strictEqual(all.captures[3].url, 'https://api.onkernel.com/profiles');
    assert.strictEqual(all.captures[3].cached, false);
    assert.strictEqual(all.captures[4].error, 'e2b unavailable');
    assert.strictEqual(
      all.captures[5].requestHeaders.Authorization,
      'Bearer surge-sec...[redacted]'
    );
    assert.strictEqual(all.captures[5].responseBody, '{"id":"blackbox-surge-message-6"}');
    assert.strictEqual(all.captures[5].cached, false);
    assert.strictEqual(all.captures[6].cached, false);
    assert.strictEqual(all.captures[7].cached, false);
    assert.strictEqual(all.captures[8].cached, false);
    assert.strictEqual(all.captures[6].responseStatus, 200);
    assert.strictEqual(all.captures[7].responseStatus, 503);
    assert.strictEqual(all.captures[8].responseStatus, 503);
    const requestHeaderCapture = all.captures[9];
    assert.strictEqual(requestHeaderCapture.url, 'https://api.example.com/request-headers');
    assert.match(
      requestHeaderCapture.requestHeaders.authorization ??
        requestHeaderCapture.requestHeaders.Authorization ??
        '',
      /Bearer request-o\.\.\.\[redacted\]|Bearer request-only-secret/
    );
    assert.strictEqual(
      requestHeaderCapture.requestHeaders['content-type'] ??
        requestHeaderCapture.requestHeaders['Content-Type'],
      'application/json'
    );
    const overrideCapture = all.captures[10];
    assert.strictEqual(overrideCapture.url, 'https://api.example.com/request-headers-override');
    assert.match(
      overrideCapture.requestHeaders.authorization ??
        overrideCapture.requestHeaders.Authorization ??
        '',
      /Bearer init-over\.\.\.\[redacted\]|Bearer init-override-secret/
    );
    assert.strictEqual(
      overrideCapture.requestHeaders['content-type'] ??
        overrideCapture.requestHeaders['Content-Type'],
      'application/json'
    );
    assert.strictEqual(
      overrideCapture.requestHeaders['x-trace'] ?? overrideCapture.requestHeaders['X-Trace'],
      'from-init'
    );
    assert.strictEqual(all.captures[11].cached, false);
    assert.strictEqual(all.captures[12].cached, false);
    assert.strictEqual(
      all.captures[11].requestHeaders.Authorization,
      'Bearer agentcard...[redacted]'
    );
    assert.deepStrictEqual(
      upstreamCalls.map((call) => call.bodyType),
      ['none', 'FormData', 'none', 'none', 'none', 'String', 'String', 'String', 'String']
    );

    const afterFirst = await readCaptures(baseUrl, '?after=1');
    assert.strictEqual(afterFirst.captures.length, 12);

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
    if (oldFakeWhatsApp === undefined) delete process.env.BLACKBOX_TEST_FAKE_WHATSAPP;
    else process.env.BLACKBOX_TEST_FAKE_WHATSAPP = oldFakeWhatsApp;
    if (oldReplayOutbound === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = oldReplayOutbound;
  }
}

run().catch((error: unknown) => {
  writeErrorLine(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
