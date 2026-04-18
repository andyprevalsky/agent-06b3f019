/**
 * Unit tests for the Cost domain (GET /cost).
 *
 * These tests exercise the full runtime -> service -> repo stack via the
 * exported `createHandler(fetchFn)` factory. The sole external boundary is
 * the OpenRouter catalog fetch; we substitute `globalThis.fetch` with a
 * fake that returns canned payloads (or throws) so the tests are fully
 * offline and complete in milliseconds.
 *
 * Coverage surface:
 *   runtime.ts  - CORS preflight, JSON success / error shaping, error class routing.
 *   service.ts  - model parsing/normalization, fixed-pricing fast path, pool
 *                 aggregation, rounding, catalog fallthrough, unknown-model 404.
 *   repo.ts     - OpenRouter catalog fetch via injected fetchFn, non-OK response
 *                 translates to an internal 500.
 *   config.ts   - fixed pricing table and model pool constants (consumed by service).
 */

import {
  assert,
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import {
  aggregatePricing,
  CostError,
  parseModelName,
  roundUpToNearestFiveCents,
} from '../domains/cost/service.ts';
import { fetchOpenRouterModels } from '../domains/cost/repo.ts';
import { createHandler, handleCostRequest } from '../domains/cost/runtime.ts';
import { FIXED_PRICING, MODEL_POOLS } from '../domains/cost/config.ts';
import type { OpenRouterModel } from '../domains/cost/types.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost:54321/functions/v1';

function makeRequest(path: string, method = 'GET'): Request {
  return new Request(`${BASE_URL}${path}`, { method });
}

async function parseJson<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return (await response.json()) as T;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * Build a fetch fake that returns a canned JSON response, or throws
 * a network-style error. Every call is recorded to `calls` for
 * after-the-fact boundary assertions.
 */
function makeFetchStub(opts: {
  calls: FetchCall[];
  status?: number;
  body?: unknown;
  bodyText?: string;
  networkError?: Error;
}): typeof fetch {
  return (input: Request | URL | string, init?: RequestInit) => {
    opts.calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      init,
    });
    if (opts.networkError) return Promise.reject(opts.networkError);

    const status = opts.status ?? 200;
    const body = opts.bodyText !== undefined
      ? opts.bodyText
      : JSON.stringify(opts.body ?? { data: [] });
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}

// A fetch fake that always fails — used to assert no network call happens on
// fixed-pricing or validation paths.
function forbiddenFetch(): typeof fetch {
  return () => {
    throw new Error('fetch must not be called on this code path');
  };
}

/**
 * Temporarily register a MODEL_POOLS entry for the duration of `fn`, then
 * remove it. Lets tests exercise the needsCatalog branch (which triggers only
 * when a pool member is absent from FIXED_PRICING) without editing config.ts.
 */
async function withTempPool(
  name: string,
  models: string[],
  fn: () => Promise<void>,
): Promise<void> {
  MODEL_POOLS[name] = models;
  try {
    await fn();
  } finally {
    delete MODEL_POOLS[name];
  }
}

// ============================================================================
// Pure helpers — parseModelName
// ============================================================================

Deno.test('parseModelName: returns null when model query param missing', () => {
  assertEquals(parseModelName(new URL('http://x/cost')), null);
});

Deno.test('parseModelName: lowercases the model name', () => {
  assertEquals(
    parseModelName(new URL('http://x/cost?model=ROSE-1-LITE')),
    'rose-1-lite',
  );
});

Deno.test('parseModelName: strips rose-labs/ prefix (after lowercasing)', () => {
  assertEquals(
    parseModelName(new URL('http://x/cost?model=ROSE-LABS/ROSE-1-LITE')),
    'rose-1-lite',
  );
  assertEquals(
    parseModelName(new URL('http://x/cost?model=rose-labs/rose-1-ultra')),
    'rose-1-ultra',
  );
});

Deno.test('parseModelName: leaves bare model ids alone', () => {
  assertEquals(
    parseModelName(new URL('http://x/cost?model=rose-1-lite')),
    'rose-1-lite',
  );
});

Deno.test('parseModelName: returns null on empty string', () => {
  assertEquals(parseModelName(new URL('http://x/cost?model=')), null);
});

// ============================================================================
// Pure helpers — roundUpToNearestFiveCents
// ============================================================================

Deno.test('roundUpToNearestFiveCents: rounds UP to $0.05/M', () => {
  // $0.50/M = 0.00000050/token → already a multiple of 0.05
  assertEquals(roundUpToNearestFiveCents(0.5 / 1_000_000), 0.5);
  // $0.51/M rounds up to $0.55
  assertEquals(roundUpToNearestFiveCents(0.51 / 1_000_000), 0.55);
  // Tiny non-zero value still rounds up to the first step (> 0).
  assert(roundUpToNearestFiveCents(0.01 / 1_000_000) >= 0.05);
});

Deno.test('roundUpToNearestFiveCents: preserves exact multiples of $0.05', () => {
  for (const perMillion of [0.05, 0.1, 1.0, 3.0, 25.0]) {
    assertEquals(roundUpToNearestFiveCents(perMillion / 1_000_000), perMillion);
  }
});

// ============================================================================
// Pure helpers — aggregatePricing
// ============================================================================

Deno.test('aggregatePricing: returns null when no models in pool match', () => {
  const pool = ['unknown-provider/unknown-model'];
  const result = aggregatePricing(pool, []);
  assertEquals(result, null);
});

Deno.test('aggregatePricing: averages fixed-price pool correctly (rose-1-lite)', () => {
  const pool = MODEL_POOLS['rose-1-lite'];
  const a = FIXED_PRICING[pool[0]];
  const b = FIXED_PRICING[pool[1]];
  const result = aggregatePricing(pool, []);

  assertExists(result);
  assertEquals(result!.avgPrompt, (a.prompt + b.prompt) / 2);
  assertEquals(result!.avgCompletion, (a.completion + b.completion) / 2);
  // minContext = min(contextLength) across pool.
  assertEquals(result!.minContext, Math.min(a.contextLength, b.contextLength));
});

Deno.test('aggregatePricing: blends a catalog-only model with fixed pricing', () => {
  const catalog: OpenRouterModel[] = [
    {
      id: 'some/catalog-model',
      context_length: 100_000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
    },
  ];
  const pool = ['google/gemini-3-flash-preview', 'some/catalog-model'];
  const fixed = FIXED_PRICING['google/gemini-3-flash-preview'];

  const result = aggregatePricing(pool, catalog);
  assertExists(result);
  assertEquals(result!.avgPrompt, (fixed.prompt + 1e-6) / 2);
  assertEquals(result!.avgCompletion, (fixed.completion + 2e-6) / 2);
  // min of (1_048_576, 100_000) = 100_000
  assertEquals(result!.minContext, 100_000);
});

Deno.test('aggregatePricing: prefers top_provider.context_length over context_length', () => {
  const catalog: OpenRouterModel[] = [
    {
      id: 'catalog/only',
      context_length: 999_999,
      top_provider: { context_length: 32_000 },
      pricing: { prompt: '0', completion: '0' },
    },
  ];
  const result = aggregatePricing(['catalog/only'], catalog);
  assertExists(result);
  assertEquals(result!.minContext, 32_000);
});

Deno.test(
  'aggregatePricing: tolerates malformed prices in catalog (NaN -> 0)',
  () => {
    const catalog: OpenRouterModel[] = [
      {
        id: 'catalog/weird',
        context_length: 100_000,
        pricing: { prompt: 'not-a-number', completion: undefined },
      },
    ];
    const result = aggregatePricing(['catalog/weird'], catalog);
    assertExists(result);
    assertEquals(result!.avgPrompt, 0);
    assertEquals(result!.avgCompletion, 0);
  },
);

Deno.test(
  'aggregatePricing: falls back to DEFAULT_MIN_CONTEXT when no model reports context',
  () => {
    const catalog: OpenRouterModel[] = [
      {
        id: 'catalog/no-ctx',
        // no context_length, no top_provider
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
    ];
    const result = aggregatePricing(['catalog/no-ctx'], catalog);
    assertExists(result);
    assertEquals(result!.minContext, 200_000); // DEFAULT_MIN_CONTEXT
  },
);

Deno.test('aggregatePricing: skips catalog entries not found (no contribution)', () => {
  // No fixed match AND not in catalog -> still null because nothing accumulated.
  const result = aggregatePricing(['missing/everywhere'], []);
  assertEquals(result, null);
});

// ============================================================================
// Repo — fetchOpenRouterModels via injected fetchFn
// ============================================================================

Deno.test('fetchOpenRouterModels: returns data array on 200', async () => {
  const calls: FetchCall[] = [];
  const data: OpenRouterModel[] = [
    { id: 'x/y', context_length: 10, pricing: { prompt: '1', completion: '2' } },
  ];
  const stub = makeFetchStub({ calls, status: 200, body: { data } });

  const result = await fetchOpenRouterModels(stub);
  assertEquals(result, data);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, 'https://openrouter.ai/api/v1/models');

  const headers = calls[0].init!.headers as Record<string, string>;
  assertExists(headers['Authorization']);
  assertEquals(headers['X-Title'], 'Rose Benchmark Suite');
  assertExists(headers['HTTP-Referer']);
});

Deno.test('fetchOpenRouterModels: returns [] when body has no data field', async () => {
  const calls: FetchCall[] = [];
  const stub = makeFetchStub({ calls, status: 200, body: {} });

  const result = await fetchOpenRouterModels(stub);
  assertEquals(result, []);
});

Deno.test('fetchOpenRouterModels: throws on non-OK status', async () => {
  const calls: FetchCall[] = [];
  const stub = makeFetchStub({ calls, status: 500, body: { error: 'boom' } });

  let caught: unknown;
  try {
    await fetchOpenRouterModels(stub);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof Error);
  assertEquals((caught as Error).message, 'OpenRouter API returned 500');
});

Deno.test('fetchOpenRouterModels: propagates network-layer errors', async () => {
  const calls: FetchCall[] = [];
  const stub = makeFetchStub({
    calls,
    networkError: new Error('ECONNREFUSED'),
  });

  let caught: unknown;
  try {
    await fetchOpenRouterModels(stub);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof Error);
  assertEquals((caught as Error).message, 'ECONNREFUSED');
});

// ============================================================================
// Runtime handler — CORS preflight
// ============================================================================

Deno.test('handler: OPTIONS preflight returns 200 + CORS headers, no fetch', async () => {
  const handler = createHandler(forbiddenFetch());
  const response = await handler(makeRequest('/cost', 'OPTIONS'));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals(
    response.headers.get('Access-Control-Allow-Headers'),
    'authorization, x-client-info, apikey, content-type',
  );
});

Deno.test('handler: default export also accepts OPTIONS', async () => {
  const response = await handleCostRequest(makeRequest('/cost', 'OPTIONS'));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
});

// ============================================================================
// Runtime handler — 400 missing param
// ============================================================================

Deno.test('handler: returns 400 when model query param missing', async () => {
  const calls: FetchCall[] = [];
  const handler = createHandler(makeFetchStub({ calls }));

  const response = await handler(makeRequest('/cost'));
  const body = await parseJson(response);

  assertEquals(response.status, 400);
  assertEquals(body.error, 'Missing required query parameter: model');
  assertEquals(response.headers.get('Content-Type'), 'application/json');
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals(calls.length, 0, 'Should not call OpenRouter on validation error');
});

Deno.test('handler: empty model string is treated as missing (400)', async () => {
  const handler = createHandler(forbiddenFetch());
  const response = await handler(makeRequest('/cost?model='));
  assertEquals(response.status, 400);
});

// ============================================================================
// Runtime handler — 404 unknown model
// ============================================================================

Deno.test('handler: unknown model returns 404 with model name in error', async () => {
  const calls: FetchCall[] = [];
  const handler = createHandler(makeFetchStub({ calls }));

  const response = await handler(makeRequest('/cost?model=totally-fake-model'));
  const body = await parseJson(response);

  assertEquals(response.status, 404);
  assertEquals(body.error, 'Model not found: totally-fake-model');
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals(calls.length, 0, 'Unknown model should not trigger catalog fetch');
});

// ============================================================================
// Runtime handler — fixed-pricing fast path (no fetch)
// ============================================================================

Deno.test('handler: known rose-1-lite pool returns averaged pricing, no fetch', async () => {
  const handler = createHandler(forbiddenFetch());
  const response = await handler(makeRequest('/cost?model=rose-1-lite'));
  const body = await parseJson<{
    model: string;
    contextLength: number;
    pricing: {
      costPerMillionInputTokens: number;
      costPerMillionOutputTokens: number;
    };
  }>(response);

  assertEquals(response.status, 200);
  assertEquals(body.model, 'rose-1-lite');
  // Pricing is rounded up to nearest $0.05/M and must be positive.
  assert(body.pricing.costPerMillionInputTokens > 0);
  assert(body.pricing.costPerMillionOutputTokens > 0);
  const isMultipleOf05 = (n: number) => Math.abs((n * 100) % 5) < 1e-6;
  assert(isMultipleOf05(body.pricing.costPerMillionInputTokens));
  assert(isMultipleOf05(body.pricing.costPerMillionOutputTokens));
  // minContext across the pool
  const pool = MODEL_POOLS['rose-1-lite'];
  const expectedCtx = Math.min(
    FIXED_PRICING[pool[0]].contextLength,
    FIXED_PRICING[pool[1]].contextLength,
  );
  assertEquals(body.contextLength, expectedCtx);
});

Deno.test('handler: rose-labs/ prefix is normalized before lookup', async () => {
  const handler = createHandler(forbiddenFetch());
  const withPrefix = await handler(makeRequest('/cost?model=rose-labs/rose-1-lite'));
  const bare = await handler(makeRequest('/cost?model=rose-1-lite'));

  assertEquals(withPrefix.status, 200);
  assertEquals(bare.status, 200);

  const a = await parseJson(withPrefix);
  const b = await parseJson(bare);
  assertEquals(a, b);
});

Deno.test('handler: resolving by raw provider model id hits FIXED_PRICING fast path', async () => {
  // Underlying-model lookup: workers sometimes pass the raw provider id.
  const handler = createHandler(forbiddenFetch());
  const response = await handler(
    makeRequest('/cost?model=google/gemini-3-flash-preview'),
  );
  const body = await parseJson<{
    model: string;
    contextLength: number;
    pricing: {
      costPerMillionInputTokens: number;
      costPerMillionOutputTokens: number;
    };
  }>(response);

  assertEquals(response.status, 200);
  assertEquals(body.model, 'google/gemini-3-flash-preview');
  assertEquals(
    body.contextLength,
    FIXED_PRICING['google/gemini-3-flash-preview'].contextLength,
  );
});

Deno.test('handler: all pool models return full response shape', async () => {
  const handler = createHandler(forbiddenFetch());
  for (const model of Object.keys(MODEL_POOLS)) {
    const response = await handler(makeRequest(`/cost?model=${model}`));
    assertEquals(response.status, 200, `model=${model}`);
    const body = await parseJson<Record<string, unknown>>(response);
    assertEquals(Object.keys(body).sort(), ['contextLength', 'model', 'pricing']);
    assertEquals(body.model, model);
  }
});

// ============================================================================
// Runtime handler — catalog-fetch path (needsCatalog = true)
// ============================================================================

Deno.test('handler: catalog fetch path activates for a pool with non-fixed members', async () => {
  await withTempPool(
    'test-catalog-pool',
    // one fixed-price, one catalog-only: exercises both accumulator branches.
    ['google/gemini-3-flash-preview', 'catalog/only-model'],
    async () => {
      const calls: FetchCall[] = [];
      const stub = makeFetchStub({
        calls,
        status: 200,
        body: {
          data: [
            {
              id: 'catalog/only-model',
              context_length: 50_000,
              pricing: { prompt: '0.000002', completion: '0.000010' },
            },
          ],
        },
      });

      const handler = createHandler(stub);
      const response = await handler(makeRequest('/cost?model=test-catalog-pool'));
      const body = await parseJson<{
        model: string;
        contextLength: number;
        pricing: {
          costPerMillionInputTokens: number;
          costPerMillionOutputTokens: number;
        };
      }>(response);

      assertEquals(response.status, 200);
      assertEquals(body.model, 'test-catalog-pool');
      assertEquals(calls.length, 1, 'needsCatalog=true should call fetch once');
      // min(1_048_576, 50_000) = 50_000
      assertEquals(body.contextLength, 50_000);
      // Averaged across 2 models, rounded up to nearest $0.05/M.
      assert(body.pricing.costPerMillionInputTokens > 0);
      assert(body.pricing.costPerMillionOutputTokens > 0);
    },
  );
});

Deno.test(
  'handler: catalog-only pool with empty catalog response returns 500 (no pricing)',
  async () => {
    await withTempPool('test-empty-catalog-pool', ['catalog/only-model'], async () => {
      const calls: FetchCall[] = [];
      const stub = makeFetchStub({ calls, status: 200, body: { data: [] } });

      const handler = createHandler(stub);
      const response = await handler(makeRequest('/cost?model=test-empty-catalog-pool'));
      const body = await parseJson(response);

      assertEquals(response.status, 500);
      assertEquals(body.error, 'No pricing information available for models in pool');
      assertEquals(calls.length, 1);
    });
  },
);

Deno.test(
  'handler: OpenRouter non-OK response bubbles up as 500 internal error',
  async () => {
    await withTempPool('test-openrouter-500-pool', ['catalog/only-model'], async () => {
      const calls: FetchCall[] = [];
      const stub = makeFetchStub({ calls, status: 503, body: { error: 'down' } });

      const handler = createHandler(stub);
      const response = await handler(makeRequest('/cost?model=test-openrouter-500-pool'));
      const body = await parseJson<{ error: string; details: string }>(response);

      assertEquals(response.status, 500);
      assertEquals(body.error, 'Failed to calculate cost');
      assertEquals(body.details, 'OpenRouter API returned 503');
      assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
    });
  },
);

Deno.test(
  'handler: malformed OpenRouter JSON body surfaces as 500 internal error',
  async () => {
    await withTempPool('test-malformed-pool', ['catalog/only-model'], async () => {
      const calls: FetchCall[] = [];
      const stub = makeFetchStub({ calls, status: 200, bodyText: '{not json' });

      const handler = createHandler(stub);
      const response = await handler(makeRequest('/cost?model=test-malformed-pool'));
      const body = await parseJson<{ error: string; details: string }>(response);

      assertEquals(response.status, 500);
      assertEquals(body.error, 'Failed to calculate cost');
      assertEquals(typeof body.details, 'string');
      assert(body.details.length > 0);
    });
  },
);

Deno.test(
  'handler: network-level fetch failure surfaces as 500 with error details',
  async () => {
    await withTempPool('test-network-error-pool', ['catalog/only-model'], async () => {
      const calls: FetchCall[] = [];
      const stub = makeFetchStub({
        calls,
        networkError: new Error('connection refused'),
      });

      const handler = createHandler(stub);
      const response = await handler(makeRequest('/cost?model=test-network-error-pool'));
      const body = await parseJson<{ error: string; details: string }>(response);

      assertEquals(response.status, 500);
      assertEquals(body.error, 'Failed to calculate cost');
      assertEquals(body.details, 'connection refused');
    });
  },
);

Deno.test(
  'handler: non-Error thrown values still produce 500 with "Unknown error" details',
  async () => {
    await withTempPool('test-weird-throw-pool', ['catalog/only-model'], async () => {
      // Fetch rejects with a non-Error value — runtime falls back to "Unknown error".
      const stub: typeof fetch = () => Promise.reject('string-error-value');

      const handler = createHandler(stub);
      const response = await handler(makeRequest('/cost?model=test-weird-throw-pool'));
      const body = await parseJson<{ error: string; details: string }>(response);

      assertEquals(response.status, 500);
      assertEquals(body.error, 'Failed to calculate cost');
      assertEquals(body.details, 'Unknown error');
    });
  },
);

// ============================================================================
// Runtime handler — invariants
// ============================================================================

Deno.test('invariant: every error response carries CORS + JSON content type', async () => {
  const handler = createHandler(forbiddenFetch());

  const scenarios: Request[] = [
    makeRequest('/cost'), // 400
    makeRequest('/cost?model=does-not-exist'), // 404
  ];

  for (const req of scenarios) {
    const response = await handler(req);
    assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
    const ct = response.headers.get('Content-Type');
    assertExists(ct);
    assert(ct!.includes('application/json'));
    const body = await parseJson(response);
    assertEquals(typeof body.error, 'string');
    assert((body.error as string).length > 0);
  }
});

Deno.test('invariant: success response carries CORS + JSON content type', async () => {
  const handler = createHandler(forbiddenFetch());
  const response = await handler(makeRequest('/cost?model=rose-1-lite'));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  const ct = response.headers.get('Content-Type');
  assertExists(ct);
  assert(ct!.includes('application/json'));
});

Deno.test('invariant: same input produces identical response bytes', async () => {
  const handler = createHandler(forbiddenFetch());
  const first = await (
    await handler(makeRequest('/cost?model=rose-1-lite'))
  ).text();
  const second = await (
    await handler(makeRequest('/cost?model=rose-1-lite'))
  ).text();
  const third = await (
    await handler(makeRequest('/cost?model=rose-1-lite'))
  ).text();
  assertEquals(first, second);
  assertEquals(second, third);
});

Deno.test('invariant: case-insensitive model names hit the same result', async () => {
  const handler = createHandler(forbiddenFetch());
  const a = await parseJson(await handler(makeRequest('/cost?model=rose-1-lite')));
  const b = await parseJson(await handler(makeRequest('/cost?model=ROSE-1-LITE')));
  const c = await parseJson(await handler(makeRequest('/cost?model=Rose-1-Lite')));
  assertEquals(a, b);
  assertEquals(b, c);
});

Deno.test(
  'invariant: validation-failure responses produce zero outbound fetches',
  async () => {
    const calls: FetchCall[] = [];
    const handler = createHandler(makeFetchStub({ calls }));

    await handler(makeRequest('/cost')); // 400
    await handler(makeRequest('/cost?model=')); // 400
    await handler(makeRequest('/cost?model=no-such-model')); // 404
    await handler(makeRequest('/cost', 'OPTIONS')); // 200

    assertEquals(calls.length, 0);
  },
);

// ============================================================================
// CostError ergonomics
// ============================================================================

Deno.test('CostError: carries status + message + name', () => {
  const err = new CostError('boom', 418);
  assertEquals(err.status, 418);
  assertEquals(err.message, 'boom');
  assertEquals(err.name, 'CostError');
  assert(err instanceof Error);
});
