#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  REQUIRED_CHROME_FLAGS,
  buildAuthorizeUrl,
  cloudRemint,
  exchangeAuthorizationCode,
  verifyGrant,
} from '../../providers/browser/claudeGrantMint';
import {
  FakeCdpWebSocket,
  installFakeWebSocket,
  type CdpCommand,
} from './support/fakeCdpWebSocket';

type EvaluationMode = 'success' | 'no-button' | 'no-code';
let evaluationMode: EvaluationMode = 'success';

function cdpResponse(command: CdpCommand): Record<string, unknown> {
  if (command.method === 'Target.getTargets') {
    return { result: { targetInfos: [{ targetId: 'page-1', type: 'page' }] } };
  }
  if (command.method === 'Target.attachToTarget') {
    return { result: { sessionId: 'page-session' } };
  }
  if (command.method === 'Runtime.evaluate') {
    const expression = String((command.params as { expression?: string }).expression ?? '');
    if (expression.includes('document.body.innerText.slice')) {
      return { result: { result: { value: 'Sign in to continue' } } };
    }
    if (expression.includes('JSON.stringify({url:')) {
      return { result: { result: { value: '{"url":"https://claude.ai"}' } } };
    }
    if (expression.includes('oauth\\/code\\/callback')) {
      return {
        result: {
          result: { value: evaluationMode === 'success' ? 'oauth-code#embedded-state' : null },
        },
      };
    }
    return {
      result: {
        result: {
          value: evaluationMode === 'no-button' ? null : { x: 420, y: 240 },
        },
      },
    };
  }
  return { result: {} };
}

async function expectReject(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let seen = '';
  try {
    await fn();
  } catch (error) {
    seen = error instanceof Error ? error.message : String(error);
  }
  assert.match(seen, pattern);
}

async function main(): Promise<void> {
  const restoreWebSocket = installFakeWebSocket();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let tokenStatus = 200;
  let inferenceStatus = 200;
  const requestBodies: string[] = [];
  Object.assign(globalThis, {
    setTimeout: ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      queueMicrotask(() => fn(...args));
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/json')) {
        return new Response(
          JSON.stringify([
            { type: 'worker', webSocketDebuggerUrl: 'ws://worker' },
            { type: 'page', webSocketDebuggerUrl: 'ws://page' },
          ])
        );
      }
      if (url.includes('/v1/oauth/token')) {
        requestBodies.push(String(init?.body ?? ''));
        if (tokenStatus !== 200) return new Response('bad exchange', { status: tokenStatus });
        return new Response(
          JSON.stringify({
            access_token: 'setup-token',
            expires_in: 31_536_000,
            scope: 'user:inference',
            account: { uuid: 'account-1', email_address: 'claude@example.com' },
          }),
          { status: 200 }
        );
      }
      return new Response(inferenceStatus === 200 ? 'CLOUDMINT' : 'rate limited', {
        status: inferenceStatus,
      });
    },
  });

  try {
    assert(REQUIRED_CHROME_FLAGS.some((flag) => flag.includes('AutomationControlled')));
    const auth = buildAuthorizeUrl();
    const authUrl = new URL(auth.url);
    assert.equal(authUrl.origin, 'https://claude.ai');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.notEqual(authUrl.searchParams.get('code_challenge'), auth.verifier);

    FakeCdpWebSocket.reset(cdpResponse);
    evaluationMode = 'success';
    const result = await cloudRemint(
      'ws://browser',
      [
        {
          name: 'sessionKey',
          value: 'session',
          domain: '.claude.ai',
          path: '/',
          secure: true,
          httpOnly: true,
          expires: 2_000_000_000,
          sameSite: 'Lax',
        },
        {
          name: 'session-only',
          value: 'session',
          domain: 'claude.ai',
          path: '/',
          secure: true,
          httpOnly: false,
        },
      ],
      { autoClick: true, codeTimeoutMs: 5 }
    );
    assert.deepEqual(
      {
        accessToken: result.accessToken,
        accountId: result.accountId,
        email: result.accountEmail,
        clicks: result.clickAttempts,
      },
      {
        accessToken: 'setup-token',
        accountId: 'account-1',
        email: 'claude@example.com',
        clicks: 1,
      }
    );
    const successSocket = FakeCdpWebSocket.instances[0];
    assert.equal(successSocket.closed, true);
    assert(
      successSocket.sent.some(
        (command) =>
          command.method === 'Input.dispatchMouseEvent' &&
          (command.params as { type?: string }).type === 'mousePressed'
      )
    );

    const exchanged = await exchangeAuthorizationCode('fresh-code', 'verifier', 'fallback-state');
    assert.equal(exchanged.accessToken, 'setup-token');
    assert.equal(exchanged.clickAttempts, 0);
    assert.equal(JSON.parse(requestBodies.at(-1) ?? '{}').state, 'fallback-state');
    await exchangeAuthorizationCode('fresh-code#inside-code', 'verifier', 'fallback-state');
    assert.equal(JSON.parse(requestBodies.at(-1) ?? '{}').state, 'inside-code');

    tokenStatus = 400;
    await expectReject(
      () => exchangeAuthorizationCode('bad-code', 'verifier', 'state'),
      /exchange failed 400: bad exchange/
    );
    tokenStatus = 200;

    inferenceStatus = 200;
    assert.deepEqual(await verifyGrant('good-token'), { ok: true, detail: 'HTTP 200' });
    inferenceStatus = 429;
    assert.deepEqual(await verifyGrant('limited-token'), { ok: false, detail: 'HTTP 429' });

    FakeCdpWebSocket.reset(cdpResponse);
    evaluationMode = 'no-button';
    await expectReject(
      () => cloudRemint('http://127.0.0.1:9222', [], { autoClick: true, codeTimeoutMs: 0 }),
      /consent screen never rendered.*Sign in to continue/
    );
    assert.equal(FakeCdpWebSocket.instances[0]?.closed, true);

    FakeCdpWebSocket.reset(cdpResponse);
    evaluationMode = 'no-code';
    await expectReject(
      () => cloudRemint('ws://browser', [], { autoClick: false, codeTimeoutMs: 0 }),
      /authorize click produced no code/
    );
    assert.equal(FakeCdpWebSocket.instances[0]?.closed, true);
  } finally {
    restoreWebSocket();
    Object.assign(globalThis, { fetch: originalFetch, setTimeout: originalSetTimeout });
  }
}

void main();
