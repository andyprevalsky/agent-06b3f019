/**
 * Production semantic runs overlap deploys: the app reloads itself once onto a newer build
 * (AppVersion 'load' check, entry-load recovery). A test step straddling that reload saw
 * "Execution context was destroyed" (prod semantic run 43085818750, mobile-layout.spec.ts:194
 * via injectSemanticSession). acrossAppReload must recover exactly that case and nothing else.
 */
import { expect, test, type Page } from '@playwright/test';

import { FRONTEND_URL, acrossAppReload } from './helpers';

const RELOADED = 'rose-test:reloaded-once';

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
  await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });

  // Control: the bare evaluate fails the way the production run did.
  const reloaded = page.waitForEvent('domcontentloaded');
  await expect(readInterruptedByOneReload(page)).rejects.toThrow(/Execution context was destroyed/);
  await reloaded;
  await page.evaluate((key) => sessionStorage.removeItem(key), RELOADED);

  expect(await acrossAppReload(page, () => readInterruptedByOneReload(page))).toBe('settled');
});

test('acrossAppReload does not retry failures without a new document', async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
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
