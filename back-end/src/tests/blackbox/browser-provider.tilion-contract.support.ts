/** Captured native screenshot replay; all HTTP/CDP activity stays in this process or loopback. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { WebSocketServer } from 'ws';
import { assertLiveTilionVendorContract } from './browser-provider.tilion-live.support';

// Captured 2026-11-02 from POST /v1/session/<id>/screenshot {} on back.tilion.dev,
// while Playwright stayed connected to oregon.back.tilion.dev. Example.com only;
// no credentials, token-bearing URLs or user content are retained.
const captured = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/tilion-attached-screenshot.json'), 'utf8')
) as Record<string, unknown>;

type Fault =
  | 'old-refusal'
  | 'unmarked'
  | 'missing-marker'
  | 'generic-success'
  | 'wrong-tab'
  | 'bad-image'
  | 'corrupt-image'
  | 'disconnect'
  | 'viewport'
  | 'dns-dead-worker';

async function replay(fault?: Fault): Promise<void> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const previous = {
    fetch: globalThis.fetch,
    connect: chromium.connectOverCDP,
    base: process.env.TILION_BASE_URL,
    key: process.env.TILION_API_KEY,
  };
  const calls: string[] = [];
  let connected = true;
  let mutatedViewport = false;
  let deletes = 0;
  let secondRefused = false;
  const page = {
    goto: async (url: string) => {
      assert.equal(url, 'https://example.com');
      calls.push('navigate');
      if (fault === 'dns-dead-worker' && !calls.includes('DELETE /v1/session/captured-session')) {
        throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/');
      }
      return { status: () => 200 };
    },
    title: async () => {
      assert(connected, 'CDP was disconnected');
      return 'Example Domain';
    },
    url: () => String(captured.url),
    evaluate: async () => ({
      url: captured.url,
      width: mutatedViewport ? 1 : 1920,
      height: 1080,
      scrollX: 0,
      scrollY: 0,
    }),
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          assert.equal(method, 'Target.getTargetInfo');
          return { targetInfo: { targetId: captured.tab_id } };
        },
        detach: async () => {},
      }),
    }),
  };
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    isConnected: () => connected,
    close: async () => {
      calls.push('disconnect');
      connected = false;
    },
  } as unknown as Browser;
  server.on('connection', (socket) => {
    calls.push('second-cdp');
    secondRefused = true;
    socket.close(4409, 'another client is attached to this session');
  });
  process.env.TILION_BASE_URL = 'https://vendor.invalid';
  process.env.TILION_API_KEY = 'local-contract-only';
  chromium.connectOverCDP = async () => {
    calls.push('connect');
    connected = true;
    return browser;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://vendor.invalid', 'unexpected outbound request');
    assert(init?.signal, 'native request lost its bounded abort signal');
    const method = init?.method;
    calls.push(`${method} ${url.pathname}`);
    if (method === 'POST' && url.pathname === '/v1/session') {
      assert.deepEqual(JSON.parse(String(init.body)), { idle_timeout: 120, ttl: 600 });
      return Response.json(
        { session_id: 'captured-session', connect_url: `ws://127.0.0.1:${address.port}` },
        { status: 201 }
      );
    }
    assert(url.pathname.startsWith('/v1/session/captured-session'));
    if (method === 'POST' && url.pathname.endsWith('/screenshot')) {
      if (!connected) return Response.json(captured);
      assert(secondRefused, 'screenshot ran before proving second-client exclusion');
      assert.deepEqual(JSON.parse(String(init.body)), {});
      if (fault === 'old-refusal') {
        return Response.json({ detail: { error: 'session_driven_by_client' } }, { status: 409 });
      }
      if (fault === 'generic-success') return Response.json({ ok: true });
      if (fault === 'disconnect') connected = false;
      if (fault === 'viewport') mutatedViewport = true;
      return Response.json({
        ...captured,
        ...(fault === 'unmarked' ? { beside_client: false } : {}),
        ...(fault === 'missing-marker' ? { beside_client: undefined } : {}),
        ...(fault === 'wrong-tab' ? { tab_id: 'different-tab' } : {}),
        ...(fault === 'bad-image' ? { image_base64: 'not-a-jpeg' } : {}),
        ...(fault === 'corrupt-image'
          ? { image_base64: '/9j/AP/Z', size_b64: 8, data_url: 'data:image/jpeg;base64,/9j/AP/Z' }
          : {}),
      });
    }
    if (method === 'DELETE') {
      deletes++;
      return new Response(null, { status: 204 });
    }
    assert.equal(method, 'GET');
    return new Response(null, { status: 410 });
  };
  try {
    await assertLiveTilionVendorContract();
    const replaced = fault === 'dns-dead-worker' ? 1 : 0;
    assert.equal(calls.filter((call) => call === 'POST /v1/session').length, 1 + replaced);
    assert.equal(deletes, 2 + replaced, 'native success must prove repeated DELETE is idempotent');
    assert.equal(calls.filter((call) => call.endsWith('/screenshot')).length, 2);
    assert.equal(calls.at(-1), 'GET /v1/session/captured-session');
  } finally {
    globalThis.fetch = previous.fetch;
    chromium.connectOverCDP = previous.connect;
    for (const [key, value] of Object.entries({
      TILION_BASE_URL: previous.base,
      TILION_API_KEY: previous.key,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    assert.equal(connected, false, 'native path must disconnect even on failure');
    assert(deletes > 0, 'native path must release its session even on failure');
  }
}

export async function assertTilionCapturedScreenshotContract(): Promise<void> {
  await replay();
}

/** A session whose worker cannot resolve DNS is released and the contract runs on a fresh one. */
export async function assertTilionVendorContractReplacesDnsDeadSession(): Promise<void> {
  await replay('dns-dead-worker');
}

export async function assertTilionScreenshotRejectsInvalidOwnership(): Promise<void> {
  for (const [fault, error] of [
    ['old-refusal', /REST screenshot while CDP attached/],
    ['unmarked', /beside_client/],
    ['missing-marker', /beside_client/],
    ['generic-success', /beside_client/],
    ['wrong-tab', /CDP target/],
    ['bad-image', /JPEG/],
    ['corrupt-image', /JPEG/],
    ['disconnect', /CDP client.*after screenshot/],
    ['viewport', /viewport/],
  ] as const) {
    await assert.rejects(() => replay(fault), error, fault);
  }
}

export async function assertTilionRotationResponseContract(): Promise<void> {
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      path.join(__dirname, '../../../scripts/fixtures/tilion-inplace-response.fixture.cjs'),
    ],
    { stdio: 'inherit' }
  );
}

export const tilionContractCases: Array<[string, () => Promise<void>]> = [
  [
    'Tilion pooled exit rotation preserves the original transport and rejects invalid proofs',
    assertTilionRotationResponseContract,
  ],
  [
    'Tilion captured screenshot preserves attached CDP ownership',
    assertTilionCapturedScreenshotContract,
  ],
  [
    'Tilion vendor contract replaces a session whose worker cannot resolve DNS',
    assertTilionVendorContractReplacesDnsDeadSession,
  ],
  [
    'Tilion screenshot rejects invalid ownership and payloads',
    assertTilionScreenshotRejectsInvalidOwnership,
  ],
];
