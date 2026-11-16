/**
 * Production semantic runs overlap deploys: the app reloads itself once onto a newer build
 * (AppVersion 'load' check, entry-load recovery). A test step straddling that reload saw
 * "Execution context was destroyed" (prod semantic run 43085818750, mobile-layout.spec.ts:194
 * via injectSemanticSession). acrossAppReload must recover exactly that case and nothing else.
 */
import { expect, test, type Page } from '@playwright/test';

import { FRONTEND_URL, acrossAppReload } from './helpers';

const RELOADED = 'rose-test:reloaded-once';

// A route-fulfilled static page: the real app could itself version-reload mid-test whenever a
// deploy goes live during a production run, which would make these controls nondeterministic.
async function openStaticPage(page: Page): Promise<void> {
  const url = `${FRONTEND_URL}/__across-app-reload-fixture`;
  await page.route(url, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }),
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

// Reloads the document the first time it runs (like the app's one-shot version reload),
// then answers on the new document.
function readInterruptedByOneReload(page: Page): Promise<string> {
  return page.evaluate((key) => {
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      location.reload();
      return new Promise<string>(() => {});
    }
    return 'settled';
  }, RELOADED);
}

test('a step interrupted by the app reloading onto a newer build is retried on the new document', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  await openStaticPage(page);

  // Control: the bare evaluate fails the way the production run did.
  const reloaded = page.waitForEvent('domcontentloaded');
  await expect(readInterruptedByOneReload(page)).rejects.toThrow(/Execution context was destroyed/);
  await reloaded;
  await page.evaluate((key) => sessionStorage.removeItem(key), RELOADED);

  expect(await acrossAppReload(page, () => readInterruptedByOneReload(page))).toBe('settled');
});

test('acrossAppReload does not retry failures without a new document', async ({ page }) => {
  await openStaticPage(page);
  let calls = 0;
  await expect(
    acrossAppReload(page, () => {
      calls++;
      return page.evaluate(() => {
        throw new Error('step failed on a stable page');
      });
    }),
  ).rejects.toThrow('step failed on a stable page');
  expect(calls).toBe(1);
});

// Prod semantic run 43686929632 (sidebar-agent-tree.spec.ts:317): the open document reloaded
// itself while the test navigated away, so page.goto failed with net::ERR_ABORTED, and the
// goto rejected before Playwright reported the reload that cancelled it. Like appVersion.ts,
// this page reloads once its held version check answers; the check answers, and the target
// stays held, until that navigation has started, so the reload always cancels it.
test('a navigation cancelled by the open document reloading is retried after that reload', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  const stale = `${FRONTEND_URL}/__across-app-reload-stale`;
  const target = `${FRONTEND_URL}/__across-app-reload-target`;
  // Reloads at most twice per session: once for the control, once under the helper.
  await page.route(stale, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>stale</title><script>
        const reloads = Number(sessionStorage.getItem('reloads') ?? 0);
        if (reloads < 2)
          fetch('/__across-app-reload-version').then(() => {
            sessionStorage.setItem('reloads', String(reloads + 1));
            location.reload();
          });
      </script>`,
    }),
  );
  // One latch per reload: the n-th version check answers once the n-th target is requested.
  const targetRequested = [0, 1].map(() => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  });
  let reloadRequested = () => {};
  const documents: string[] = [];
  page.on('request', (request) => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    documents.push(new URL(request.url()).pathname);
    if (request.url() === stale) reloadRequested();
  });
  let checks = 0;
  await page.route(`${FRONTEND_URL}/__across-app-reload-version`, async (route) => {
    await targetRequested[checks++].promise;
    await route.fulfill({ json: {} });
  });
  let targets = 0;
  await page.route(target, async (route) => {
    if (targets++ >= 2)
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title>' });
    const reloadStarted = new Promise<void>((resolve) => (reloadRequested = resolve));
    targetRequested[targets - 1].resolve();
    const reloaded = await Promise.race([
      reloadStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);
    // The reload has cancelled this navigation; without one, answer it so the assertions below
    // name the missing reload instead of the goto hanging.
    if (!reloaded)
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title>' });
    await route.abort().catch(() => {});
  });
  const goto = () => page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.goto(stale, { waitUntil: 'domcontentloaded' });

  // Control: the bare goto fails the way the production run did.
  const reloaded = page.waitForEvent('domcontentloaded');
  // Playwright names the cancellation by whichever report reaches it first.
  await expect(goto()).rejects.toThrow(/net::ERR_ABORTED|is interrupted by another navigation/);
  await reloaded;
  documents.length = 0;

  await acrossAppReload(page, goto, 1);
  expect(new URL(page.url()).pathname).toBe('/__across-app-reload-target');
  expect(documents).toEqual([
    '/__across-app-reload-target',
    '/__across-app-reload-stale',
    '/__across-app-reload-target',
  ]);
});

test('acrossAppReload does not retry a navigation that fails without a new document', async ({
  page,
}) => {
  await openStaticPage(page);
  const target = `${FRONTEND_URL}/__across-app-reload-target`;
  let calls = 0;
  await page.route(target, (route) => route.abort());
  await expect(
    acrossAppReload(
      page,
      () => {
        calls++;
        return page.goto(target, { waitUntil: 'domcontentloaded' });
      },
      1,
    ),
  ).rejects.toThrow(/net::ERR_FAILED|net::ERR_ABORTED/);
  expect(calls).toBe(1);
});
