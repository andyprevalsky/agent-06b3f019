/**
 * Semantic Tests: Mobile Layout.
 *
 * Runs on an iPhone-14-sized viewport (390×844) to assert that specific UI
 * elements do not overflow horizontally and remain fully accessible.
 *
 * Bugs caught by these tests (and already fixed):
 *  - WebPreviewBanner: fixed-line pill ("rounded-full flex items-center")
 *    caused the "Download for Mac" link to clip off the right edge on 390 px
 *    screens. Fix: flex-wrap + rounded-2xl + whitespace-nowrap on the link.
 *  - PausedBanner: same rounded-full pattern, fixed with flex-wrap + rounded-2xl.
 *  - TerminalHeader: hard-coded width: 320px — now min(320px, 100vw-32px).
 *  - RoseToolSetChip popover: fixed w-[400px] — now min(400px, 100vw-32px).
 *
 * NOTE on broad DOM-walk overflow checks: this app's root container uses
 * `overflow: hidden` (intentional, full-screen), and several child components
 * (carousel ticker, AsciiLoader) are also intentionally overflow-clipped.
 * A broad `scrollWidth > innerWidth` or `getBoundingClientRect().right > vw`
 * scan produces many false positives from those components, so we use targeted
 * locator-based checks for the specific elements we care about instead.
 *
 * Three tests, each independently exercising a different viewport concern.
 * Kept lightweight (tests 1 + 3 share the landing URL; test 2 creates an agent)
 * so they can be parallelised if workers are increased.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

import {
  FRONTEND_URL,
  HAS_INJECTED_SESSION,
  attachRecorder,
  createAgent,
  deleteAgent,
  expectDevAuthenticated,
  expectInjectedSessionRecognized,
  hasUncaughtErrors,
  injectSemanticSession,
  loadBenchmarkTask,
} from './helpers';

// iPhone 14 logical resolution — mirrors what Playwright's `devices['iPhone 14']` uses.
test.use({ viewport: { width: 390, height: 844 } });

const SCREENSHOT_DIR = path.join(import.meta.dirname, '../playwright-mobile-screenshots');

function saveScreenshot(name: string, buffer: Buffer): void {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCREENSHOT_DIR, `${name}.png`), buffer);
}

/** Asserts an element's bounding box lies within the 390 px viewport. */
async function assertWithinViewport(locator: import('@playwright/test').Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label}: element not found / not visible`).not.toBeNull();
  if (!box) return;
  expect(box.x, `${label}: left edge off-screen (x=${box.x})`).toBeGreaterThanOrEqual(-1);
  expect(
    box.x + box.width,
    `${label}: right edge exceeds 390px viewport (right=${box.x + box.width})`,
  ).toBeLessThanOrEqual(392); // 2 px sub-pixel tolerance
}

async function waitForDevLogin(
  page: import('@playwright/test').Page,
  rec: ReturnType<typeof attachRecorder>,
) {
  if (HAS_INJECTED_SESSION) {
    await expectInjectedSessionRecognized(page);
  } else {
    await expectDevAuthenticated(page, rec);
  }
}

// ── Test 1: landing screen ────────────────────────────────────────────────

test.describe('mobile-layout', () => {
  test('landing screen — header and query input fit within 390 px viewport', async ({ page }) => {
    const rec = attachRecorder(page);
    if (HAS_INJECTED_SESSION) {
      await injectSemanticSession(page);
    }
    await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
    await waitForDevLogin(page, rec);
    // Let opening animation settle so all elements reach their resting position.
    await page.waitForTimeout(2_000);

    saveScreenshot('01-landing', await page.screenshot({ fullPage: false }));

    // ── Header within bounds ──────────────────────────────────────────────
    await assertWithinViewport(page.locator('header').first(), 'TerminalHeader');

    // ── Query textarea accessible and within bounds ───────────────────────
    // Prefer the goal/composer placeholders — never `textarea.first()`, which
    // can match an off-screen Codex/cloud-agent terminal input (x≈-160k).
    const textarea = page.locator(
      'textarea[placeholder="Enter any goal"], textarea[placeholder="Type your message..."]',
    );
    await expect(textarea).toBeVisible();
    await assertWithinViewport(textarea, 'Query textarea');

    expect(hasUncaughtErrors(rec), 'Uncaught errors on mobile landing screen').toEqual([]);
  });

  // ── Test 2: WebPreviewBanner wraps on mobile ──────────────────────────

  test('agent active — WebPreviewBanner and message bubbles fit within 390 px viewport', async ({
    page,
  }) => {
    const rec = attachRecorder(page);
    const task = await loadBenchmarkTask('claude-code-agent');
    const agentId = await createAgent(task.prompt);

    try {
      if (HAS_INJECTED_SESSION) {
        await injectSemanticSession(page);
      }
      await page.goto(`${FRONTEND_URL}/?agent-id=${agentId}`, { waitUntil: 'domcontentloaded' });
      await waitForDevLogin(page, rec);

      // Wait for Supabase channel subscription.
      await expect
        .poll(
          () =>
            rec.console.some(
              (m) =>
                m.text.includes(`agent:${agentId.slice(0, 10)}`) &&
                m.text.includes('status: SUBSCRIBED'),
            ),
          { timeout: 30_000, message: 'Agent channel never reached SUBSCRIBED' },
        )
        .toBe(true);

      // Wait for ≥2 message bubbles (user goal + ≥1 assistant/tool).
      const messageLocator = page.locator('[data-message-id]');
      await expect
        .poll(() => messageLocator.count(), {
          timeout: 120_000,
          message: 'Agent never produced ≥2 realtime message bubbles on mobile',
        })
        .toBeGreaterThanOrEqual(2);

      // Grace period for trailing streaming / banner state to render.
      await page.waitForTimeout(3_000);

      saveScreenshot('02-agent-active', await page.screenshot({ fullPage: false }));

      // ── Invariant 1: WebPreviewBanner (source=WEB) fits within viewport ──
      // Previously the "Download for Mac" link clipped off the right edge
      // because the banner used `rounded-full flex items-center` with no wrap.
      // Fix: flex-wrap + rounded-2xl + whitespace-nowrap on the link.
      const banner = page.locator('[data-testid="web-preview-banner"]');
      if ((await banner.count()) > 0) {
        await assertWithinViewport(banner, 'WebPreviewBanner');
        // The call-to-action link must also be fully within bounds.
        const downloadLink = banner.locator('a');
        if ((await downloadLink.count()) > 0) {
          await assertWithinViewport(downloadLink, 'WebPreviewBanner "Download for Mac" link');
        }
      }

      // ── Invariant 2: every rendered message bubble fits within viewport ──
      const bubbleOverflows = await page.locator('[data-message-id]').evaluateAll((els) =>
        els
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.getAttribute('data-message-id'), left: r.left, right: r.right };
          })
          .filter((b) => b.right > 392 || b.left < -1),
      );
      expect(
        bubbleOverflows,
        `Message bubbles exceed 390 px viewport: ${JSON.stringify(bubbleOverflows)}`,
      ).toEqual([]);

      // ── Invariant 3: query input still reachable ─────────────────────────
      // Prefer the goal/composer placeholders — never `textarea.first()`, which
      // can match an off-screen Codex/cloud-agent terminal input (x≈-160k).
      const textarea = page.locator(
        'textarea[placeholder="Enter any goal"], textarea[placeholder="Type your message..."]',
      );
      await expect(textarea).toBeVisible();
      await assertWithinViewport(textarea, 'Query textarea (agent active)');

      expect(hasUncaughtErrors(rec), 'Uncaught errors during mobile agent-active flow').toEqual([]);
    } finally {
      await deleteAgent(agentId);
    }
  });

  // ── Test 3: header responsiveness ────────────────────────────────────

  test('header is centered and never wider than the 390 px viewport', async ({ page }) => {
    const rec = attachRecorder(page);
    if (HAS_INJECTED_SESSION) {
      await injectSemanticSession(page);
    }
    await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
    await waitForDevLogin(page, rec);
    await page.waitForTimeout(1_000);

    // ── Header within viewport ────────────────────────────────────────────
    await assertWithinViewport(page.locator('header').first(), 'TerminalHeader');

    // ── Header must be centered (≤ 8 px off the horizontal midpoint) ─────
    // Previously the header used a hard-coded `width: 320px` inline style.
    // Fix: `width: min(320px, calc(100vw - 32px))` so it shrinks on
    // sub-320 px viewports and stays centered.
    const result = await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return null;
      const rect = header.getBoundingClientRect();
      return {
        center: Math.round(rect.left + rect.width / 2),
        midpoint: Math.round(window.innerWidth / 2),
      };
    });
    expect(result, 'Header element not found').not.toBeNull();
    if (result) {
      expect(
        Math.abs(result.center - result.midpoint),
        `Header is not centered: center=${result.center} midpoint=${result.midpoint}`,
      ).toBeLessThanOrEqual(8);
    }

    expect(hasUncaughtErrors(rec), 'Uncaught errors on mobile header check').toEqual([]);
  });
});

// Desktop uses the same opening surface but must center the art itself, rather
// than the combined art/caption stack. Keep the real CSS geometry under test.
test('desktop opening ASCII stays centered on the large grid tile', async ({ page }) => {
  const rec = attachRecorder(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 813 },
  ]) {
    await page.setViewportSize(viewport);
    if (HAS_INJECTED_SESSION) await injectSemanticSession(page);
    await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
    await waitForDevLogin(page, rec);
    // Dev login persists the browser-review user, whose reload opens Browse.
    // Enter an empty chat through the same Home action a user would take.
    const home = page.getByTestId('rose-home-project-row');
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    await home.getByRole('button', { name: 'Create Super Agent', exact: true }).click();
    const frame = page.locator('pre[data-ascii-layer="frame"]').first();
    await expect(frame).toBeVisible();
    await expect
      .poll(
        async () => {
          const box = await frame.boundingBox();
          if (!box || box.height === 0) return Infinity;
          return Math.max(
            Math.abs(box.x + box.width / 2 - viewport.width / 2),
            Math.abs(box.y + box.height / 2 - viewport.height * 0.4),
          );
        },
        { message: 'ASCII center must match the large grid tile, independently of caption height' },
      )
      .toBeLessThan(2);
  }
});
