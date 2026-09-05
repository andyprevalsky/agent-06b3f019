#!/usr/bin/env tsx

import assert from 'node:assert';
import { CREDENTIAL_PROBE_ATTEMPTS, fetchWithTimeout } from '../blackbox/credential-probe-fetch';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function response(status: number): Response {
  return new Response(null, { status });
}

async function main(): Promise<void> {
  await test('a healthy response is returned on the first attempt', async () => {
    let calls = 0;
    const res = await fetchWithTimeout('https://example.test/health', {}, 5000, async () => {
      calls += 1;
      return response(200);
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 1, 'a successful probe must not be retried');
  });

  // The whole point of the gate: a rejected credential must fail fast and must
  // never be retried into looking healthy.
  for (const status of [401, 402, 403]) {
    await test(`an auth rejection (${status}) is surfaced without a retry`, async () => {
      let calls = 0;
      const res = await fetchWithTimeout('https://example.test/health', {}, 5000, async () => {
        calls += 1;
        return response(status);
      });
      assert.equal(res.status, status);
      assert.equal(calls, 1, 'an auth rejection is a verdict, not a transport failure');
    });
  }

  await test('a single transport abort is retried and can still succeed', async () => {
    let calls = 0;
    const res = await fetchWithTimeout('https://example.test/health', {}, 5000, async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      }
      return response(200);
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 2, 'the transport abort must be retried exactly once');
  });

  await test('a provider that never answers still throws', async () => {
    let calls = 0;
    await assert.rejects(
      fetchWithTimeout('https://example.test/health', {}, 5000, async () => {
        calls += 1;
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      }),
      /aborted/
    );
    assert.equal(calls, CREDENTIAL_PROBE_ATTEMPTS, 'retries must be bounded');
  });

  await test('the caller-supplied abort signal is passed through', async () => {
    let sawSignal = false;
    await fetchWithTimeout(
      'https://example.test/health',
      { method: 'GET' },
      5000,
      async (_u, init) => {
        sawSignal = init.signal instanceof AbortSignal;
        assert.equal(init.method, 'GET', 'caller init must be preserved');
        return response(200);
      }
    );
    assert.ok(sawSignal, 'each attempt must carry its own timeout signal');
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
    process.exit(1);
  }
}

void main();
