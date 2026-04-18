/**
 * Blackbox tests for GET /cost
 *
 * Domain surface:
 *   - Single entrypoint: GET /cost?model=<name>
 *   - No authentication required (verify_jwt = false)
 *   - External boundary: outbound fetch to https://openrouter.ai/api/v1/models
 *   - Returns averaged pricing for a model pool with rounding to nearest $0.05/M tokens
 *
 * Coverage matrix:
 *   Entrypoint: GET /cost
 *     - validation: missing model param (400), unknown model (404)
 *     - happy path: rose-1-lite, rose-1-ultra, rose-1-browser-use
 *     - normalization: rose-labs/ prefix, case-insensitive
 *     - response shape: exact keys, types, value ranges
 *     - CORS: OPTIONS preflight
 *     - error surface: consistent { error: string } shape
 *     - reproducibility: same-input produces same-output
 *     - concurrency: parallel requests do not corrupt state
 *   Invariants: auth boundary (N/A - no auth), error surface, idempotency,
 *     same-input reproducibility, state transition (stateless), ordering (N/A),
 *     boundary param, duplication prevention (N/A), cleanup, observability
 */

import {
  assert,
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { testClient } from './utils/test-client.ts';
import { assertHasProperty, assertStatusCode } from './utils/fixtures.ts';

// Known model pool names from the cost edge function source
const KNOWN_MODELS = ['rose-1-lite', 'rose-1-ultra', 'rose-1-browser-use'];

// ============================================================================
// Contract: Response Shape
// ============================================================================

Deno.test('GET /cost - rose-1-lite returns complete response shape', async () => {
  const response = await testClient.get('/cost?model=rose-labs/rose-1-lite');

  assertStatusCode(response.status, 200);

  // Top-level keys
  assertHasProperty(response.data, 'model');
  assertHasProperty(response.data, 'contextLength');
  assertHasProperty(response.data, 'pricing');

  // Pricing sub-keys
  assertHasProperty(response.data.pricing, 'costPerMillionInputTokens');
  assertHasProperty(response.data.pricing, 'costPerMillionOutputTokens');

  // Types
  assertEquals(typeof response.data.model, 'string');
  assertEquals(typeof response.data.contextLength, 'number');
  assertEquals(typeof response.data.pricing.costPerMillionInputTokens, 'number');
  assertEquals(typeof response.data.pricing.costPerMillionOutputTokens, 'number');

  // Model name is normalized (no rose-labs/ prefix)
  assertEquals(response.data.model, 'rose-1-lite');

  // No extra keys leak (poolSize, internal data)
  assertEquals('poolSize' in response.data, false, 'poolSize should not be in response');
  assertEquals('pool' in response.data, false, 'pool should not be in response');
});

Deno.test('GET /cost - response has exactly expected top-level keys', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(response.status, 200);

  const keys = Object.keys(response.data).sort();
  assertEquals(keys, ['contextLength', 'model', 'pricing']);

  const pricingKeys = Object.keys(response.data.pricing).sort();
  assertEquals(pricingKeys, ['costPerMillionInputTokens', 'costPerMillionOutputTokens']);
});

// ============================================================================
// Contract: Value Ranges
// ============================================================================

Deno.test('GET /cost - pricing values are positive and within plausible range', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(response.status, 200);

  const { costPerMillionInputTokens, costPerMillionOutputTokens } = response.data.pricing;

  // Pricing must be positive
  assert(
    costPerMillionInputTokens > 0,
    `Input cost must be positive, got ${costPerMillionInputTokens}`,
  );
  assert(
    costPerMillionOutputTokens > 0,
    `Output cost must be positive, got ${costPerMillionOutputTokens}`,
  );

  // Pricing should be under $100/M tokens (sanity check for reasonable model costs)
  assert(
    costPerMillionInputTokens < 100,
    `Input cost implausibly high: $${costPerMillionInputTokens}/M`,
  );
  assert(
    costPerMillionOutputTokens < 100,
    `Output cost implausibly high: $${costPerMillionOutputTokens}/M`,
  );
});

Deno.test('GET /cost - pricing is rounded to nearest $0.05', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(response.status, 200);

  const { costPerMillionInputTokens, costPerMillionOutputTokens } = response.data.pricing;

  // Prices should be multiples of 0.05 (rounded up to nearest 5 cents)
  // Use a small epsilon for floating point comparison
  const isMultipleOf05 = (n: number) => Math.abs((n * 100) % 5) < 0.01;

  assert(
    isMultipleOf05(costPerMillionInputTokens),
    `Input cost ${costPerMillionInputTokens} is not a multiple of $0.05`,
  );
  assert(
    isMultipleOf05(costPerMillionOutputTokens),
    `Output cost ${costPerMillionOutputTokens} is not a multiple of $0.05`,
  );
});

Deno.test('GET /cost - contextLength is a positive integer', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(response.status, 200);

  const ctx = response.data.contextLength;
  assert(ctx > 0, `contextLength must be positive, got ${ctx}`);
  assert(Number.isInteger(ctx), `contextLength must be integer, got ${ctx}`);
  // Typical context lengths range from 4096 to 1M+
  assert(ctx >= 4096, `contextLength implausibly small: ${ctx}`);
});

// ============================================================================
// Happy Path: All Known Models
// ============================================================================

Deno.test('GET /cost - returns cost for rose-1-ultra', async () => {
  const response = await testClient.get('/cost?model=rose-labs/rose-1-ultra');

  assertStatusCode(response.status, 200);
  assertEquals(response.data.model, 'rose-1-ultra');
  assert(response.data.pricing.costPerMillionInputTokens > 0);
  assert(response.data.pricing.costPerMillionOutputTokens > 0);
  assert(response.data.contextLength > 0);
});

Deno.test('GET /cost - returns cost for rose-1-browser-use', async () => {
  const response = await testClient.get('/cost?model=rose-1-browser-use');

  assertStatusCode(response.status, 200);
  assertEquals(response.data.model, 'rose-1-browser-use');
  assert(response.data.pricing.costPerMillionInputTokens > 0);
  assert(response.data.pricing.costPerMillionOutputTokens > 0);
  assert(response.data.contextLength > 0);
});

// ============================================================================
// Input Normalization
// ============================================================================

Deno.test('GET /cost - normalizes model name (removes rose-labs/ prefix)', async () => {
  const withPrefix = await testClient.get('/cost?model=rose-labs/rose-1-lite');
  const withoutPrefix = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(withPrefix.status, 200);
  assertStatusCode(withoutPrefix.status, 200);

  assertEquals(withPrefix.data.model, withoutPrefix.data.model);
  assertEquals(withPrefix.data.contextLength, withoutPrefix.data.contextLength);
  assertEquals(
    withPrefix.data.pricing.costPerMillionInputTokens,
    withoutPrefix.data.pricing.costPerMillionInputTokens,
  );
  assertEquals(
    withPrefix.data.pricing.costPerMillionOutputTokens,
    withoutPrefix.data.pricing.costPerMillionOutputTokens,
  );
});

Deno.test('GET /cost - model name is case-insensitive', async () => {
  const lower = await testClient.get('/cost?model=rose-1-lite');
  const upper = await testClient.get('/cost?model=ROSE-1-LITE');
  const mixed = await testClient.get('/cost?model=Rose-1-Lite');

  assertStatusCode(lower.status, 200);
  assertStatusCode(upper.status, 200);
  assertStatusCode(mixed.status, 200);

  // All three should return the same pricing
  assertEquals(lower.data.model, upper.data.model);
  assertEquals(lower.data.model, mixed.data.model);
});

Deno.test('GET /cost - rose-labs/ prefix normalization is also case-insensitive', async () => {
  const lower = await testClient.get('/cost?model=rose-labs/rose-1-lite');
  const upper = await testClient.get('/cost?model=ROSE-LABS/ROSE-1-LITE');

  assertStatusCode(lower.status, 200);
  assertStatusCode(upper.status, 200);
  assertEquals(lower.data.model, upper.data.model);
});

// ============================================================================
// Validation: Error Cases
// ============================================================================

Deno.test('GET /cost - returns 400 for missing model parameter', async () => {
  const response = await testClient.get('/cost');

  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
  assertEquals(typeof response.data.error, 'string');
  assert(response.data.error.length > 0, 'Error message should not be empty');
});

Deno.test('GET /cost - returns 404 for unknown model', async () => {
  const response = await testClient.get('/cost?model=unknown-model-xyz');

  assertStatusCode(response.status, 404);
  assertHasProperty(response.data, 'error');
  assertEquals(typeof response.data.error, 'string');
  assert(response.data.error.length > 0, 'Error message should not be empty');
});

Deno.test('GET /cost - 400 error includes mention of model parameter', async () => {
  const response = await testClient.get('/cost');

  assertStatusCode(response.status, 400);
  assert(
    response.data.error.toLowerCase().includes('model'),
    `Error message should mention "model", got: ${response.data.error}`,
  );
});

Deno.test('GET /cost - 404 error includes the unknown model name', async () => {
  const response = await testClient.get('/cost?model=nonexistent-model-abc');

  assertStatusCode(response.status, 404);
  assert(
    response.data.error.toLowerCase().includes('nonexistent-model-abc'),
    `Error message should include model name, got: ${response.data.error}`,
  );
});

Deno.test('GET /cost - empty model parameter returns 400 or 404', async () => {
  const response = await testClient.get('/cost?model=');

  // Empty string is technically "present" but not a valid model
  // Accept either 400 (missing/invalid) or 404 (not found)
  assert(
    response.status === 400 || response.status === 404,
    `Expected 400 or 404 for empty model, got ${response.status}`,
  );
  assertHasProperty(response.data, 'error');
});

// ============================================================================
// CORS
// ============================================================================

Deno.test('GET /cost - response includes CORS headers', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(response.status, 200);
  const allowOrigin = response.headers.get('access-control-allow-origin');
  assertEquals(allowOrigin, '*', 'Should have Access-Control-Allow-Origin: *');
});

Deno.test('GET /cost - error responses also include CORS headers', async () => {
  const response = await testClient.get('/cost');

  assertStatusCode(response.status, 400);
  const allowOrigin = response.headers.get('access-control-allow-origin');
  assertEquals(allowOrigin, '*', 'Error responses should also have CORS headers');
});

// ============================================================================
// Invariant: Error Surface Consistency
// ============================================================================

Deno.test('GET /cost - all error responses have { error: string } shape', async () => {
  const errorCases = [
    { path: '/cost', expectedStatus: 400 }, // missing model
    { path: '/cost?model=nonexistent', expectedStatus: 404 }, // unknown model
  ];

  for (const { path, expectedStatus } of errorCases) {
    const response = await testClient.get(path);
    assertStatusCode(response.status, expectedStatus);
    assertHasProperty(response.data, 'error');
    assertEquals(
      typeof response.data.error,
      'string',
      `Error at ${path} should have string error, got ${typeof response.data.error}`,
    );
  }
});

// ============================================================================
// Invariant: Idempotency / Same-input Reproducibility
// ============================================================================

Deno.test('GET /cost - same input produces same output (reproducibility)', async () => {
  const r1 = await testClient.get('/cost?model=rose-1-lite');
  const r2 = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(r1.status, 200);
  assertStatusCode(r2.status, 200);

  assertEquals(r1.data.model, r2.data.model);
  assertEquals(r1.data.contextLength, r2.data.contextLength);
  assertEquals(
    r1.data.pricing.costPerMillionInputTokens,
    r2.data.pricing.costPerMillionInputTokens,
  );
  assertEquals(
    r1.data.pricing.costPerMillionOutputTokens,
    r2.data.pricing.costPerMillionOutputTokens,
  );
});

// ============================================================================
// Invariant: Concurrency Safety
// ============================================================================

Deno.test('GET /cost - concurrent requests do not corrupt responses', async () => {
  // Fire requests in parallel for different models
  const promises = KNOWN_MODELS.map((model) => testClient.get(`/cost?model=${model}`));

  const results = await Promise.all(promises);

  for (let i = 0; i < KNOWN_MODELS.length; i++) {
    assertStatusCode(results[i].status, 200);
    assertEquals(
      results[i].data.model,
      KNOWN_MODELS[i],
      `Response ${i} should be for model ${KNOWN_MODELS[i]}, got ${results[i].data.model}`,
    );
  }
});

Deno.test('GET /cost - concurrent identical requests produce identical results', async () => {
  const promises = Array.from({ length: 5 }, () => testClient.get('/cost?model=rose-1-lite'));

  const results = await Promise.all(promises);

  const firstData = results[0].data;
  for (let i = 1; i < results.length; i++) {
    assertStatusCode(results[i].status, 200);
    assertEquals(
      results[i].data.pricing.costPerMillionInputTokens,
      firstData.pricing.costPerMillionInputTokens,
      `Concurrent request ${i} returned different input cost`,
    );
    assertEquals(
      results[i].data.pricing.costPerMillionOutputTokens,
      firstData.pricing.costPerMillionOutputTokens,
      `Concurrent request ${i} returned different output cost`,
    );
  }
});

// ============================================================================
// Invariant: Content-Type
// ============================================================================

Deno.test('GET /cost - success response has application/json content-type', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(response.status, 200);
  const contentType = response.headers.get('content-type');
  assertExists(contentType);
  assert(
    contentType!.includes('application/json'),
    `Expected application/json content-type, got: ${contentType}`,
  );
});

Deno.test('GET /cost - error response has application/json content-type', async () => {
  const response = await testClient.get('/cost');

  assertStatusCode(response.status, 400);
  const contentType = response.headers.get('content-type');
  assertExists(contentType);
  assert(
    contentType!.includes('application/json'),
    `Expected application/json content-type for errors, got: ${contentType}`,
  );
});

// ============================================================================
// Invariant: No Auth Required
// ============================================================================

Deno.test('GET /cost - no authentication required (no API key, no JWT)', async () => {
  // This endpoint should work with no auth headers at all
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertStatusCode(response.status, 200);
  assertHasProperty(response.data, 'model');
  assertHasProperty(response.data, 'pricing');
});

// ============================================================================
// Cross-Model Consistency
// ============================================================================

Deno.test('GET /cost - all known models return valid responses with same shape', async () => {
  for (const model of KNOWN_MODELS) {
    const response = await testClient.get(`/cost?model=${model}`);

    assertStatusCode(response.status, 200);
    assertEquals(response.data.model, model, `Model name mismatch for ${model}`);
    assertHasProperty(response.data, 'contextLength');
    assertHasProperty(response.data, 'pricing');
    assertHasProperty(response.data.pricing, 'costPerMillionInputTokens');
    assertHasProperty(response.data.pricing, 'costPerMillionOutputTokens');

    assert(
      response.data.pricing.costPerMillionInputTokens > 0,
      `${model} input cost must be positive`,
    );
    assert(
      response.data.pricing.costPerMillionOutputTokens > 0,
      `${model} output cost must be positive`,
    );
    assert(response.data.contextLength > 0, `${model} contextLength must be positive`);
  }
});

Deno.test('GET /cost - output cost >= input cost for all models (typical LLM pricing)', async () => {
  for (const model of KNOWN_MODELS) {
    const response = await testClient.get(`/cost?model=${model}`);

    assertStatusCode(response.status, 200);

    const { costPerMillionInputTokens, costPerMillionOutputTokens } = response.data.pricing;

    // For LLM pricing, output tokens are typically more expensive than input tokens.
    // This is a soft invariant - if a model breaks this, it signals a pricing data issue.
    assert(
      costPerMillionOutputTokens >= costPerMillionInputTokens,
      `${model}: output cost ($${costPerMillionOutputTokens}/M) should be >= input cost ($${costPerMillionInputTokens}/M)`,
    );
  }
});
