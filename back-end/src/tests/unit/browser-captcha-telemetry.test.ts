#!/usr/bin/env tsx
/** Permanent regression coverage for provider CAPTCHA observability. */
import assert from 'node:assert';
import {
  kernelCaptchaTelemetryConfig,
  summarizeKernelCaptchaEvents,
  summarizeSteelCaptchaStatus,
} from '../../providers/browser/captchaTelemetry';

function testKernelTelemetryIsExplicitlyEnabled(): void {
  assert.deepStrictEqual(kernelCaptchaTelemetryConfig(), {
    enabled: true,
    browser: { captcha: { enabled: true } },
  });
}

function testKernelTerminalOutcomesAreNormalized(): void {
  const telemetry = summarizeKernelCaptchaEvents([
    {
      seq: 10,
      event: {
        category: 'captcha',
        type: 'captcha_solve_result',
        ts: 1_700_000_000_000_000,
        source: { service: 'captcha' },
        data: {
          captcha_type: 'turnstile',
          duration_ms: 12_500,
          status: 'abandoned',
          website_host: 'example.com',
        },
      },
    },
  ]);

  assert.strictEqual(telemetry.provider, 'kernel');
  assert.strictEqual(telemetry.telemetryEnabled, true);
  assert.strictEqual(telemetry.latestOutcome?.status, 'abandoned');
  assert.strictEqual(telemetry.latestOutcome?.captchaType, 'turnstile');
  assert.strictEqual(telemetry.latestOutcome?.durationMs, 12_500);
}

function testSteelInFlightSolverStateIsNormalized(): void {
  const telemetry = summarizeSteelCaptchaStatus([
    {
      isSolvingCaptcha: true,
      pageId: 'page-1',
      tasks: [{ id: 'captcha-task-1', status: 'solving', type: 'turnstile' }],
      url: 'https://example.com/challenge?session_secret=must-not-leak',
      created: 100,
      lastUpdated: 200,
    },
  ]);

  assert.strictEqual(telemetry.provider, 'steel');
  assert.strictEqual(telemetry.telemetryEnabled, true);
  assert.strictEqual(telemetry.isSolving, true);
  assert.strictEqual(telemetry.activeTaskCount, 1);
  assert.strictEqual(telemetry.pages[0]?.hostname, 'example.com');
  assert.strictEqual('pageId' in (telemetry.pages[0] ?? {}), false);
  assert.strictEqual(JSON.stringify(telemetry).includes('must-not-leak'), false);
  assert.strictEqual(telemetry.latestOutcome, null);
}

function testSteelTerminalTaskOutcomesAreNormalized(): void {
  const telemetry = summarizeSteelCaptchaStatus([
    {
      isSolvingCaptcha: false,
      pageId: 'page-1',
      tasks: [
        {
          id: 'older',
          status: 'failed_to_solve',
          type: 'recaptchaV2',
          failureTime: 1_000,
          totalDuration: 900,
        },
        {
          id: 'newer',
          status: 'solved',
          type: 'turnstile',
          solveTime: 2_000,
          totalDuration: 1_500,
        },
      ],
      url: 'https://login.example.com/start',
      lastUpdated: 2_000,
    },
  ]);

  assert.strictEqual(telemetry.isSolving, false);
  assert.strictEqual(telemetry.latestOutcome?.status, 'success');
  assert.strictEqual(telemetry.latestOutcome?.captchaType, 'turnstile');
  assert.strictEqual(telemetry.latestOutcome?.durationMs, 1_500);
  assert.strictEqual(telemetry.latestOutcome?.websiteHost, 'login.example.com');
  assert.strictEqual(telemetry.latestOutcome?.timestampMicros, 2_000_000);
}

testKernelTelemetryIsExplicitlyEnabled();
testKernelTerminalOutcomesAreNormalized();
testSteelInFlightSolverStateIsNormalized();
testSteelTerminalTaskOutcomesAreNormalized();
process.stdout.write('PASS browser CAPTCHA telemetry normalization\n');
