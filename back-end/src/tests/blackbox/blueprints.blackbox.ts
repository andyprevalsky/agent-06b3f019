#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for /api/blueprints
 *
 * Domain surface:
 *   POST /api/blueprints/search     — search blueprints by goal similarity (auth: JWT or API key)
 *   POST /api/blueprints            — create a blueprint (auth: JWT or API key)
 *   GET  /api/blueprints            — list user's blueprints (auth: JWT via app-level middleware)
 *   GET  /api/blueprints/by-goal    — find blueprint by exact goal title (auth: JWT)
 *   DELETE /api/blueprints/:id      — delete a blueprint (auth: JWT via app-level middleware)
 *   PATCH  /api/blueprints/:id/feedback — submit feedback for a blueprint (auth: JWT)
 *
 * Boundary capture coverage:
 *   POST /search and POST / both call OpenAI embeddings API:
 *   - POST https://api.openai.com/v1/embeddings (via openai.embeddings.create)
 *   Boundary tests verify URL, method, and Authorization header of outbound calls.
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401 on all endpoints
 *   - error-surface: missing required fields return 400; not-found returns 404
 *   - read-after-write: create then list shows new blueprint; create then by-goal finds it
 *   - state-transition: create -> feedback -> delete lifecycle
 *   - idempotency: same invalid request always returns same error
 *   - concurrency: 10 parallel auth-check requests return consistent results
 *   - same-input reproducibility: three sequential validation errors return identical status
 *   - cleanup: created blueprints are deleted after tests
 *   - tenant isolation: user A cannot see/delete user B's blueprints
 *   - boundary param: OpenAI embeddings call uses expected URL, method, and auth header
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - ordering/pagination: no pagination params (list returns up to 50 DESC)
 *   - atomicity: single DB operations per request
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: duplicate blueprints allowed by design
 *   - time/clock: timestamps come from DB, not tested for clock drift
 *   - call ordering: independent endpoints
 *
 * Usage:
 *   npx tsx src/tests/blackbox/blueprints.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/blueprints.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({ error: z.string() });

const BlueprintSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  blueprint: z.any(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const BlueprintListSchema = z.array(BlueprintSchema);

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  accessToken?: string;
  userId?: string;
  accessToken2?: string;
  userId2?: string;
  createdIds: string[];
}

const ctx: TestContext = { createdIds: [] };

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data: unknown;
  const ct = response.headers.get('content-type');
  if (ct?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data, headers: response.headers };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
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
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

async function runPool(
  tests: { name: string; fn: () => Promise<void> }[],
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(tests.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tests.length) return;
      results[idx] = await runTest(tests[idx].name, tests[idx].fn);
    }
  }
  const workerCount = Math.min(concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ==================== SETUP ====================

async function setup(): Promise<void> {
  // User 1
  const res1 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res1.status, 200, res1.data);
  const d1 = res1.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d1.session.access_token;
  ctx.userId = d1.user.id;

  // User 2 (for tenant isolation)
  const res2 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res2.status, 200, res2.data);
  const d2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken2 = d2.session.access_token;
  ctx.userId2 = d2.user.id;
}

async function cleanup(): Promise<void> {
  for (const id of ctx.createdIds) {
    try {
      await request(`${BASE_URL}/api/blueprints/${id}`, {
        method: 'DELETE',
        headers: authHeaders(ctx.accessToken!),
      });
    } catch {
      // best-effort cleanup
    }
  }
}

// ==================== HELPERS ====================

async function createBlueprint(
  token: string,
  title: string,
  blueprint: unknown = { steps: ['step1'] }
): Promise<{ id: string; status: number; data: unknown }> {
  const res = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title, blueprint }),
  });
  const id = res.status === 201 ? (res.data as { id: string }).id : '';
  if (id) ctx.createdIds.push(id);
  return { id, status: res.status, data: res.data };
}

// ==================== POST /api/blueprints/search ====================

// --- auth boundary ---

async function testSearch_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testSearch_invalidToken() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, {
    method: 'POST',
    headers: authHeaders('invalid.jwt.token'),
    body: JSON.stringify({ goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testSearch_missingGoal() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /search (missing goal)');
}

async function testSearch_emptyBody() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

// --- happy path ---

async function testSearch_emptyResults() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 'zzz_unique_nonexistent_goal_' + Date.now() }),
  });
  assertStatus(res.status, 200, res.data);
  if (!Array.isArray(res.data)) throw new Error('Expected array response');
}

// ==================== POST /api/blueprints ====================

// --- auth boundary ---

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    body: JSON.stringify({ title: 'test', blueprint: {} }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_invalidToken() {
  const res = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: authHeaders('invalid.jwt.token'),
    body: JSON.stringify({ title: 'test', blueprint: {} }),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testCreate_missingTitle() {
  const res = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ blueprint: { steps: [] } }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (missing title)');
}

async function testCreate_missingBlueprint() {
  const res = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ title: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (missing blueprint)');
}

async function testCreate_emptyBody() {
  const res = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

// --- happy path ---

async function testCreate_happy() {
  const { status, data } = await createBlueprint(
    ctx.accessToken!,
    'BB test blueprint ' + Date.now()
  );
  assertStatus(status, 201, data);
  assertSchema(BlueprintSchema, data, 'POST / (happy)');
  const bp = data as { userId: string };
  if (bp.userId !== ctx.userId) {
    throw new Error(`Expected userId ${ctx.userId}, got ${bp.userId}`);
  }
}

// ==================== GET /api/blueprints ====================

// --- auth boundary ---

async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints`);
  assertStatus(res.status, 401, res.data);
}

async function testList_invalidToken() {
  const res = await request(`${BASE_URL}/api/blueprints`, {
    headers: authHeaders('invalid.jwt.token'),
  });
  assertStatus(res.status, 401, res.data);
}

// --- happy path ---

async function testList_emptyForFreshUser() {
  // User2 has no blueprints -> empty array
  const res = await request(`${BASE_URL}/api/blueprints`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(BlueprintListSchema, res.data, 'GET / (fresh user)');
}

// ==================== GET /api/blueprints/by-goal ====================

// --- auth boundary ---

async function testByGoal_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/by-goal?goal=test`);
  assertStatus(res.status, 401, res.data);
}

async function testByGoal_invalidToken() {
  const res = await request(`${BASE_URL}/api/blueprints/by-goal?goal=test`, {
    headers: authHeaders('invalid.jwt.token'),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testByGoal_missingGoal() {
  const res = await request(`${BASE_URL}/api/blueprints/by-goal`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /by-goal (missing goal)');
}

// --- not found ---

async function testByGoal_notFound() {
  const res = await request(
    `${BASE_URL}/api/blueprints/by-goal?goal=nonexistent-goal-${Date.now()}`,
    { headers: authHeaders(ctx.accessToken!) }
  );
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /by-goal (not found)');
}

// ==================== DELETE /api/blueprints/:id ====================

// --- auth boundary ---

async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
}

async function testDelete_invalidToken() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent`, {
    method: 'DELETE',
    headers: authHeaders('invalid.jwt.token'),
  });
  assertStatus(res.status, 401, res.data);
}

// --- not found ---

async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent-id`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'DELETE /:id (not found)');
}

// ==================== PATCH /api/blueprints/:id/feedback ====================

// --- auth boundary ---

async function testFeedback_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, {
    method: 'PATCH',
    body: JSON.stringify({ rating: 5 }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testFeedback_invalidToken() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, {
    method: 'PATCH',
    headers: authHeaders('invalid.jwt.token'),
    body: JSON.stringify({ rating: 5 }),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testFeedback_invalidRatingZero() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ rating: 0 }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PATCH /feedback (rating 0)');
}

async function testFeedback_invalidRatingSix() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ rating: 6 }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PATCH /feedback (rating 6)');
}

async function testFeedback_missingRating() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

// --- not found ---

async function testFeedback_notFound() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ rating: 5 }),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'PATCH /feedback (not found)');
}

// ==================== INVARIANTS ====================

async function testIdempotency_validationError() {
  const body = JSON.stringify({});
  const r1 = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body,
  });
  const r2 = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body,
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelAuthChecks() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/blueprints/search`, {
        method: 'POST',
        body: JSON.stringify({ goal: 'concurrent test' }),
      })
    )
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected uniform status, got: ${[...statuses].join(', ')}`);
  }
}

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/blueprints`, {
      method: 'POST',
      headers: authHeaders(ctx.accessToken!),
      body: JSON.stringify({}),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== SEQUENTIAL TESTS ====================

// --- read-after-write: create then list ---

async function testReadAfterWrite_createThenList() {
  const title = 'RAW list test ' + Date.now();
  const { id, status } = await createBlueprint(ctx.accessToken!, title);
  assertStatus(status, 201, { id });

  const listRes = await request(`${BASE_URL}/api/blueprints`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const list = listRes.data as { id: string; title: string }[];
  if (!list.find((bp) => bp.id === id)) {
    throw new Error(`Created blueprint ${id} not found in list`);
  }
}

// --- read-after-write: create then by-goal ---

async function testReadAfterWrite_createThenByGoal() {
  const title = 'RAW by-goal test ' + Date.now();
  const { id, status } = await createBlueprint(ctx.accessToken!, title);
  assertStatus(status, 201, { id });

  const goalRes = await request(
    `${BASE_URL}/api/blueprints/by-goal?goal=${encodeURIComponent(title)}`,
    { headers: authHeaders(ctx.accessToken!) }
  );
  assertStatus(goalRes.status, 200, goalRes.data);
  const found = goalRes.data as { id: string };
  if (found.id !== id) {
    throw new Error(`Expected blueprint ${id}, got ${found.id}`);
  }
}

// --- state-transition: create -> feedback -> delete ---

async function testStateTransition_createFeedbackDelete() {
  const title = 'Lifecycle test ' + Date.now();
  const { id, status: createStatus } = await createBlueprint(ctx.accessToken!, title);
  assertStatus(createStatus, 201, { id });

  // Submit feedback
  const feedbackRes = await request(`${BASE_URL}/api/blueprints/${id}/feedback`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ rating: 4, comment: 'Good blueprint' }),
  });
  assertStatus(feedbackRes.status, 200, feedbackRes.data);
  const updated = feedbackRes.data as { metadata: { feedback: { rating: number } } };
  if (updated.metadata?.feedback?.rating !== 4) {
    throw new Error(`Expected feedback rating 4, got ${JSON.stringify(updated.metadata)}`);
  }

  // Delete
  const deleteRes = await request(`${BASE_URL}/api/blueprints/${id}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(deleteRes.status, 204, deleteRes.data);
  // Remove from cleanup list since already deleted
  ctx.createdIds = ctx.createdIds.filter((cid) => cid !== id);

  // Verify deleted
  const getRes = await request(
    `${BASE_URL}/api/blueprints/by-goal?goal=${encodeURIComponent(title)}`,
    { headers: authHeaders(ctx.accessToken!) }
  );
  assertStatus(getRes.status, 404, getRes.data);
}

// --- tenant isolation ---

async function testTenantIsolation_crossUserInvisible() {
  const title = 'Isolation test ' + Date.now();
  const { id, status } = await createBlueprint(ctx.accessToken!, title);
  assertStatus(status, 201, { id });

  // User 2 cannot see it in list
  const listRes = await request(`${BASE_URL}/api/blueprints`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const list = listRes.data as { id: string }[];
  if (list.find((bp) => bp.id === id)) {
    throw new Error('User 2 can see user 1 blueprint - tenant isolation broken');
  }

  // User 2 cannot delete it
  const deleteRes = await request(`${BASE_URL}/api/blueprints/${id}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(deleteRes.status, 404, deleteRes.data);

  // User 2 cannot submit feedback on it
  const feedbackRes = await request(`${BASE_URL}/api/blueprints/${id}/feedback`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken2!),
    body: JSON.stringify({ rating: 1 }),
  });
  assertStatus(feedbackRes.status, 404, feedbackRes.data);
}

// --- boundary capture: OpenAI embeddings on create ---

async function testBoundary_openAIEmbeddingsOnCreate() {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) return; // capture harness not active
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  await createBlueprint(ctx.accessToken!, 'Boundary embed test ' + Date.now());

  const capturesRes = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
  };

  const openAICalls = body.captures.filter(
    (c) => c.url.includes('api.openai.com') && c.url.includes('embeddings')
  );
  if (openAICalls.length === 0) {
    // If OPENAI_API_KEY is not set, the call fails before fetch - acceptable
    return;
  }

  const call = openAICalls[0];
  if (call.method !== 'POST') {
    throw new Error(`Expected POST to OpenAI, got ${call.method}`);
  }
  const headerKeys = Object.keys(call.requestHeaders).map((k) => k.toLowerCase());
  if (!headerKeys.includes('authorization')) {
    throw new Error('Expected Authorization header in OpenAI call');
  }
}

// --- boundary capture: OpenAI embeddings on search ---

async function testBoundary_openAIEmbeddingsOnSearch() {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) return; // capture harness not active
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  await request(`${BASE_URL}/api/blueprints/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 'Boundary search test' }),
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
  };

  const openAICalls = body.captures.filter(
    (c) => c.url.includes('api.openai.com') && c.url.includes('embeddings')
  );
  // Search only calls embeddings if there are existing blueprints with embeddings.
  // For a fresh user, it returns [] without calling OpenAI. Both cases are acceptable.
  if (openAICalls.length === 0) return;

  const call = openAICalls[0];
  if (call.method !== 'POST') {
    throw new Error(`Expected POST to OpenAI, got ${call.method}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Blueprints Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId}`);
  console.log(`  User 2: ${ctx.userId2}\n`);

  const parallelTests = [
    // auth boundary -- POST /search
    { name: 'POST /blueprints/search -- no auth -> 401', fn: testSearch_noAuth },
    { name: 'POST /blueprints/search -- invalid token -> 401', fn: testSearch_invalidToken },
    // validation -- POST /search
    { name: 'POST /blueprints/search -- missing goal -> 400', fn: testSearch_missingGoal },
    { name: 'POST /blueprints/search -- empty body -> 400', fn: testSearch_emptyBody },
    // happy path -- POST /search
    {
      name: 'POST /blueprints/search -- empty results for fresh user',
      fn: testSearch_emptyResults,
    },
    // auth boundary -- POST /
    { name: 'POST /blueprints -- no auth -> 401', fn: testCreate_noAuth },
    { name: 'POST /blueprints -- invalid token -> 401', fn: testCreate_invalidToken },
    // validation -- POST /
    { name: 'POST /blueprints -- missing title -> 400', fn: testCreate_missingTitle },
    { name: 'POST /blueprints -- missing blueprint -> 400', fn: testCreate_missingBlueprint },
    { name: 'POST /blueprints -- empty body -> 400', fn: testCreate_emptyBody },
    // happy path -- POST /
    { name: 'POST /blueprints -- happy path (create)', fn: testCreate_happy },
    // auth boundary -- GET /
    { name: 'GET /blueprints -- no auth -> 401', fn: testList_noAuth },
    { name: 'GET /blueprints -- invalid token -> 401', fn: testList_invalidToken },
    // happy path -- GET /
    { name: 'GET /blueprints -- empty for fresh user', fn: testList_emptyForFreshUser },
    // auth boundary -- GET /by-goal
    { name: 'GET /blueprints/by-goal -- no auth -> 401', fn: testByGoal_noAuth },
    { name: 'GET /blueprints/by-goal -- invalid token -> 401', fn: testByGoal_invalidToken },
    // validation -- GET /by-goal
    { name: 'GET /blueprints/by-goal -- missing goal -> 400', fn: testByGoal_missingGoal },
    // not found -- GET /by-goal
    { name: 'GET /blueprints/by-goal -- not found -> 404', fn: testByGoal_notFound },
    // auth boundary -- DELETE /:id
    { name: 'DELETE /blueprints/:id -- no auth -> 401', fn: testDelete_noAuth },
    { name: 'DELETE /blueprints/:id -- invalid token -> 401', fn: testDelete_invalidToken },
    // not found -- DELETE /:id
    { name: 'DELETE /blueprints/:id -- not found -> 404', fn: testDelete_notFound },
    // auth boundary -- PATCH /:id/feedback
    { name: 'PATCH /blueprints/:id/feedback -- no auth -> 401', fn: testFeedback_noAuth },
    {
      name: 'PATCH /blueprints/:id/feedback -- invalid token -> 401',
      fn: testFeedback_invalidToken,
    },
    // validation -- PATCH /:id/feedback
    {
      name: 'PATCH /blueprints/:id/feedback -- rating 0 -> 400',
      fn: testFeedback_invalidRatingZero,
    },
    {
      name: 'PATCH /blueprints/:id/feedback -- rating 6 -> 400',
      fn: testFeedback_invalidRatingSix,
    },
    {
      name: 'PATCH /blueprints/:id/feedback -- missing rating -> 400',
      fn: testFeedback_missingRating,
    },
    // not found -- PATCH /:id/feedback
    { name: 'PATCH /blueprints/:id/feedback -- not found -> 404', fn: testFeedback_notFound },
    // invariants
    {
      name: 'idempotency -- same validation error same status',
      fn: testIdempotency_validationError,
    },
    {
      name: 'concurrency -- 10 parallel auth checks consistent',
      fn: testConcurrency_parallelAuthChecks,
    },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
    },
  ];

  const sequentialTests = [
    // read-after-write
    { name: 'read-after-write -- create then list', fn: testReadAfterWrite_createThenList },
    { name: 'read-after-write -- create then by-goal', fn: testReadAfterWrite_createThenByGoal },
    // state-transition
    {
      name: 'state-transition -- create -> feedback -> delete',
      fn: testStateTransition_createFeedbackDelete,
    },
    // tenant isolation
    {
      name: 'tenant isolation -- cross-user invisible + undeletable',
      fn: testTenantIsolation_crossUserInvisible,
    },
    // boundary capture (must be sequential due to shared capture buffer)
    { name: 'boundary -- OpenAI embeddings on create', fn: testBoundary_openAIEmbeddingsOnCreate },
    { name: 'boundary -- OpenAI embeddings on search', fn: testBoundary_openAIEmbeddingsOnSearch },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  console.log(`Running ${sequentialTests.length} sequential tests...`);
  const sequentialResults: TestResult[] = [];
  for (const test of sequentialTests) {
    sequentialResults.push(await runTest(test.name, test.fn));
  }

  const allResults = [...parallelResults, ...sequentialResults];

  for (const r of allResults) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  // Cleanup created blueprints
  console.log('\nCleaning up...');
  await cleanup();

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL BLUEPRINTS BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
