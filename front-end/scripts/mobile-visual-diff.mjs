#!/usr/bin/env node
/**
 * Pixel-diff two production builds of the mobile web app at identical,
 * frozen animation states (companion to mobile-cpu-benchmark.mjs).
 *
 *   MOBILE_CPU_NOW=<ms> node scripts/mobile-visual-diff.mjs \
 *     --baseline /path/dist-a --candidate /path/dist-b --out /path/dir
 *
 * Per build and scenario (chat, home): pin Date/timers to one fake clock, let
 * the app settle, pause the clock and run its timers 2 minutes forward, write one fixed text into the ASCII loader
 * layers, stop the liquid-metal shader at one frame (setSpeed(0) + setFrame),
 * then for each sample time seek EVERY running CSS animation (energy pills
 * included) to that time and screenshot. Scenarios: chat, home, the mobile
 * drawer open over the chat, and the drawer's first slide-out frames (the app
 * revealed again). Screenshots must match byte-for-byte
 * in pixels; any differing pixel is reported with a diff image.
 */
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENTS, installFixtures, openScenario, serve } from './mobile-cpu-benchmark.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const OUT = resolve(args.out ?? 'mobile-visual-diff');
const FIXED_NOW = Number(process.env.MOBILE_CPU_NOW);
if (!Number.isFinite(FIXED_NOW)) throw new Error('Set MOBILE_CPU_NOW (shared fixture clock)');
const SAMPLE_TIMES_MS = Array.from({ length: Number(args.samples ?? 13) }, (_, i) => i * 4_750);
const SHADER_FRAME_MS = 4_321;
const ASCII_TEXT = Array.from({ length: 27 }, (_, row) =>
  Array.from({ length: 50 }, (_, col) => ' .:;i1tfLCG08@'[(row * 7 + col * 3) % 14]).join(''),
).join('\n');

async function capture(browser, dist, label) {
  const server = await serve(resolve(dist));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shots = {};
  const scenarios = (args.scenarios ?? 'chat,home,drawer,drawer-closing').split(',');
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.clock.install({ time: FIXED_NOW });
    await installFixtures(page);
    await openScenario(page, origin, scenario === 'drawer-closing' ? 'drawer' : scenario);
    // Pause, then run every timer in order for 2 minutes so timer-driven UI
    // (the opening caption cycle) reaches the same state in every run.
    await page.clock.pauseAt(FIXED_NOW + 30_000);
    await page.clock.runFor(120_000);
    await page.evaluate(
      async ({ text, frame }) => {
        for (const pre of document.querySelectorAll('pre[data-ascii-layer]'))
          pre.textContent = text;
        for (const host of document.querySelectorAll('[data-paper-shader]')) {
          host.paperShaderMount?.setSpeed(0);
          host.paperShaderMount?.setFrame(frame);
        }
      },
      { text: ASCII_TEXT, frame: SHADER_FRAME_MS },
    );
    if (scenario === 'drawer-closing') {
      // Reveal: start the drawer's slide-out, then re-freeze the shader (a
      // covered app holds its loop and resumes on uncover).
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate((frame) => {
        for (const animation of document.getAnimations()) animation.pause();
        for (const host of document.querySelectorAll('[data-paper-shader]')) {
          host.paperShaderMount?.setSpeed(0);
          host.paperShaderMount?.setFrame(frame);
        }
      }, SHADER_FRAME_MS);
    }
    await page.waitForTimeout(500); // real time: canvas commits land
    for (const time of SAMPLE_TIMES_MS) {
      await page.evaluate((t) => {
        for (const animation of document.getAnimations()) {
          // Finished one-shot transitions (the drawer's slide-in) keep their end
          // state; seeking them back would show a state the app never reaches.
          if (animation.playState === 'finished') continue;
          animation.pause();
          animation.currentTime = t;
        }
      }, time);
      await page.waitForTimeout(150);
      const path = join(OUT, `${label}-${scenario}-${time}.png`);
      await page.screenshot({ path, animations: 'allow', caret: 'hide' });
      shots[`${scenario}-${time}`] = path;
    }
    await context.close();
  }
  server.close();
  return shots;
}

function diff(a, b, out) {
  const left = PNG.sync.read(readFileSync(a));
  const right = PNG.sync.read(readFileSync(b));
  if (left.width !== right.width || left.height !== right.height) return { sizeMismatch: true };
  const image = new PNG({ width: left.width, height: left.height });
  let pixels = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++)
      delta = Math.max(delta, Math.abs(left.data[i + c] - right.data[i + c]));
    image.data[i] = delta ? 255 : left.data[i] >> 2;
    image.data[i + 1] = delta ? 0 : left.data[i + 1] >> 2;
    image.data[i + 2] = delta ? 0 : left.data[i + 2] >> 2;
    image.data[i + 3] = 255;
    if (delta) pixels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  if (pixels) writeFileSync(out, PNG.sync.write(image));
  return { differingPixels: pixels, totalPixels: left.width * left.height, maxChannelDelta };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const before = await capture(browser, args.baseline, 'baseline');
const after = await capture(browser, args.candidate, 'candidate');
await browser.close();
const results = Object.fromEntries(
  Object.keys(before).map((key) => [
    key,
    diff(before[key], after[key], join(OUT, `diff-${key}.png`)),
  ]),
);
const identical = Object.values(results).every((r) => r.differingPixels === 0);
const report = { fixedNow: FIXED_NOW, agents: AGENTS.length, identical, results };
writeFileSync(join(OUT, 'visual-diff.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(identical ? 0 : 2);
