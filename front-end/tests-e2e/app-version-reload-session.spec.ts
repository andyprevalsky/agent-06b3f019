/**
 * A production deploy that promotes while a semantic run is in flight.
 *
 * The page's HTML still comes from the previous build, so on `load` the app sees
 * a newer id in /version.json and reloads itself once onto it
 * (src/lib/appVersion.ts). The session-injection helpers run right after
 * `page.goto` and must survive that one app-initiated reload rather than fail
 * with "Execution context was destroyed" (production semantic run 43085818750,
 * mobile-layout.spec.ts:194).
 *
 *   goto (old build) --load--> GET /version.json (newer) --> location.reload()
 *        \-- helper page.evaluate pending ------------------/  (context destroyed)
 */
import { expect, test } from '@playwright/test';

import {
  FRONTEND_URL,
  HAS_INJECTED_SESSION,
  expectInjectedSessionRecognized,
  injectSemanticSession,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 } });

test('injected session survives the app reloading onto a newly promoted deploy', async ({
  page,
}) => {
  test.skip(!HAS_INJECTED_SESSION, 'needs the runner-generated semantic session');
  const response = await page.request.get(`${FRONTEND_URL}/version.json`);
  const served = (await response.json().catch(() => null)) as { buildId?: string } | null;
  // The Vite dev server has no build id, so the app never version-reloads there.
  test.skip(!served?.buildId, 'frontend is not a production build');

  // Every document of this page is "stale": the deployed id is always newer.
  await page.route(
    (url) => url.pathname === '/version.json',
    (route) => route.fulfill({ json: { buildId: `${served?.buildId}-promoted` } }),
  );
  const versionReloads: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('[AppVersion]')) versionReloads.push(message.text());
  });

  await injectSemanticSession(page);
  await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
  await expectInjectedSessionRecognized(page);

  // The reload under test really happened, exactly once (the app's per-session guard).
  await expect.poll(() => versionReloads.length).toBeGreaterThanOrEqual(1);
  expect(versionReloads).toHaveLength(1);
  expect(versionReloads[0]).toContain('replaced by');
  await expect(page.locator('header').first()).toBeVisible();
});
