/**
 * browser-world-state: every credential percolates into the user's one
 * browser template, collisions within one account keep the best login,
 * different accounts never compete, and the home browser opens on demand at
 * the URL its root agent's tree is working on.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  mergeHarvestedSites,
  mergeSessionWorldState,
  recordSiteFork,
  ROOT_BROWSER_SOURCE,
  rootBrowserAgentId,
  type WorldStateCookie,
  type WorldStateMergeReceipt,
} from '../../providers/browser/worldState';
import { openRootBrowser, type RootBrowserDeps } from '../../domains/browser-world/service';
import {
  api,
  assert,
  chromeMicros,
  cookieValue,
  createAgent,
  createAgentTask,
  createUser,
  DAY,
  fingerprintOf,
  fork,
  freshBrowser,
  headOf,
  jarCookie,
  nowSeconds,
  outcomeOf,
  seedSourceAccount,
  seedTemplate,
  setSiteCookie,
  templateCookieValue,
} from './browser-world-state.support';

type Task = Awaited<ReturnType<typeof createAgentTask>>;

async function close(task: Task, cookies: WorldStateCookie[], signedInSites?: string[]) {
  return mergeHarvestedSites({ browserSessionId: task.id, cookies, signedInSites });
}

function expectSite(
  receipt: WorldStateMergeReceipt | null,
  site: string,
  outcome: string,
  rule?: string | null
): void {
  const entry = outcomeOf(receipt, site);
  assert(
    entry?.outcome === outcome && (rule === undefined || entry.rule === rule),
    `${site}: expected ${outcome}${rule === undefined ? '' : `/${String(rule)}`}, got ${JSON.stringify(entry)}`
  );
}

export async function anUnforkedSitesNewLoginPercolatesIn(): Promise<void> {
  const userId = await createUser('percolate');
  const task = await createAgentTask(userId);
  const { browser, context } = await freshBrowser();
  // No /prepare-auth and no sign-in evidence: the agent just signed in somewhere.
  await setSiteCookie(context, 'example.net', 'session', 'net-login', nowSeconds() + 30 * DAY);
  await context.addCookies([{ name: '_ga', value: 'GA1.1', domain: '.example.biz', path: '/' }]);

  const receipt = await mergeSessionWorldState(task.sessionId, { browser });

  expectSite(receipt, 'example.net', 'merged', 'template_invalid');
  assert(outcomeOf(receipt, 'example.net')?.account === '', JSON.stringify(receipt));
  const head = await headOf(userId, 'example.net');
  assert(head?.revision === 1 && head.lastWriterTaskId === task.id, JSON.stringify(head));
  assert(head.validatedAt === null, 'a login without evidence was recorded as validated');
  assert((await templateCookieValue(userId, 'example.net')) === 'net-login', 'template cookie');
  assert((await headOf(userId, 'example.biz')) === null, 'a site without auth cookies merged');
  assert(outcomeOf(receipt, 'example.biz') === undefined, 'cookie-only site reported');
  const recorded = await prisma.browserSiteFork.findUnique({
    where: { browserSessionId_site: { browserSessionId: task.id, site: 'example.net' } },
  });
  assert(recorded?.mergedRevision === 1, `merge not recorded on the task: ${JSON.stringify(recorded)}`);
}

export async function collisionsKeepTheBestLogin(): Promise<void> {
  const userId = await createUser('keep-best');
  const now = nowSeconds();
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await seedTemplate(userId, 'example.com', 'expired-login', 3, { expires: now - DAY });
  await seedTemplate(userId, 'example.org', 'valid-login', 5, { expires: now + 7 * DAY });
  await seedTemplate(userId, 'example.net', 'checked', 2, {
    expires: now + 7 * DAY,
    validatedAt: anHourAgo,
  });
  await seedTemplate(userId, 'example.edu', 'long', 1, {
    expires: now + 30 * DAY,
    observedAt: new Date(),
  });
  await seedTemplate(userId, 'example.info', 'older', 4, {
    expires: now + 30 * DAY,
    observedAt: anHourAgo,
  });
  const first = await close(await createAgentTask(userId), [
    jarCookie('example.com', 'fresh-login', { expires: now + 7 * DAY }),
    jarCookie('example.org', 'dead-login', { expires: now - 60 }),
    jarCookie('example.net', 'unchecked', { expires: now + 365 * DAY }),
    jarCookie('example.edu', 'short', { expires: now + DAY }),
    jarCookie('example.info', 'newer', { expires: now + 30 * DAY }),
  ]);

  // A valid login beats an expired one; an expired one never replaces a valid one.
  expectSite(first, 'example.com', 'merged', 'template_invalid');
  assert((await templateCookieValue(userId, 'example.com')) === 'fresh-login', 'expired kept');
  assert((await headOf(userId, 'example.com'))?.revision === 4, 'one write per accepted login');
  expectSite(first, 'example.org', 'expired');
  assert((await templateCookieValue(userId, 'example.org')) === 'valid-login', 'expired won');
  assert((await headOf(userId, 'example.org'))?.revision === 5, 'expired login wrote');
  // A validated login beats an unvalidated one even with a later expiry...
  expectSite(first, 'example.net', 'kept', 'validated');
  assert((await templateCookieValue(userId, 'example.net')) === 'checked', 'validation lost');
  // ...and, neither validated, the later expiry wins over the newer state.
  expectSite(first, 'example.edu', 'kept', 'later_expiry');
  assert((await templateCookieValue(userId, 'example.edu')) === 'long', 'shorter expiry won');
  // Equal validation and expiry: the newer valid login beats the older one.
  expectSite(first, 'example.info', 'merged', 'newer');
  assert((await templateCookieValue(userId, 'example.info')) === 'newer', 'older login kept');
  assert(
    (await headOf(userId, 'example.info'))?.supersededFingerprints[0] ===
      fingerprintOf('example.info', 'older'),
    'the replaced login was not recorded as superseded'
  );

  const second = await close(
    await createAgentTask(userId),
    [
      jarCookie('example.net', 'signed-in', { expires: now + DAY }),
      jarCookie('example.edu', 'longer', { expires: now + 60 * DAY }),
    ],
    ['www.example.net']
  );
  // Sign-in evidence makes the new login the most recently validated one.
  expectSite(second, 'example.net', 'merged', 'validated');
  const net = await headOf(userId, 'example.net');
  assert(
    net?.validatedAt !== null && net!.validatedAt.getTime() > anHourAgo.getTime(),
    `validation time not recorded: ${JSON.stringify(net)}`
  );
  assert((await templateCookieValue(userId, 'example.net')) === 'signed-in', 'evidence lost');
  expectSite(second, 'example.edu', 'merged', 'later_expiry');
}

export async function aLoggedOutStateNeverClobbersAValidLogin(): Promise<void> {
  const userId = await createUser('logged-out');
  const now = nowSeconds();
  await seedTemplate(userId, 'example.com', 'valid-login', 3, { expires: now + 30 * DAY });
  await seedTemplate(userId, 'example.org', 'new-login', 6, {
    expires: now + 30 * DAY,
    superseded: [fingerprintOf('example.org', 'old-login')],
  });
  await seedTemplate(userId, 'example.net', 'valid-net', 2, { expires: now + 30 * DAY });
  await seedTemplate(userId, 'example.edu', 'valid-edu', 2, { expires: now + 30 * DAY });
  const task = await createAgentTask(userId);
  // The task forked example.edu signed in, and the site then dropped every cookie.
  await recordSiteFork({
    browserSessionId: task.id,
    userId,
    agentId: task.agentId,
    site: 'example.edu',
    account: '',
    baseRevision: 2,
    liveCookies: [jarCookie('example.edu', 'valid-edu', { expires: now + 30 * DAY })],
  });

  const receipt = await close(task, [
    // The site signed the user out and issued a guest token under another name.
    jarCookie('example.com', 'guest', { name: 'auth_token', expires: now + 30 * DAY }),
    // A stale copy of a login the template already replaced.
    jarCookie('example.org', 'old-login', { expires: now + 60 * DAY }),
    { name: '_ga', value: 'GA1.1', domain: '.example.edu', path: '/' },
  ]);

  expectSite(receipt, 'example.com', 'signed_out');
  expectSite(receipt, 'example.org', 'superseded');
  expectSite(receipt, 'example.edu', 'no_login');
  for (const [site, value, revision] of [
    ['example.com', 'valid-login', 3],
    ['example.org', 'new-login', 6],
    ['example.edu', 'valid-edu', 2],
  ] as const) {
    assert((await templateCookieValue(userId, site)) === value, `${site}: a valid login was lost`);
    assert((await headOf(userId, site))?.revision === revision, `${site}: revision moved`);
  }
  const forked = await prisma.browserSiteFork.findUniqueOrThrow({
    where: { browserSessionId_site: { browserSessionId: task.id, site: 'example.edu' } },
  });
  assert(forked.lastOutcome === 'no_login', `fork outcome ${forked.lastOutcome}`);

  // A real sign-in with a different cookie set is not a sign-out.
  const signedIn = await close(
    await createAgentTask(userId),
    [jarCookie('example.net', 'fresh', { name: 'auth_token', expires: now + DAY })],
    ['example.net']
  );
  expectSite(signedIn, 'example.net', 'merged', 'validated');
}

export async function concurrentClosesConvergeOnTheBestLogin(): Promise<void> {
  const now = nowSeconds();
  const jars = {
    a: [jarCookie('example.com', 'a', { expires: now + DAY })],
    b: [jarCookie('example.com', 'b', { expires: now + 30 * DAY })],
    c: [jarCookie('example.com', 'c', { expires: now + 7 * DAY })],
  };
  const settled = async (userId: string, expected: string, receipts: WorldStateMergeReceipt[]) => {
    const head = await headOf(userId, 'example.com');
    const merged = receipts
      .map((receipt) => outcomeOf(receipt, 'example.com'))
      .filter((entry) => entry?.outcome === 'merged');
    assert((await templateCookieValue(userId, 'example.com')) === expected, `best was ${expected}`);
    assert(head?.revision === merged.length, `revision ${head?.revision} for ${merged.length} writes`);
    const revisions = new Set(merged.map((entry) => entry?.merged_revision));
    assert(revisions.size === merged.length, 'two closes wrote the same revision');
    const rows = await prisma.cookie.count({
      where: { userId, browserSource: ROOT_BROWSER_SOURCE, domain: '.example.com' },
    });
    assert(rows === 1, `concurrent closes left ${rows} template cookie rows`);
  };

  // Simultaneous closes: the validated login wins whatever the interleaving.
  const racing = await createUser('race');
  const [ta, tb, tc] = await Promise.all([1, 2, 3].map(() => createAgentTask(racing)));
  const raced = await Promise.all([
    close(ta, jars.a),
    close(tb, jars.b),
    close(tc, jars.c, ['example.com']),
  ]);
  await settled(racing, 'c', raced.filter((receipt) => receipt !== null));

  // Without evidence the later expiry wins, in either order.
  for (const order of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    const userId = await createUser(`order-${order.join('')}`);
    const receipts: WorldStateMergeReceipt[] = [];
    for (const name of order) {
      const receipt = await close(await createAgentTask(userId), jars[name]);
      if (receipt !== null) receipts.push(receipt);
    }
    await settled(userId, 'b', receipts);
  }
}

export async function aRetriedKeptCloseWritesNothing(): Promise<void> {
  const userId = await createUser('kept-retry');
  const now = nowSeconds();
  await seedTemplate(userId, 'example.com', 'checked', 9, {
    expires: now + 7 * DAY,
    validatedAt: new Date(Date.now() - 60_000),
  });
  const task = await createAgentTask(userId);
  const jar = [jarCookie('example.com', 'unchecked', { expires: now + 365 * DAY })];
  const before = await headOf(userId, 'example.com');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expectSite(await close(task, jar), 'example.com', 'kept', 'validated');
  }
  const after = await headOf(userId, 'example.com');
  assert(
    after?.revision === 9 && after.updatedAt.getTime() === before?.updatedAt.getTime(),
    `a retried kept close wrote the head: ${JSON.stringify(after)}`
  );
  assert((await templateCookieValue(userId, 'example.com')) === 'checked', 'kept login changed');
}

export async function differentAccountsBothSurvive(): Promise<void> {
  const userId = await createUser('accounts');
  const now = nowSeconds();
  // Two synced Chrome profiles: each is its own account on example.com.
  await seedSourceAccount(userId, 'example.com', 'alice-1', {
    browserSource: 'chrome',
    browserProfile: 'Profile 1',
    creationUtc: chromeMicros(now - 60),
  });
  await seedSourceAccount(userId, 'example.com', 'bob-1', {
    browserSource: 'chrome',
    browserProfile: 'Profile 2',
    creationUtc: chromeMicros(now - 120),
  });
  const run = async (expectedInjected: string, nextValue: string | null, evidence?: string[]) => {
    const task = await createAgentTask(userId);
    const { browser, context } = await freshBrowser();
    await fork(task, userId, browser, 'https://example.com/');
    assert(
      (await cookieValue(context, 'example.com')) === expectedInjected,
      `injected ${await cookieValue(context, 'example.com')}, expected ${expectedInjected}`
    );
    if (nextValue !== null) await setSiteCookie(context, 'example.com', 'session', nextValue);
    return mergeSessionWorldState(task.sessionId, { browser, signedInSites: evidence });
  };

  // Alice's account (the fresher profile) is injected, refreshed and merged.
  const alice = await run('alice-1', 'alice-2');
  expectSite(alice, 'example.com', 'merged');
  assert(outcomeOf(alice, 'example.com')?.account === 'chrome:Profile 1', JSON.stringify(alice));
  // Bob's profile becomes the freshest source; his task merges into his account.
  await prisma.cookie.updateMany({
    where: { userId, browserSource: 'chrome', browserProfile: 'Profile 2' },
    data: { creationUtc: chromeMicros(now + 3_600) },
  });
  const bob = await run('bob-1', 'bob-2');
  expectSite(bob, 'example.com', 'merged');
  assert(outcomeOf(bob, 'example.com')?.account === 'chrome:Profile 2', JSON.stringify(bob));
  assert(
    (await templateCookieValue(userId, 'example.com', 'chrome:Profile 1')) === 'alice-2',
    'a different account was overwritten'
  );
  assert(
    (await templateCookieValue(userId, 'example.com', 'chrome:Profile 2')) === 'bob-2',
    "bob's login did not percolate"
  );

  // Two states of the SAME account resolve by keep-best.
  const stale = await run('bob-1', null);
  expectSite(stale, 'example.com', 'superseded');
  const signedIn = await run('bob-1', 'bob-3', ['example.com']);
  expectSite(signedIn, 'example.com', 'merged', 'validated');
  assert(
    (await templateCookieValue(userId, 'example.com', 'chrome:Profile 2')) === 'bob-3',
    'same-account keep-best did not take the validated login'
  );
  const aliceHead = await headOf(userId, 'example.com', 'chrome:Profile 1');
  assert(aliceHead?.revision === 1, `alice's account moved: ${JSON.stringify(aliceHead)}`);

  const listed = await api('/api/browser-world/sites', userId);
  const accounts = (listed.body.sites as Array<{ site: string; account: string }>)
    .filter((entry) => entry.site === 'example.com')
    .map((entry) => entry.account)
    .sort();
  assert(
    accounts.join(',') === 'chrome:Profile 1,chrome:Profile 2',
    `sites view: ${JSON.stringify(listed.body)}`
  );
}

export async function defaultUrlComesFromTheTreesActiveTask(): Promise<void> {
  const userId = await createUser('tree');
  const rootId = await createAgent(userId);
  const childId = await createAgent(userId, { parentAgentId: rootId, busId: rootId });
  const otherRoot = await createAgent(userId);
  const idleRoot = await createAgent(userId);
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
  await createAgentTask(userId, {
    agentId: rootId,
    status: 'CLOSED',
    currentUrl: 'https://closed.example/',
    createdAt: at(60_000),
  });
  await createAgentTask(userId, {
    agentId: childId,
    startUrl: 'https://older.example/start',
    createdAt: at(-120_000),
  });
  await createAgentTask(userId, {
    agentId: childId,
    startUrl: 'https://working.example/start',
    currentUrl: 'https://working.example/inbox',
    createdAt: at(-60_000),
  });
  await createAgentTask(userId, { agentId: otherRoot, startUrl: 'https://other.example/' });

  const view = await api(`/api/browser-world/root?agent_id=${rootId}`, userId);
  assert(
    view.status === 200 && view.body.default_url === 'https://working.example/inbox',
    `default_url: ${JSON.stringify(view.body)}`
  );
  const other = await api(`/api/browser-world/root?agent_id=${otherRoot}`, userId);
  assert(other.body.default_url === 'https://other.example/', JSON.stringify(other.body));
  const idle = await api(`/api/browser-world/root?agent_id=${idleRoot}`, userId);
  assert(idle.status === 200 && idle.body.default_url === null, JSON.stringify(idle.body));
  const none = await api('/api/browser-world/root', userId);
  assert(none.status === 200 && none.body.default_url === null, JSON.stringify(none.body));
  const stranger = await createUser('stranger');
  const foreign = await api(`/api/browser-world/root?agent_id=${rootId}`, stranger);
  assert(foreign.body.default_url === null, `another user's URL leaked: ${JSON.stringify(foreign)}`);
  const bad = await api('/api/browser-world/root?agent_id=not-a-uuid', userId);
  assert(bad.status === 400, `bad agent_id returned ${bad.status}`);
}

function homeDeps(opened: Array<string | undefined>): RootBrowserDeps {
  return {
    createSession: async (contextId, agentId, startUrl) => {
      opened.push(startUrl);
      const row = await prisma.browserSession.create({
        data: {
          contextId,
          agentId,
          sessionId: `home-${randomUUID()}`,
          wsUrl: 'ws://already-connected.invalid',
          debugUrl: 'https://live.example/home',
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
        validationBrowser: null,
      };
    },
    isLive: async () => true,
    close: async (sessionId) => {
      await prisma.browserSession.update({ where: { sessionId }, data: { status: 'CLOSED' } });
      return { worldState: null };
    },
  };
}

export async function openWithoutStartUrlUsesTheDefaultUrl(): Promise<void> {
  const userId = await createUser('home-url');
  const rootId = await createAgent(userId);
  const idleRoot = await createAgent(userId);
  await createAgentTask(userId, {
    agentId: rootId,
    startUrl: 'https://working.example/start',
    currentUrl: 'https://working.example/inbox',
  });
  const opened: Array<string | undefined> = [];
  const deps = homeDeps(opened);

  const home = await openRootBrowser(userId, { agentId: rootId }, deps);
  assert(opened[0] === 'https://working.example/inbox', `opened at ${String(opened[0])}`);
  assert(home.start_url === 'https://working.example/inbox', JSON.stringify(home));
  // An open home browser is reused as it is; it is not re-navigated.
  const again = await openRootBrowser(userId, { agentId: idleRoot }, deps);
  assert(again.task_id === home.task_id && opened.length === 1, 'open re-created the home browser');
  await deps.close(home.session_id);

  const chosen = await openRootBrowser(
    userId,
    { agentId: rootId, startUrl: 'https://chosen.example/' },
    deps
  );
  assert(opened[1] === 'https://chosen.example/', 'an explicit start_url did not win');
  await deps.close(chosen.session_id);
  await openRootBrowser(userId, { agentId: idleRoot }, deps);
  assert(opened.length === 3 && opened[2] === undefined, `idle tree opened at ${String(opened[2])}`);
}

export async function theHomeBrowserIsNotAutoOpened(): Promise<void> {
  const userId = await createUser('not-auto');
  const rootId = await createAgent(userId);
  const task = await createAgentTask(userId, {
    agentId: rootId,
    startUrl: 'https://working.example/',
  });
  const { browser, context } = await freshBrowser();
  await setSiteCookie(context, 'example.com', 'session', 'agent-login');

  const receipt = await mergeSessionWorldState(task.sessionId, { browser });
  expectSite(receipt, 'example.com', 'merged');
  const view = await api(`/api/browser-world/root?agent_id=${rootId}`, userId);
  assert(view.status === 200 && view.body.root === null, `home browser open: ${JSON.stringify(view.body)}`);
  assert(view.body.default_url === 'https://working.example/', JSON.stringify(view.body));
  const sites = (view.body.sites as Array<{ site: string }>).map((entry) => entry.site);
  assert(sites.includes('example.com'), 'percolated credentials are not listed');
  const homeSessions = await prisma.browserSession.count({
    where: { agentId: rootBrowserAgentId(userId) },
  });
  assert(homeSessions === 0, 'reading state or percolating credentials opened the home browser');
}

export const keepBestCases: Array<[string, () => Promise<void>]> = [
  ["an unforked site's new login percolates in", anUnforkedSitesNewLoginPercolatesIn],
  ['collisions keep the best login', collisionsKeepTheBestLogin],
  ['a logged-out state never clobbers a valid login', aLoggedOutStateNeverClobbersAValidLogin],
  ['concurrent closes converge on the best login', concurrentClosesConvergeOnTheBestLogin],
  ['a retried kept close writes nothing', aRetriedKeptCloseWritesNothing],
  ['different accounts both survive; one account keeps best', differentAccountsBothSurvive],
  ["default_url comes from the tree's active task", defaultUrlComesFromTheTreesActiveTask],
  ['open without start_url uses default_url', openWithoutStartUrlUsesTheDefaultUrl],
  ['the home browser is not auto-opened', theHomeBrowserIsNotAutoOpened],
];
