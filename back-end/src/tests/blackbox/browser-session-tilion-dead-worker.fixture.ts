/**
 * Dead Tilion worker at browser init and resume (2026-11-13, east pool, sess_993d70*):
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

// Set once the loopback server listens: resume restores navigate real Chromium here.
let START_URL = '';
// Worker budget: the first call plus agents SESSION_INIT_TRANSIENT_MAX_ATTEMPTS (4) retries.
const WORKER_INIT_CALLS = 5;
// Captured 2026-11-13T05:20:44Z from east.back.tilion.dev for sess_993d70a19f01…
// (CDP websocket upgrade and DELETE /v1/session/<id> returned these exact bytes).
const ALB_503_BODY =
  '<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body>\r\n' +
  '<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n</body>\r\n</html>\r\n';
const ALB_503 =
  'HTTP/1.1 503 Service Temporarily Unavailable\r\nServer: awselb/2.0\r\n' +
  `Content-Type: text/html\r\nContent-Length: ${Buffer.byteLength(ALB_503_BODY)}\r\n` +
  `Connection: close\r\n\r\n${ALB_503_BODY}`;

/**
 * One planned answer per POST /v1/session. Capacity and keyed-create plans replay
 * the 2026-11-15 parallel-wave smoke (PR #2110, agent-payment-test-shop): 503
 * capacity_unavailable ×2 (Retry-After 5 in production; 0 here to bound runtime),
 * then a create that never answered within the 15 s client timeout.
 * - capacity: 503 capacity_unavailable, nothing allocated.
 * - hang: allocates a session under the request's Idempotency-Key, never answers.
 * - in-flight: 409 idempotency_key_in_use (a create under this key is still running).
 * - replay: the documented keyed replay, 201 with the key's session.
 */
type Worker =
  'dead' | 'healthy' | 'no-id' | 'no-connect-url' | 'capacity' | 'hang' | 'in-flight' | 'replay';

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
  /** Every POST /v1/session: its planned answer and Idempotency-Key. */
  posts: { worker: Worker; key: string }[];
  deletes: Map<string, number>;
  unexpected: string[];
  noConnectUrl: string[];
}

async function startFakeTilion(deadPort: number, healthyEndpoint: string): Promise<FakeTilion> {
  const state: FakeTilion = {
    server: null as unknown as Server,
    baseUrl: '',
    plan: [],
    creates: [],
    posts: [],
    deletes: new Map(),
    unexpected: [],
    noConnectUrl: [],
  };
  const dead = new Set<string>();
  const released = new Set<string>();
  const keyed = new Map<string, string>();
  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Request-ID': randomUUID(),
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  state.server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fixture').pathname;
      const sessionId = /^\/v1\/session\/([^/]+)/.exec(path)?.[1];
      if (req.method === 'GET' && path === '/account') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<title>Account</title><p>fixture</p>');
      } else if (req.method === 'GET' && path === '/v1/regions') {
        json(res, 200, [{ code: 'us', name: 'United States', country: 'us' }]);
      } else if (req.method === 'POST' && path === '/v1/session') {
        const worker = state.plan.shift();
        if (worker === undefined) {
          // Recorded, never thrown: a throw in this handler crashes the process before the
          // scenarios' own failures are asserted and before cleanup runs.
          state.unexpected.push('POST /v1/session beyond the scenario plan');
          json(res, 500, { detail: 'fixture create beyond plan' });
          return;
        }
        const key = String(req.headers['idempotency-key'] ?? '');
        state.posts.push({ worker, key });
        if (worker === 'capacity') {
          json(
            res,
            503,
            {
              detail: {
                error: 'capacity_unavailable',
                message: 'no session capacity in this region right now; please retry',
              },
            },
            { 'Retry-After': '0' }
          );
          return;
        }
        if (worker === 'in-flight') {
          json(
            res,
            409,
            { detail: { error: 'idempotency_key_in_use', message: 'create still running' } },
            { 'Retry-After': '0' }
          );
          return;
        }
        if (worker === 'replay') {
          const replayed = keyed.get(key);
          if (replayed === undefined) {
            state.unexpected.push('replay of an Idempotency-Key that allocated nothing');
            json(res, 500, { detail: 'fixture replay without allocation' });
          } else
            json(res, 201, {
              session_id: replayed,
              state: 'live',
              created_at: Date.now() / 1000,
              connect_url: healthyEndpoint,
              exit_id: null,
            });
          return;
        }
        const prefix = worker === 'dead' ? 'sess_993d70' : 'sess_c3d0eb';
        const id = `${prefix}${randomUUID().replace(/-/g, '').slice(0, 21)}`;
        state.creates.push(worker === 'no-id' ? '<no-id>' : id);
        if (worker === 'dead') dead.add(id);
        if (worker === 'no-connect-url') state.noConnectUrl.push(id);
        if (worker === 'hang') {
          // Allocated, but the reply is lost: only a keyed replay can identify it.
          keyed.set(key, id);
          return;
        }
        const connectUrl =
          worker === 'dead' ? `ws://127.0.0.1:${deadPort}/cdp/${id}?token=t` : healthyEndpoint;
        json(res, 201, {
          ...(worker === 'no-id' ? {} : { session_id: id }),
          state: 'live',
          created_at: Date.now() / 1000,
          connect_url: worker === 'no-id' || worker === 'no-connect-url' ? null : connectUrl,
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
        released.add(sessionId);
        res.writeHead(204).end();
      } else if (sessionId && req.method === 'GET' && path === `/v1/session/${sessionId}/status`) {
        const now = Date.now() / 1000;
        if (released.has(sessionId)) json(res, 404, { detail: 'session not found' });
        else
          json(res, 200, { state: 'ready', created_at: now - 30, ttl: 600, expires_at: now + 570 });
      } else if (sessionId && req.method === 'GET' && path === `/v1/session/${sessionId}`) {
        if (released.has(sessionId)) json(res, 410, { detail: 'session closed' });
        else
          json(res, 200, {
            session_id: sessionId,
            state: 'live',
            created_at: Date.now() / 1000 - 30,
            ttl: 600,
            idle_timeout: 120,
            connect_url: healthyEndpoint,
          });
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
  START_URL = `${tilion.baseUrl}/account`;
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
        realm: '127.0.0.1',
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
  const { initSession, closeBrowserSession } =
    await import('../../domains/browser-session/service');
  const { resumeOwnedBrowserSession } =
    await import('../../domains/browser-session/service.control');
  const { logicalBrowserTaskId } = await import('../../providers/browser/logicalSession');
  const { TILION_TASK_CREATE_ATTEMPTS } =
    await import('../../providers/browser/tilionCreateValidation');
  const { TILION_SESSION_CREATE_MAX_ATTEMPTS } =
    await import('../../providers/browser/tilionClient');
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

  async function scenario(
    name: string,
    plan: Worker[],
    expectSuccess: boolean,
    expectedKeys?: number
  ) {
    const agentId = randomUUID();
    await prisma.agent.create({ data: { id: agentId, userId, goal: `tilion ${name}` } });
    tilion.plan = [...plan];
    tilion.creates.length = 0;
    tilion.posts.length = 0;
    tilion.deletes.clear();
    const { session, errors } = await workerInit(agentId);
    const row = await prisma.browserSession.findUnique({
      where: { id: logicalBrowserTaskId(agentId) },
    });
    const deadIds = tilion.creates.filter((id) => id.startsWith('sess_993d70'));
    const keys = new Set(tilion.posts.map((post) => post.key));
    const observed = {
      creates: tilion.creates.map((id) => id.slice(0, 11)),
      posts: tilion.posts.map((post) => post.worker),
      keys: keys.size,
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
    } else if (session !== null || tilion.posts.length !== plan.length) {
      failures.push(`${name}: failed create must stay latched ${JSON.stringify(observed)}`);
    }
    // A keyed create is settled by replaying its key, never relaunched under a new one.
    if (expectedKeys !== undefined && keys.size !== expectedKeys)
      failures.push(
        `${name}: expected ${expectedKeys} Idempotency-Key(s) ${JSON.stringify(observed)}`
      );
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

  /** A paused browser resumes onto a replacement session while two creates land dead. */
  async function resumeScenario() {
    const agentId = randomUUID();
    await prisma.agent.create({ data: { id: agentId, userId, goal: 'tilion resume' } });
    tilion.plan = ['healthy'];
    tilion.creates.length = 0;
    tilion.deletes.clear();
    const first = await initSession(userId, agentId, START_URL);
    await closeBrowserSession(first.session_id, true);
    tilion.plan = ['dead', 'dead', 'healthy'];
    tilion.creates.length = 0;
    tilion.deletes.clear();
    let resumed: { session_id?: string | null } | null = null;
    let error: string | null = null;
    try {
      resumed = await resumeOwnedBrowserSession(logicalBrowserTaskId(agentId), userId);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const observed = {
      creates: tilion.creates.map((id) => id.slice(0, 11)),
      resumed: resumed?.session_id?.slice(0, 11) ?? null,
      error: error?.slice(0, 160) ?? null,
    };
    if (!resumed?.session_id?.startsWith('sess_c3d0eb') || resumed.session_id === first.session_id)
      failures.push(
        `resume-dead-dead-then-healthy: no healthy replacement ${JSON.stringify(observed)}`
      );
    for (const id of tilion.creates.filter((created) => created.startsWith('sess_993d70'))) {
      if ((tilion.deletes.get(id) ?? 0) === 0)
        failures.push(`resume-dead-dead-then-healthy: dead ${id.slice(0, 11)} never released`);
    }
    console.log(`scenario resume-dead-dead-then-healthy: ${JSON.stringify(observed)}`);
  }

  try {
    await prisma.user.create({ data: { userId, isAnonymous: false } });
    // One dead create: the adapter's second create must land on the healthy worker.
    await scenario('dead-then-healthy', ['dead', 'healthy'], true);
    // Every adapter create dead: the worker's retry must create afresh.
    const perCall = TILION_TASK_CREATE_ATTEMPTS;
    const allDead = Array<Worker>(perCall).fill('dead');
    await scenario('all-adapter-creates-dead-then-healthy', [...allDead, 'healthy'], true);
    // A create that returned no session id is ambiguous: no retry may allocate again.
    await scenario('unidentified-allocation', Array<Worker>(perCall).fill('no-id'), false);
    // A key without raw CDP is a permanent misconfiguration: one create, released, never retried.
    await scenario('no-connect-url', ['no-connect-url'], false);
    for (const id of tilion.noConnectUrl) {
      if ((tilion.deletes.get(id) ?? 0) === 0)
        failures.push(`no-connect-url: session ${id.slice(0, 11)} release never attempted`);
    }
    // PR #2110 smoke: capacity ×2, then a lost reply whose first replay is lost too. The
    // create settles by replaying its key (409 while still running, then 201) and binds it.
    await scenario(
      'capacity-then-lost-replies-replayed',
      ['capacity', 'capacity', 'hang', 'hang', 'in-flight', 'replay'],
      true,
      1
    );
    // Capacity for a whole create call: a definite rejection, so the worker's retry creates afresh.
    const capacityCall = Array<Worker>(TILION_SESSION_CREATE_MAX_ATTEMPTS).fill('capacity');
    await scenario('capacity-exhausted-then-healthy', [...capacityCall, 'healthy'], true, 2);
    // A create still in flight at the call's end may own a browser: latched, never relaunched.
    const inFlight = Array<Worker>(TILION_SESSION_CREATE_MAX_ATTEMPTS - 1).fill('in-flight');
    await scenario('unsettled-keyed-create-stays-latched', ['hang', ...inFlight], false, 1);
    // A rejection after a lost reply cannot prove that reply allocated nothing: still latched.
    const rejected = Array<Worker>(TILION_SESSION_CREATE_MAX_ATTEMPTS - 1).fill('capacity');
    await scenario('capacity-after-lost-reply-stays-latched', ['hang', ...rejected], false, 1);
    // Resume replacements have no outer retry: the adapter's own creates must reach a healthy worker.
    await resumeScenario();
    // One assertion so a failure always prints both: scenario failures name the boundary.
    assert.deepEqual(
      { failures, unexpected: tilion.unexpected },
      { failures: [], unexpected: [] },
      'dead Tilion worker must not end browser init, and Tilion calls stay in the fixture contract'
    );
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
  // A create that arrived during cleanup (after the assertion above) still fails the run.
  assert.deepEqual(tilion.unexpected, [], 'Tilion calls outside the fixture contract');
  console.log(
    'PASS Tilion dead worker: second create, fresh worker retry, latched non-retryable creates, capacity retry, keyed replay, resume replacement'
  );
}

// Exit explicitly: a failure before cleanup must not leave loopback servers holding the process.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
