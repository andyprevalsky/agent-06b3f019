/** A document that outlives its deploy must not strand the app on the static shell. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIResponse, type Page, type Route } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
import { MOBILE_AGENTS, installMobileTrajectories } from './mobile-performance';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// The entry is the document's last module script: /assets/index-*.js or /assets/main-*.js
// in production builds (E2E fixtures add a modulepreloaded index-* chunk), /src/main.tsx
// on the dev server. Resolve it from the served HTML instead of guessing a file name.
function entryOf(html: string, base: string): string | undefined {
  const sources = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)];
  const src = sources[sources.length - 1]?.[1];
  return src && new URL(src, base).pathname;
}
// The build under test is the first document the browser navigated to; a separate HTML fetch
// can see another build when the production alias switches between the two (run 43686704518).
// A document without a module script (an error or challenge page) fails loudly.
function bindEntry(html: string, base: string, status?: number) {
  const entry = entryOf(html, base);
  const problem = `the first document (${status ?? 'proxied'}) has no module script: ${html.slice(0, 200)}`;
  return () => {
    if (!entry) throw new Error(problem);
    return entry;
  };
}
// Routes the entry of the build under test into `handler`; a fault on another build's entry
// would leave the navigated one untouched. While `pinned()` holds, each reload replays the
// first document, so it names one entry as a stale cached document does; otherwise reloads
// reach the live build, whose own entry is not this test's.
async function routeEntry(
  page: Page,
  handler: (route: Route) => Promise<void>,
  pinned: () => boolean = () => false,
) {
  let entry: (() => string) | undefined;
  let first: APIResponse | undefined;
  await page.route((url) => entry !== undefined && url.pathname === entry(), handler);
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame())
      return route.fallback();
    const response = first && pinned() ? first : await route.fetch();
    if (!first) {
      first = response;
      entry = bindEntry(await response.text(), response.url(), response.status());
    }
    await route.fulfill({ response });
  });
  return () => {
    if (!entry) throw new Error('no document has been navigated yet');
    return entry();
  };
}
type Pinned = { status: number; headers: Record<string, string>; body: Buffer };
// The build under test, pinned: its HTML and every module and stylesheet its documents can
// load, read together. A promote mid-test can undeploy it while an edge still serves its HTML
// (its assets 404 at the origin, 2026-11-16 04:45Z), and then its entry recovery reloads again
// for a reason the test did not cause, and a document can name another build's entry. A proxy
// answering from the pin keeps every document on the build under test, whole. Re-read when the
// origin already lacks one of its assets.
async function pinLiveBuild() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const html = await (await fetch(`${FRONTEND_URL}/?no-auto-login`)).text();
    const assets = new Map<string, Pinned>();
    let pending = [...new Set(html.match(/\/assets\/[\w.-]+\.(?:js|css)/g) ?? [])];
    let whole = true;
    while (pending.length && whole) {
      const fetched = await Promise.all(
        pending.map(async (path) => {
          const response = await fetch(new URL(path, FRONTEND_URL));
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            if (
              !['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(
                name,
              )
            )
              headers[name] = value;
          });
          const body = Buffer.from(await response.arrayBuffer());
          return { path, pinned: { status: response.status, headers, body } };
        }),
      );
      const next = new Set<string>();
      for (const { path, pinned } of fetched) {
        if (pinned.status !== 200) whole = false;
        assets.set(path, pinned);
        // Chunks name each other as "./name.js" (imports) or "assets/name.js" (preload map).
        if (path.endsWith('.js'))
          for (const [, name] of pinned.body
            .toString()
            .matchAll(/(?:assets\/|\.\/)([\w.-]+\.(?:js|css))/g))
            if (!assets.has(`/assets/${name}`)) next.add(`/assets/${name}`);
      }
      pending = [...next];
    }
    if (whole) return { html, entry: bindEntry(html, FRONTEND_URL)(), assets };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('the live build never served all of its assets');
}
// Every document is the pinned HTML, and the pinned build's assets come from the pin.
function servesPinnedBuild(pin: Awaited<ReturnType<typeof pinLiveBuild>>) {
  return (url: URL, accept: string): Answer | null => {
    if (url.pathname === '/' && accept.includes('text/html'))
      return {
        status: 200,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
        body: pin.html,
      };
    return pin.assets.get(url.pathname) ?? null;
  };
}
// A proxy serving only the pinned build (and the live origin for anything else); closed after
// each test.
const proxies: { close: () => void }[] = [];
test.afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});
async function servePinnedBuild() {
  const pin = await pinLiveBuild();
  const pinned = servesPinnedBuild(pin);
  const server = await serveFrontend(
    (url, accept) => pinned(url, accept) ?? { upstreamPath: url.pathname },
  );
  proxies.push(server);
  return { origin: server.origin, entry: pin.entry };
}
// After a production alias switch the previous build's entry chunk is a plain 404.
async function failEntry(page: Page, times: number) {
  let failed = 0;
  return routeEntry(
    page,
    (route) =>
      failed++ < times
        ? route.fulfill({
            status: 404,
            contentType: 'text/plain',
            body: 'The page could not be found',
          })
        : route.continue(),
    () => failed < times,
  );
}
const VERSION_RELOAD_GUARD = 'rose:version-reload:';
// Document requests only: the app's own history updates also fire framenavigated.
// Counts the first document and the documents requested by a document of the build under
// test (one that requested `entry`). A deploy switch mid-test can hand the reload a newer
// build whose own entry recovery reloads again; that reload is not this build's. Nor is the
// build under test's own version reload onto a build promoted mid-test (prod semantic run
// 43686929632: c680f58fe7 went live between the recovery reload and the mount): appVersion.ts
// writes its `rose:version-reload:<build>` guard just before reloading, every document
// reports that write, and the reload it announces is left uncounted whether its request is
// reported before or after the write. `versionReloads` lists every announced target. Chunk
// reloads (`chunk:` guard) and entry recoveries still count.
async function countDocuments(page: Page, entry: string | (() => string)) {
  const entryNow = typeof entry === 'string' ? () => entry : entry;
  const loads = { count: 0, versionReloads: [] as string[] };
  let fromBuildUnderTest = true;
  // The counted document request not yet answered, and a version reload whose request is due.
  let pendingCounted = false;
  let versionReloadDue = false;
  page.on('request', (request) => {
    if (request.frame() !== page.mainFrame()) return;
    if (request.isNavigationRequest()) {
      pendingCounted = false;
      if (!fromBuildUnderTest) return;
      if (versionReloadDue) versionReloadDue = false;
      else {
        loads.count++;
        pendingCounted = true;
      }
    } else if (new URL(request.url()).pathname === entryNow()) fromBuildUnderTest = true;
  });
  page.on('response', (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      fromBuildUnderTest = false;
      pendingCounted = false;
    }
  });
  await page.exposeBinding('roseTestVersionReload', (source, target: string) => {
    if (source.frame !== page.mainFrame()) return;
    loads.versionReloads.push(target);
    if (!fromBuildUnderTest) return;
    if (pendingCounted) {
      loads.count--;
      pendingCounted = false;
    } else versionReloadDue = true;
  });
  await page.addInitScript((guard) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      const target = key.startsWith(guard) ? key.slice(guard.length) : '';
      if (this === window.sessionStorage && target && !target.startsWith('chunk:'))
        (
          window as Window & { roseTestVersionReload?: (build: string) => void }
        ).roseTestVersionReload?.(target);
      setItem.call(this, key, value);
    };
  }, VERSION_RELOAD_GUARD);
  return loads;
}
test('stale document whose entry chunk 404s reloads onto the live build and mounts', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  const entry = await failEntry(page, 1);
  const loads = await countDocuments(page, entry);
  const url = `${FRONTEND_URL}/?no-auto-login&agent-id=${MOBILE_AGENTS[0]}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
  await expect(page.locator(`[data-message-id^="${MOBILE_AGENTS[0]}-"]`).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get('agent-id')).toBe(MOBILE_AGENTS[0]);
  expect(loads.count).toBe(2);
});
// A real origin in front of the frontend. `answer` serves a request itself, or names the
// upstream path to forward it to and an optional rewrite of the forwarded body.
type Answer =
  | { status: number; headers: Record<string, string>; body: string | Buffer }
  | { upstreamPath: string; rewrite?: (body: string) => string };
async function serveFrontend(answer: (url: URL, accept: string) => Answer) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', FRONTEND_URL);
    const accept = request.headers.accept ?? '*/*';
    const answered = answer(url, accept);
    if ('status' in answered) {
      response.writeHead(answered.status, answered.headers);
      response.end(answered.body);
      return;
    }
    const upstreamUrl = new URL(answered.upstreamPath + url.search, FRONTEND_URL);
    fetch(upstreamUrl, { headers: { accept }, redirect: 'manual' })
      .then(async (upstream) => {
        const raw = Buffer.from(await upstream.arrayBuffer());
        const body = answered.rewrite ? Buffer.from(answered.rewrite(raw.toString())) : raw;
        const headers: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          if (
            !['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(
              name,
            )
          )
            headers[name] = value;
        });
        response.writeHead(upstream.status, headers);
        response.end(body);
      })
      .catch(() => {
        response.writeHead(502);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
// Vercel answers a missing /assets/* file with 404 plus that path's year-long immutable
// Cache-Control, and a reload replays a cached 404 without asking the network. page.route
// disables the browser HTTP cache, so a real origin in front of the frontend serves it.
// The build under test is pinned (pinLiveBuild): its documents and assets come from the pin.
async function serveEntryCachedAs404Once(pin: Awaited<ReturnType<typeof pinLiveBuild>>) {
  let entryRequests = 0;
  const pinned = servesPinnedBuild(pin);
  const server = await serveFrontend((url, accept) => {
    if (url.pathname === pin.entry && entryRequests++ === 0)
      return {
        status: 404,
        headers: {
          'cache-control': 'public, max-age=31536000, immutable',
          'content-type': 'text/plain; charset=utf-8',
        },
        body: 'The page could not be found',
      };
    return pinned(url, accept) ?? { upstreamPath: url.pathname };
  });
  return { ...server, entry: () => pin.entry, entryRequests: () => entryRequests };
}
// Every production deploy starts this suite, so a later merge can switch the alias between a
// stale document and its reload (run 43638239542). Documents after the first name the next
// build's entry, which 404s once (an edge node served the new HTML before it held the new
// assets; page.route disables the HTTP cache, so no immutable header is needed) and then
// serves a module importing the real entry: lazy chunks import it by name, so one app copy.
// The entry is bound from the first document the origin forwards, as in routeEntry. Later
// documents are that HTML renamed, and /version.json is not served: the simulated switch is the
// only one these documents see, so a real promote mid-test (04:53:50Z on 2026-11-16 handed the
// third document a newer build: nextRequests 2) cannot change the exact counts below.
async function serveDeploySwitchAfterFirstDocument() {
  let bound: (() => string) | undefined;
  const entry = () => bound?.() ?? '';
  const next = () => entry().replace(/(\.[^./]+)$/, '-next$1');
  let first = '';
  const bind = (html: string) => {
    bound = bindEntry(html, FRONTEND_URL);
    first = html;
    return html;
  };
  let documents = 0;
  let nextRequests = 0;
  const server = await serveFrontend((url, accept): Answer => {
    if (url.pathname === '/version.json')
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
    if (url.pathname === '/' && accept.includes('text/html')) {
      if (documents++ === 0) return { upstreamPath: '/', rewrite: bind };
      return {
        status: 200,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
        body: first.replaceAll(`"${entry()}"`, `"${next()}"`),
      };
    }
    if (!bound || url.pathname !== next()) return { upstreamPath: url.pathname };
    if (nextRequests++ === 0)
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
    return {
      status: 200,
      headers: { 'content-type': 'text/javascript' },
      body: `import ${JSON.stringify(entry())};`,
    };
  });
  return { ...server, entry, next, nextRequests: () => nextRequests };
}
test('an entry 404 cached as immutable is refetched before the reload and the app mounts', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  const origin = await serveEntryCachedAs404Once(await pinLiveBuild());
  try {
    const loads = await countDocuments(page, origin.entry);
    await page.goto(`${origin.origin}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    // React replaces the static links in #root when the live entry runs.
    await expect(page.locator('#root .rose-static-links')).toHaveCount(0);
    await expect(page.locator('#root > *').first()).toBeAttached();
    expect(loads.count).toBe(2);
    // The cached 404 alone would never reach the origin again.
    expect(origin.entryRequests()).toBeGreaterThanOrEqual(2);
  } finally {
    origin.close();
  }
});
// Prod semantic run 43686929632: a build went live between the recovery reload and the mount,
// so the recovered document's load check reloaded it onto that build (Expected 2, Received 3).
// Every /version.json here names a newer build; the entry 404s once (no-store: never cached).
test('a build promoted before the recovered document mounts: its version reload is not the recovery’s', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  const live = (await (
    await page.request.get(`${FRONTEND_URL}/version.json`)
  )
    .json()
    .catch(() => null)) as { buildId?: string } | null;
  // The Vite dev server has no build id, so the app never version-reloads there.
  test.skip(!live?.buildId, 'frontend is not a production build');
  const promoted = `${live?.buildId}-promoted`;
  const pin = await pinLiveBuild();
  const { entry } = pin;
  const pinned = servesPinnedBuild(pin);
  let entryRequests = 0;
  const origin = await serveFrontend((url, accept) => {
    if (url.pathname === '/version.json')
      return { upstreamPath: url.pathname, rewrite: () => JSON.stringify({ buildId: promoted }) };
    if (url.pathname === entry && entryRequests++ === 0)
      return {
        status: 404,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
        body: 'Not found',
      };
    return pinned(url, accept) ?? { upstreamPath: url.pathname };
  });
  try {
    let documents = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
    });
    const loads = await countDocuments(page, entry);
    await page.goto(`${origin.origin}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    // The recovered document reloaded onto the promoted build, once (appVersion's guard), and
    // that document mounts.
    await expect.poll(() => loads.versionReloads.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => documents, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#root .rose-static-links')).toHaveCount(0);
    await expect(page.locator('#root > *').first()).toBeAttached();
    expect(loads.versionReloads).toEqual([promoted]);
    // The entry recovery itself spent exactly one reload.
    expect(loads.count).toBe(2);
  } finally {
    origin.close();
  }
});
// Semantic gate check, 2026-11-16 04:45Z: a promote undeployed the build under test (its
// entry 404 at the origin) while an edge kept serving its HTML for ~15 s, so the recovery
// reload got that HTML again and reloaded a second time (Expected 2, Received 3). Here every
// document is that HTML, and once the first has loaded the origin no longer has its assets.
test('the build under test undeployed mid-test, its HTML still at an edge: the recovery reloads once', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  const pin = await pinLiveBuild();
  const pinned = servesPinnedBuild(pin);
  let documents = 0;
  let entryRequests = 0;
  const origin = await serveFrontend((url, accept) => {
    if (url.pathname === '/version.json')
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
    if (url.pathname === '/' && accept.includes('text/html') && documents++ > 0)
      return {
        status: 200,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
        body: pin.html,
      };
    if (url.pathname === pin.entry && entryRequests++ === 0)
      return {
        status: 404,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
        body: 'Not found',
      };
    const answer = pinned(url, accept);
    if (answer) return answer;
    // The origin after the promote: the undeployed build's assets are gone.
    if (url.pathname.startsWith('/assets/'))
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
    return { upstreamPath: url.pathname };
  });
  try {
    const loads = await countDocuments(page, pin.entry);
    await page.goto(`${origin.origin}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root .rose-static-links')).toHaveCount(0);
    await expect(page.locator('#root > *').first()).toBeAttached();
    expect(documents).toBe(2);
    expect(loads.count).toBe(2);
  } finally {
    origin.close();
  }
});
test('an entry that never loads stops after three bounded reloads', async ({ page }) => {
  await installMobileTrajectories(page);
  const entry = await failEntry(page, Number.POSITIVE_INFINITY);
  const loads = await countDocuments(page, entry);
  await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => loads.count, { timeout: 20_000 }).toBe(4);
  // Twice the largest backoff: a fourth reload would have started by now.
  await page.waitForTimeout(4_000);
  expect(loads.count).toBe(4);
  await expect(page.locator('#root .rose-static-links')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toHaveCount(0);
});
// Every HTML request is a newer build naming its own entry (served as the live entry's body),
// as during the burst of production promotions in run 43686704518.
async function serveNewBuildPerDocument() {
  let builds = 0;
  const server = await serveFrontend((url, accept) => {
    const renamed = url.pathname.match(/^(.*)-build\d+(\.[^./]+)$/);
    if (renamed) return { upstreamPath: renamed[1] + renamed[2] };
    if (url.pathname !== '/' || !accept.includes('text/html'))
      return { upstreamPath: url.pathname };
    const build = ++builds;
    return {
      upstreamPath: '/',
      rewrite: (html) => {
        const entry = bindEntry(html, FRONTEND_URL)();
        const next = entry.replace(/(\.[^./]+)$/, `-build${build}$1`);
        return html.replaceAll(`"${entry}"`, `"${next}"`);
      },
    };
  });
  return { ...server, builds: () => builds };
}
test('an entry that never loads is faulted on the navigated document across a deploy switch', async ({
  page,
}) => {
  await installMobileTrajectories(page);
  const origin = await serveNewBuildPerDocument();
  try {
    // A separate HTML request sees another build than the navigation that follows it.
    const html = await page.request.get(`${origin.origin}/?no-auto-login`, {
      headers: { accept: 'text/html' },
    });
    expect(entryOf(await html.text(), origin.origin)).toMatch(/-build1\.[^./]+$/);
    const entry = await failEntry(page, Number.POSITIVE_INFINITY);
    const loads = await countDocuments(page, entry);
    const notFound = new Set<string>();
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (response.status() === 404 && /-build\d+\./.test(path)) notFound.add(path);
    });
    await page.goto(`${origin.origin}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => loads.count, { timeout: 20_000 }).toBe(4);
    await page.waitForTimeout(4_000);
    expect(loads.count).toBe(4);
    await expect(page.locator('#root .rose-static-links')).toBeVisible();
    // Every reload replayed the navigated build-2 document: its entry is the only one faulted.
    expect(origin.builds()).toBe(2);
    expect(entry()).toMatch(/-build2\.[^./]+$/);
    expect([...notFound]).toEqual([entry()]);
  } finally {
    origin.close();
  }
});
// Negative control for the binding above: the build under test stays the first navigated
// document, so the next build's own recovery reload (its entry 404s once) is not counted.
test('a stale document that reloads onto a build whose entry 404s once counts only its own reload', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  const origin = await serveDeploySwitchAfterFirstDocument();
  try {
    const entry = await failEntry(page, 1);
    const loads = await countDocuments(page, entry);
    await page.goto(`${origin.origin}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
    // Past the next build's 0.5 s backoff and reload: neither is this build's.
    await page.waitForTimeout(3_000);
    expect(entry()).toBe(origin.entry());
    expect(origin.nextRequests()).toBeGreaterThanOrEqual(2);
    expect(loads.count).toBe(2);
  } finally {
    origin.close();
  }
});
test('connectivity lost during the backoff waits for online without spending an attempt', async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  let failed = 0;
  // The connection drops just as the stale entry fails, before the backoff timer fires.
  const entry = await routeEntry(page, async (route) => {
    if (failed++ > 0) return route.continue();
    await context.setOffline(true);
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });
  const loads = await countDocuments(page, entry);
  await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
  // Past the first 0.5 s backoff: no offline reload, and the attempt is not charged.
  await page.waitForTimeout(2_000);
  expect(loads.count).toBe(1);
  await expect(page.locator('#root .rose-static-links')).toBeVisible();
  const charged = await page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) => key.startsWith('rose:entry-reload:')),
  );
  expect(charged).toEqual([]);
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
  expect(loads.count).toBe(2);
});
test('a deploy switch during the offline backoff: the stale document reloads once and the next build recovers itself', async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  const origin = await serveDeploySwitchAfterFirstDocument();
  const entry = origin.entry;
  try {
    let failed = 0;
    await page.route(
      (url) => url.pathname === entry(),
      async (route) => {
        if (failed++ > 0) return route.continue();
        await context.setOffline(true);
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
      },
    );
    let documents = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
    });
    const loads = await countDocuments(page, entry);
    await page.goto(`${origin.origin}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);
    expect(loads.count).toBe(1);
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
    // The next build's own entry 404 cost it one reload, charged to its own entry URL.
    expect(documents).toBe(3);
    expect(origin.nextRequests()).toBe(3);
    const charged = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith('rose:entry-reload:')),
    );
    expect(
      charged.map(([key, value]) => [
        new URL(key.slice('rose:entry-reload:'.length)).pathname,
        value,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [entry(), '1'],
        [origin.next(), '1'],
      ]),
    );
    expect(charged).toHaveLength(2);
    // The stale build's recovery spent exactly one reload.
    expect(loads.count).toBe(2);
  } finally {
    origin.close();
  }
});
test('connectivity lost while revalidating the entry waits for online and charges one attempt', async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  let requests = 0;
  // The stale entry 404s online; the connection drops just as the recovery refetches it.
  const entry = await routeEntry(page, async (route) => {
    requests++;
    if (requests === 1)
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
    if (requests === 2) {
      await context.setOffline(true);
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
  const loads = await countDocuments(page, entry);
  await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => requests).toBe(2);
  // No offline navigation: the static links stay, and the one attempt is charged once.
  await page.waitForTimeout(2_000);
  expect(loads.count).toBe(1);
  await expect(page.locator('#root .rose-static-links')).toBeVisible();
  const charged = () =>
    page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith('rose:entry-reload:')),
    );
  expect((await charged()).map(([, value]) => value)).toEqual(['1']);
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
  expect(loads.count).toBe(2);
  expect((await charged()).map(([, value]) => value)).toEqual(['1']);
});
