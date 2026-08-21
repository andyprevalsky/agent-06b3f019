#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Offline unit tests for the dev test-phone OTP login bypass predicate.
 *
 * The shared admin/test phones (+19729777432 / +529729777432) must NEVER hit
 * live Twilio Verify from local/blackbox/benchmark stacks — they share the
 * production Verify service and have repeatedly rate-limited prod login.
 * Capture/blackbox flags therefore cannot disable the bypass.
 */

import assert from 'node:assert';
import { devTestPhoneBypassApplies } from '../../domains/auth/service.twilio';

const DEV_PHONE = '+19729777432';
const LATAM_DEV_PHONE = '+529729777432';
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

test('blackbox capture still bypasses (never burn prod Verify quota)', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(DEV_PHONE, {
      isDev: true,
      isBlackboxTest: true,
      benchmarkAllowDevOtpLogin: false,
    }),
    true
  );
});

test('LATAM +52 dev phone also bypasses under capture', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(LATAM_DEV_PHONE, {
      isDev: true,
      isBlackboxTest: true,
      benchmarkAllowDevOtpLogin: false,
    }),
    true
  );
});

test('benchmark flag is irrelevant — bypass stays on under capture either way', () => {
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

test('spaced formatting of the admin phone still bypasses', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies('+1 972 977 7432', {
      isDev: true,
      isBlackboxTest: true,
      benchmarkAllowDevOtpLogin: false,
    }),
    true
  );
});

test('non-string phone does not throw and does not bypass', () => {
  assert.strictEqual(
    devTestPhoneBypassApplies(null as unknown as string, {
      isDev: true,
      isBlackboxTest: true,
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
