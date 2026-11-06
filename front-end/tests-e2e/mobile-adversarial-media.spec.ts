/** Real app media owners: actual playback, multipart replay and delayed signing. */
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { FRONTEND_URL } from './helpers';
import { mobileResourceMonitor } from './mobile-performance';
import {
  installAdversarialMedia,
  installMediaAuditObserver,
  mediaAuditState,
  MEDIA_AGENT,
} from './mobile-adversarial-media-fixtures';

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  trace: 'off',
  video: 'off',
});

test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
});

test('real mobile media releases playback and blobs after repeated owner exits', async ({
  page,
}, info) => {
  const fixture = await installAdversarialMedia(page);
  await installMediaAuditObserver(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const monitor = await mobileResourceMonitor(page);
  const samples: unknown[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    for (let round = 0; round < 6; round++) {
      if (round === 0)
        await page.goto(`${FRONTEND_URL}/?agent-id=${MEDIA_AGENT}&no-auto-login`, {
          waitUntil: 'domcontentloaded',
        });
      else {
        await page.getByRole('button', { name: 'Open menu', exact: true }).click();
        await page.getByTestId(`rose-agent-row-${MEDIA_AGENT}`).filter({ visible: true }).click();
      }
      console.log('MEDIA_STEP', round, 'opening history');
      await page.getByRole('button', { name: /Worked for/ }).click();
      const chip = page.getByTestId('browser-agent-chip');
      await expect(chip).toBeVisible();
      const inline = page.getByTestId('inline-media-video');
      await expect(inline).toHaveCount(1);
      console.log('MEDIA_STEP', round, 'inline playback');
      await inline.evaluate((node: HTMLVideoElement) => {
        node.muted = true;
        void node.play().catch((error) => {
          node.dataset.playError = String(error);
        });
      });
      await expect
        .poll(() => inline.evaluate((node: HTMLVideoElement) => node.currentTime))
        .toBeGreaterThan(0);
      await chip
        .getByTestId('browser-agent-chip-header')
        .getByText('Browser Agent', { exact: true })
        .click();
      console.log('MEDIA_CHIP_AFTER_CLICK', await chip.innerText());
      await chip.getByRole('button', { name: /^Recording/ }).click();
      const video = chip.locator('video');
      await expect(video).toHaveCount(1);
      await expect
        .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
        .toBeGreaterThanOrEqual(2);
      for (let part = 2; part <= 6; part++) {
        await chip
          .getByRole('button', { name: `Play recording part ${part} of 6`, exact: true })
          .click();
        if (part < 6)
          await expect
            .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
            .toBeGreaterThanOrEqual(2);
        else await expect(chip.locator('iframe')).toHaveCount(1);
      }
      await chip.getByRole('button', { name: 'Result', exact: true }).click();
      await expect(chip.locator('video, iframe')).toHaveCount(0);
      await page.getByText('+15555550123', { exact: true }).click();
      const audio = page.locator('audio');
      await expect(audio).toHaveCount(1);
      await audio.evaluate((node: HTMLAudioElement) => {
        node.muted = true;
        void node.play().catch((error) => {
          node.dataset.playError = String(error);
        });
      });
      await expect
        .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime))
        .toBeGreaterThan(0);
      await page
        .getByTestId('rose-mobile-header')
        .getByRole('button', { name: 'Back', exact: true })
        .click();
      await expect(page.locator('video,audio,iframe[title="Browser recording"]')).toHaveCount(0);
      const state = await mediaAuditState(page);
      expect(state.blobUrls).toEqual([]);
      const sample = { ...(await monitor.snapshot(`media-owner-exit-${round}`)), state };
      samples.push(sample);
      console.log('MEDIA_OWNER_SAMPLE', JSON.stringify(sample));
    }
    // Let existing one-second click matching and frame-removal tasks retire.
    await monitor.background();
    const released = await monitor.snapshot('media-idle-owner-exit');
    const warmed = samples[1] as Awaited<ReturnType<typeof monitor.snapshot>>;
    expect(
      released.documents,
      'closed replay iframe documents must reach a plateau',
    ).toBeLessThanOrEqual(warmed.documents);
    if (process.env.MEDIA_HEAP_SNAPSHOT_PATH)
      await monitor.heapSnapshot(process.env.MEDIA_HEAP_SNAPSHOT_PATH);
    expect(errors).toEqual([]);
  } finally {
    fixture.releaseAll();
    await writeFile(
      info.outputPath('media-resources.json'),
      JSON.stringify(
        { samples, errors, videoBytes: fixture.videoBytes, audioBytes: fixture.audioBytes },
        null,
        2,
      ),
    );
    await monitor.dispose();
  }
});

test('collapsing a real recording card aborts pending URL signing', async ({ page }, info) => {
  const fixture = await installAdversarialMedia(page);
  await installMediaAuditObserver(page);
  fixture.hold('part-0.mp4');
  try {
    await page.goto(`${FRONTEND_URL}/?agent-id=${MEDIA_AGENT}&no-auto-login`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('button', { name: /Worked for/ }).click();
    const chip = page.getByTestId('browser-agent-chip');
    await chip
      .getByTestId('browser-agent-chip-header')
      .getByText('Browser Agent', { exact: true })
      .click();
    console.log('MEDIA_CHIP_AFTER_CLICK', await chip.innerText());
    await chip.getByRole('button', { name: /^Recording/ }).click();
    await expect.poll(() => fixture.requests.includes('part-0.mp4')).toBe(true);
    await chip
      .getByTestId('browser-agent-chip-header')
      .getByText('Browser Agent', { exact: true })
      .click();
    console.log('MEDIA_CHIP_AFTER_CLICK', await chip.innerText());
    await expect
      .poll(
        async () =>
          (await mediaAuditState(page)).fetches.find((r) =>
            r.url.includes('/attachments/part-0.mp4/url'),
          )?.aborted,
      )
      .toBe(true);
  } finally {
    await writeFile(
      info.outputPath('media-signing.json'),
      JSON.stringify(await mediaAuditState(page), null, 2),
    );
    fixture.releaseAll();
  }
});
