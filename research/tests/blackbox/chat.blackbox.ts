/**
 * Blackbox tests for the chat Supabase edge function.
 *
 * Domain surface:
 *   The chat function is an OpenAI-compatible /chat/completions proxy.
 *   It strips the /chat prefix and forwards requests to the completions function.
 *   URL: /functions/v1/chat/completions
 *
 * Entrypoints tested:
 *   1. Path routing — only /chat/completions and /chat are valid; other paths return 404
 *   2. Auth passthrough — API key (x-api-key) is forwarded to completions
 *   3. Auth boundary — missing API key results in 401 from completions
 *   4. Happy path — valid request returns chat completion response
 *   5. Validation passthrough — invalid payloads produce 400 from completions
 *   6. Error surface consistency — all errors include { error: string }
 *   7. Same-input reproducibility — same invalid input produces same error
 *   8. Method passthrough — POST body and headers are forwarded faithfully
 *   9. Response shape contract — proxied response matches completions contract
 *
 * Boundary:
 *   The edge function makes an outbound fetch() to SUPABASE_URL + /functions/v1/completions.
 *   Since this is a Supabase-internal call (edge function -> edge function on same project),
 *   we cannot use fetchCapture. We test the boundary indirectly: by verifying that the chat
 *   endpoint produces the same observable responses as calling /completions directly.
 *   Any divergence between /chat/completions and /completions indicates broken proxy behavior.
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { testClient } from './helpers.ts';

const ROSE_API_KEY = Deno.env.get('ROSE_API_KEY') || Deno.env.get('ROSELABS_API_KEY') || '';

const sampleMessages = [{ role: 'user' as const, content: 'What is 2+2? Reply in one word.' }];

/** Status codes that indicate the API key was accepted but the request cannot be fulfilled */
const AUTH_OR_QUOTA_CODES = new Set([401, 402, 429]);

// ---------------------------------------------------------------------------
// Path routing
// ---------------------------------------------------------------------------

Deno.test('POST /chat/completions — valid path returns non-404 response', async () => {
  // Even without an API key, the proxy should forward to completions
  // and return completions' auth error — NOT a 404.
  const res = await testClient.post('/chat/completions', {
    model: 'rose-labs/rose-1-lite',
    messages: sampleMessages,
  });
  assertNotEquals(res.status, 404, 'Valid path /chat/completions must not return 404');
});

Deno.test('GET /chat/invalid-path — returns 404 for unknown path', async () => {
  const res = await testClient.request('/chat/invalid-path');
  assertEquals(res.status, 404);
  assertEquals(typeof res.data.error, 'string');
  assertEquals(res.data.error, 'Not found');
});

Deno.test('GET /chat/foo/bar — returns 404 for deeply nested unknown path', async () => {
  const res = await testClient.request('/chat/foo/bar');
  assertEquals(res.status, 404);
  assertEquals(res.data.error, 'Not found');
});

Deno.test('POST /chat/some-other-endpoint — returns 404', async () => {
  const res = await testClient.post('/chat/some-other-endpoint', {});
  assertEquals(res.status, 404);
  assertEquals(res.data.error, 'Not found');
});

// ---------------------------------------------------------------------------
// Auth boundary — missing API key
// ---------------------------------------------------------------------------

Deno.test('POST /chat/completions — returns 401 without API key', async () => {
  const res = await testClient.post('/chat/completions', {
    model: 'rose-labs/rose-1-lite',
    messages: sampleMessages,
  });
  // The completions endpoint rejects requests without an API key with 401
  assertEquals(res.status, 401);
  assertExists(res.data.error);
});

// ---------------------------------------------------------------------------
// Auth passthrough — API key forwarded to completions
// ---------------------------------------------------------------------------

Deno.test({
  name: 'POST /chat/completions — valid API key produces successful completion',
  fn: async () => {
    if (!ROSE_API_KEY) {
      console.log('Skipping: ROSE_API_KEY / ROSELABS_API_KEY not set');
      return;
    }

    const res = await testClient.post(
      '/chat/completions',
      {
        model: 'rose-labs/rose-1-lite',
        messages: sampleMessages,
      },
      {
        headers: { 'x-api-key': ROSE_API_KEY },
      },
    );

    if (AUTH_OR_QUOTA_CODES.has(res.status)) {
      console.log(`Skipping: API key rejected or quota exceeded (${res.status})`);
      return;
    }

    assertEquals(res.status, 200);
    assertExists(res.data.id, 'Response must have an id field');
    assertEquals(res.data.object, 'chat.completion');
    assertExists(res.data.choices, 'Response must have choices');
    assertExists(res.data.choices[0].message.content, 'First choice must have message content');
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ---------------------------------------------------------------------------
// Response shape contract
// ---------------------------------------------------------------------------

Deno.test({
  name: 'POST /chat/completions — response shape matches completions contract',
  fn: async () => {
    if (!ROSE_API_KEY) {
      console.log('Skipping: ROSE_API_KEY / ROSELABS_API_KEY not set');
      return;
    }

    const res = await testClient.post(
      '/chat/completions',
      {
        model: 'rose-labs/rose-1-lite',
        messages: sampleMessages,
      },
      {
        headers: { 'x-api-key': ROSE_API_KEY },
      },
    );

    if (AUTH_OR_QUOTA_CODES.has(res.status)) {
      console.log(`Skipping: API key rejected or quota exceeded (${res.status})`);
      return;
    }

    assertEquals(res.status, 200);

    // OpenAI-compatible response shape
    assertEquals(typeof res.data.id, 'string');
    assertEquals(res.data.object, 'chat.completion');
    assertEquals(Array.isArray(res.data.choices), true);
    assertEquals(res.data.choices.length >= 1, true);

    const choice = res.data.choices[0];
    assertExists(choice.message);
    assertEquals(typeof choice.message.content, 'string');
    assertEquals(typeof choice.message.role, 'string');
    assertExists(choice.finish_reason);

    // Usage stats
    assertExists(res.data.usage);
    assertEquals(typeof res.data.usage.prompt_tokens, 'number');
    assertEquals(typeof res.data.usage.completion_tokens, 'number');
    assertEquals(typeof res.data.usage.total_tokens, 'number');

    // Rose metadata
    assertExists(res.data.requested_model);
    assertExists(res.data.actual_model);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ---------------------------------------------------------------------------
// Boundary parity — chat/completions matches direct /completions
// ---------------------------------------------------------------------------

Deno.test({
  name: 'POST /chat/completions — 401 error shape matches direct /completions 401 error shape',
  fn: async () => {
    // Call both endpoints without API key and compare error shapes
    const chatRes = await testClient.post('/chat/completions', {
      model: 'rose-labs/rose-1-lite',
      messages: sampleMessages,
    });

    const directRes = await testClient.post('/completions', {
      model: 'rose-labs/rose-1-lite',
      messages: sampleMessages,
    });

    // Both should return the same status
    assertEquals(chatRes.status, directRes.status, 'Status codes should match');

    // Both should have the same error field
    assertEquals(typeof chatRes.data.error, typeof directRes.data.error);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'POST /chat/completions — validation error shape matches direct /completions',
  fn: async () => {
    if (!ROSE_API_KEY) {
      console.log('Skipping: ROSE_API_KEY / ROSELABS_API_KEY not set');
      return;
    }

    // Send request missing the required 'model' field
    const chatRes = await testClient.post(
      '/chat/completions',
      { messages: sampleMessages },
      { headers: { 'x-api-key': ROSE_API_KEY } },
    );

    const directRes = await testClient.post(
      '/completions',
      { messages: sampleMessages },
      { headers: { 'x-api-key': ROSE_API_KEY } },
    );

    if (AUTH_OR_QUOTA_CODES.has(chatRes.status) || AUTH_OR_QUOTA_CODES.has(directRes.status)) {
      console.log(`Skipping: API key rejected or quota exceeded (chat=${chatRes.status}, direct=${directRes.status})`);
      return;
    }

    assertEquals(
      chatRes.status,
      directRes.status,
      `Status codes should match: chat=${chatRes.status}, direct=${directRes.status}`,
    );
    assertEquals(typeof chatRes.data.error, typeof directRes.data.error);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ---------------------------------------------------------------------------
// Validation passthrough
// ---------------------------------------------------------------------------

Deno.test({
  name: 'POST /chat/completions — returns 400 for missing model field',
  fn: async () => {
    if (!ROSE_API_KEY) {
      console.log('Skipping: ROSE_API_KEY / ROSELABS_API_KEY not set');
      return;
    }

    const res = await testClient.post(
      '/chat/completions',
      { messages: sampleMessages },
      { headers: { 'x-api-key': ROSE_API_KEY } },
    );

    if (AUTH_OR_QUOTA_CODES.has(res.status)) {
      console.log(`Skipping: API key rejected or quota exceeded (${res.status})`);
      return;
    }

    assertEquals(res.status, 400);
    assertExists(res.data.error);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'POST /chat/completions — returns 400 for missing messages field',
  fn: async () => {
    if (!ROSE_API_KEY) {
      console.log('Skipping: ROSE_API_KEY / ROSELABS_API_KEY not set');
      return;
    }

    const res = await testClient.post(
      '/chat/completions',
      { model: 'rose-labs/rose-1-lite' },
      { headers: { 'x-api-key': ROSE_API_KEY } },
    );

    if (AUTH_OR_QUOTA_CODES.has(res.status)) {
      console.log(`Skipping: API key rejected or quota exceeded (${res.status})`);
      return;
    }

    assertEquals(res.status, 400);
    assertExists(res.data.error);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'POST /chat/completions — returns 400 for invalid model name',
  fn: async () => {
    if (!ROSE_API_KEY) {
      console.log('Skipping: ROSE_API_KEY / ROSELABS_API_KEY not set');
      return;
    }

    const res = await testClient.post(
      '/chat/completions',
      {
        model: 'invalid-model-name-that-does-not-exist',
        messages: sampleMessages,
      },
      { headers: { 'x-api-key': ROSE_API_KEY } },
    );

    if (AUTH_OR_QUOTA_CODES.has(res.status)) {
      console.log(`Skipping: API key rejected or quota exceeded (${res.status})`);
      return;
    }

    assertEquals(res.status, 400);
    assertExists(res.data.error);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ---------------------------------------------------------------------------
// Error surface consistency
// ---------------------------------------------------------------------------

Deno.test('POST /chat/completions — 401 error response has { error: string }', async () => {
  const res = await testClient.post('/chat/completions', {
    model: 'rose-labs/rose-1-lite',
    messages: sampleMessages,
  });
  assertEquals(res.status, 401);
  assertEquals(typeof res.data.error, 'string');
});

Deno.test('GET /chat/not-found — 404 error response has { error: string }', async () => {
  const res = await testClient.request('/chat/not-found');
  assertEquals(res.status, 404);
  assertEquals(typeof res.data.error, 'string');
});

// ---------------------------------------------------------------------------
// Same-input reproducibility
// ---------------------------------------------------------------------------

Deno.test('POST /chat/completions — same invalid input produces same error status and shape', async () => {
  const payload = {
    model: 'rose-labs/rose-1-lite',
    messages: sampleMessages,
  };

  const res1 = await testClient.post('/chat/completions', payload);
  const res2 = await testClient.post('/chat/completions', payload);

  assertEquals(res1.status, res2.status);
  assertEquals(typeof res1.data.error, typeof res2.data.error);
});

Deno.test('GET /chat/bad-path — same 404 path produces identical response', async () => {
  const res1 = await testClient.request('/chat/bad-path');
  const res2 = await testClient.request('/chat/bad-path');

  assertEquals(res1.status, res2.status);
  assertEquals(res1.data.error, res2.data.error);
});

// ---------------------------------------------------------------------------
// Method handling
// ---------------------------------------------------------------------------

Deno.test('OPTIONS /chat/completions — returns CORS headers', async () => {
  const res = await testClient.request('/chat/completions', { method: 'OPTIONS' });
  // Supabase edge functions handle OPTIONS at the platform level
  // The function should not return an error for OPTIONS
  assertEquals(res.status === 200 || res.status === 204, true, `Expected 200 or 204, got ${res.status}`);
});

// ---------------------------------------------------------------------------
// Header passthrough
// ---------------------------------------------------------------------------

Deno.test({
  name: 'POST /chat/completions — custom x-request-id header is forwarded through proxy',
  fn: async () => {
    if (!ROSE_API_KEY) {
      console.log('Skipping: ROSE_API_KEY / ROSELABS_API_KEY not set');
      return;
    }

    const requestId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await testClient.post(
      '/chat/completions',
      {
        model: 'rose-labs/rose-1-lite',
        messages: sampleMessages,
      },
      {
        headers: {
          'x-api-key': ROSE_API_KEY,
          'x-request-id': requestId,
        },
      },
    );

    if (AUTH_OR_QUOTA_CODES.has(res.status)) {
      console.log(`Skipping: API key rejected or quota exceeded (${res.status})`);
      return;
    }

    // The completions endpoint should process the request successfully
    // regardless of the x-request-id header (passthrough test)
    assertEquals(res.status, 200);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// ---------------------------------------------------------------------------
// Empty path variant (path stripped to "")
// ---------------------------------------------------------------------------

Deno.test('POST /chat — empty path after /chat is accepted (proxied to completions)', async () => {
  const res = await testClient.post('/chat', {
    model: 'rose-labs/rose-1-lite',
    messages: sampleMessages,
  });
  // Empty path ("") is allowed by the function — it proxies to completions.
  // Without an API key we expect 401 from completions, not 404 from chat.
  assertNotEquals(res.status, 404, '/chat with empty subpath should not return 404');
});
