/** Real-app mobile stress: 6,000 API messages -> switch/back -> old history -> bounded resources. */
import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { FRONTEND_URL } from './helpers';
import {
  expectMobileContent,
  installMobileTrajectories,
  MOBILE_AGENTS,
  mobileResourceMonitor,
} from './mobile-performance';

// Recording every full-DOM action snapshot distorts this resource probe; keep
// the explicit private before/after screenshots and JSON measurements instead.
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  trace: 'off',
  video: 'off',
});

async function switchAndBack(page: Page) {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByTestId(`rose-agent-row-${MOBILE_AGENTS[1]}`).filter({ visible: true }).click();
  await expectMobileContent(page, MOBILE_AGENTS[1]);
  // Agent selection intentionally replaces the URL; the app's Back control
  // clears the selected trajectory without unloading this browser document.
  await page
    .getByTestId('rose-mobile-header')
    .getByRole('button', { name: 'Back', exact: true })
    .click();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByTestId(`rose-agent-row-${MOBILE_AGENTS[0]}`).filter({ visible: true }).click();
  await expectMobileContent(page, MOBILE_AGENTS[0]);
}

async function inspectOldContent(page: Page) {
  const first = page.locator(`[data-message-id="${MOBILE_AGENTS[0]}-0"]`);
  await first.scrollIntoViewIfNeeded();
  await expect(first).toBeInViewport();
  await expect(first).toContainText('Review section 0');
  const group = page.getByTestId('trajectory-work-group').first();
  const disclosure = group.getByRole('button', { name: /Worked/ });
  await disclosure.click();
  // 50 a page: all 28 activities fit on one page, with no pager.
  await expect(group.getByTestId('trajectory-history-entry')).toHaveCount(28);
  await expect(group.getByRole('button', { name: 'Next activities' })).toHaveCount(0);
  await expect(group.getByText('Inspect audit source 0/21', { exact: true })).toBeVisible();
  await first.scrollIntoViewIfNeeded();
  return disclosure;
}

test('mobile long trajectories retain old content and bounded resources after repeated switch/back', async ({
  page,
}, testInfo) => {
  const rounds = Number(process.env.MOBILE_STRESS_ROUNDS ?? 6);
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    throw new Error('MOBILE_STRESS_ROUNDS must be a positive integer');
  }
  const snapshotOnly = process.env.MOBILE_STRESS_SNAPSHOT_ONLY === '1';
  // The extended soak changes workload size, keeping the normal gate's deadline
  // and every resource bound intact. Each UI action retains its 15s deadline.
  test.setTimeout(Math.max(180_000, rounds * 20_000));
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const fixture = await installMobileTrajectories(page);
  const monitor = await mobileResourceMonitor(page);
  const samples: (Awaited<ReturnType<typeof monitor.snapshot>> & {
    channels: ReturnType<typeof fixture.realtime>;
  })[] = [];
  const sample = async (label: string) => {
    const value = { ...(await monitor.snapshot(label)), channels: fixture.realtime() };
    samples.push(value);
    console.log('MOBILE_SAMPLE', JSON.stringify(value));
  };
  try {
    await page.goto(`${FRONTEND_URL}/?agent-id=${MOBILE_AGENTS[0]}&no-auto-login`, {
      waitUntil: 'domcontentloaded',
    });
    await expectMobileContent(page, MOBILE_AGENTS[0]);
    await switchAndBack(page); // Warm both routes, modules and React's alternate trees.
    await switchAndBack(page); // Include SDK exposure/replay initialization in the baseline.
    const old = await inspectOldContent(page);
    await page.screenshot({
      path: testInfo.outputPath('mobile-before.png'),
      animations: 'disabled',
    });
    await old.click();
    await expectMobileContent(page, MOBILE_AGENTS[0]);
    await sample('warmed');
    const backgroundBefore = await monitor.background();
    for (let cycle = 1; cycle <= rounds; cycle++) {
      if (!snapshotOnly) await switchAndBack(page);
      await sample(`${snapshotOnly ? 'snapshot' : 'round-trip'}-${cycle}`);
    }
    const backgroundAfter = await monitor.background();
    if (process.env.MOBILE_HEAP_SNAPSHOT_PATH) {
      await monitor.heapSnapshot(process.env.MOBILE_HEAP_SNAPSHOT_PATH);
    }
    const oldAfter = await inspectOldContent(page);
    await page.screenshot({
      path: testInfo.outputPath('mobile-after.png'),
      animations: 'disabled',
    });
    await oldAfter.click();
    await expectMobileContent(page, MOBILE_AGENTS[0]);
    expect(errors).toEqual([]);
    expect(
      Object.keys(monitor.paths).filter((path) => path.includes('react-grab')),
      'Use a production preview or VITE_ENABLE_REACT_GRAB=false for resource measurements',
    ).toEqual([]);
    const baseline = samples[0];
    // Generous fixed allowances cover JIT/React bookkeeping, but not one retained
    // full trajectory/DOM/listener set per navigation. Timing is diagnostic only.
    for (const sample of samples.slice(1)) {
      expect
        .soft(sample.heapBytes, `${sample.label}: post-GC heap`)
        .toBeLessThanOrEqual(baseline.heapBytes * 1.2 + 4 * 1024 * 1024);
      expect
        .soft(sample.nodes, `${sample.label}: retained DOM`)
        .toBeLessThanOrEqual(baseline.nodes + 500);
      expect
        .soft(sample.listeners, `${sample.label}: listeners`)
        .toBeLessThanOrEqual(baseline.listeners + 100);
      expect
        .soft(sample.documents, `${sample.label}: documents`)
        .toBeLessThanOrEqual(baseline.documents + 1);
      expect.soft(sample.mediaElements).toBe(baseline.mediaElements);
      expect.soft(sample.openSockets).toBeLessThanOrEqual(baseline.openSockets + 1);
      expect
        .soft(sample.channels.active, `${sample.label}: active realtime channels`)
        .toBeLessThanOrEqual(baseline.channels.active);
      for (const name of Object.keys(baseline.retained)) {
        expect
          .soft(sample.retained[name], `${sample.label}: retained ${name}`)
          .toBeLessThanOrEqual(baseline.retained[name] + 1);
      }
    }
    expect
      .soft(backgroundAfter.apiGetRequests, 'idle application API GET request growth')
      .toBeLessThanOrEqual(backgroundBefore.apiGetRequests + 4);
    expect
      .soft(backgroundAfter.inflight, 'idle inflight growth')
      .toBeLessThanOrEqual(backgroundBefore.inflight + 1);
    const result = {
      repeat: testInfo.repeatEachIndex,
      rounds,
      snapshotOnly,
      viewport: page.viewportSize(),
      reducedMotion: await page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
      fixture,
      samples,
      backgroundBefore,
      backgroundAfter,
      requestPaths: monitor.paths,
      requestMethods: monitor.methods,
      idleRequestAssertionScope: 'GET requests with URL pathname starting /api/',
      failedRequests: monitor.failedRequests,
      telemetryResponses: monitor.telemetryResponses,
      errors,
    };
    await writeFile(testInfo.outputPath('mobile-resources.json'), JSON.stringify(result, null, 2));
    await testInfo.attach('mobile-resources', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(
      'MOBILE_BACKGROUND',
      JSON.stringify({ fixture, backgroundBefore, backgroundAfter, errors }),
    );
  } finally {
    await monitor.dispose();
  }
});
