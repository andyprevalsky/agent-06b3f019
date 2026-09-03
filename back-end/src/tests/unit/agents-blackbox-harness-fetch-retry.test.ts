#!/usr/bin/env tsx

/**
 * Coverage blackbox can drop a live socket (`fetch failed`) while the
 * backend is still healthy. createTestAgent already retries that; request()
 * must too so tenant-isolation DELETEs do not fail the suite.
 *
 * Run: npx tsx src/tests/unit/agents-blackbox-harness-fetch-retry.test.ts
 */

import assert from 'node:assert/strict';

import { isTransientFetchError, request } from '../blackbox/agents-blackbox-harness';

async function run(): Promise<void> {
  assert.equal(isTransientFetchError(new TypeError('fetch failed')), true);
  assert.equal(
    isTransientFetchError(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })
    ),
    true
  );
  assert.equal(isTransientFetchError(new Error('Expected status 404, got 500')), false);

  const originalFetch = globalThis.fetch;
  let retryCalls = 0;
  globalThis.fetch = (async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ error: 'Agent not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const res = await request('http://localhost/api/agents/retry-probe', { method: 'DELETE' });
    assert.equal(retryCalls, 2);
    assert.equal(res.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let noRetryCalls = 0;
  globalThis.fetch = (async () => {
    noRetryCalls += 1;
    throw new Error('Expected status 404, got 500');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => request('http://localhost/api/agents/no-retry', { method: 'DELETE' }),
      /Expected status 404/
    );
    assert.equal(noRetryCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  process.stdout.write('PASS agents blackbox request retries fetch failed\n');
}

void run();
