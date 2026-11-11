/** A document that outlives its deploy must not strand the app on the static shell. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
import { MOBILE_AGENTS, installMobileTrajectories } from './mobile-performance';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// The entry is the document's last module script: /assets/index-*.js or /assets/main-*.js
// in production builds (E2E fixtures add a modulepreloaded index-* chunk), /src/main.tsx
// on the dev server. Resolve it from the served HTML instead of guessing a file name.
async function entryPath(page: Page): Promise<string> {
  const html = await (await page.request.get(`${FRONTEND_URL}/?no-auto-login`)).text();
  const sources = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)];
  expect(sources.length).toBeGreaterThan(0);
  return new URL(sources[sources.length - 1][1], FRONTEND_URL).pathname;
}
// After a production alias switch the previous build's entry chunk is a plain 404.
async function failEntry(page: Page, times: number) {
  const entry = await entryPath(page);
  let failed = 0;
  await page.route(
    (url) => url.pathname === entry,
    (route) =>
      failed++ < times
        ? route.fulfill({
            status: 404,
            contentType: 'text/plain',
            body: 'The page could not be found',
          })
        : route.continue(),
  );
}
// Document requests only: the app's own history updates also fire framenavigated.
function countDocuments(page: Page) {
  const loads = { count: 0 };
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads.count++;
  });
  return loads;
}
test('stale document whose entry chunk 404s reloads onto the live build and mounts', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  await failEntry(page, 1);
  const loads = countDocuments(page);
  const url = `${FRONTEND_URL}/?no-auto-login&agent-id=${MOBILE_AGENTS[0]}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
  await expect(page.locator(`[data-message-id^="${MOBILE_AGENTS[0]}-"]`).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.get('agent-id')).toBe(MOBILE_AGENTS[0]);
  expect(loads.count).toBe(2);
});
// Vercel answers a missing /assets/* file with 404 plus that path's year-long immutable
// Cache-Control, and a reload replays a cached 404 without asking the network. page.route
// disables the browser HTTP cache, so a real origin in front of the frontend serves it.
async function serveEntryCachedAs404Once(entry: string) {
  let entryRequests = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', FRONTEND_URL);
    if (url.pathname === entry && entryRequests++ === 0) {
      response.writeHead(404, {
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('The page could not be found');
      return;
    }
    const accept = request.headers.accept ?? '*/*';
    fetch(url, { headers: { accept }, redirect: 'manual' })
      .then(async (upstream) => {
        const body = Buffer.from(await upstream.arrayBuffer());
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
    entryRequests: () => entryRequests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
test('an entry 404 cached as immutable is refetched before the reload and the app mounts', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  const origin = await serveEntryCachedAs404Once(await entryPath(page));
  try {
    const loads = countDocuments(page);
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
test('an entry that never loads stops after three bounded reloads', async ({ page }) => {
  await installMobileTrajectories(page);
  await failEntry(page, Number.POSITIVE_INFINITY);
  const loads = countDocuments(page);
  await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => loads.count, { timeout: 20_000 }).toBe(4);
  // Twice the largest backoff: a fourth reload would have started by now.
  await page.waitForTimeout(4_000);
  expect(loads.count).toBe(4);
  await expect(page.locator('#root .rose-static-links')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toHaveCount(0);
});
test('connectivity lost during the backoff waits for online without spending an attempt', async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  const entry = await entryPath(page);
  let failed = 0;
  // The connection drops just as the stale entry fails, before the backoff timer fires.
  await page.route(
    (url) => url.pathname === entry,
    async (route) => {
      if (failed++ > 0) return route.continue();
      await context.setOffline(true);
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
    },
  );
  const loads = countDocuments(page);
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
test('connectivity lost while revalidating the entry waits for online and charges one attempt', async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(30_000);
  await installMobileTrajectories(page);
  const entry = await entryPath(page);
  let requests = 0;
  // The stale entry 404s online; the connection drops just as the recovery refetches it.
  await page.route(
    (url) => url.pathname === entry,
    async (route) => {
      requests++;
      if (requests === 1)
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
      if (requests === 2) {
        await context.setOffline(true);
        return route.abort('internetdisconnected');
      }
      return route.continue();
    },
  );
  const loads = countDocuments(page);
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
