import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import Module, { createRequire } from 'node:module';
import express from 'express';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function observe<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('native HTTP observer did not settle within 30 seconds')),
          30_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runBrowserInitDisconnectCases(): Promise<void> {
  // Load the production router unchanged. Only its auth/service/provider
  // boundaries are local fixtures; Express and the HTTP disconnect are real.
  const routePath = new URL('../../domains/browser-session/routes.ts', import.meta.url).pathname;
  const initRoutePath = new URL('../../domains/browser-session/routes.init.ts', import.meta.url)
    .pathname;
  const require = createRequire(import.meta.url);
  const loader = Module as unknown as {
    _load: (id: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  let init = async (): Promise<{ session_id: string; task_id: string }> => {
    throw new Error('fixture not selected');
  };
  let close = async (_sessionId: string, _pause: boolean): Promise<void> => {
    throw new Error('fixture not selected');
  };
  const registrationNames: Record<string, string> = {
    './routes.credentials': 'registerBrowserCredentialRoutes',
    './routes.files': 'registerBrowserDataRoutes',
    './routes.rotation': 'registerBrowserRotationRoute',
    './routes.control': 'registerBrowserControlRoutes',
    './routes.resume': 'registerBrowserResumeRoute',
    './routes.challenge-recovery': 'registerBrowserChallengeRecoveryRoutes',
  };
  loader._load = function (id, parent, isMain) {
    if (parent?.filename === routePath || parent?.filename === initRoutePath) {
      if (id === './service')
        return {
          initSession: () => init(),
          closeBrowserSession: (sessionId: string, pause: boolean) => close(sessionId, pause),
        };
      if (id.endsWith('/auth') || id.endsWith('/hybridAuth'))
        return {
          authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
          hybridAuth: async (req: { isInternal: boolean }, _res: unknown, next: () => void) => {
            req.isInternal = true;
            next();
          },
        };
      if (id.endsWith('/browser')) return { BrowserProviderRateLimitError: class extends Error {} };
      if (id.endsWith('/logger'))
        return { createLogger: () => ({ info() {}, warn() {}, error() {} }) };
      if (registrationNames[id]) return { [registrationNames[id]]: () => undefined };
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  let router: express.Router;
  try {
    delete require.cache[routePath];
    router = require(routePath).default as express.Router;
  } finally {
    loader._load = originalLoad;
  }
  const app = express();
  app.use(express.json());
  app.use('/api/browser-session', router);
  const server = app.listen(0, '127.0.0.1');
  await observe(once(server, 'listening'));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const body = JSON.stringify({
    user_id: 'disconnect-fixture-user',
    agent_id: '11111111-1111-4111-8111-111111111111',
    task_id: '22222222-2222-4222-8222-222222222222',
    start_url: 'https://example.com',
  });
  let settlePending: (() => void) | undefined;
  try {
    for (const scenario of [
      'disconnect-during-preparation',
      'disconnect-before-allocation',
      'success',
      'close-failure',
      'init-error',
    ] as const) {
      const started = deferred<void>();
      const settle = deferred<void>();
      settlePending = () => settle.resolve();
      const settled = deferred<void>();
      const disconnected = deferred<void>();
      const closed: string[] = [];
      const sessions = new Map([['foreign-session', 'ACTIVE']]);
      const ownedSessionId = `owned-${scenario}`;
      let responseClosed = false;
      server.once('request', (_req, res) => {
        res.once('close', () => {
          responseClosed = true;
          disconnected.resolve();
        });
      });
      init = async () => {
        if (scenario !== 'disconnect-before-allocation' && scenario !== 'init-error')
          sessions.set(ownedSessionId, 'ACTIVE');
        started.resolve();
        await settle.promise;
        if (scenario === 'init-error') {
          settled.resolve();
          throw new Error('fixture initialization returned no owner');
        }
        sessions.set(ownedSessionId, 'ACTIVE');
        settled.resolve();
        return { session_id: ownedSessionId, task_id: '22222222-2222-4222-8222-222222222222' };
      };
      close = async (sessionId, pause) => {
        assert.equal(sessionId, ownedSessionId, 'disconnect cleanup touched a foreign session');
        assert.equal(pause, false, 'unacknowledged allocation must be released, not paused');
        closed.push(sessionId);
        sessions.set(sessionId, scenario === 'close-failure' ? 'ERROR' : 'CLOSED');
        if (scenario === 'close-failure') throw new Error('fixture provider close unavailable');
      };
      const client = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/api/browser-session/init',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      client.on('error', () => undefined);
      const success = deferred<{ status: number | undefined; body: string }>();
      client.on('response', (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += String(chunk);
        });
        res.on('end', () => success.resolve({ status: res.statusCode, body: responseBody }));
      });
      client.end(body);
      await observe(started.promise);
      if (scenario !== 'success') {
        client.destroy();
        await observe(disconnected.promise);
      }
      settle.resolve();
      await observe(settled.promise);
      if (scenario === 'success') {
        const response = await observe(success.promise);
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).session_id, ownedSessionId);
        await observe(disconnected.promise);
      }
      // Let the real async route consume the settled preparation and close.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(responseClosed, 'native response close was not observed');
      assert.equal(sessions.get('foreign-session'), 'ACTIVE');
      if (scenario === 'success' || scenario === 'init-error') {
        assert.deepEqual(closed, [], 'successful acknowledgment was spuriously cleaned up');
        assert.equal(sessions.get(ownedSessionId), scenario === 'success' ? 'ACTIVE' : undefined);
      } else {
        assert.deepEqual(
          closed,
          [ownedSessionId],
          'disconnected init retained an unacknowledged session'
        );
        assert.equal(
          sessions.get(ownedSessionId),
          scenario === 'close-failure' ? 'ERROR' : 'CLOSED'
        );
      }
      console.log(`PASS browser-session init ${scenario}: exact owner, foreign unchanged`);
    }
  } finally {
    settlePending?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    server.closeAllConnections();
    await observe(
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    );
    assert.equal(server.listening, false);
    console.log('browser-session init native HTTP connections and server joined');
    delete require.cache[routePath];
  }
}
