/**
 * Dead Tilion worker at browser init (2026-11-13, east pool, sess_993d70*):
 * POST /v1/session 201, then the CDP upgrade AND DELETE answer the AWS ALB's
 * "503 Service Temporarily Unavailable" (no healthy target); Tilion round-robins
 * the next create onto a healthy worker.
 *
 *   worker retry loop ─► initSession ─► initializeLogicalBrowser ─► createRemote
 *        ▲                                  receipt FAILED latch ─┐   │ create #1 → dead
 *        └── "before readiness" forever (the bug) ◄───────────────┘   │ create #2 → ...
 *
 * Real initSession, receipt coalescer, Tilion adapter, tilionClient HTTP,
 * Playwright connectOverCDP and local Prisma (saved-credential lookup is
 * stubbed: it reaches AgentPhone). Only Tilion is replayed on
 * loopback: its REST API, the dead data plane (captured bytes), and healthy
 * workers backed by a real local Chromium.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { chromium, type Browser } from 'playwright';

const START_URL = 'https://shop.example.test/account';
// Worker retry budget: agents SESSION_INIT_TRANSIENT_MAX_ATTEMPTS (5) after the first try.
const WORKER_INIT_CALLS = 6;
// Captured 2026-11-13T05:20:44Z from east.back.tilion.dev for sess_993d70a19f01…
// (CDP websocket upgrade and DELETE /v1/session/<id> returned these exact bytes).
const ALB_503_BODY =
  '<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body>\r\n' +
  '<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n</body>\r\n</html>\r\n';
const ALB_503 =
  'HTTP/1.1 503 Service Temporarily Unavailable\r\nServer: awselb/2.0\r\n' +
  `Content-Type: text/html\r\nContent-Length: ${Buffer.byteLength(ALB_503_BODY)}\r\n` +
  `Connection: close\r\n\r\n${ALB_503_BODY}`;

type Worker = 'dead' | 'healthy' | 'no-id';

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`External network forbidden in Tilion dead-worker fixture: ${url.hostname}`);
  }
  return originalFetch(input, init);
}) as typeof fetch;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

/** The dead worker's data plane: every request and upgrade gets the ALB 503. */
async function startDeadDataPlane(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.socket?.end(ALB_503);
  });
  server.on('upgrade', (_req: IncomingMessage, socket: Socket) => socket.end(ALB_503));
  return { server, port: await listen(server) };
}

async function startHealthyWorker(): Promise<{ browser: Browser; endpoint: string }> {
  const port = await freePort();
  const browser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${port}`],
  });
  return { browser, endpoint: `http://127.0.0.1:${port}` };
}

interface FakeTilion {
  server: Server;
  baseUrl: string;
  plan: Worker[];
  creates: string[];
  deletes: Map<string, number>;
  unexpected: string[];
}

async function startFakeTilion(deadPort: number, healthyEndpoint: string): Promise<FakeTilion> {
  const state: FakeTilion = {
    server: null as unknown as Server,
    baseUrl: '',
    plan: [],
    creates: [],
    deletes: new Map(),
    unexpected: [],
  };
  const dead = new Set<string>();
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-ID': randomUUID() });
    res.end(JSON.stringify(body));
  };
  state.server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fixture').pathname;
      const sessionId = /^\/v1\/session\/([^/]+)/.exec(path)?.[1];
      if (req.method === 'GET' && path === '/v1/regions') {
        json(res, 200, [{ code: 'us', name: 'United States', country: 'us' }]);
      } else if (req.method === 'POST' && path === '/v1/session') {
        const worker = state.plan.shift();
        assert(worker !== undefined, 'more Tilion creates than the scenario planned');
        const prefix = worker === 'dead' ? 'sess_993d70' : 'sess_c3d0eb';
        const id = `${prefix}${randomUUID().replace(/-/g, '').slice(0, 21)}`;
        state.creates.push(worker === 'no-id' ? '<no-id>' : id);
        if (worker === 'dead') dead.add(id);
        const connectUrl =
          worker === 'dead' ? `ws://127.0.0.1:${deadPort}/cdp/${id}?token=t` : healthyEndpoint;
        json(res, 201, {
          ...(worker === 'no-id' ? {} : { session_id: id }),
          state: 'live',
          created_at: Date.now() / 1000,
          connect_url: worker === 'no-id' ? null : connectUrl,
          exit_id: null,
        });
      } else if (sessionId && dead.has(sessionId)) {
        if (req.method === 'DELETE')
          state.deletes.set(sessionId, (state.deletes.get(sessionId) ?? 0) + 1);
        res.socket?.end(ALB_503);
      } else if (sessionId && req.method === 'POST' && path.endsWith('/view-token')) {
        json(res, 200, { live_view_url: `/v1/session/${sessionId}/live-view?token=t` });
      } else if (sessionId && req.method === 'DELETE') {
        state.deletes.set(sessionId, (state.deletes.get(sessionId) ?? 0) + 1);
        res.writeHead(204).end();
      } else {
        // Only the Tilion API surface is contract; hosts may probe any local listener.
        if (path.startsWith('/v1/')) state.unexpected.push(`${req.method} ${path}`);
        json(res, 404, { detail: 'not in fixture' });
      }
    });
  });
  state.baseUrl = `http://127.0.0.1:${await listen(state.server)}`;
  return state;
}

async function main() {
  // The checked-in back-end/.env targets production; this fixture writes rows.
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(database.hostname), 'local database required');
  assert.match(database.pathname, /^\/victoria(_[\w-]+)?$/);
  const dead = await startDeadDataPlane();
  const healthy = await startHealthyWorker();
  const tilion = await startFakeTilion(dead.port, healthy.endpoint);
  process.env.TILION_BASE_URL = tilion.baseUrl;
  // Production shape: Tilion is the default provider with direct egress.
  process.env.BROWSER_PROVIDER = 'tilion';
  process.env.TILION_API_KEY = 'fixture-tilion-key';
  process.env.TILION_PROXY_TYPE = 'direct';
  delete process.env.BROWSER_AGENT_TILION_ENABLED;
  // Saved-credential lookup reaches AgentPhone; it is not part of provider init.
  const authOptions = await import('../../providers/authOptions');
  await mock.module('../../providers/authOptions', {
    namedExports: {
      ...authOptions,
      getAuthOptions: async () => ({
        realm: 'shop.example.test',
        steel_session: null,
        cookie_bundles: [],
        passwords: [],
        passkeys: [],
        email_otp: { available: false, connected_emails: [], match_for_site_account: null },
        readable_identifiers: [],
        minted: null,
      }),
    },
  });
  const { prisma } = await import('../../providers/database');
  const { initSession } = await import('../../domains/browser-session/service');
  const { logicalBrowserTaskId } = await import('../../providers/browser/logicalSession');
  const userId = `tilion-dead-worker-${randomUUID()}`;
  const failures: string[] = [];

  /** The worker's bounded transient-retry loop over POST /browser-session/init. */
  async function workerInit(agentId: string) {
    const errors: string[] = [];
    for (let call = 1; call <= WORKER_INIT_CALLS; call++) {
      try {
        return { session: await initSession(userId, agentId, START_URL), errors };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { session: null, errors };
  }

  async function scenario(name: string, plan: Worker[], expectSuccess: boolean) {
    const agentId = randomUUID();
    await prisma.agent.create({ data: { id: agentId, userId, goal: `tilion ${name}` } });
    tilion.plan = [...plan];
    tilion.creates.length = 0;
    tilion.deletes.clear();
    const { session, errors } = await workerInit(agentId);
    const row = await prisma.browserSession.findUnique({
      where: { id: logicalBrowserTaskId(agentId) },
    });
    const deadIds = tilion.creates.filter((id) => id.startsWith('sess_993d70'));
    const observed = {
      creates: tilion.creates.map((id) => id.slice(0, 11)),
      errors: errors.map((e) => e.slice(0, 160)),
      bound: row?.sessionId ?? null,
      status: row?.status ?? null,
    };
    if (expectSuccess) {
      if (session === null || !session.session_id.startsWith('sess_c3d0eb'))
        failures.push(
          `${name}: no healthy session after the worker retries ${JSON.stringify(observed)}`
        );
      else if (row?.sessionId !== session.session_id || row.status !== 'ACTIVE')
        failures.push(`${name}: healthy session not bound ACTIVE ${JSON.stringify(observed)}`);
      if (tilion.plan.length !== 0)
        failures.push(`${name}: planned creates unused ${JSON.stringify(observed)}`);
    } else if (session !== null || tilion.creates.length !== plan.length) {
      failures.push(`${name}: ambiguous allocation must stay latched ${JSON.stringify(observed)}`);
    }
    for (const id of deadIds) {
      if ((tilion.deletes.get(id) ?? 0) === 0)
        failures.push(`${name}: dead session ${id.slice(0, 11)} release never attempted`);
    }
    if (errors.some((e) => e.includes('before readiness')) && expectSuccess)
      failures.push(
        `${name}: a worker retry inherited the failed receipt ${JSON.stringify(observed)}`
      );
    console.log(`scenario ${name}: ${JSON.stringify(observed)}`);
  }

  try {
    await prisma.user.create({ data: { userId, isAnonymous: false } });
    // One dead create: the adapter's second create must land on the healthy worker.
    await scenario('dead-then-healthy', ['dead', 'healthy'], true);
    // Both adapter creates dead: the worker's retry must create afresh.
    await scenario('dead-dead-then-healthy', ['dead', 'dead', 'healthy'], true);
    // A create that returned no session id is ambiguous: no retry may allocate again.
    await scenario('unidentified-allocation', ['no-id', 'no-id'], false);
    assert.deepEqual(tilion.unexpected, [], 'Tilion calls outside the fixture contract');
    assert.deepEqual(failures, [], 'dead Tilion worker must not end browser init');
    console.log('PASS Tilion dead worker: second create, fresh worker retry, ambiguous latch');
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: {
        operationType: 'browser_session_initialization',
        request: { path: ['userId'], equals: userId },
      },
    });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
    await healthy.browser.close();
    for (const server of [tilion.server, dead.server]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    globalThis.fetch = originalFetch;
  }
}

// Exit explicitly: a failure before cleanup must not leave loopback servers holding the process.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
