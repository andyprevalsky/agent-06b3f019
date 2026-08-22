#!/usr/bin/env tsx
/**
 * Permanent coverage for the in-page CAPTCHA auto-solve live-view banner.
 *
 * Diagram (feature context):
 *
 *   Kernel/Steel session create ──► installCaptchaSolveIndicator (Playwright)
 *   Compute connect attachCdp   ──► Page.addScriptToEvaluateOnNewDocument
 *   Agent browser CDP attach    ──► same script (Python mirror)
 *              │
 *              ▼
 *   Live view shows "AUTO-SOLVING CAPTCHA" banner when widgets detected
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTCHA_SOLVE_INDICATOR_DOM_ID,
  CAPTCHA_SOLVE_INDICATOR_SCRIPT,
  installCaptchaSolveIndicator,
} from '../../providers/browser/captchaSolveIndicator';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../../..');

function extractPythonScript(source: string): string {
  const marker = 'CAPTCHA_SOLVE_INDICATOR_SCRIPT = r"""';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'python script marker missing');
  const bodyStart = start + marker.length;
  const end = source.indexOf('"""', bodyStart);
  assert.ok(end > bodyStart, 'python script terminator missing');
  return source.slice(bodyStart, end);
}

function testTsAndPythonScriptsStayInSync(): void {
  const pyPath = join(REPO_ROOT, 'agents/browser_tools/captcha_solve_indicator.py');
  const pySource = readFileSync(pyPath, 'utf8');
  const pyScript = extractPythonScript(pySource);
  assert.equal(
    pyScript,
    CAPTCHA_SOLVE_INDICATOR_SCRIPT,
    'TS and Python CAPTCHA indicator scripts drifted — update both'
  );
  assert.ok(pySource.includes(CAPTCHA_SOLVE_INDICATOR_DOM_ID));
}

function testScriptAdvertisesVisibleBannerCopy(): void {
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /Auto-solving CAPTCHA/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /do not click the challenge/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /hcaptcha\.com/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /pointer-events:none/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, new RegExp(CAPTCHA_SOLVE_INDICATOR_DOM_ID));
}

async function testInstallRegistersInitScriptOnAllContexts(): Promise<void> {
  const initScripts: string[] = [];
  const evaluates: string[] = [];
  const fakeBrowser = {
    contexts: () => [
      {
        addInitScript: async (script: string) => {
          initScripts.push(script);
        },
        pages: () => [
          {
            evaluate: async (script: string) => {
              evaluates.push(script);
            },
          },
        ],
      },
      {
        addInitScript: async (script: string) => {
          initScripts.push(script);
        },
        pages: () => [],
      },
    ],
  };

  await installCaptchaSolveIndicator(fakeBrowser as never);
  assert.equal(initScripts.length, 2);
  assert.equal(initScripts[0], CAPTCHA_SOLVE_INDICATOR_SCRIPT);
  assert.equal(evaluates.length, 1);
  assert.equal(evaluates[0], CAPTCHA_SOLVE_INDICATOR_SCRIPT);
}

async function testScriptShowsAndHidesBannerInRealPage(): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(CAPTCHA_SOLVE_INDICATOR_SCRIPT);
    await page.goto('data:text/html,<html><body><h1>clean</h1></body></html>');
    await page.waitForTimeout(100);
    assert.equal(await page.locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}`).count(), 0);

    await page.evaluate(() => {
      const iframe = document.createElement('iframe');
      iframe.src = 'https://newassets.hcaptcha.com/captcha/v1/challenge';
      iframe.title = 'hCaptcha challenge';
      document.body.appendChild(iframe);
    });
    await page.waitForSelector(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}`, { timeout: 3_000 });
    const title = await page
      .locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID} .rose-captcha-title`)
      .innerText();
    assert.match(title, /auto-solving captcha/i);

    await page.evaluate(() => {
      document.querySelectorAll('iframe').forEach((el) => el.remove());
    });
    await page.waitForFunction(
      (id) => document.getElementById(id) === null,
      CAPTCHA_SOLVE_INDICATOR_DOM_ID,
      { timeout: 3_000 }
    );
  } finally {
    await browser.close();
  }
}

function testInstallSitesAreWired(): void {
  const kernel = readFileSync(join(REPO_ROOT, 'back-end/src/providers/browser/kernel.ts'), 'utf8');
  const steel = readFileSync(join(REPO_ROOT, 'back-end/src/providers/steel/session.ts'), 'utf8');
  const recovery = readFileSync(
    join(REPO_ROOT, 'back-end/src/providers/steel/sessionRecovery.ts'),
    'utf8'
  );
  const cdp = readFileSync(
    join(REPO_ROOT, 'back-end/src/domains/compute-grants/connectSession.ts'),
    'utf8'
  );
  const agent = readFileSync(join(REPO_ROOT, 'agents/browser_tools/dom_service.py'), 'utf8');

  assert.match(kernel, /installCaptchaSolveIndicator/);
  assert.match(steel, /installCaptchaSolveIndicator/);
  assert.match(recovery, /installCaptchaSolveIndicator/);
  assert.match(cdp, /CAPTCHA_SOLVE_INDICATOR_SCRIPT/);
  assert.match(agent, /_inject_captcha_solve_indicator/);
}

testTsAndPythonScriptsStayInSync();
testScriptAdvertisesVisibleBannerCopy();
testInstallSitesAreWired();

async function main(): Promise<void> {
  await testInstallRegistersInitScriptOnAllContexts();
  await testScriptShowsAndHidesBannerInRealPage();
  process.stdout.write('PASS captcha solve indicator\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
