/**
 * Blackbox tests for GET /cost edge function.
 *
 * Domain surface:
 *   GET /cost?model=<name> -- returns averaged pricing information for a Rose
 *   model pool. No authentication required. Fetches OpenRouter model catalog
 *   to look up per-token pricing, applies fixed pricing for some models
 *   (browser-use, kimi-k2.5), averages across the pool, rounds up to nearest
 *   $0.05 per million tokens.
 *
 * Entrypoints tested:
 *   1. CORS headers on success and error responses
 *   2. Validation (missing model -> 400, unknown model -> 404)
 *   3. Happy path for all three model pools (rose-1-lite, rose-1-ultra, rose-1-browser-use)
 *   4. Model name normalization (rose-labs/ prefix, case-insensitive)
 *   5. Response shape contract (exact top-level keys, pricing sub-keys)
 *   6. Value range invariants (positive prices, positive context length)
 *   7. Pricing rounding invariant ($0.05 multiples)
 *   8. Error surface invariant (all errors have { error: string })
 *   9. Content-Type on all responses (application/json)
 *   10. No auth required (no API key, no JWT)
 *   11. Same-input reproducibility
 *   12. Concurrent request safety
 *   13. Cross-model consistency (same shape, output >= input pricing)
 *   14. No internal data leakage (poolSize, pool members)
 *
 * Boundary:
 *   The edge function calls https://openrouter.ai/api/v1/models to fetch
 *   pricing data. Since the edge function runs on Supabase (not our server),
 *   we cannot use fetchCapture. We test the boundary indirectly by verifying
 *   that pricing values reflect real OpenRouter data (positive, plausible range,
 *   correctly rounded) and that models with fixed pricing return values
 *   consistent with the configured fixed rates.
 *
 * Run:
 *   bash research/scripts/run-blackbox-tests.sh cost
 */

import {
  assert,
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { testClient } from './helpers.ts';

// Known model pool names from the cost edge function source
const KNOWN_MODELS = ['rose-1-lite', 'rose-1-ultra', 'rose-1-browser-use'];

/** Status codes indicating OpenRouter (upstream) is unavailable — skip, don't fail. */
const UPSTREAM_FAILURE_CODES = new Set([402, 429, 500, 502, 503]);

// deno-lint-ignore no-explicit-any
function isUpstreamUnavailable(status: number, data: any): boolean {
  return UPSTREAM_FAILURE_CODES.has(status);
}

// deno-lint-ignore no-explicit-any
function skipIfUpstream(status: number, data: any, label: string): boolean {
  if (isUpstreamUnavailable(status, data)) {
    console.log(`SKIP: Upstream provider unavailable (${status}: ${data?.error ?? 'unknown'})`);
    return true;
  }
  return false;
}

// ============================================================================
// Contract: Response Shape
// ============================================================================

Deno.test('GET /cost - rose-1-lite returns complete response shape', async () => {
  const response = await testClient.get('/cost?model=rose-labs/rose-1-lite');

  assertEquals(response.status, 200);

  // Top-level keys
  assertExists(response.data.model);
  assertExists(response.data.contextLength);
  assertExists(response.data.pricing);

  // Pricing sub-keys
  assertExists(response.data.pricing.costPerMillionInputTokens);
  assertExists(response.data.pricing.costPerMillionOutputTokens);

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

  assertEquals(response.status, 200);

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

  assertEquals(response.status, 200);

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

  assertEquals(response.status, 200);

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

Deno.test('GET /cost - contextLength is a positive integer above 4096', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertEquals(response.status, 200);

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

  assertEquals(response.status, 200);
  assertEquals(response.data.model, 'rose-1-ultra');
  assert(response.data.pricing.costPerMillionInputTokens > 0);
  assert(response.data.pricing.costPerMillionOutputTokens > 0);
  assert(response.data.contextLength > 0);
});

Deno.test('GET /cost - returns cost for rose-1-browser-use', async () => {
  const response = await testClient.get('/cost?model=rose-1-browser-use');

  assertEquals(response.status, 200);
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

  assertEquals(withPrefix.status, 200);
  assertEquals(withoutPrefix.status, 200);

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

  assertEquals(lower.status, 200);
  assertEquals(upper.status, 200);
  assertEquals(mixed.status, 200);

  // All three should return the same model name (normalized to lowercase)
  assertEquals(lower.data.model, upper.data.model);
  assertEquals(lower.data.model, mixed.data.model);
});

Deno.test('GET /cost - rose-labs/ prefix normalization is also case-insensitive', async () => {
  const lower = await testClient.get('/cost?model=rose-labs/rose-1-lite');
  const upper = await testClient.get('/cost?model=ROSE-LABS/ROSE-1-LITE');

  assertEquals(lower.status, 200);
  assertEquals(upper.status, 200);
  assertEquals(lower.data.model, upper.data.model);
});

// ============================================================================
// Validation: Error Cases
// ============================================================================

Deno.test('GET /cost - returns 400 for missing model parameter', async () => {
  const response = await testClient.get('/cost');

  assertEquals(response.status, 400);
  assertExists(response.data.error);
  assertEquals(typeof response.data.error, 'string');
  assert(response.data.error.length > 0, 'Error message should not be empty');
});

Deno.test('GET /cost - returns 404 for unknown model', async () => {
  const response = await testClient.get('/cost?model=unknown-model-xyz');

  assertEquals(response.status, 404);
  assertExists(response.data.error);
  assertEquals(typeof response.data.error, 'string');
  assert(response.data.error.length > 0, 'Error message should not be empty');
});

Deno.test('GET /cost - 400 error includes mention of model parameter', async () => {
  const response = await testClient.get('/cost');

  assertEquals(response.status, 400);
  assert(
    response.data.error.toLowerCase().includes('model'),
    `Error message should mention "model", got: ${response.data.error}`,
  );
});

Deno.test('GET /cost - 404 error includes the unknown model name', async () => {
  const response = await testClient.get('/cost?model=nonexistent-model-abc');

  assertEquals(response.status, 404);
  assert(
    response.data.error.toLowerCase().includes('nonexistent-model-abc'),
    `Error message should include model name, got: ${response.data.error}`,
  );
});

Deno.test('GET /cost - empty model parameter returns 400 or 404', async () => {
  const response = await testClient.get('/cost?model=');

  // Empty string after toLowerCase() is falsy, so it should be caught by the
  // missing-model check and return 400. But we also accept 404 for robustness.
  assert(
    response.status === 400 || response.status === 404,
    `Expected 400 or 404 for empty model, got ${response.status}`,
  );
  assertExists(response.data.error);
});

// ============================================================================
// CORS
// ============================================================================

Deno.test('GET /cost - response includes CORS headers', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertEquals(response.status, 200);
  const allowOrigin = response.headers.get('access-control-allow-origin');
  assertEquals(allowOrigin, '*', 'Should have Access-Control-Allow-Origin: *');
});

Deno.test('GET /cost - error responses also include CORS headers', async () => {
  const response = await testClient.get('/cost');

  assertEquals(response.status, 400);
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
    assertEquals(response.status, expectedStatus);
    assertExists(response.data.error);
    assertEquals(
      typeof response.data.error,
      'string',
      `Error at ${path} should have string error, got ${typeof response.data.error}`,
    );
  }
});

// ============================================================================
// Invariant: Content-Type
// ============================================================================

Deno.test('GET /cost - success response has application/json content-type', async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertEquals(response.status, 200);
  const contentType = response.headers.get('content-type');
  assertExists(contentType);
  assert(
    contentType!.includes('application/json'),
    `Expected application/json content-type, got: ${contentType}`,
  );
});

Deno.test('GET /cost - error response has application/json content-type', async () => {
  const response = await testClient.get('/cost');

  assertEquals(response.status, 400);
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
  // This endpoint works with no auth headers at all
  const response = await testClient.get('/cost?model=rose-1-lite');

  assertEquals(response.status, 200);
  assertExists(response.data.model);
  assertExists(response.data.pricing);
});

// ============================================================================
// Invariant: Same-Input Reproducibility
// ============================================================================

Deno.test('GET /cost - same input produces same output (reproducibility)', async () => {
  const r1 = await testClient.get('/cost?model=rose-1-lite');
  const r2 = await testClient.get('/cost?model=rose-1-lite');

  assertEquals(r1.status, 200);
  assertEquals(r2.status, 200);

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

Deno.test('GET /cost - concurrent requests for different models return correct data', async () => {
  const promises = KNOWN_MODELS.map((model) => testClient.get(`/cost?model=${model}`));
  const results = await Promise.all(promises);

  for (let i = 0; i < KNOWN_MODELS.length; i++) {
    assertEquals(results[i].status, 200);
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

  // Skip if any request hit an upstream failure (OpenRouter unavailable)
  for (const r of results) {
    if (skipIfUpstream(r.status, r.data, 'concurrent')) return;
  }

  const firstData = results[0].data;
  for (let i = 1; i < results.length; i++) {
    assertEquals(results[i].status, 200);
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
// Cross-Model Consistency
// ============================================================================

Deno.test('GET /cost - all known models return valid responses with same shape', async () => {
  for (const model of KNOWN_MODELS) {
    const response = await testClient.get(`/cost?model=${model}`);

    if (skipIfUpstream(response.status, response.data, model)) return;
    assertEquals(response.status, 200);
    assertEquals(response.data.model, model, `Model name mismatch for ${model}`);
    assertExists(response.data.contextLength);
    assertExists(response.data.pricing);
    assertExists(response.data.pricing.costPerMillionInputTokens);
    assertExists(response.data.pricing.costPerMillionOutputTokens);

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

    if (skipIfUpstream(response.status, response.data, model)) return;
    assertEquals(response.status, 200);

    const { costPerMillionInputTokens, costPerMillionOutputTokens } = response.data.pricing;

    // For LLM pricing, output tokens are typically more expensive than input.
    // This is a soft invariant that catches pricing data anomalies.
    assert(
      costPerMillionOutputTokens >= costPerMillionInputTokens,
      `${model}: output ($${costPerMillionOutputTokens}/M) should be >= input ($${costPerMillionInputTokens}/M)`,
    );
  }
});
