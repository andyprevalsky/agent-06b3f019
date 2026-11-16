#!/usr/bin/env tsx
/**
 * Permanent coverage for the telemetry-driven CAPTCHA auto-solve live-view chip.
 *
 *   Provider CAPTCHA telemetry ──► resolveCaptchaIndicatorPhase
 *              │
 *              ▼
 *   CDP setPhase(idle|solving|succeeded|failed) ──► animated chip
 *
 * Steel: isSolving + terminal task status. Kernel: captcha_solve_result only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTCHA_SOLVE_INDICATOR_DOM_ID,
  CAPTCHA_SOLVE_INDICATOR_SCRIPT,
  captchaSolveIndicatorSetPhaseScript,
  emptyCaptchaIndicatorMemory,
  installCaptchaSolveIndicator,
  resolveCaptchaAutoSolveActive,
  resolveCaptchaIndicatorPhase,
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
  assert.ok(pySource.includes('resolve_captcha_indicator_phase'));
}

function testScriptIsTelemetryDrivenNotDomOnly(): void {
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /Auto-solving CAPTCHA/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /CAPTCHA solved/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /CAPTCHA solve failed/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /__ROSE_CAPTCHA_AUTO_SOLVE__/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /setPhase/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /pointer-events:none/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /border-radius:9999px/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /bottom:40px/);
  assert.match(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /transition:opacity/);
  assert.doesNotMatch(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /hcaptcha\.com/);
  assert.doesNotMatch(CAPTCHA_SOLVE_INDICATOR_SCRIPT, /captchaVisible/);
}

function testResolveCaptchaAutoSolveActive(): void {
  assert.equal(resolveCaptchaAutoSolveActive({ provider: 'steel', isSolving: true }), true);
  assert.equal(resolveCaptchaAutoSolveActive({ provider: 'steel', isSolving: false }), false);
  assert.equal(resolveCaptchaAutoSolveActive({ provider: 'kernel', isSolving: null }), false);
}

function testResolveCaptchaIndicatorPhaseTransitions(): void {
  let memory = emptyCaptchaIndicatorMemory();

  let resolved = resolveCaptchaIndicatorPhase(
    { provider: 'steel', isSolving: true, latestOutcome: null },
    memory
  );
  assert.equal(resolved.phase, 'solving');
  memory = resolved.memory;

  const nowMicros = Date.now() * 1000;
  resolved = resolveCaptchaIndicatorPhase(
    {
      provider: 'steel',
      isSolving: false,
      latestOutcome: {
        status: 'success',
        captchaType: 'turnstile',
        durationMs: 1200,
        errorCode: null,
        websiteHost: 'example.com',
        timestampMicros: nowMicros,
      },
    },
    memory
  );
  assert.equal(resolved.phase, 'succeeded');
  memory = resolved.memory;

  // Same outcome must not re-fire forever.
  resolved = resolveCaptchaIndicatorPhase(
    {
      provider: 'steel',
      isSolving: false,
      latestOutcome: {
        status: 'success',
        captchaType: 'turnstile',
        durationMs: 1200,
        errorCode: null,
        websiteHost: 'example.com',
        timestampMicros: nowMicros,
      },
    },
    memory
  );
  assert.equal(resolved.phase, 'idle');

  // Kernel has no in-flight state: idle until a fresh terminal outcome lands.
  memory = emptyCaptchaIndicatorMemory();
  resolved = resolveCaptchaIndicatorPhase(
    { provider: 'kernel', isSolving: null, latestOutcome: null },
    memory
  );
  assert.equal(resolved.phase, 'idle');
  memory = resolved.memory;

  resolved = resolveCaptchaIndicatorPhase(
    {
      provider: 'kernel',
      isSolving: null,
      latestOutcome: {
        status: 'failure',
        captchaType: 'hcaptcha',
        durationMs: 800,
        errorCode: 'ERROR_CAPTCHA_UNSOLVABLE',
        websiteHost: 'claude.ai',
        timestampMicros: Date.now() * 1000,
      },
    },
    memory
  );
  assert.equal(resolved.phase, 'failed');
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

async function testScriptShowsPhaseTransitions(): Promise<void> {
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
    assert.equal(await page.locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}`).count(), 0);

    await page.evaluate(captchaSolveIndicatorSetPhaseScript('solving'));
    await page.waitForSelector(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}[data-phase="solving"]`, {
      timeout: 3_000,
    });
    let label = await page
      .locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID} .rose-captcha-label`)
      .innerText();
    assert.match(label, /auto-solving captcha/i);

    await page.evaluate(captchaSolveIndicatorSetPhaseScript('succeeded'));
    await page.waitForSelector(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}[data-phase="succeeded"]`, {
      timeout: 3_000,
    });
    label = await page
      .locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID} .rose-captcha-label`)
      .innerText();
    assert.match(label, /captcha solved/i);

    await page.evaluate(captchaSolveIndicatorSetPhaseScript('failed'));
    await page.waitForSelector(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}[data-phase="failed"]`, {
      timeout: 3_000,
    });
    label = await page
      .locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID} .rose-captcha-label`)
      .innerText();
    assert.match(label, /captcha solve failed/i);

    // idle while holding terminal should not instantly clear
    await page.evaluate(captchaSolveIndicatorSetPhaseScript('idle'));
    assert.equal(await page.locator(`#${CAPTCHA_SOLVE_INDICATOR_DOM_ID}`).count(), 1);
  } finally {
    await browser.close();
  }
}

/**
 * H-35b: a challenge widget on the page is not evidence that a solver is
 * working on it. Kernel reports only terminal captcha_solve_result events and
 * Tilion reports no per-session solver state, so neither may claim "solving";
 * the chip is in-page DOM that the browser agent reads as fact.
 */
function testWidgetPresenceIsNotSolverEvidence(): void {
  const indicatorSources = [
    'back-end/src/providers/browser/captchaSolveIndicator.ts',
    'back-end/src/domains/compute-grants/connectSession.watcher.ts',
    'agents/browser_tools/captcha_solve_indicator.py',
    'agents/browser_tools/dom_service.py',
  ];
  for (const relative of indicatorSources) {
    const source = readFileSync(join(REPO_ROOT, relative), 'utf8');
    assert.doesNotMatch(
      source,
      /CAPTCHA_WIDGET_PRESENT_SCRIPT|kernelChallengeWidgetsPresent|kernel_challenge_widgets_present|probe_captcha_widgets_present/,
      `${relative} still treats widget presence as solver evidence`
    );
  }
  for (const provider of ['kernel', 'tilion'] as const) {
    assert.equal(resolveCaptchaAutoSolveActive({ provider, isSolving: null }), false);
    assert.equal(
      resolveCaptchaIndicatorPhase({ provider, isSolving: null, latestOutcome: null }).phase,
      'idle'
    );
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
  assert.match(watcher, /resolveCaptchaIndicatorPhase/);
  assert.match(watcher, /captchaSolveIndicatorSetPhaseScript/);
  assert.match(agent, /start_captcha_telemetry_indicator/);
  assert.match(agent, /set_captcha_indicator_phase/);
  assert.match(handler, /start_captcha_telemetry_indicator_for_task/);
}

testTsAndPythonScriptsStayInSync();
testScriptIsTelemetryDrivenNotDomOnly();
testResolveCaptchaAutoSolveActive();
testResolveCaptchaIndicatorPhaseTransitions();
testInstallSitesAreWired();
testWidgetPresenceIsNotSolverEvidence();

async function main(): Promise<void> {
  await testInstallRegistersInitScriptOnAllContexts();
  await testScriptShowsPhaseTransitions();
  process.stdout.write('PASS captcha solve indicator\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
