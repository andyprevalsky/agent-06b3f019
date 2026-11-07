/** A document that outlives its deploy must not strand the app on the static shell. */
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
import { MOBILE_AGENTS, installMobileTrajectories } from './mobile-performance';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// Production serves a hashed /assets/index-*.js entry; the dev server serves /src/main.tsx.
const ENTRY = /\/(assets\/index-[^/]+\.js|src\/main\.tsx)(\?.*)?$/;
// After a production alias switch the previous build's entry chunk is a plain 404.
async function failEntry(page: Page, times: number) {
  let failed = 0;
  await page.route(ENTRY, (route) =>
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
  let failed = 0;
  // The connection drops just as the stale entry fails, before the backoff timer fires.
  await page.route(ENTRY, async (route) => {
    if (failed++ > 0) return route.continue();
    await context.setOffline(true);
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  });
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
