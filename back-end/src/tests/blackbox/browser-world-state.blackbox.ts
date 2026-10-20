#!/usr/bin/env tsx
/**
 * Root browser world state split by website (plan row A6).
 *
 * The provider boundary is a local Chromium (the same stand-in the
 * auth-persist and steel-injection suites use), so no cloud browser starts.
 * Fork runs through the real `/prepare-auth` service and injection path; merge
 * through the real close-time harvest; reads through the HTTP routes.
 *
 * Invariants:
 *   - fork is scoped to the prepared site (no other Root site is injected)
 *   - a new login merges into Root; Root then seeds the next agent's fork
 *   - unchanged and anonymous sites do not merge; a lost login does not merge
 *   - a stale agent cannot overwrite a newer Root login (guarded LWW)
 *   - owner scoping on every read and write
 *   - a retried merge (activity retry, rule 20) never bumps the revision twice
 *   - the Root browser opens from Root state, merges only what the user changed
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { prisma } from '../../providers/database';
import {
  mergeSessionWorldState,
  ROOT_BROWSER_PROFILE,
  ROOT_BROWSER_SOURCE,
  rootBrowserAgentId,
  siteAuthSnapshot,
  type WorldStateMergeReceipt,
} from '../../providers/browser/worldState';
import { prepareSessionCredentials } from '../../domains/browser-session/service';
import {
  closeRootBrowser,
  openRootBrowser,
  type RootBrowserDeps,
} from '../../domains/browser-world/service';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY ?? '';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── fixtures ──────────────────────────────────────────────────────────────

const users: string[] = [];

async function createUser(label: string): Promise<string> {
  const userId = `world-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  users.push(userId);
  return userId;
}

async function cleanup(userId: string): Promise<void> {
  await prisma.browserSession.deleteMany({ where: { context: { userId } } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.browserSiteState.deleteMany({ where: { userId } });
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function createAgentTask(userId: string, options: { agentId?: string } = {}) {
  const agentId = options.agentId ?? randomUUID();
  if (options.agentId === undefined) {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal: 'Use the root browser world state',
        status: 'ACTIVE',
        temporalWorkflowId: agentId,
      },
    });
  }
  const context = await prisma.browserContext.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId,
      sessionId: `world-${randomUUID()}`,
      // The caller hands the real (local) browser to every call.
      wsUrl: 'ws://already-connected.invalid',
      provider: 'kernel',
      status: 'ACTIVE',
      startUrl: 'https://example.com/',
      providerProfileSource: 'user_persistent',
      providerProfilePersist: true,
    },
  });
}

/** Root state for one site, written the way a merge writes it. */
async function seedRootSite(userId: string, site: string, value: string, revision: number) {
  const cookie = { name: 'session', value, domain: `.${site}`, path: '/' };
  await prisma.cookie.create({
    data: {
      userId,
      ...cookie,
      isSecure: true,
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: ROOT_BROWSER_PROFILE,
      creationUtc: 13_400_000_000_000_000n,
      hasExpires: false,
      isPersistent: false,
    },
  });
  await prisma.cookieBundle.create({
    data: {
      userId,
      authRealm: site,
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: ROOT_BROWSER_PROFILE,
    },
  });
  await prisma.browserSiteState.create({
    data: {
      userId,
      site,
      revision,
      authFingerprint: siteAuthSnapshot([cookie], site).fingerprint,
      cookieCount: 1,
      lastWriterKind: 'agent',
    },
  });
}

async function setSiteCookie(context: BrowserContext, site: string, name: string, value: string) {
  await context.addCookies([
    { name, value, domain: `.${site}`, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
  ]);
}

async function cookieValue(context: BrowserContext, site: string, name = 'session') {
  const cookies = await context.cookies();
  return cookies.find((cookie) => cookie.name === name && cookie.domain === `.${site}`)?.value;
}

async function headOf(userId: string, site: string) {
  return prisma.browserSiteState.findUnique({ where: { userId_site: { userId, site } } });
}

async function rootCookieValue(userId: string, site: string) {
  const row = await prisma.cookie.findFirst({
    where: {
      userId,
      domain: `.${site}`,
      name: 'session',
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: ROOT_BROWSER_PROFILE,
    },
  });
  return row?.value;
}

function outcomeOf(receipt: WorldStateMergeReceipt | null, site: string) {
  return receipt?.sites.find((entry) => entry.site === site);
}

const browsers: Browser[] = [];

async function freshBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const context = await browser.newContext();
  return { browser, context };
}

async function fork(session: { sessionId: string }, userId: string, browser: Browser, url: string) {
  await prepareSessionCredentials(session.sessionId, userId, url, { browser });
}

async function api(path: string, userId: string | null, init: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...(userId === null ? {} : { 'X-User-Id': userId }),
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ── cases ─────────────────────────────────────────────────────────────────

async function forkIsScopedToThePreparedSite(): Promise<void> {
  const userId = await createUser('scope');
  await seedRootSite(userId, 'example.com', 'root-com', 3);
  await seedRootSite(userId, 'example.org', 'root-org', 1);
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();

  await fork(task, userId, browser, 'https://www.example.com/account');

  assert(
    (await cookieValue(context, 'example.com')) === 'root-com',
    'the prepared site did not receive Root state'
  );
  assert(
    (await cookieValue(context, 'example.org')) === undefined,
    'a site the agent never prepared was injected (full-jar fork)'
  );
  const forks = await prisma.browserSiteFork.findMany({ where: { browserSessionId: task.id } });
  assert(forks.length === 1 && forks[0]?.site === 'example.com', JSON.stringify(forks));
  assert(forks[0].baseRevision === 3, `base revision ${forks[0].baseRevision}, expected 3`);
  assert(
    forks[0].baseFingerprint ===
      siteAuthSnapshot(
        [{ name: 'session', value: 'root-com', domain: '.example.com', path: '/' }],
        'example.com'
      ).fingerprint,
    'fork base is not the jar the session started from'
  );
}

async function newLoginMergesAndSeedsTheNextFork(): Promise<void> {
  const userId = await createUser('merge');
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();
  await fork(task, userId, browser, 'https://example.net/login');
  await setSiteCookie(context, 'example.net', 'session', 'agent-login');

  const receipt = await mergeSessionWorldState(task.sessionId, {
    browser,
    signedInSites: ['example.net'],
  });

  const entry = outcomeOf(receipt, 'example.net');
  assert(entry?.outcome === 'merged' && entry.merged_revision === 1, JSON.stringify(receipt));
  const head = await headOf(userId, 'example.net');
  assert(head?.revision === 1 && head.lastWriterTaskId === task.id, JSON.stringify(head));
  assert(head.lastWriterAgentId === task.agentId && head.lastWriterKind === 'agent', 'writer');
  assert((await rootCookieValue(userId, 'example.net')) === 'agent-login', 'Root cookie missing');

  const next = await createAgentTask(userId);
  const nextBrowser = await freshBrowser();
  await fork(next, userId, nextBrowser.browser, 'https://example.net/');
  assert(
    (await cookieValue(nextBrowser.context, 'example.net')) === 'agent-login',
    'the merged login did not seed the next agent'
  );
  const nextFork = await prisma.browserSiteFork.findUniqueOrThrow({
    where: { browserSessionId_site: { browserSessionId: next.id, site: 'example.net' } },
  });
  assert(nextFork.baseRevision === 1, `next fork base ${nextFork.baseRevision}`);
}

async function unchangedAnonymousAndSignedOutSitesDoNotMerge(): Promise<void> {
  const userId = await createUser('nomerge');
  await seedRootSite(userId, 'example.com', 'root-com', 3);
  await seedRootSite(userId, 'example.org', 'root-org', 2);
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();
  await fork(task, userId, browser, 'https://example.com/');
  await fork(task, userId, browser, 'https://example.org/');
  await fork(task, userId, browser, 'https://example.edu/');
  // example.edu: an anonymous visit leaves an auth-looking cookie, no sign-in.
  await setSiteCookie(context, 'example.edu', 'session', 'anonymous-visitor');
  // example.org: the site signed the agent out and issued a different cookie.
  await context.clearCookies({ domain: '.example.org' });
  await setSiteCookie(context, 'example.org', 'auth_token', 'guest');

  const receipt = await mergeSessionWorldState(task.sessionId, { browser });

  assert(outcomeOf(receipt, 'example.com')?.outcome === 'unchanged', JSON.stringify(receipt));
  assert(outcomeOf(receipt, 'example.edu')?.outcome === 'no_login_signal', JSON.stringify(receipt));
  assert(outcomeOf(receipt, 'example.org')?.outcome === 'signed_out', JSON.stringify(receipt));
  assert((await headOf(userId, 'example.com'))?.revision === 3, 'unchanged site was rewritten');
  assert((await headOf(userId, 'example.org'))?.revision === 2, 'signed-out jar was merged');
  assert((await headOf(userId, 'example.edu')) === null, 'anonymous cookies became Root state');
  assert((await rootCookieValue(userId, 'example.org')) === 'root-org', 'Root login was lost');
}

async function staleAgentCannotOverwriteNewerRootLogin(): Promise<void> {
  const userId = await createUser('stale');
  await seedRootSite(userId, 'example.com', 'root-com', 3);
  const taskA = await createAgentTask(userId);
  const taskB = await createAgentTask(userId);
  const a = await freshBrowser();
  const b = await freshBrowser();
  await fork(taskA, userId, a.browser, 'https://example.com/');
  await fork(taskB, userId, b.browser, 'https://example.com/');
  await setSiteCookie(b.context, 'example.com', 'session', 'b-login');
  await setSiteCookie(a.context, 'example.com', 'session', 'a-login');

  const merged = await mergeSessionWorldState(taskB.sessionId, { browser: b.browser });
  const stale = await mergeSessionWorldState(taskA.sessionId, { browser: a.browser });

  assert(outcomeOf(merged, 'example.com')?.outcome === 'merged', JSON.stringify(merged));
  const staleEntry = outcomeOf(stale, 'example.com');
  assert(
    staleEntry?.outcome === 'stale' &&
      staleEntry.base_revision === 3 &&
      staleEntry.head_revision === 4,
    JSON.stringify(stale)
  );
  const head = await headOf(userId, 'example.com');
  assert(head?.revision === 4 && head.lastWriterTaskId === taskB.id, JSON.stringify(head));
  assert(
    (await rootCookieValue(userId, 'example.com')) === 'b-login',
    'stale agent clobbered Root'
  );

  // The per-agent view shows which sites each task forked and how they ended.
  const viewA = await api(`/api/browser-world/agents/${taskA.agentId}`, userId);
  const tasksA = viewA.body.tasks as Array<{ task_id: string; sites: Array<{ state: string }> }>;
  assert(viewA.status === 200 && tasksA[0]?.sites[0]?.state === 'stale', JSON.stringify(viewA));
  const viewB = await api(`/api/browser-world/agents/${taskB.agentId}`, userId);
  const tasksB = viewB.body.tasks as Array<{
    task_id: string;
    live_view_path: string;
    control_path: string;
    sites: Array<{ site: string; state: string; merged_revision: number; root_revision: number }>;
  }>;
  const siteB = tasksB[0]?.sites[0];
  assert(
    siteB?.state === 'merged' && siteB.merged_revision === 4 && siteB.root_revision === 4,
    JSON.stringify(viewB)
  );
  assert(
    tasksB[0]?.live_view_path === `/api/browser-session/task/${taskB.id}/live-view` &&
      tasksB[0].control_path === `/api/browser-session/task/${taskB.id}/control`,
    'takeover paths missing from the agent view'
  );
}

async function everyReadAndWriteIsOwnerScoped(): Promise<void> {
  const owner = await createUser('owner');
  const other = await createUser('other');
  await seedRootSite(owner, 'example.com', 'owner-com', 1);
  await seedRootSite(other, 'example.com', 'other-com', 5);
  await seedRootSite(other, 'example.org', 'other-org', 1);
  const otherTask = await createAgentTask(other);
  const otherBrowser = await freshBrowser();
  await fork(otherTask, other, otherBrowser.browser, 'https://example.org/');

  // The owner's agent signs in again on a site both users have.
  const task = await createAgentTask(owner);
  const { browser, context } = await freshBrowser();
  await fork(task, owner, browser, 'https://example.com/');
  await setSiteCookie(context, 'example.com', 'session', 'owner-new');
  await mergeSessionWorldState(task.sessionId, { browser });
  assert((await headOf(owner, 'example.com'))?.revision === 2, 'owner merge missing');
  assert((await headOf(other, 'example.com'))?.revision === 5, 'merge crossed users');
  assert((await rootCookieValue(other, 'example.com')) === 'other-com', 'other Root rewritten');

  const anonymous = await fetch(`${BASE_URL}/api/browser-world/sites`);
  assert(anonymous.status === 401, `unauthenticated read returned ${anonymous.status}`);
  const keyOnly = await api('/api/browser-world/sites', null);
  assert(keyOnly.status === 401, `API key without a user returned ${keyOnly.status}`);

  const sites = await api('/api/browser-world/sites', owner);
  const listed = (sites.body.sites as Array<{ site: string; revision: number }>).map((s) => s.site);
  assert(sites.status === 200 && listed.join(',') === 'example.com', JSON.stringify(sites.body));

  const foreignAgent = await api(`/api/browser-world/agents/${otherTask.agentId}`, owner);
  assert(
    foreignAgent.status === 200 && (foreignAgent.body.tasks as unknown[]).length === 0,
    `another user's agent leaked: ${JSON.stringify(foreignAgent.body)}`
  );
  const ownAgent = await api(`/api/browser-world/agents/${otherTask.agentId}`, other);
  assert((ownAgent.body.tasks as unknown[]).length === 1, 'owner cannot see its own agent');

  const forget = await api('/api/browser-world/sites/example.org', owner, { method: 'DELETE' });
  assert(forget.status === 200 && forget.body.forgotten === false, JSON.stringify(forget.body));
  assert((await headOf(other, 'example.org'))?.cookieCount === 1, 'forget crossed users');
  const forgetOwn = await api('/api/browser-world/sites/example.org', other, { method: 'DELETE' });
  assert(forgetOwn.body.forgotten === true, JSON.stringify(forgetOwn.body));
  const tombstone = await headOf(other, 'example.org');
  assert(tombstone?.revision === 2 && tombstone.cookieCount === 0, JSON.stringify(tombstone));
  assert((await rootCookieValue(other, 'example.org')) === undefined, 'forgotten cookies remain');
  // The fork that predates the forget is now stale: it cannot resurrect the login.
  await setSiteCookie(otherBrowser.context, 'example.org', 'session', 'resurrected');
  const late = await mergeSessionWorldState(otherTask.sessionId, {
    browser: otherBrowser.browser,
  });
  assert(outcomeOf(late, 'example.org')?.outcome === 'stale', JSON.stringify(late));
}

async function retriedMergeIsIdempotent(): Promise<void> {
  const userId = await createUser('retry');
  await seedRootSite(userId, 'example.com', 'root-com', 7);
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();
  await fork(task, userId, browser, 'https://example.com/');
  await setSiteCookie(context, 'example.com', 'session', 'fresh-login');

  const first = await mergeSessionWorldState(task.sessionId, { browser });
  // Temporal retries the close: the browser is still up the first time...
  const second = await mergeSessionWorldState(task.sessionId, { browser });
  // ...and already released the next time.
  await prisma.browserSession.update({ where: { id: task.id }, data: { status: 'CLOSED' } });
  const third = await mergeSessionWorldState(task.sessionId);

  assert(outcomeOf(first, 'example.com')?.merged_revision === 8, JSON.stringify(first));
  for (const receipt of [second, third]) {
    const entry = outcomeOf(receipt, 'example.com');
    assert(
      entry?.outcome === 'unchanged' && entry.merged_revision === 8 && entry.head_revision === 8,
      `retry changed the merge: ${JSON.stringify(receipt)}`
    );
  }
  assert((await headOf(userId, 'example.com'))?.revision === 8, 'retry bumped the revision');
  const rootRows = await prisma.cookie.count({
    where: { userId, browserSource: ROOT_BROWSER_SOURCE, domain: '.example.com' },
  });
  assert(rootRows === 1, `retry duplicated Root cookies (${rootRows})`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A browser reachable over CDP, so the service can disconnect its handle. */
async function cdpBrowser(): Promise<{ endpoint: string }> {
  const port = await freePort();
  const owner = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  });
  browsers.push(owner);
  return { endpoint: `http://127.0.0.1:${port}` };
}

async function rootBrowserOpensFromRootAndMergesWhatTheUserChanged(): Promise<void> {
  const userId = await createUser('root');
  await seedRootSite(userId, 'example.com', 'root-com', 2);
  const { endpoint } = await cdpBrowser();
  const viewer = await chromium.connectOverCDP(endpoint);
  browsers.push(viewer);
  const rootContext = viewer.contexts()[0];
  assert(rootContext !== undefined, 'CDP browser has no default context');
  // The persistent profile already carries an agent's anonymous visit.
  await setSiteCookie(rootContext, 'example.edu', 'session', 'profile-anonymous');

  let created = 0;
  const deps: RootBrowserDeps = {
    createSession: async (contextId, agentId) => {
      created += 1;
      const row = await prisma.browserSession.create({
        data: {
          contextId,
          agentId,
          sessionId: `root-${randomUUID()}`,
          wsUrl: 'ws://already-connected.invalid',
          debugUrl: 'https://live.example/root',
          provider: 'kernel',
          status: 'ACTIVE',
          providerProfileSource: 'user_persistent',
        },
      });
      return {
        provider: 'kernel',
        sessionId: row.sessionId,
        debugUrl: row.debugUrl ?? '',
        taskId: row.id,
        wsUrl: row.wsUrl ?? '',
        proxySource: 'none',
        proxyLocation: { country: 'US' },
        profileId: null,
        profileSource: 'user_persistent',
        validationBrowser: await chromium.connectOverCDP(endpoint),
      };
    },
    isLive: async () => true,
    close: async (sessionId) => {
      const worldState = await mergeSessionWorldState(sessionId, { browser: viewer });
      await prisma.browserSession.update({ where: { sessionId }, data: { status: 'CLOSED' } });
      return { worldState };
    },
  };

  const root = await openRootBrowser(userId, {}, deps);
  assert(root.live_view_url === 'https://live.example/root', JSON.stringify(root));
  assert((await cookieValue(rootContext, 'example.com')) === 'root-com', 'Root state not injected');
  const again = await openRootBrowser(userId, {}, deps);
  assert(again.task_id === root.task_id && created === 1, 'a live Root browser was not reused');
  const session = await prisma.browserSession.findUniqueOrThrow({ where: { id: root.task_id } });
  assert(session.agentId === rootBrowserAgentId(userId), 'Root session is not marked as Root');

  const view = await api('/api/browser-world/root', userId);
  const viewRoot = view.body.root as { task_id: string; live_view_path: string } | null;
  assert(view.status === 200 && viewRoot?.task_id === root.task_id, JSON.stringify(view.body));
  assert(
    viewRoot.live_view_path === `/api/browser-session/task/${root.task_id}/live-view`,
    'Root takeover path missing'
  );

  // While Root is open an agent signs in to example.com; Root's tab never touches it.
  const task = await createAgentTask(userId);
  const agent = await freshBrowser();
  await fork(task, userId, agent.browser, 'https://example.com/');
  await setSiteCookie(agent.context, 'example.com', 'session', 'agent-com');
  await mergeSessionWorldState(task.sessionId, { browser: agent.browser });
  // The user signs in to a new site in the Root browser.
  await setSiteCookie(rootContext, 'example.org', 'session', 'user-org');

  const { world_state: closed } = await closeRootBrowser(userId, deps);

  assert(closed?.kind === 'root', JSON.stringify(closed));
  assert(outcomeOf(closed, 'example.org')?.outcome === 'merged', JSON.stringify(closed));
  assert(outcomeOf(closed, 'example.com')?.outcome === 'unchanged', JSON.stringify(closed));
  assert(outcomeOf(closed, 'example.edu')?.outcome === 'unchanged', JSON.stringify(closed));
  const org = await headOf(userId, 'example.org');
  assert(org?.revision === 1 && org.lastWriterKind === 'root', JSON.stringify(org));
  assert((await rootCookieValue(userId, 'example.com')) === 'agent-com', 'Root clobbered agent');
  assert((await headOf(userId, 'example.edu')) === null, 'profile cookies merged as a login');
  const afterClose = await api('/api/browser-world/root', userId);
  assert(afterClose.body.root === null, 'closed Root browser still reported open');
}

async function main(): Promise<void> {
  process.stdout.write('Browser World State Black-box Tests\n');
  const cases: Array<[string, () => Promise<void>]> = [
    ['fork is scoped to the prepared site', forkIsScopedToThePreparedSite],
    ['a new login merges and seeds the next fork', newLoginMergesAndSeedsTheNextFork],
    [
      'unchanged, anonymous and signed-out sites do not merge',
      unchangedAnonymousAndSignedOutSitesDoNotMerge,
    ],
    ['a stale agent cannot overwrite a newer Root login', staleAgentCannotOverwriteNewerRootLogin],
    ['every read and write is owner scoped', everyReadAndWriteIsOwnerScoped],
    ['a retried merge is idempotent', retriedMergeIsIdempotent],
    [
      'Root browser opens from Root and merges what the user changed',
      rootBrowserOpensFromRootAndMergesWhatTheUserChanged,
    ],
  ];
  let failed = 0;
  try {
    for (const [name, run] of cases) {
      try {
        await run();
        process.stdout.write(`  PASS  world-state -- ${name}\n`);
      } catch (error) {
        failed += 1;
        process.stdout.write(
          `  FAIL  world-state -- ${name}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  } finally {
    for (const browser of browsers.reverse()) await browser.close().catch(() => undefined);
    for (const userId of users) await cleanup(userId).catch(() => undefined);
  }
  if (failed > 0) throw new Error(`${failed} browser-world-state case(s) failed`);
  process.stdout.write('All browser-world-state blackbox tests passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
