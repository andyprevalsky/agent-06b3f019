#!/usr/bin/env tsx
/**
 * Permanent coverage for the telemetry-driven CAPTCHA auto-solve live-view chip.
 *
 *   Provider CAPTCHA telemetry ──► resolveCaptchaAutoSolveActive
 *              │
 *              ▼
 *   CDP setSolving(true|false) ──► in-page chip show/hide
 *
 * Steel uses real isSolving; Kernel synthesizes via live challenge-widget probe
 * because Kernel only emits terminal captcha_solve_result events.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTCHA_SOLVE_INDICATOR_DOM_ID,
  CAPTCHA_SOLVE_INDICATOR_SCRIPT,
  captchaSolveIndicatorSetSolvingScript,
  installCaptchaSolveIndicator,
  resolveCaptchaAutoSolveActive,
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
  assert.ok(pySource.includes('resolve_captcha_auto_solve_active'));
}

function testScriptIsTelemetryDrivenNotDomOnly(): void {
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /Auto-solving CAPTCHA/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /__ROSE_CAPTCHA_AUTO_SOLVE__/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /setSolving/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /pointer-events:none/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /border-radius:9999px/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /bottom:40px/);
  assert.doesNotMatch(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /hcaptcha\.com/);
  assert.doesNotMatch(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /captchaVisible/);
}

function testResolveCaptchaAutoSolveActive(): void {
  assert.equal(resolveCaptchaAutoSolveActive({ provider: 'steel', isSolving: true }), true);
  assert.equal(resolveCaptchaAutoSolveActive({ provider: 'steel', isSolving: false }), false);
  assert.equal(
    resolveCaptchaAutoSolveActive(
      { provider: 'kernel', isSolving: null },
      { kernelChallengeWidgetsPresent: true }
    ),
    true
  );
  assert.equal(
    resolveCaptchaAutoSolveActive(
      { provider: 'kernel', isSolving: null },
      { kernelChallengeWidgetsPresent: false }
    ),
    false
  );
  assert.equal(
    resolveCaptchaAutoSolveActive(
      { provider: 'steel', isSolving: false },
      { kernelChallengeWidgetsPresent: true }
    ),
    false
  );
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
}

async function testScriptShowsOnlyWhenTelemetrySetsSolving(): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(CAPTCHA_SOLVE_INDICATOR_SCRIPT);
    await page.goto(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body style="font-family:sans-serif;padding:40px">' +
            '<h1>Sign in</h1>' +
            '<p>Demo login page</p>' +
            '<iframe src="https://newassets.hcaptcha.com/captcha/v1/challenge" title="hCaptcha challenge" ' +
            'style="width:320px;height:120px;border:1px solid #ccc"></iframe>' +
            '</body></html>'
        )
    );
    await page.waitForTimeout(200);
    // Captcha iframe is visible but telemetry has not said solving yet.
    assert.equal(await page.locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}`).count(), 0);

    await page.evaluate(captchaSolveIndicatorSetSolvingScript(true));
    await page.waitForSelector(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}`, { timeout: 3_000 });
    const label = await page
      .locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID} .rose-captcha-label`)
      .innerText();
    assert.match(label, /auto-solving captcha/i);

    await page.evaluate(captchaSolveIndicatorSetSolvingScript(false));
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
  const watcher = readFileSync(
    join(REPO_ROOT, 'back-end/src/domains/compute-grants/connectSession.watcher.ts'),
    'utf8'
  );
  const agent = readFileSync(join(REPO_ROOT, 'agents/browser_tools/dom_service.py'), 'utf8');
  const handler = readFileSync(
    join(REPO_ROOT, 'agents/domains/spawn_browser_agent_v3/handler.py'),
    'utf8'
  );

  assert.match(kernel, /installCaptchaSolveIndicator/);
  assert.match(steel, /installCaptchaSolveIndicator/);
  assert.match(recovery, /installCaptchaSolveIndicator/);
  assert.match(watcher, /resolveCaptchaAutoSolveActive/);
  assert.match(watcher, /captchaSolveIndicatorSetSolvingScript/);
  assert.match(agent, /start_captcha_telemetry_indicator/);
  assert.match(handler, /start_captcha_telemetry_indicator_for_task/);
}

testTsAndPythonScriptsStayInSync();
testScriptIsTelemetryDrivenNotDomOnly();
testResolveCaptchaAutoSolveActive();
testInstallSitesAreWired();

async function main(): Promise<void> {
  await testInstallRegistersInitScriptOnAllContexts();
  await testScriptShowsOnlyWhenTelemetrySetsSolving();
  process.stdout.write('PASS captcha solve indicator\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
