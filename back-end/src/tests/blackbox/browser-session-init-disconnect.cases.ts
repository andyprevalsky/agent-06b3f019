import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import Module, { createRequire } from 'node:module';
import express from 'express';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function observe<T>(
  promise: Promise<T>,
  identity: string,
  snapshot: () => Record<string, unknown> = () => ({})
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `native HTTP observer did not settle within 30 seconds: ${identity}; ${JSON.stringify(snapshot())}`
              )
            ),
          30_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nativeHttpState(
  phase: string,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: number,
  responseId: number
) {
  return {
    phase,
    requestId,
    responseId,
    method: req.method,
    path: req.url?.slice(0, 120),
    requestDestroyed: req.destroyed,
    responseDestroyed: res.destroyed,
    writableFinished: res.writableFinished,
  };
}

async function testNativeObserverDiagnosticIdentity(): Promise<void> {
  let nativeState: ReturnType<typeof nativeHttpState> | undefined;
  const server = createServer((req, res) => {
    res.destroy();
    nativeState = nativeHttpState('diagnostic-error', req, res, 1, 1);
  });
  server.listen(0, '127.0.0.1');
  await observe(once(server, 'listening'), 'diagnostic-http:listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const failed = deferred<string>();
    const client = httpRequest({ hostname: '127.0.0.1', port: address.port });
    client.once('error', (error: NodeJS.ErrnoException) => failed.resolve(error.code ?? 'UNKNOWN'));
    client.end();
    const code = await observe(failed.promise, 'diagnostic-http:client-error');
    assert.equal(code, 'ECONNRESET', 'controlled local HTTP error must be real');
    const originalTimer = globalThis.setTimeout;
    let requestedDeadline: number | undefined;
    let pending: Promise<unknown>;
    try {
      // Accelerate only this observer's timer, restoring the global before awaiting.
      globalThis.setTimeout = ((callback: () => void, delay: number) => {
        requestedDeadline = delay;
        return originalTimer(callback, 0);
      }) as typeof setTimeout;
      pending = observe(new Promise(() => undefined), 'diagnostic-http:response-close', () => ({
        clientErrorCodes: [code],
        nativeState,
      }));
    } finally {
      globalThis.setTimeout = originalTimer;
    }
    await assert.rejects(pending, (error: Error) => {
      assert.match(error.message, /diagnostic-http:response-close/);
      assert.match(error.message, /ECONNRESET/);
      assert.match(error.message, /"responseDestroyed":true/);
      assert.match(error.message, /"requestId":1/);
      return true;
    });
    assert.equal(requestedDeadline, 30_000, 'normal observer deadline must remain unchanged');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  console.log('PASS native HTTP observer diagnostic identity (real ECONNRESET, original deadline)');
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
  let recordFixtureError: (message: unknown, details: unknown) => void = () => undefined;
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
        return {
          createLogger: () => ({
            info() {},
            warn() {},
            error(message: unknown, details: unknown) {
              recordFixtureError(message, details);
            },
          }),
        };
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
  type NativeRequest = { req: IncomingMessage; res: ServerResponse };
  const requestContext = new AsyncLocalStorage<NativeRequest>();
  const requestIds = new WeakMap<IncomingMessage, number>();
  const responseIds = new WeakMap<ServerResponse, number>();
  let sequence = 0;
  const app = express();
  app.use((req, res, next) => {
    const id = ++sequence;
    requestIds.set(req, id);
    responseIds.set(res, id);
    requestContext.run({ req, res }, next);
  });
  app.use(express.json());
  app.use('/api/browser-session', router);
  const server = app.listen(0, '127.0.0.1');
  await observe(once(server, 'listening'), 'browser-init:listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const body = JSON.stringify({
    user_id: 'disconnect-fixture-user',
    agent_id: '11111111-1111-4111-8111-111111111111',
    task_id: '22222222-2222-4222-8222-222222222222',
    start_url: 'https://example.com',
  });
  let settlePending: (() => void) | undefined;
  let removeRequestObserver = () => {};
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
      const closeObserved = deferred<void>();
      const sessions = new Map([['foreign-session', 'ACTIVE']]);
      const ownedSessionId = `owned-${scenario}`;
      let responseClosed = false;
      let intentionalDestroy = false;
      const events: string[] = [];
      const requests: ReturnType<typeof nativeHttpState>[] = [];
      const closeAttempts: Array<{ sessionId: string; expectedSessionId: string; pause: boolean }> =
        [];
      const fixtureErrors: Array<{ message: string; error: string }> = [];
      const retain = <T>(items: T[], item: T, limit: number) => {
        items.push(item);
        if (items.length > limit) items.shift();
      };
      const recordRequest = (phase: string, context: NativeRequest | undefined) => {
        if (context)
          retain(
            requests,
            nativeHttpState(
              phase,
              context.req,
              context.res,
              requestIds.get(context.req) ?? -1,
              responseIds.get(context.res) ?? -1
            ),
            8
          );
      };
      recordFixtureError = (message, details) => {
        const error = (details as { error?: unknown } | undefined)?.error;
        retain(
          fixtureErrors,
          { message: String(message).slice(0, 200), error: String(error ?? '').slice(0, 500) },
          4
        );
      };
      const clientErrors: Array<{ code: string; afterIntentionalDestroy: boolean }> = [];
      const mark = (event: string) => {
        events.push(event);
        if (events.length > 16) events.shift();
      };
      const observed = <T>(promise: Promise<T>, phase: string) =>
        observe(promise, `${scenario}:${phase}`, () => ({
          events: [...events],
          requests: [...requests],
          closeAttempts: [...closeAttempts],
          fixtureErrors: [...fixtureErrors],
          clientErrors: [...clientErrors],
          responseClosed,
          intentionalDestroy,
        }));
      const observeInitRequest = (_req: IncomingMessage, res: ServerResponse) => {
        const requestPath = (_req as express.Request).originalUrl ?? _req.url;
        if (_req.method !== 'POST' || requestPath !== '/api/browser-session/init') return;
        server.off('request', observeInitRequest);
        recordRequest('request-event', { req: _req, res });
        mark('server-request');
        res.once('close', () => {
          recordRequest('response-close', { req: _req, res });
          mark('response-close');
          responseClosed = true;
          disconnected.resolve();
        });
      };
      removeRequestObserver = () => server.off('request', observeInitRequest);
      server.on('request', observeInitRequest);
      init = async () => {
        if (scenario !== 'disconnect-before-allocation' && scenario !== 'init-error')
          sessions.set(ownedSessionId, 'ACTIVE');
        recordRequest('init-entry', requestContext.getStore());
        mark('init-started');
        started.resolve();
        await settle.promise;
        recordRequest('init-settle', requestContext.getStore());
        if (scenario === 'init-error') {
          mark('init-settled');
          settled.resolve();
          throw new Error('fixture initialization returned no owner');
        }
        sessions.set(ownedSessionId, 'ACTIVE');
        mark('init-settled');
        settled.resolve();
        return { session_id: ownedSessionId, task_id: '22222222-2222-4222-8222-222222222222' };
      };
      close = async (sessionId, pause) => {
        retain(closeAttempts, { sessionId, expectedSessionId: ownedSessionId, pause }, 4);
        assert.equal(sessionId, ownedSessionId, 'disconnect cleanup touched a foreign session');
        assert.equal(pause, false, 'unacknowledged allocation must be released, not paused');
        closed.push(sessionId);
        sessions.set(sessionId, scenario === 'close-failure' ? 'ERROR' : 'CLOSED');
        mark('native-close');
        closeObserved.resolve();
        if (scenario === 'close-failure') throw new Error('fixture provider close unavailable');
      };
      // An unrelated native request must not satisfy this scenario's close observation.
      await observed(
        new Promise<void>((resolve, reject) => {
          const unrelated = httpRequest(
            { hostname: '127.0.0.1', port: address.port, path: '/', method: 'HEAD' },
            (response) => {
              response.resume();
              response.once('end', resolve);
              response.once('error', reject);
            }
          );
          unrelated.once('error', reject);
          unrelated.end();
        }),
        'unrelated-head'
      );
      const client = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/api/browser-session/init',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      client.on('error', (error: NodeJS.ErrnoException) => {
        const code = (error.code ?? 'UNKNOWN').slice(0, 64);
        clientErrors.push({ code, afterIntentionalDestroy: intentionalDestroy });
        if (clientErrors.length > 4) clientErrors.shift();
        mark(`client-error:${code}`);
      });
      client.once('close', () => mark('client-close'));
      const success = deferred<{ status: number | undefined; body: string }>();
      client.on('response', (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += String(chunk);
        });
        res.on('end', () => success.resolve({ status: res.statusCode, body: responseBody }));
      });
      client.end(body);
      await observed(started.promise, 'started');
      if (scenario !== 'success') {
        intentionalDestroy = true;
        mark('client-destroy-requested');
        client.destroy();
        await observed(disconnected.promise, 'disconnected');
      }
      settle.resolve();
      await observed(settled.promise, 'settled');
      if (scenario === 'success') {
        const response = await observed(success.promise, 'success');
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).session_id, ownedSessionId);
        await observed(disconnected.promise, 'disconnected');
      }
      // A disconnected allocation must reach its exact close; wait for that
      // observation within the fixture bound instead of one event-loop turn.
      if (scenario !== 'success' && scenario !== 'init-error')
        await observed(closeObserved.promise, 'closeObserved');
      // Let the real async route consume the settled preparation.
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
    removeRequestObserver();
    settlePending?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    server.closeAllConnections();
    await observe(
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
      'browser-init:server-close'
    );
    assert.equal(server.listening, false);
    console.log('browser-session init native HTTP connections and server joined');
    delete require.cache[routePath];
  }
  await testNativeObserverDiagnosticIdentity();
}
