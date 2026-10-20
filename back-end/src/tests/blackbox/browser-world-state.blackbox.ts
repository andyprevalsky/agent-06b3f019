#!/usr/bin/env tsx
/**
 * The user's one browser template, split by website and account (plan row A6).
 *
 * The provider boundary is a local Chromium (the same stand-in the
 * auth-persist and steel-injection suites use), so no cloud browser starts.
 * Fork runs through the real `/prepare-auth` service and injection path; merge
 * through the real close-time harvest; reads through the HTTP routes.
 *
 * Invariants:
 *   - fork is scoped to the prepared site (no other template site is injected)
 *   - every credential a task holds at close percolates into the template;
 *     a collision within one account keeps the best login (keep-best rule in
 *     providers/browser/worldStateKeepBest.ts), different accounts never compete
 *   - a logged-out, expired, empty or superseded state never replaces a login
 *   - owner scoping on every read and write
 *   - a retried close (activity retry, rule 20) never writes twice
 *   - the home browser opens only on request, from the template, at the URL
 *     its root agent's tree is working on
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import {
  mergeSessionWorldState,
  ROOT_BROWSER_SOURCE,
  rootBrowserAgentId,
} from '../../providers/browser/worldState';
import {
  closeRootBrowser,
  openRootBrowser,
  type RootBrowserDeps,
} from '../../domains/browser-world/service';
import { keepBestCases } from './browser-world-state.keep-best.cases';
import {
  api,
  assert,
  BASE_URL,
  browsers,
  cleanup,
  cookieValue,
  createAgentTask,
  createUser,
  fingerprintOf,
  fork,
  freshBrowser,
  headOf,
  outcomeOf,
  seedTemplate,
  setSiteCookie,
  templateCookieValue,
  users,
} from './browser-world-state.support';

async function forkIsScopedToThePreparedSite(): Promise<void> {
  const userId = await createUser('scope');
  await seedTemplate(userId, 'example.com', 'root-com', 3);
  await seedTemplate(userId, 'example.org', 'root-org', 1);
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();

  await fork(task, userId, browser, 'https://www.example.com/account');

  assert(
    (await cookieValue(context, 'example.com')) === 'root-com',
    'the prepared site did not receive the template login'
  );
  assert(
    (await cookieValue(context, 'example.org')) === undefined,
    'a site the agent never prepared was injected (full-jar fork)'
  );
  const forks = await prisma.browserSiteFork.findMany({ where: { browserSessionId: task.id } });
  assert(forks.length === 1 && forks[0]?.site === 'example.com', JSON.stringify(forks));
  assert(forks[0].baseRevision === 3, `base revision ${forks[0].baseRevision}, expected 3`);
  assert(forks[0].account === '', `forked account ${forks[0].account}`);
  assert(
    forks[0].baseFingerprint === fingerprintOf('example.com', 'root-com'),
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
  assert(head.validatedAt !== null, 'sign-in evidence did not validate the login');
  assert((await templateCookieValue(userId, 'example.net')) === 'agent-login', 'cookie missing');

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

async function unchangedAndLoggedOutSitesKeepTheTemplate(): Promise<void> {
  const userId = await createUser('nomerge');
  await seedTemplate(userId, 'example.com', 'root-com', 3);
  await seedTemplate(userId, 'example.org', 'root-org', 2);
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();
  await fork(task, userId, browser, 'https://example.com/');
  await fork(task, userId, browser, 'https://example.org/');
  await fork(task, userId, browser, 'https://example.edu/');
  // example.edu: a first login (here an anonymous visit) needs no sign-in evidence.
  await setSiteCookie(context, 'example.edu', 'session', 'first-visit');
  // example.org: the site signed the agent out and issued a different cookie.
  await context.clearCookies({ domain: '.example.org' });
  await setSiteCookie(context, 'example.org', 'auth_token', 'guest');

  const receipt = await mergeSessionWorldState(task.sessionId, { browser });

  assert(outcomeOf(receipt, 'example.com')?.outcome === 'unchanged', JSON.stringify(receipt));
  assert(outcomeOf(receipt, 'example.org')?.outcome === 'signed_out', JSON.stringify(receipt));
  assert(outcomeOf(receipt, 'example.edu')?.outcome === 'merged', JSON.stringify(receipt));
  assert((await headOf(userId, 'example.com'))?.revision === 3, 'unchanged site was rewritten');
  assert((await headOf(userId, 'example.org'))?.revision === 2, 'signed-out jar was merged');
  assert((await headOf(userId, 'example.edu'))?.revision === 1, 'first login did not percolate');
  assert((await templateCookieValue(userId, 'example.org')) === 'root-org', 'login was lost');
}

async function everyReadAndWriteIsOwnerScoped(): Promise<void> {
  const owner = await createUser('owner');
  const other = await createUser('other');
  await seedTemplate(owner, 'example.com', 'owner-com', 1);
  await seedTemplate(other, 'example.com', 'other-com', 5);
  await seedTemplate(other, 'example.org', 'other-org', 1);
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
  assert((await templateCookieValue(other, 'example.com')) === 'other-com', 'other rewritten');

  const anonymous = await fetch(`${BASE_URL}/api/browser-world/sites`);
  assert(anonymous.status === 401, `unauthenticated read returned ${anonymous.status}`);
  const keyOnly = await api('/api/browser-world/sites', null);
  assert(keyOnly.status === 401, `API key without a user returned ${keyOnly.status}`);

  const sites = await api('/api/browser-world/sites', owner);
  const listed = (sites.body.sites as Array<{ site: string; account: string }>).map(
    (s) => `${s.site}|${s.account}`
  );
  assert(sites.status === 200 && listed.join(',') === 'example.com|', JSON.stringify(sites.body));

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
  assert((await templateCookieValue(other, 'example.org')) === undefined, 'cookies remain');
  // A task still holding the forgotten login cannot bring it back...
  const stale = await mergeSessionWorldState(otherTask.sessionId, {
    browser: otherBrowser.browser,
  });
  assert(outcomeOf(stale, 'example.org')?.outcome === 'superseded', JSON.stringify(stale));
  assert((await headOf(other, 'example.org'))?.cookieCount === 0, 'forgotten login came back');
  // ...but a new login after the forget percolates like any other.
  await setSiteCookie(otherBrowser.context, 'example.org', 'session', 'signed-in-again');
  const fresh = await mergeSessionWorldState(otherTask.sessionId, {
    browser: otherBrowser.browser,
  });
  assert(outcomeOf(fresh, 'example.org')?.outcome === 'merged', JSON.stringify(fresh));
}

async function retriedMergeIsIdempotent(): Promise<void> {
  const userId = await createUser('retry');
  await seedTemplate(userId, 'example.com', 'root-com', 7);
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();
  await fork(task, userId, browser, 'https://example.com/');
  await setSiteCookie(context, 'example.com', 'session', 'fresh-login');

  const first = await mergeSessionWorldState(task.sessionId, { browser });
  // Temporal retries the close: the browser is still up the first time...
  const second = await mergeSessionWorldState(task.sessionId, { browser });
  // ...unreachable the next (no CDP endpoint we may dial)...
  const unreachable = await mergeSessionWorldState(task.sessionId);
  // ...and already released the last time.
  await prisma.browserSession.update({ where: { id: task.id }, data: { status: 'CLOSED' } });
  const third = await mergeSessionWorldState(task.sessionId);

  assert(outcomeOf(first, 'example.com')?.merged_revision === 8, JSON.stringify(first));
  assert(outcomeOf(first, 'example.com')?.rule === 'newer', JSON.stringify(first));
  assert(
    outcomeOf(unreachable, 'example.com')?.merged_revision === 8,
    `unreachable retry lost the receipt: ${JSON.stringify(unreachable)}`
  );
  for (const receipt of [second, third]) {
    const entry = outcomeOf(receipt, 'example.com');
    assert(
      entry?.outcome === 'unchanged' && entry.merged_revision === 8 && entry.head_revision === 8,
      `retry changed the merge: ${JSON.stringify(receipt)}`
    );
  }
  assert((await headOf(userId, 'example.com'))?.revision === 8, 'retry bumped the revision');
  const rows = await prisma.cookie.count({
    where: { userId, browserSource: ROOT_BROWSER_SOURCE, domain: '.example.com' },
  });
  assert(rows === 1, `retry duplicated template cookies (${rows})`);
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

async function homeBrowserOpensFromTheTemplateAndMergesOnClose(): Promise<void> {
  const userId = await createUser('root');
  await seedTemplate(userId, 'example.com', 'root-com', 2, { creationUtc: 13_400_000_100_000_000n });
  // A second, older account on the same site: the home browser holds ONE login per site.
  await seedTemplate(userId, 'example.com', 'other-account', 1, { account: 'chrome:Profile 2' });
  await prisma.cookie.create({
    data: {
      userId,
      name: 'sid2',
      value: 'other-sid',
      domain: '.example.com',
      path: '/',
      browserSource: ROOT_BROWSER_SOURCE,
      browserProfile: 'chrome:Profile 2',
      creationUtc: 13_400_000_000_000_000n,
      hasExpires: false,
      isPersistent: false,
    },
  });
  const { endpoint } = await cdpBrowser();
  const viewer = await chromium.connectOverCDP(endpoint);
  browsers.push(viewer);
  const homeContext = viewer.contexts()[0];
  assert(homeContext !== undefined, 'CDP browser has no default context');
  // The persistent profile already carries an earlier visit.
  await setSiteCookie(homeContext, 'example.edu', 'session', 'profile-visit');

  let created = 0;
  const deps: RootBrowserDeps = {
    createSession: async (contextId, agentId, startUrl) => {
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
          startUrl: startUrl ?? null,
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
  assert(root.start_url === null, `opened at ${String(root.start_url)}`);
  assert((await cookieValue(homeContext, 'example.com')) === 'root-com', 'template not injected');
  assert(
    (await cookieValue(homeContext, 'example.com', 'sid2')) === undefined,
    'two accounts were injected into one jar'
  );
  const again = await openRootBrowser(userId, {}, deps);
  assert(again.task_id === root.task_id && created === 1, 'a live home browser was not reused');
  const session = await prisma.browserSession.findUniqueOrThrow({ where: { id: root.task_id } });
  assert(session.agentId === rootBrowserAgentId(userId), 'home session is not marked as home');

  const view = await api('/api/browser-world/root', userId);
  const viewRoot = view.body.root as { task_id: string; live_view_path: string } | null;
  assert(view.status === 200 && viewRoot?.task_id === root.task_id, JSON.stringify(view.body));
  assert(
    viewRoot.live_view_path === `/api/browser-session/task/${root.task_id}/live-view`,
    'home takeover path missing'
  );

  // While it is open an agent signs in to example.com; the home tab never touches it.
  const task = await createAgentTask(userId);
  const agent = await freshBrowser();
  await fork(task, userId, agent.browser, 'https://example.com/');
  await setSiteCookie(agent.context, 'example.com', 'session', 'agent-com');
  await mergeSessionWorldState(task.sessionId, { browser: agent.browser });
  // The user signs in to a new site in the home browser.
  await setSiteCookie(homeContext, 'example.org', 'session', 'user-org');

  const { world_state: closed } = await closeRootBrowser(userId, deps);

  assert(closed?.kind === 'root', JSON.stringify(closed));
  assert(outcomeOf(closed, 'example.org')?.outcome === 'merged', JSON.stringify(closed));
  // The home tab still holds the login the agent replaced: it is stale, not better.
  assert(outcomeOf(closed, 'example.com')?.outcome === 'superseded', JSON.stringify(closed));
  // Every credential percolates, including what the persistent profile held.
  assert(outcomeOf(closed, 'example.edu')?.outcome === 'merged', JSON.stringify(closed));
  const org = await headOf(userId, 'example.org');
  assert(org?.revision === 1 && org.lastWriterKind === 'root', JSON.stringify(org));
  assert((await templateCookieValue(userId, 'example.com')) === 'agent-com', 'home clobbered');
  assert(
    (await templateCookieValue(userId, 'example.com', 'chrome:Profile 2')) === 'other-account',
    'the other account was touched'
  );
  const afterClose = await api('/api/browser-world/root', userId);
  assert(afterClose.body.root === null, 'closed home browser still reported open');
}

async function rootRoutesValidateBeforeTouchingAProvider(): Promise<void> {
  const userId = await createUser('routes');
  const post = (path: string, body: unknown) =>
    api(path, userId, { method: 'POST', body: JSON.stringify(body) });
  const badUrl = await post('/api/browser-world/root/open', { start_url: 'not a url' });
  assert(badUrl.status === 400, `bad start_url returned ${badUrl.status}`);
  const badAgent = await post('/api/browser-world/root/open', { agent_id: 'not-a-uuid' });
  assert(badAgent.status === 400, `bad agent_id returned ${badAgent.status}`);
  const unknownField = await post('/api/browser-world/root/open', { profile: 'other-user' });
  assert(unknownField.status === 400, `unknown field returned ${unknownField.status}`);
  const notOpen = await post('/api/browser-world/root/close', {});
  assert(notOpen.status === 404, `closing an unopened home browser returned ${notOpen.status}`);
  const none = await api('/api/browser-world/root', userId);
  assert(none.status === 200 && none.body.root === null, JSON.stringify(none.body));
  const badAgentView = await api('/api/browser-world/agents/not-a-uuid', userId);
  assert(badAgentView.status === 400, `bad agent id returned ${badAgentView.status}`);
  const badSite = await api('/api/browser-world/sites/bad%20site', userId, { method: 'DELETE' });
  assert(badSite.status === 400, `bad site returned ${badSite.status}`);
  const anonymousOpen = await fetch(`${BASE_URL}/api/browser-world/root/open`, { method: 'POST' });
  assert(anonymousOpen.status === 401, `unauthenticated open returned ${anonymousOpen.status}`);
}

async function main(): Promise<void> {
  process.stdout.write('Browser World State Black-box Tests\n');
  const cases: Array<[string, () => Promise<void>]> = [
    ['fork is scoped to the prepared site', forkIsScopedToThePreparedSite],
    ['a new login merges and seeds the next fork', newLoginMergesAndSeedsTheNextFork],
    [
      'unchanged and logged-out sites keep the template',
      unchangedAndLoggedOutSitesKeepTheTemplate,
    ],
    ['every read and write is owner scoped', everyReadAndWriteIsOwnerScoped],
    ['a retried merge is idempotent', retriedMergeIsIdempotent],
    ['home routes validate before touching a provider', rootRoutesValidateBeforeTouchingAProvider],
    [
      'the home browser opens from the template and merges on close',
      homeBrowserOpensFromTheTemplateAndMergesOnClose,
    ],
    ...keepBestCases,
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
