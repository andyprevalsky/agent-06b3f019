#!/usr/bin/env tsx
/**
 * Capture real-browser screenshots of the CAPTCHA auto-solve chip phases.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  CAPTCHA_SOLVE_INDICATOR_SCRIPT,
  captchaSolveIndicatorSetPhaseScript,
  type CaptchaIndicatorPhase,
} from '../src/providers/browser/captchaSolveIndicator';

const HTML = `<!doctype html>
<html>
<head>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafafa; color: #111; }
    .wrap { max-width: 420px; margin: 72px auto; padding: 32px; background: white; border: 1px solid #e5e5e5; border-radius: 12px; }
    .logo { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    .sub { color: #666; margin-bottom: 24px; }
    .challenge {
      border: 1px solid #d4d4d4; border-radius: 8px; overflow: hidden; background: #fff;
    }
    .challenge-head { background: #1a9b8e; color: white; padding: 10px 12px; font-weight: 600; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 8px; }
    .tile { aspect-ratio: 1; background: linear-gradient(135deg, #ddd, #bbb); border-radius: 4px; }
    .foot { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">Claude</div>
    <div class="sub">Sign in</div>
    <div class="challenge">
      <div class="challenge-head">Select items smaller than a monitor</div>
      <div class="grid">
        <div class="tile"></div><div class="tile"></div><div class="tile"></div>
        <div class="tile"></div><div class="tile"></div><div class="tile"></div>
        <div class="tile"></div><div class="tile"></div><div class="tile"></div>
      </div>
      <div class="foot"><span>hCaptcha</span><span>Skip</span></div>
    </div>
  </div>
</body>
</html>`;

async function shot(
  phase: Exclude<CaptchaIndicatorPhase, 'idle'>,
  filename: string
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    await page.addInitScript(CAPTCHA_SOLVE_INDICATOR_SCRIPT);
    await page.goto('data:text/html,' + encodeURIComponent(HTML));
    await page.evaluate(captchaSolveIndicatorSetPhaseScript(phase));
    await page.waitForSelector(`#rose-captcha-auto-solve-chip[data-phase="${phase}"]`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/opt/cursor/artifacts/${filename}`, fullPage: true });
    process.stdout.write(`Wrote /opt/cursor/artifacts/${filename}\n`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  mkdirSync('/opt/cursor/artifacts', { recursive: true });
  await shot('solving', 'captcha_auto_solve_chip_solving.png');
  await shot('succeeded', 'captcha_auto_solve_chip_succeeded.png');
  await shot('failed', 'captcha_auto_solve_chip_failed.png');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exit(1);
});
