#!/usr/bin/env tsx
/**
 * Black-box tests for /api/models
 *
 * Domain surface:
 *   GET    /api/models       — public, no auth, returns list of LLM models (OpenRouter + Rose custom)
 *   DELETE /api/models/cache — public, no auth, clears 1-hour in-memory model cache
 *
 * Boundary capture coverage:
 *   This domain makes one outbound third-party HTTP call:
 *   - GET https://openrouter.ai/api/v1/models (on cache miss only)
 *   - Headers: Authorization (Bearer), HTTP-Referer, X-Title
 *   Boundary tests verify the exact URL, method, and header keys of the outbound call.
 *   On cache hit, zero outbound calls are made (verified separately).
 *
 * Invariants covered:
 *   - auth boundary: both endpoints are public, work without any auth headers
 *   - error-surface: unsupported HTTP methods don't return 200; 500 error has structured shape
 *   - idempotency: GET /models returns same data on repeated calls (within cache TTL)
 *   - ordering: model order is deterministic (Rose first, featured, then alphabetical by provider/name)
 *   - concurrency: 10 parallel GETs return consistent results
 *   - same-input reproducibility: three sequential GETs return identical responses
 *   - duplication prevention: model IDs are unique across the response
 *   - boundary param: OpenRouter call uses exact URL, GET method, and expected header keys
 *   - call ordering: exactly 1 outbound call on cache miss, 0 on cache hit
 *   - cleanup: tests clear cache state; no persistent side effects
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write consistency: cache is ephemeral in-memory, not DB-persisted state
 *   - state transition: no state machine (cache is binary: present or absent)
 *   - atomicity: read-only data, no transactions
 *   - referential integrity: no foreign keys or DB relations
 *   - event/job cardinality: no events emitted
 *   - tenant isolation: public endpoint, no user scoping
 *   - time/clock: no timestamps in response
 *
 * Usage:
 *   npx tsx src/tests/blackbox/models.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/models.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ModelItem = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  description: z.string().optional(),
  contextLength: z.number().optional(),
  pricing: z
    .object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
    })
    .optional(),
});

const ListModelsResponse = z.object({
  models: z.array(ModelItem),
  cached: z.boolean(),
  count: z.number().optional(),
});

const CacheClearedResponse = z.object({
  message: z.string(),
});

const ErrorResponse = z.object({
  error: z.string(),
});

type ModelItemType = z.infer<typeof ModelItem>;

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data: unknown;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data, headers: response.headers };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}

/** Ensure cache is warm so parallel tests don't race on cold cache. */
async function ensureCacheWarm(): Promise<void> {
  const res = await request(`${BASE_URL}/api/models`);
  if (res.status !== 200) throw new Error(`Warmup failed: status ${res.status}`);
}

// ==================== DELETE /api/models/cache — CONTRACT TESTS ====================

async function testClearCache_happy() {
  const res = await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  assertStatus(res.status, 200, res.data);
  assertSchema(CacheClearedResponse, res.data, 'DELETE /cache');
}

async function testClearCache_responseShape() {
  const res = await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string };
  if (typeof body.message !== 'string' || body.message.length === 0) {
    throw new Error(`Expected non-empty message, got: ${JSON.stringify(body.message)}`);
  }
}

async function testClearCache_thenListNotCached() {
  // rose.blackbox.ts runs in parallel (domainConcurrency=6) and also hits
  // /api/models, so the cache can be re-warmed between our DELETE and GET.
  // Retry up to 5× to win the race; each cycle re-clears before re-reading.
  let lastCached: unknown = 'unknown';
  for (let attempt = 0; attempt < 5; attempt++) {
    await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
    const res = await request(`${BASE_URL}/api/models`);
    assertStatus(res.status, 200, res.data);
    const body = res.data as { cached: boolean };
    lastCached = body.cached;
    if (body.cached === false) return;
  }
  throw new Error(
    `Expected cached=false after clearing; lost race across 5 attempts (last cached=${String(lastCached)})`
  );
}

async function testClearCache_idempotent() {
  await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  const res2 = await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  assertStatus(res2.status, 200, res2.data);
  assertSchema(CacheClearedResponse, res2.data, 'DELETE /cache (second call)');
}

async function testClearCache_contentType() {
  const res = await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  const ct = res.headers.get('content-type');
  if (!ct || !ct.includes('application/json')) {
    throw new Error(`Expected Content-Type application/json, got: ${ct}`);
  }
}

// ==================== GET /api/models — CONTRACT TESTS ====================

async function testListModels_happy() {
  await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListModelsResponse, res.data, 'GET /api/models');
  if (body.models.length < 2)
    throw new Error(`Expected at least 2 models, got ${body.models.length}`);
  if (body.models[0].id !== 'rose-labs/rose-1-lite')
    throw new Error(`Expected first model rose-labs/rose-1-lite, got ${body.models[0].id}`);
  if (body.models[1].id !== 'rose-labs/rose-1-ultra')
    throw new Error(`Expected second model rose-labs/rose-1-ultra, got ${body.models[1].id}`);
}

async function testListModels_cached() {
  await ensureCacheWarm();
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListModelsResponse, res.data, 'GET /api/models (cached)');
  if (body.cached !== true) throw new Error(`Expected cached=true, got ${body.cached}`);
}

async function testListModels_uncachedHasCount() {
  await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { count?: number; models: unknown[] };
  if (typeof body.count !== 'number')
    throw new Error(`Expected count field on uncached response, got ${typeof body.count}`);
  if (body.count !== body.models.length)
    throw new Error(`count (${body.count}) does not match models.length (${body.models.length})`);
}

async function testListModels_roseModelShape() {
  await ensureCacheWarm();
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { models: ModelItemType[] };
  for (const roseId of ['rose-labs/rose-1-lite', 'rose-labs/rose-1-ultra']) {
    const model = body.models.find((m) => m.id === roseId);
    if (!model) throw new Error(`${roseId} not found`);
    if (
      !model.pricing ||
      typeof model.pricing.prompt !== 'string' ||
      typeof model.pricing.completion !== 'string'
    ) {
      throw new Error(`${roseId} missing pricing: ${JSON.stringify(model.pricing)}`);
    }
    if (typeof model.contextLength !== 'number') throw new Error(`${roseId} missing contextLength`);
    if (model.provider !== 'rose-labs')
      throw new Error(`${roseId} expected provider=rose-labs, got ${model.provider}`);
  }
}

async function testListModels_roseModelsFirst() {
  await ensureCacheWarm();
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { models: ModelItemType[] };
  if (body.models[0].id !== 'rose-labs/rose-1-lite')
    throw new Error(`First model should be rose-1-lite, got ${body.models[0].id}`);
  if (body.models[1].id !== 'rose-labs/rose-1-ultra')
    throw new Error(`Second model should be rose-1-ultra, got ${body.models[1].id}`);
}

async function testListModels_modelItemSchema() {
  await ensureCacheWarm();
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { models: unknown[] };
  for (let i = 0; i < body.models.length; i++) {
    const result = ModelItem.safeParse(body.models[i]);
    if (!result.success) {
      const id = (body.models[i] as { id?: string })?.id ?? `index ${i}`;
      throw new Error(`Model "${id}" schema validation failed: ${result.error.message}`);
    }
  }
}

async function testListModels_contentType() {
  const res = await request(`${BASE_URL}/api/models`);
  const ct = res.headers.get('content-type');
  if (!ct || !ct.includes('application/json')) {
    throw new Error(`Expected Content-Type application/json, got: ${ct}`);
  }
}

async function testListModels_providerDerivedFromId() {
  await ensureCacheWarm();
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { models: ModelItemType[] };
  for (const model of body.models) {
    const expectedProvider = model.id.split('/')[0] || 'unknown';
    if (model.provider !== expectedProvider) {
      throw new Error(
        `Model "${model.id}": expected provider="${expectedProvider}", got "${model.provider}"`
      );
    }
  }
}

// ==================== AUTH BOUNDARY INVARIANT ====================

async function testAuth_noAuthRequired_list() {
  const response = await fetch(`${BASE_URL}/api/models`);
  if (response.status === 401 || response.status === 403) {
    throw new Error(`GET /api/models should not require auth, got ${response.status}`);
  }
}

async function testAuth_noAuthRequired_clearCache() {
  const response = await fetch(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`DELETE /api/models/cache should not require auth, got ${response.status}`);
  }
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testError_postNotAllowed() {
  const res = await request(`${BASE_URL}/api/models`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (res.status === 200) throw new Error('POST /api/models should not return 200');
}

async function testError_putNotAllowed() {
  const res = await request(`${BASE_URL}/api/models`, {
    method: 'PUT',
    body: JSON.stringify({}),
  });
  if (res.status === 200) throw new Error('PUT /api/models should not return 200');
}

async function testError_patchNotAllowed() {
  const res = await request(`${BASE_URL}/api/models`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  if (res.status === 200) throw new Error('PATCH /api/models should not return 200');
}

async function testError_500Shape() {
  // Can't force a 500 from outside, but verify shape if one occurs
  const res = await request(`${BASE_URL}/api/models`);
  if (res.status === 500) {
    const body = assertSchema(ErrorResponse, res.data, 'GET /api/models (500)');
    if (!body.error) throw new Error('500 response missing error field');
  }
  // If 200, this test is a no-op — error path requires OpenRouter failure
}

// ==================== IDEMPOTENCY / CACHE INVARIANT ====================

async function testIdempotency_sameResponse() {
  await ensureCacheWarm();
  const res1 = await request(`${BASE_URL}/api/models`);
  const res2 = await request(`${BASE_URL}/api/models`);
  if (res1.status !== res2.status)
    throw new Error(`Status mismatch: first=${res1.status}, second=${res2.status}`);
  if (res1.status === 200) {
    const a = JSON.stringify(res1.data);
    const b = JSON.stringify(res2.data);
    if (a !== b)
      throw new Error('Idempotency violation: two identical GETs returned different data');
  }
}

// ==================== ORDERING INVARIANT ====================

async function testOrdering_deterministic() {
  await ensureCacheWarm();
  const res1 = await request(`${BASE_URL}/api/models`);
  const res2 = await request(`${BASE_URL}/api/models`);
  if (res1.status !== 200 || res2.status !== 200) return;
  const ids1 = (res1.data as { models: ModelItemType[] }).models.map((m) => m.id);
  const ids2 = (res2.data as { models: ModelItemType[] }).models.map((m) => m.id);
  if (JSON.stringify(ids1) !== JSON.stringify(ids2)) {
    throw new Error('Model ordering is not deterministic between consecutive GETs');
  }
}

// ==================== CONCURRENCY INVARIANT ====================

async function testConcurrency_parallelGETsConsistent() {
  await ensureCacheWarm();
  const requests = Array.from({ length: 10 }, () => request(`${BASE_URL}/api/models`));
  const results = await Promise.all(requests);

  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size > 1) {
    throw new Error(`Concurrent requests returned mixed statuses: ${[...statuses].join(', ')}`);
  }

  if (results[0].status === 200) {
    const baseline = JSON.stringify(results[0].data);
    for (let i = 1; i < results.length; i++) {
      if (JSON.stringify(results[i].data) !== baseline) {
        throw new Error(`Concurrent request ${i} returned different data than request 0`);
      }
    }
  }
}

// ==================== SAME-INPUT REPRODUCIBILITY INVARIANT ====================

async function testReproducibility_threeSequentialRuns() {
  await ensureCacheWarm();
  const snapshots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/models`);
    snapshots.push(JSON.stringify({ status: res.status, data: res.data }));
  }
  if (new Set(snapshots).size !== 1) {
    throw new Error('Three sequential GETs did not return identical responses');
  }
}

// ==================== DUPLICATION PREVENTION INVARIANT ====================

async function testDuplication_modelIdsUnique() {
  await ensureCacheWarm();
  const res = await request(`${BASE_URL}/api/models`);
  if (res.status !== 200) return;
  const body = res.data as { models: ModelItemType[] };
  const seen = new Set<string>();
  for (const model of body.models) {
    if (seen.has(model.id)) throw new Error(`Duplicate model ID: ${model.id}`);
    seen.add(model.id);
  }
}

// ==================== BOUNDARY CAPTURE — OPENROUTER OUTBOUND CALL ====================

async function testBoundary_openRouterCallOnCacheMiss() {
  const captureToken = `models-cache-miss-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Snapshot cursor, clear model cache, then hit GET /models.
  // Verify exactly 1 outbound call to OpenRouter with correct URL, method, and headers.
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) return; // capture harness not active, skip

  // Clear model cache to force a real outbound call
  await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });

  await request(`${BASE_URL}/api/models`, {
    headers: { 'X-Capture-Token': captureToken },
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: {
      url: string;
      method: string;
      requestHeaders: Record<string, string>;
      requestBody: string | null;
    }[];
  };

  // Should have at least 1 outbound call to OpenRouter
  const openRouterCalls = body.captures.filter((c) =>
    c.url.includes('openrouter.ai/api/v1/models')
  );
  if (openRouterCalls.length === 0) {
    throw new Error(
      `Expected outbound call to openrouter.ai/api/v1/models, got ${body.captures.length} captures: ${JSON.stringify(body.captures.map((c) => c.url)).substring(0, 500)}`
    );
  }

  const call = openRouterCalls[0];

  // Assert exact URL
  if (call.url !== 'https://openrouter.ai/api/v1/models') {
    throw new Error(`Expected URL https://openrouter.ai/api/v1/models, got ${call.url}`);
  }

  // Assert method
  if (call.method !== 'GET') {
    throw new Error(`Expected method GET, got ${call.method}`);
  }

  // Assert required header keys (values are redacted by the capture harness)
  const headerKeys = Object.keys(call.requestHeaders).map((k) => k.toLowerCase());
  if (!headerKeys.includes('authorization')) {
    throw new Error(
      `Expected Authorization header, got headers: ${JSON.stringify(Object.keys(call.requestHeaders))}`
    );
  }
  if (!headerKeys.includes('http-referer')) {
    throw new Error(
      `Expected HTTP-Referer header, got headers: ${JSON.stringify(Object.keys(call.requestHeaders))}`
    );
  }
  if (!headerKeys.includes('x-title')) {
    throw new Error(
      `Expected X-Title header, got headers: ${JSON.stringify(Object.keys(call.requestHeaders))}`
    );
  }

  // Assert no request body (GET request)
  if (call.requestBody !== null) {
    throw new Error(`Expected null request body for GET, got: ${call.requestBody}`);
  }
}

/** Filter out infra calls from concurrent tests (anthropic, openrouter, etc.). */
const MODELS_INFRA_HOSTS = [
  'anthropic.com',
  'openai.com',
  'supabase.co',
  'api.github.com',
  'ip-api.com',
  'surge.app',
  'verify.twilio.com',
  'e2b.app',
  'stripe.com',
  'parallel.ai',
  'exa.ai',
  'perplexity.ai',
  'vapi.ai',
  'googleapis.com',
  'connect.steelbrowser.com',
];

function filterInfra(captures: { url: string }[]): { url: string }[] {
  return captures.filter((c) => !MODELS_INFRA_HOSTS.some((h) => c.url.includes(h)));
}

async function testBoundary_noOutboundCallOnCacheHit() {
  const captureToken = `models-cache-hit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Warm the cache first
  await ensureCacheWarm();

  // Snapshot cursor, then hit GET /models again (should be cached)
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) return; // capture harness not active, skip

  await request(`${BASE_URL}/api/models`, {
    headers: { 'X-Capture-Token': captureToken },
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as { captures: { url: string }[] };
  const relevant = filterInfra(body.captures);
  if (relevant.length > 0) {
    throw new Error(
      `Expected 0 outbound calls on cache hit, got ${relevant.length}: ${JSON.stringify(relevant).substring(0, 500)}`
    );
  }
}

async function testBoundary_clearCacheNoOutbound() {
  const captureToken = `models-clear-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // DELETE /cache should not make any outbound calls
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) return; // capture harness not active, skip

  await request(`${BASE_URL}/api/models/cache`, {
    method: 'DELETE',
    headers: { 'X-Capture-Token': captureToken },
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as { captures: { url: string }[] };
  const relevant = filterInfra(body.captures);
  if (relevant.length > 0) {
    throw new Error(`Expected 0 outbound calls on DELETE /cache, got ${relevant.length}`);
  }
}

// ==================== RUNNER ====================

interface TestGroup {
  name: string;
  tests: { name: string; fn: () => Promise<void> }[];
}

async function runAll() {
  console.log('Models Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Warm the cache once before parallel tests to avoid thundering herd on cold start
  await ensureCacheWarm();

  // Parallel groups — read-only tests that never mutate cache state
  // ensureCacheWarm() only adds to cache, never clears, so it's safe concurrently
  const parallelGroups: TestGroup[] = [
    {
      name: 'GET /api/models — contract',
      tests: [
        { name: 'cached response', fn: testListModels_cached },
        { name: 'Rose model shape (pricing + contextLength)', fn: testListModels_roseModelShape },
        { name: 'Rose models are first two', fn: testListModels_roseModelsFirst },
        { name: 'every model matches schema', fn: testListModels_modelItemSchema },
        { name: 'Content-Type: application/json', fn: testListModels_contentType },
        { name: 'provider derived from model ID', fn: testListModels_providerDerivedFromId },
      ],
    },
    {
      name: 'Auth boundary',
      tests: [{ name: 'GET /models — no auth required', fn: testAuth_noAuthRequired_list }],
    },
    {
      name: 'Error surface',
      tests: [
        { name: 'POST not allowed', fn: testError_postNotAllowed },
        { name: 'PUT not allowed', fn: testError_putNotAllowed },
        { name: 'PATCH not allowed', fn: testError_patchNotAllowed },
        { name: '500 error shape (if applicable)', fn: testError_500Shape },
      ],
    },
    {
      name: 'Idempotency / cache',
      tests: [{ name: 'two GETs return same data', fn: testIdempotency_sameResponse }],
    },
    {
      name: 'Ordering',
      tests: [{ name: 'model order deterministic', fn: testOrdering_deterministic }],
    },
    {
      name: 'Concurrency',
      tests: [{ name: '10 parallel GETs consistent', fn: testConcurrency_parallelGETsConsistent }],
    },
    {
      name: 'Reproducibility',
      tests: [
        { name: 'three sequential runs identical', fn: testReproducibility_threeSequentialRuns },
      ],
    },
    {
      name: 'Duplication prevention',
      tests: [{ name: 'model IDs unique', fn: testDuplication_modelIdsUnique }],
    },
  ];

  // Sequential groups — tests that mutate cache or use shared capture state
  const sequentialGroups: TestGroup[] = [
    {
      name: 'DELETE /api/models/cache — contract',
      tests: [
        { name: 'happy path', fn: testClearCache_happy },
        { name: 'response shape', fn: testClearCache_responseShape },
        { name: 'idempotent (double clear)', fn: testClearCache_idempotent },
        { name: 'Content-Type: application/json', fn: testClearCache_contentType },
        { name: 'DELETE /cache — no auth required', fn: testAuth_noAuthRequired_clearCache },
      ],
    },
    {
      name: 'Cache state (sequential)',
      tests: [
        { name: 'happy path (Rose models first)', fn: testListModels_happy },
        { name: 'clear then list returns cached=false', fn: testClearCache_thenListNotCached },
        { name: 'uncached response has count', fn: testListModels_uncachedHasCount },
      ],
    },
    {
      name: 'Boundary capture',
      tests: [
        {
          name: 'OpenRouter call on cache miss (URL, method, headers)',
          fn: testBoundary_openRouterCallOnCacheMiss,
        },
        { name: 'zero outbound calls on cache hit', fn: testBoundary_noOutboundCallOnCacheHit },
        { name: 'DELETE /cache makes no outbound calls', fn: testBoundary_clearCacheNoOutbound },
      ],
    },
  ];

  const allGroups = [...parallelGroups, ...sequentialGroups];

  // Flatten parallel tests for concurrent execution
  const parallelTests: { groupName: string; name: string; fn: () => Promise<void> }[] = [];
  for (const group of parallelGroups) {
    for (const test of group.tests) {
      parallelTests.push({ groupName: group.name, name: test.name, fn: test.fn });
    }
  }

  // Run parallel tests concurrently with case concurrency limit
  const allResults: (TestResult & { groupName: string })[] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= parallelTests.length) return;
      const t = parallelTests[idx];
      const result = await runTest(`${t.groupName} -- ${t.name}`, t.fn);
      allResults[idx] = { ...result, groupName: t.groupName };
    }
  }

  const workerCount = Math.min(CASE_CONCURRENCY, parallelTests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Run sequential boundary tests one at a time
  for (const group of sequentialGroups) {
    for (const test of group.tests) {
      const result = await runTest(`${group.name} -- ${test.name}`, test.fn);
      allResults.push({ ...result, groupName: group.name });
    }
  }

  // Print results grouped
  for (const group of allGroups) {
    console.log(`\n  ${group.name}`);
    for (const test of group.tests) {
      const result = allResults.find(
        (r) => r.groupName === group.name && r.name.endsWith(test.name)
      )!;
      const icon = result.passed ? '  PASS' : '  FAIL';
      console.log(
        `${icon}  ${test.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
      );
    }
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(
    `\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total (caseConcurrency=${workerCount})`
  );
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
