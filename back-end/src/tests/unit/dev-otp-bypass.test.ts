#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Offline unit tests for the dev test-phone OTP login bypass predicate.
 *
 * Regression (PR #783): benchmark stacks set BLACKBOX_TEST_CAPTURE_OUTBOUND=1 to
 * capture the agent's outbound SMS, which flips IS_BLACKBOX_TEST and disabled the
 * dev-phone OTP bypass — deterministically breaking the message-person iMessage
 * relay's auto-login. BENCHMARK_ALLOW_DEV_OTP_LOGIN re-enables the login bypass
 * under capture, while staying IS_DEV-gated so production can never bypass.
 */

import assert from 'node:assert';
import { devTestPhoneBypassApplies } from '../../domains/auth/service.twilio';

const DEV_PHONE = '+19729777432';
const NON_TEST_PHONE = '+15551239999';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test('bypasses in plain dev (not blackbox)', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(DEV_PHONE, {
      isDev: true,
      isBlackboxTest: false,
      benchmarkAllowDevOtpLogin: false,
    }),
    true
  );
});

test('blackbox capture disables the bypass by default', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(DEV_PHONE, {
      isDev: true,
      isBlackboxTest: true,
      benchmarkAllowDevOtpLogin: false,
    }),
    false
  );
});

test('benchmark flag re-enables the bypass under capture (the relay fix)', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(DEV_PHONE, {
      isDev: true,
      isBlackboxTest: true,
      benchmarkAllowDevOtpLogin: true,
    }),
    true
  );
});

test('production can NEVER bypass, even with the benchmark flag', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(DEV_PHONE, {
      isDev: false,
      isBlackboxTest: true,
      benchmarkAllowDevOtpLogin: true,
    }),
    false
  );
  assert.strictEqual(
    devTestPhoneBypassApplies(DEV_PHONE, {
      isDev: false,
      isBlackboxTest: false,
      benchmarkAllowDevOtpLogin: false,
    }),
    false
  );
});

test('non-test phones never bypass', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(NON_TEST_PHONE, {
      isDev: true,
      isBlackboxTest: false,
      benchmarkAllowDevOtpLogin: true,
    }),
    false
  );
});

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`\n✅ ${passed} dev-OTP-bypass tests passed`);
