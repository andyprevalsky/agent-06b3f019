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

test('a step that succeeded on a document the app then replaced is repeated on the new one', async ({
  page,
}) => {
  page.setDefaultTimeout(30_000);
  await openStaticPage(page);
  const reads: string[] = [];
  const result = await acrossAppReload(page, async () => {
    const read = await page.evaluate((key) => sessionStorage.getItem(key) ?? 'replaced', RELOADED);
    reads.push(read);
    if (reads.length === 1) {
      // The read succeeded, then the app reloads itself before the next step starts.
      await Promise.all([
        page.waitForRequest((request) => request.isNavigationRequest()),
        page.evaluate((key) => {
          sessionStorage.setItem(key, 'new document');
          setTimeout(() => location.reload(), 0);
        }, RELOADED),
      ]);
    }
    return read;
  });
  expect(reads).toEqual(['replaced', 'new document']);
  expect(result).toBe('new document');
});

test('a redirect hop of the step’s own navigation is not an app reload', async ({ page }) => {
  const target = `${FRONTEND_URL}/__across-app-reload-fixture`;
  await page.route(`${FRONTEND_URL}/__across-app-reload-redirect`, (route) =>
    route.fulfill({ status: 302, headers: { location: target } }),
  );
  await page.route(target, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }),
  );
  let navigations = 0;
  await acrossAppReload(
    page,
    async () => {
      navigations++;
      await page.goto(`${FRONTEND_URL}/__across-app-reload-redirect`);
    },
    1,
  );
  expect(navigations).toBe(1);
  expect(page.url()).toBe(target);
});
