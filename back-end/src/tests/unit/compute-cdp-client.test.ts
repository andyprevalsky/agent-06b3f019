#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import {
  CODEX_HOSTED_LOGIN_SUCCESS_URL,
  attachCdp,
  codexCallbackFulfillment,
  countAccepted,
} from '../../domains/compute-grants/cdp';
import {
  seedTargetSession,
  seedVirtualPasskeys,
  type PasskeySeed,
} from '../../domains/compute-grants/cdp.passkeys';
import {
  FakeCdpWebSocket,
  installFakeWebSocket,
  type CdpCommand,
} from './support/fakeCdpWebSocket';

const callbackUrl = 'http://localhost:1455/auth/callback?code=oauth-code&state=expected';
const passkey: PasskeySeed = {
  credentialId: 'credential-id',
  privateKey: 'private-key',
  rpId: 'example.com',
  signCount: 3,
  userHandle: 'user-handle',
};

function responseFor(command: CdpCommand): Record<string, unknown> {
  if (command.method === 'Target.getTargets') {
    return {
      result: {
        targetInfos: [
          { targetId: 'page-1', type: 'page', url: callbackUrl },
          { targetId: 'worker-1', type: 'service_worker', url: 'https://worker.invalid' },
          { targetId: 'page-2', type: 'page', url: 'https://auth.openai.com/oauth/authorize' },
        ],
      },
    };
  }
  if (command.method === 'Target.attachToTarget') {
    const targetId = (command.params as { targetId?: string }).targetId;
    return { result: { sessionId: `session-${targetId ?? 'unknown'}` } };
  }
  if (command.method === 'Network.getAllCookies') {
    return {
      result: {
        cookies: [
          { name: 'accepted', domain: '.example.com' },
          { name: 'host-cookie', domain: 'example.com' },
        ],
      },
    };
  }
  if (command.method === 'Network.getCookies') {
    return {
      result: {
        cookies: [
          {
            name: 'session',
            value: 'value',
            domain: 'example.com',
            path: '/',
            secure: true,
            httpOnly: true,
          },
        ],
      },
    };
  }
  if (command.method === 'Runtime.evaluate') {
    return {
      result: {
        result: {
          value: command.sessionId === 'session-page-2' ? 'second-page-value' : null,
        },
      },
    };
  }
  if (command.method === 'WebAuthn.addVirtualAuthenticator') {
    return { result: { authenticatorId: 'authenticator-1' } };
  }
  return { result: {} };
}

async function main(): Promise<void> {
  const restoreWebSocket = installFakeWebSocket();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  Object.assign(globalThis, {
    fetch: async () =>
      new Response(
        JSON.stringify([
          { type: 'worker', webSocketDebuggerUrl: 'ws://worker' },
          { type: 'page', webSocketDebuggerUrl: 'ws://page' },
        ])
      ),
    setTimeout: ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      queueMicrotask(() => fn(...args));
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
  });

  try {
    FakeCdpWebSocket.reset(responseFor);
    const cdp = await attachCdp('http://127.0.0.1:9222');
    const socket = FakeCdpWebSocket.instances[0];
    assert.equal(socket.url, 'ws://page');

    assert.equal(countAccepted([], []), 0);
    assert.equal(
      countAccepted(
        [
          {
            name: 'accepted',
            value: 'one',
            domain: 'example.com',
            path: '/',
            secure: true,
            httpOnly: true,
          },
          {
            name: 'missing',
            value: 'two',
            domain: '.example.com',
            path: '/',
            secure: false,
            httpOnly: false,
          },
        ],
        [{ name: 'accepted', domain: '.example.com' }]
      ),
      1
    );

    assert.equal(await cdp.setCookies([]), 0);
    assert.equal(
      await cdp.setCookies([
        {
          name: 'accepted',
          value: 'one',
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expires: 2_000_000_000,
          sameSite: 'Lax',
          sourceScheme: 'Secure',
        },
        {
          name: 'host-cookie',
          value: 'two',
          domain: '',
          path: '/',
          secure: true,
          httpOnly: false,
        },
      ]),
      1
    );
    assert.equal(
      await cdp.setCookie({
        name: 'accepted',
        value: 'three',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: true,
      }),
      1
    );
    assert.equal((await cdp.getCookies(['https://example.com']))[0]?.name, 'session');
    assert.equal(await cdp.evaluate('null'), undefined);
    assert.equal(await cdp.evaluateAnyTarget('find me'), 'second-page-value');
    assert.deepEqual(await cdp.getPageUrls(), [
      callbackUrl,
      'https://auth.openai.com/oauth/authorize',
    ]);

    await cdp.navigate('https://example.com');
    await cdp.armCodexCallback('expected');
    socket.message({ not: 'json command' });
    socket.dispatchEvent(new MessageEvent('message', { data: '{not-json' }));
    socket.message({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'popup-session', targetInfo: { type: 'page', targetId: 'popup' } },
    });
    socket.message({
      method: 'Fetch.requestPaused',
      sessionId: 'popup-session',
      params: { requestId: 'ignored', request: { url: 'https://example.com/' } },
    });
    socket.message({
      method: 'Fetch.requestPaused',
      sessionId: 'popup-session',
      params: { requestId: 'callback', request: { url: callbackUrl } },
    });
    await waitImmediate();
    assert.equal(cdp.getCapturedCodexCallbackUrl(), callbackUrl);
    assert(socket.sent.some((command) => command.method === 'Fetch.continueRequest'));
    assert(socket.sent.some((command) => command.method === 'Fetch.fulfillRequest'));
    assert.equal(await cdp.showFinishingPage(callbackUrl), true);
    assert.equal(await cdp.showFinishingPage('https://example.com/not-a-callback'), false);

    assert.equal(await cdp.seedPasskeys([passkey]), 2);
    socket.message({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'new-session', targetInfo: { type: 'page', targetId: 'page-3' } },
    });
    await waitImmediate();
    assert(
      socket.sent.some(
        (command) =>
          command.method === 'WebAuthn.addCredential' && command.sessionId === 'new-session'
      )
    );
    assert.equal(await cdp.seedPasskeys([]), 0);
    cdp.close();
    assert.equal(socket.closed, true);

    const sends: CdpCommand[] = [];
    const send = async (method: string, params: unknown = {}, opts = {}) => {
      const command = {
        id: sends.length + 1,
        method,
        params: params as Record<string, unknown>,
        ...opts,
      };
      sends.push(command);
      return responseFor(command);
    };
    assert.equal(await seedTargetSession(send, 'manual-session', []), true);
    assert.equal(await seedVirtualPasskeys(send, [], new Set()), 0);
    assert.equal(await seedVirtualPasskeys(send, [passkey], new Set(['page-1'])), 1);

    const redirect = codexCallbackFulfillment(callbackUrl, 'expected');
    assert.equal(redirect?.responseCode, 302);
    assert.equal(redirect?.responseHeaders[0]?.value, CODEX_HOSTED_LOGIN_SUCCESS_URL);
    const denied = codexCallbackFulfillment(
      'http://localhost:1457/auth/callback?error=access_denied&state=expected',
      'expected'
    );
    assert.equal(denied?.responseCode, 200);
    assert.equal(typeof denied?.body, 'string');
    assert.equal(
      codexCallbackFulfillment('http://localhost:1455/auth/callback?state=expected', 'expected'),
      null
    );
    assert.equal(codexCallbackFulfillment('not a url', 'expected'), null);
  } finally {
    restoreWebSocket();
    Object.assign(globalThis, { fetch: originalFetch, setTimeout: originalSetTimeout });
  }
}

void main();
