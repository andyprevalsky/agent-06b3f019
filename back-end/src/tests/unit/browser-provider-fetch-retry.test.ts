#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  isTransientKernelConnectionError,
  retryBackendFetch,
} from '../blackbox/browser-provider.helpers';

async function run(): Promise<void> {
  assert.equal(
    isTransientKernelConnectionError(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })
    ),
    true
  );
  assert.equal(
    isTransientKernelConnectionError(new Error('rotate-proxy 400: invalid request')),
    false
  );
  assert.equal(
    isTransientKernelConnectionError(
      new Error(
        '/rotate-proxy 500: Timed out fetching a new connection from the connection pool (Current connection pool timeout: 30, connection limit: 4)'
      )
    ),
    true
  );
  assert.equal(
    isTransientKernelConnectionError(new Error('/rotate-proxy 500: {"error":"P2024"}')),
    true
  );

  const originalFetch = globalThis.fetch;
  let retryCalls = 0;
  globalThis.fetch = (async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw new TypeError('fetch failed');
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    const response = await retryBackendFetch('http://localhost/retry-probe');
    assert.equal(retryCalls, 2);
    assert.equal(response.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let semanticCalls = 0;
  globalThis.fetch = (async () => {
    semanticCalls += 1;
    throw new Error('rotate-proxy 400: invalid request');
  }) as typeof fetch;
  try {
    await assert.rejects(() => retryBackendFetch('http://localhost/no-retry'), /rotate-proxy 400/);
    assert.equal(semanticCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  process.stdout.write('PASS browser provider fetch retries only transport failures\n');
}

void run();
