/**
 * Blackbox tests for POST /completions edge function.
 *
 * Run: bash research/scripts/run-blackbox-tests.sh completions
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { cleanupTestData, getTestJwt, getTestUserId, seedApiKey } from './helpers.ts';

const BASE_URL = Deno.env.get('BASE_URL') ||
  `http://localhost:${Deno.env.get('RESEARCH_PORT') || '54321'}/functions/v1`;
const COMPLETIONS_URL = `${BASE_URL}/completions`;
const sampleMessages = [{ role: 'user' as const, content: 'What is 2+2? Just the number.' }];

/**
 * Status codes that indicate the completions function processed the request correctly
 * but the upstream provider could not fulfill it (e.g., OpenRouter credits exhausted).
 * Tests that require a successful upstream response should skip when these codes appear.
 */
const UPSTREAM_FAILURE_CODES = new Set([402, 429, 500, 502, 503]);

/** Returns true if the response indicates an upstream provider failure (not a completions function bug). */
function isUpstreamFailure(status: number, data: any): boolean {
  if (!UPSTREAM_FAILURE_CODES.has(status)) return false;
  if (status === 500) {
    const errorStr = typeof data === 'string' ? data : (data?.error || '');
    return errorStr.includes('waterfall') || errorStr.includes('failed') ||
      errorStr.includes('402') || errorStr.includes('credits');
  }
  return true;
}

let _apiKey: string | null = null;

async function getApiKey(): Promise<string | null> {
  const envKey = Deno.env.get('ROSE_API_KEY') || Deno.env.get('ROSELABS_API_KEY');
  if (envKey) return envKey;
  if (_apiKey !== null) return _apiKey;
  try {
    await getTestJwt();
    const userId = getTestUserId();
    const { apiKey } = await seedApiKey(userId, 'bbx-completions');
    _apiKey = apiKey;
    return _apiKey;
  } catch (e) {
    console.log(`Failed to obtain API key: ${e}`);
    return null;
  }
}

function skipNoKey(k: string | null): boolean {
  if (!k) {
    console.log('SKIP: No API key');
    return true;
  }
  return false;
}

function ah(k: string): Record<string, string> {
  return { 'x-api-key': k };
}

async function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; headers: Headers }> {
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let data;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data, headers: res.headers };
}

async function readStream(
  res: Response,
  maxChunks = 100,
): Promise<{ fullText: string; chunks: any[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  const chunks: any[] = [];
  let n = 0;
  try {
    while (n < maxChunks) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
      n++;
    }
  } finally {
    reader.cancel();
  }
  for (const line of fullText.split('\n')) {
    if (line.startsWith('data:') && !line.includes('[DONE]')) {
      const js = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      try { chunks.push(JSON.parse(js.trim())); } catch { /* partial */ }
    }
  }
  return { fullText, chunks };
}

// --- CORS ---

Deno.test('OPTIONS /completions - CORS headers', async () => {
  const res = await fetch(COMPLETIONS_URL, { method: 'OPTIONS' });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
  assertEquals((res.headers.get('access-control-allow-headers') || '').includes('x-api-key'), true);
  await res.body?.cancel();
});

// --- Auth boundary ---

Deno.test('POST /completions - 401 missing x-api-key', async () => {
  const { status, data } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages });
  assertEquals(status, 401);
  assertExists(data.error);
  assertMatch(data.error.toLowerCase(), /api.?key/i);
});

Deno.test('POST /completions - 401 invalid API key', async () => {
  const { status, data } = await post(
    { model: 'rose-labs/rose-1-lite', messages: sampleMessages },
    { 'x-api-key': 'not-valid-key-1234567890abcdef' },
  );
  assertEquals(status, 401);
  assertEquals(typeof data.error, 'string');
});

Deno.test('POST /completions - auth before validation', async () => {
  const { status } = await post({});
  assertEquals(status, 401);
});

// --- Validation ---

Deno.test('POST /completions - 400 missing model', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post({ messages: sampleMessages }, ah(k!));
  assertEquals(status, 400);
  assertMatch(data.error.toLowerCase(), /model/);
});

Deno.test('POST /completions - 400 missing messages', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post({ model: 'rose-labs/rose-1-lite' }, ah(k!));
  assertEquals(status, 400);
  assertMatch(data.error.toLowerCase(), /messages/);
});

Deno.test('POST /completions - 400 empty messages', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post({ model: 'rose-labs/rose-1-lite', messages: [] }, ah(k!));
  assertEquals(status, 400);
  assertMatch(data.error.toLowerCase(), /messages/);
});

Deno.test('POST /completions - 400 non-array messages', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'rose-labs/rose-1-lite', messages: 'string' },
    ah(k!),
  );
  assertEquals(status, 400);
  assertExists(data.error);
});

Deno.test('POST /completions - 400 unknown model', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'invalid-model-xyz', messages: sampleMessages },
    ah(k!),
  );
  assertEquals(status, 400);
  assertMatch(data.error.toLowerCase(), /model/);
});

Deno.test('POST /completions - 400 model_seed out of range', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'rose-labs/rose-1-lite', messages: sampleMessages, model_seed: 999, stream: false },
    ah(k!),
  );
  assertEquals(status, 400);
  assertMatch(data.error.toLowerCase(), /model_seed|out of range/i);
});

Deno.test('POST /completions - 400 invalid model_preference', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'rose-labs/rose-1-lite', messages: sampleMessages, model_preference: 'INVALID', stream: false },
    ah(k!),
  );
  assertEquals(status, 400);
  assertMatch(data.error.toLowerCase(), /model_preference|invalid/i);
});

// --- Error surface ---

Deno.test('Error responses always have { error: string }', async () => {
  const r1 = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages });
  assertEquals(typeof r1.data.error, 'string');
  const r2 = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages }, { 'x-api-key': 'bogus' });
  assertEquals(typeof r2.data.error, 'string');
});

// --- Happy-path streaming (rose-1-lite) ---
// Note: These tests tolerate upstream provider failures (e.g., OpenRouter 402 credits exhausted).
// When upstream fails, the completions function returns 500 with "waterfall models failed".
// The tests verify that auth + validation + routing passed (not 401/400), and when upstream
// succeeds, they verify the full SSE streaming contract.

Deno.test({
  name: 'POST /completions - streaming rose-1-lite valid SSE',
  fn: async () => {
    const k = await getApiKey();
    if (skipNoKey(k)) return;
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, stream: true }),
    });
    assertNotEquals(res.status, 401, 'Auth must pass with valid API key');
    assertNotEquals(res.status, 400, 'Validation must pass with valid payload');
    if (res.status !== 200) {
      const data = await res.json();
      if (isUpstreamFailure(res.status, data)) {
        console.log(`SKIP: Upstream provider unavailable (${res.status}: ${data.error})`);
        return;
      }
      assertEquals(res.status, 200, `Unexpected status: ${JSON.stringify(data)}`);
    }
    assertEquals((res.headers.get('content-type') || '').includes('text/event-stream'), true);
    const { fullText, chunks } = await readStream(res);
    assertEquals(fullText.includes('data:'), true);
    assertEquals(chunks.some((c) => c.requested_model && c.actual_model && c.pool_name), true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'POST /completions - streaming ends with [DONE]',
  fn: async () => {
    const k = await getApiKey();
    if (skipNoKey(k)) return;
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: [{ role: 'user', content: 'Say hi' }], stream: true, max_tokens: 10 }),
    });
    assertNotEquals(res.status, 401, 'Auth must pass');
    assertNotEquals(res.status, 400, 'Validation must pass');
    if (res.status !== 200) {
      const data = await res.json();
      if (isUpstreamFailure(res.status, data)) {
        console.log(`SKIP: Upstream provider unavailable (${res.status}: ${data.error})`);
        return;
      }
      assertEquals(res.status, 200, `Unexpected status: ${JSON.stringify(data)}`);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let full = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
      }
    } finally { reader.cancel(); }
    assertEquals(full.includes('[DONE]'), true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'POST /completions - streaming chunks have choices',
  fn: async () => {
    const k = await getApiKey();
    if (skipNoKey(k)) return;
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, stream: true }),
    });
    assertNotEquals(res.status, 401, 'Auth must pass');
    assertNotEquals(res.status, 400, 'Validation must pass');
    if (res.status !== 200) {
      const data = await res.json();
      if (isUpstreamFailure(res.status, data)) {
        console.log(`SKIP: Upstream provider unavailable (${res.status}: ${data.error})`);
        return;
      }
      assertEquals(res.status, 200, `Unexpected status: ${JSON.stringify(data)}`);
    }
    const { chunks } = await readStream(res);
    assertEquals(chunks.length > 0, true);
    assertEquals(chunks.some((c) => Array.isArray(c.choices) && c.choices.length > 0), true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// --- Happy-path streaming (rose-1-ultra) ---

Deno.test({
  name: 'POST /completions - streaming rose-1-ultra valid SSE',
  fn: async () => {
    const k = await getApiKey();
    if (skipNoKey(k)) return;
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({ model: 'rose-labs/rose-1-ultra', messages: sampleMessages, stream: true }),
    });
    assertNotEquals(res.status, 401, 'Auth must pass');
    assertNotEquals(res.status, 400, 'Validation must pass');
    if (res.status !== 200) {
      const data = await res.json();
      if (isUpstreamFailure(res.status, data)) {
        console.log(`SKIP: Upstream provider unavailable (${res.status}: ${data.error})`);
        return;
      }
      assertEquals(res.status, 200, `Unexpected status: ${JSON.stringify(data)}`);
    }
    assertEquals((res.headers.get('content-type') || '').includes('text/event-stream'), true);
    const { chunks } = await readStream(res);
    assertEquals(chunks.some((c) => c.requested_model && c.actual_model), true);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// --- Model name normalization ---
// These tests verify that model name normalization (prefix stripping, case insensitivity)
// does not cause a 400 validation error. A 500 from upstream is acceptable proof that
// the model name was normalized and routed correctly.

Deno.test('POST /completions - with rose-labs/ prefix', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'rose-labs/rose-1-lite', messages: sampleMessages, stream: true },
    ah(k!),
  );
  assertNotEquals(status, 401, 'Auth must pass');
  assertNotEquals(status, 400, 'rose-labs/ prefix must be accepted');
});

Deno.test('POST /completions - without prefix', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'rose-1-lite', messages: sampleMessages, stream: true },
    ah(k!),
  );
  assertNotEquals(status, 401, 'Auth must pass');
  assertNotEquals(status, 400, 'Model name without prefix must be accepted');
});

Deno.test('POST /completions - case-insensitive model', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'Rose-Labs/Rose-1-Lite', messages: sampleMessages, stream: true },
    ah(k!),
  );
  assertNotEquals(status, 401, 'Auth must pass');
  assertNotEquals(status, 400, 'Case-insensitive model name must be accepted');
});

// --- Parameter acceptance ---

Deno.test('POST /completions - accepts seed', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, seed: 42, stream: true }, ah(k!));
  assertNotEquals(status, 400);
});

Deno.test('POST /completions - accepts cot_steps', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, cot_steps: 3, stream: true }, ah(k!));
  assertNotEquals(status, 400);
});

Deno.test('POST /completions - accepts temperature', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, temperature: 0.5, stream: true }, ah(k!));
  assertNotEquals(status, 400);
});

Deno.test('POST /completions - accepts max_tokens', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, max_tokens: 50, stream: true }, ah(k!));
  assertNotEquals(status, 400);
});

Deno.test('POST /completions - accepts tools', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status } = await post({
    model: 'rose-labs/rose-1-lite',
    messages: [{ role: 'user', content: 'Weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { location: { type: 'string' } } } } }],
    stream: true,
  }, ah(k!));
  assertNotEquals(status, 400);
});

Deno.test('POST /completions - accepts skip_cache', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, skip_cache: true, stream: true }, ah(k!));
  assertNotEquals(status, 400);
});

Deno.test('POST /completions - accepts reasoning', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, reasoning: { max_tokens: 256 }, stream: true }, ah(k!));
  assertNotEquals(status, 400);
});

// --- model_seed streaming ---

Deno.test({
  name: 'POST /completions - model_seed=0 streaming',
  fn: async () => {
    const k = await getApiKey();
    if (skipNoKey(k)) return;
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, model_seed: 0, stream: true }),
    });
    assertNotEquals(res.status, 400);
    if (res.status === 200) {
      const { chunks } = await readStream(res);
      assertEquals(chunks.some((c) => c.actual_model), true);
    } else {
      await res.text(); // consume body to avoid leak
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// --- Direct passthrough ---

Deno.test('POST /completions - direct google/ passthrough', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data } = await post(
    { model: 'google/gemini-3-flash-preview', messages: sampleMessages, stream: false },
    ah(k!),
  );
  assertNotEquals(status, 400);
  assertNotEquals(status, 401);
  if (status === 200) {
    assertEquals(data.pool_name, 'direct');
    assertEquals(data.pool_size, 1);
  }
});

// --- Content-Type and CORS ---

Deno.test('POST /completions - JSON errors have application/json', async () => {
  const { headers } = await post({ model: 'rose-labs/rose-1-lite', messages: sampleMessages });
  assertEquals((headers.get('content-type') || '').includes('application/json'), true);
});

Deno.test('POST /completions - CORS on errors', async () => {
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: sampleMessages }),
  });
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
  await res.json();
});

Deno.test('POST /completions - CORS on authenticated request', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ah(k!) },
    body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: sampleMessages, stream: true }),
  });
  // CORS headers must be present regardless of upstream success/failure
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
  assertNotEquals(res.status, 401, 'Auth must pass');
  assertNotEquals(res.status, 400, 'Validation must pass');
  if (res.status === 200) {
    await res.body?.cancel();
  } else {
    await res.json(); // consume body
  }
});

// --- Custom headers ---

Deno.test('POST /completions - x-request-id accepted', async () => {
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'test-12345' },
    body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: sampleMessages }),
  });
  assertEquals(res.status, 401);
  await res.json();
});

Deno.test('POST /completions - x-agent-id x-call-site accepted', async () => {
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-id': 'test', 'x-call-site': 'bbx' },
    body: JSON.stringify({ model: 'rose-labs/rose-1-lite', messages: sampleMessages }),
  });
  assertEquals(res.status, 401);
  await res.json();
});

// --- Upstream failure error shape ---
// When upstream providers fail (e.g., 402 credits exhausted), the completions function
// should return a structured JSON error with CORS headers, not crash.

Deno.test('POST /completions - upstream failure returns JSON error with details', async () => {
  const k = await getApiKey();
  if (skipNoKey(k)) return;
  const { status, data, headers: h } = await post(
    { model: 'rose-labs/rose-1-lite', messages: sampleMessages, stream: true },
    ah(k!),
  );
  if (status === 200) {
    console.log('SKIP: Upstream succeeded (no failure to test)');
    return;
  }
  // When upstream fails, the function should still return proper JSON
  assertEquals(typeof data.error, 'string', 'Upstream failure must have error string');
  // CORS must be present even on upstream failures
  assertEquals(h.get('access-control-allow-origin'), '*');
});

// --- Same-input reproducibility ---

Deno.test('POST /completions - same invalid input produces same error', async () => {
  const payload = { model: 'rose-labs/rose-1-lite', messages: sampleMessages };
  const r1 = await post(payload);
  const r2 = await post(payload);
  assertEquals(r1.status, r2.status);
  assertEquals(r1.data.error, r2.data.error);
});

// --- Cleanup ---

Deno.test('cleanup: delete test data', async () => {
  await cleanupTestData();
});
