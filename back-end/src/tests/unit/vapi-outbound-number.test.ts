#!/usr/bin/env tsx
/**
 * RCA 2026-11-06 I-13: phone-call-payment dialed FROM its own benchmark callee
 * number, because that answering line was in the outbound caller-ID pool.
 * No outbound caller ID may be a benchmark callee: the known phone-call-payment
 * line, or any id in BENCHMARK_CALLEE_PHONE_NUMBER_ID(S), parsed as
 * agents/benchmarks/phone_callee.py does (one id, or comma-separated task=id).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// The phone-call-payment benchmark's answering line (+14159416744).
const PHONE_CALL_PAYMENT_CALLEE_ID = '2fe93786-c619-4a57-8a74-710f87b7b13b';

function configuredCalleeIds(env: NodeJS.ProcessEnv): string[] {
  const ids = [env.BENCHMARK_CALLEE_PHONE_NUMBER_ID?.trim() ?? ''];
  for (const entry of (env.BENCHMARK_CALLEE_PHONE_NUMBER_IDS ?? '').split(',')) {
    const separator = entry.indexOf('=');
    if (separator > 0) ids.push(entry.slice(separator + 1).trim());
  }
  return ids.filter(Boolean);
}

test('no outbound caller ID is a benchmark callee number', async () => {
  process.env.VAPI_PRIVATE_KEY ??= 'test-vapi-private-key';
  const { OUTBOUND_PHONE_NUMBER_POOL } = await import('../../domains/vapi/config');
  assert.ok(OUTBOUND_PHONE_NUMBER_POOL.length > 0, 'outbound caller pool must not be empty');

  const callees = new Set([PHONE_CALL_PAYMENT_CALLEE_ID, ...configuredCalleeIds(process.env)]);
  const overlap = OUTBOUND_PHONE_NUMBER_POOL.filter((phone) => callees.has(phone.id));
  assert.deepEqual(overlap, [], 'benchmark callee numbers must never be outbound caller IDs');
  assert.ok(
    !OUTBOUND_PHONE_NUMBER_POOL.some((phone) => phone.number === '+14159416744'),
    'the phone-call-payment answering line must not be an outbound caller ID'
  );
});

test('callee id parsing matches the phone_callee.py env contract', () => {
  assert.deepEqual(
    configuredCalleeIds({
      BENCHMARK_CALLEE_PHONE_NUMBER_ID: ' single-id ',
      BENCHMARK_CALLEE_PHONE_NUMBER_IDS: 'phone-call-payment=id-a, phone-hold=id-b',
    }),
    ['single-id', 'id-a', 'id-b']
  );
  assert.deepEqual(configuredCalleeIds({}), []);
});
