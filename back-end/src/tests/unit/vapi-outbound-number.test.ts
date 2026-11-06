#!/usr/bin/env tsx
/**
 * Causal repro (RCA 2026-11-06 I-13): phone-call-payment dialed FROM its own
 * benchmark callee number. The outbound caller-ID pool contained the number
 * that BENCHMARK_CALLEE_PHONE_NUMBER_IDS reserves for an inbound persona, and
 * the random pick never compared the caller with the destination.
 *
 * Drives the real initiateCall path (direct Vapi placement, no DB) with the
 * random pick forced onto every pool slot and asserts the POST /call body.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type PlacedCall = { phoneNumberId?: string; customer?: { number?: string } };

const EXTERNAL_CALLEE = '+12025550143';
const HOLD_URL_ENV = [
  'PHONE_HOLD_PUBLIC_URL',
  'PUBLIC_BASE_URL',
  'BACKEND_URL',
  'RENDER_EXTERNAL_URL',
];

test('outbound caller ID is never a reserved benchmark callee or the destination', async () => {
  // config.ts reads the key at import time; the stubbed fetch below means no
  // real Vapi request can be made with it.
  process.env.VAPI_PRIVATE_KEY = 'test-vapi-private-key';
  for (const key of HOLD_URL_ENV) delete process.env[key];
  delete process.env.BENCHMARK_CALLEE_PHONE_NUMBER_ID;

  const { OUTBOUND_PHONE_NUMBER_POOL } = await import('../../domains/vapi/config');
  const { initiateCall } = await import('../../domains/vapi/service');
  const { VapiApiError } = await import('../../domains/vapi/vapiClientService');
  assert.ok(OUTBOUND_PHONE_NUMBER_POOL.length >= 2, 'repro needs a multi-number outbound pool');

  const placed: PlacedCall[] = [];
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const pickSlot = (slot: number): void => {
    Math.random = () => (slot + 0.5) / OUTBOUND_PHONE_NUMBER_POOL.length;
  };
  const callWithEveryPick = async (to: string): Promise<PlacedCall[]> => {
    const results: PlacedCall[] = [];
    for (let slot = 0; slot < OUTBOUND_PHONE_NUMBER_POOL.length; slot += 1) {
      pickSlot(slot);
      placed.length = 0;
      await initiateCall({ to, system_prompt: 'Order roses.', output_schema: {} });
      assert.equal(placed.length, 1, 'expected exactly one Vapi call placement');
      results.push(placed[0]);
    }
    return results;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/call') || init?.method !== 'POST') {
      throw new Error(`unexpected outbound request in repro: ${init?.method ?? 'GET'} ${url}`);
    }
    placed.push(JSON.parse(String(init.body)) as PlacedCall);
    return new Response(JSON.stringify({ id: `call-${placed.length}`, status: 'queued' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const [other, callee] = OUTBOUND_PHONE_NUMBER_POOL;

    // 1. A number reserved as a benchmark callee never places outbound calls.
    process.env.BENCHMARK_CALLEE_PHONE_NUMBER_IDS = `phone-call-client-intake=not-in-pool,phone-call-payment=${callee.id}`;
    for (const call of await callWithEveryPick(EXTERNAL_CALLEE)) {
      assert.notEqual(
        call.phoneNumberId,
        callee.id,
        `outbound call used benchmark callee number ${callee.number} as its caller ID`
      );
      assert.equal(call.customer?.number, EXTERNAL_CALLEE);
    }

    // 2. The benchmark itself dials the callee: caller must never equal destination.
    for (const call of await callWithEveryPick(callee.number)) {
      assert.notEqual(call.phoneNumberId, callee.id, `call dialed itself: ${callee.number}`);
      assert.equal(call.customer?.number, callee.number);
    }

    // 3. No callee reservations: dialing a pool number still never self-dials.
    delete process.env.BENCHMARK_CALLEE_PHONE_NUMBER_IDS;
    for (const call of await callWithEveryPick(callee.number)) {
      assert.notEqual(call.phoneNumberId, callee.id, `call dialed itself: ${callee.number}`);
    }

    // 4. Destination is a pool number and every other one is reserved:
    //    refuse before contacting Vapi instead of self-dialing.
    process.env.BENCHMARK_CALLEE_PHONE_NUMBER_ID = other.id;
    process.env.BENCHMARK_CALLEE_PHONE_NUMBER_IDS = OUTBOUND_PHONE_NUMBER_POOL.slice(2)
      .map((entry, index) => `task-${index}=${entry.id}`)
      .join(',');
    for (let slot = 0; slot < OUTBOUND_PHONE_NUMBER_POOL.length; slot += 1) {
      pickSlot(slot);
      placed.length = 0;
      await assert.rejects(
        initiateCall({ to: callee.number, system_prompt: 'Order roses.', output_schema: {} }),
        (error: unknown) =>
          error instanceof VapiApiError && error.statusCode >= 400 && error.statusCode < 500,
        'expected a 4xx refusal when every eligible caller would self-dial'
      );
      assert.equal(placed.length, 0, 'a refused self-dial must not reach Vapi');
    }
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});
