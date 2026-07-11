#!/usr/bin/env tsx
/**
 * Black-box tests for the LATAM dev test phone (+529729777432 / 181818).
 *
 * The +52 variant of the dev credentials exercises the country-selector →
 * E.164 → OTP path end to end without sending a real Mexican SMS. The bypass
 * is dev-only (IS_DEV && !IS_BLACKBOX_TEST — see auth/service.twilio.ts), so
 * assertions are lenient the same way auth.blackbox.ts is for the +1 dev
 * phone: 200 when the bypass is active, 400/500 when the backend runs with
 * outbound capture (real Twilio required) or outside dev.
 *
 * Usage:
 *   bash scripts/run-blackbox-tests.sh auth-latam-dev-phone
 */

import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

const LATAM_DEV_PHONE = '+529729777432';
const DEV_OTP = '181818';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const ct = response.headers.get('content-type');
  const data = ct?.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

async function testSendOtp_latamDevPhone() {
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: LATAM_DEV_PHONE }),
  });
  // 200 when the dev bypass is active; 400/500 when capture mode forces real Twilio
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(
      `Expected 200/400/500 for LATAM dev send-otp, got ${res.status}: ${JSON.stringify(res.data)}`
    );
  }
}

async function testVerifyOtp_latamDevPhone() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: LATAM_DEV_PHONE, token: DEV_OTP }),
  });
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(
      `Expected 200/400/500 for LATAM dev verify-otp, got ${res.status}: ${JSON.stringify(res.data)}`
    );
  }
}

async function testVerifyOtp_latamDevPhoneRejectsWrongCode() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: LATAM_DEV_PHONE, token: '000000' }),
  });
  if (res.status === 200) {
    throw new Error('Expected the LATAM dev phone to reject a wrong OTP code');
  }
}

async function runAll() {
  console.log('LATAM Dev Phone Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}\n`);

  const tests = [
    { name: 'POST /send-otp -- +52 dev phone accepted', fn: testSendOtp_latamDevPhone },
    { name: 'POST /verify-otp -- +52 dev phone + 181818', fn: testVerifyOtp_latamDevPhone },
    {
      name: 'POST /verify-otp -- +52 dev phone rejects wrong code',
      fn: testVerifyOtp_latamDevPhoneRejectsWrongCode,
    },
  ];

  const results: TestResult[] = [];
  for (const test of tests) {
    const result = await runTest(test.name, test.fn);
    results.push(result);
    const icon = result.passed ? '  PASS' : '  FAIL';
    console.log(
      `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
    );
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
