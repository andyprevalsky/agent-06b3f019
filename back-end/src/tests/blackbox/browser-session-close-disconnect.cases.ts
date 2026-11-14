/** Real HTTP disconnect must reach the checkpoint owner through the close service. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import Module, { createRequire } from 'node:module';
import express from 'express';
import { within } from './browser-session-lifecycle.fixture-support';

export async function runBrowserCloseDisconnectCases(): Promise<void> {
  const require = createRequire(import.meta.url);
  const routePath = new URL('../../domains/browser-session/routes.ts', import.meta.url).pathname;
  const servicePath = new URL('../../domains/browser-session/service.close.ts', import.meta.url)
    .pathname;
  const loader = Module as unknown as {
    _load: (id: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  const cached = [require.cache[routePath], require.cache[servicePath]];
  let entered!: () => void;
  let aborted!: () => void;
  let release!: () => void;
  let finished!: () => void;
  let observedSignal: AbortSignal | undefined;
  let disconnect = true;
  const registrationNames: Record<string, string> = {
    './routes.init': 'registerBrowserInitRoute',
    './routes.credentials': 'registerBrowserCredentialRoutes',
    './routes.files': 'registerBrowserDataRoutes',
    './routes.rotation': 'registerBrowserRotationRoute',
    './routes.control': 'registerBrowserControlRoutes',
    './routes.resume': 'registerBrowserResumeRoute',
    './routes.challenge-recovery': 'registerBrowserChallengeRecoveryRoutes',
  };
  loader._load = function (id, parent, isMain) {
    if (parent?.filename === routePath) {
      if (id === './service') return require(servicePath);
      if (registrationNames[id]) return { [registrationNames[id]]: () => {} };
      if (id.endsWith('/auth') || id.endsWith('/hybridAuth')) {
        const auth = (_req: unknown, _res: unknown, next: () => void) => next();
        return { authenticate: auth, authenticateInternal: auth, hybridAuth: auth };
      }
    }
    if (parent?.filename === servicePath && id === '../../providers/browser') {
      return {
        closeSession: async (
          _id: string,
          pause: boolean,
          _url: unknown,
          options: { signal?: AbortSignal }
        ) => {
          assert.equal(pause, true);
          observedSignal = options.signal;
          entered();
          try {
            if (disconnect)
              await new Promise<void>((resolve) => {
                release = resolve;
                options.signal?.addEventListener(
                  'abort',
                  () => {
                    aborted();
                    resolve();
                  },
                  { once: true }
                );
              });
            return { worldState: null };
          } finally {
            finished();
          }
        },
      };
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  let server: ReturnType<express.Express['listen']> | undefined;
  try {
    delete require.cache[routePath];
    delete require.cache[servicePath];
    const router = require(routePath).default as express.Router;
    const app = express();
    app.use(express.json());
    app.use('/api/browser-session', router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const client = request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/browser-session/close',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify({ session_id: 'fixture-native', pause: true }));
    await within(started);
    assert(observedSignal, 'close route and service forward the owning caller signal');
    assert.equal(observedSignal.aborted, false, 'body completion is not a client disconnect');
    client.destroy();
    await within(cancelled);
    await within(completed);
    assert.equal(observedSignal.aborted, true, 'real socket close aborts checkpoint ownership');

    disconnect = false;
    const normalStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const normalFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/browser-session/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'fixture-native', pause: true }),
    });
    await within(normalStarted);
    await within(normalFinished);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, status: 'PAUSED', world_state: null });
    assert.equal(
      observedSignal!.aborted,
      false,
      'completed response does not cancel successful pause'
    );
    console.log(
      'PASS close HTTP disconnect signal through actual route and service; normal close preserved'
    );
  } finally {
    release?.();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve()))
      );
    }
    loader._load = originalLoad;
    for (const [index, path] of [routePath, servicePath].entries()) {
      delete require.cache[path];
      if (cached[index]) require.cache[path] = cached[index];
    }
  }
}
