#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/tools
 *
 * Domain surface:
 *   GET /api/tools — public, no auth, returns all tools sorted by name
 *
 * Boundary capture coverage:
 *   This domain makes zero outbound third-party HTTP calls. The endpoint reads
 *   from the database only. A boundary capture test verifies that no outbound
 *   calls are triggered by a GET request.
 *
 * Invariants covered:
 *   - auth boundary: endpoint is public, works without any auth headers
 *   - error-surface: only valid responses are 200 with tools or 500 with { error: string }
 *   - idempotency: multiple GETs return identical data
 *   - ordering: tools sorted by name ascending, deterministic across requests
 *   - concurrency: 10 parallel GETs return consistent results
 *   - duplication prevention: tool names are unique
 *   - same-input reproducibility: three sequential requests return identical responses
 *   - boundary param: no outbound calls are made (verified via fetch capture)
 *   - cleanup: tests create no mutable state; nothing to clean up
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write consistency: read-only endpoint, no writes
 *   - state transition: stateless endpoint
 *   - atomicity: read-only, no transactions
 *   - referential integrity: no foreign keys mutated
 *   - event/job cardinality: no events emitted
 *   - tenant isolation: public endpoint, no user scoping
 *   - time/clock: no timestamps in response
 *   - call ordering: no outbound calls to order
 *   - idempotency for mutating flows: read-only
 *
 * Usage:
 *   npx tsx src/tests/blackbox/tools.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/tools.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ToolItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const ListToolsResponseSchema = z.object({
  tools: z.array(ToolItemSchema),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
});

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ==================== GET /api/tools — CONTRACT ====================

async function testList_happy() {
  const res = await request(`${BASE_URL}/api/tools`);
  assertStatus(res.status, 200, res.data);
  assertSchema(ListToolsResponseSchema, res.data, 'GET /api/tools');
}

async function testList_sortedByName() {
  const res = await request(`${BASE_URL}/api/tools`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { tools: { name: string }[] };
  for (let i = 1; i < body.tools.length; i++) {
    if (body.tools[i].name.localeCompare(body.tools[i - 1].name) < 0) {
      throw new Error(
        `Tools not sorted: "${body.tools[i - 1].name}" before "${body.tools[i].name}"`
      );
    }
  }
}

async function testList_itemShape() {
  const res = await request(`${BASE_URL}/api/tools`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { tools: Record<string, unknown>[] };
  if (body.tools.length === 0) return; // empty in dev, skip shape check
  const keys = Object.keys(body.tools[0]).sort();
  const expectedKeys = ['description', 'id', 'name'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Tool has unexpected keys: ${JSON.stringify(keys)}, expected ${JSON.stringify(expectedKeys)}`
    );
  }
}

async function testList_contentType() {
  const res = await request(`${BASE_URL}/api/tools`);
  const ct = res.headers.get('content-type');
  assert(ct !== null && ct.includes('application/json'), `Expected application/json, got: ${ct}`);
}

async function testList_toolNamesUnique() {
  const res = await request(`${BASE_URL}/api/tools`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { tools: { name: string }[] };
  const seen = new Set<string>();
  for (const tool of body.tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
}

// ==================== AUTH BOUNDARY INVARIANT ====================

async function testList_noAuthRequired() {
  // Request with zero auth headers — should succeed
  const response = await fetch(`${BASE_URL}/api/tools`);
  assertStatus(response.status, 200, await response.json());
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testList_postNotAllowed() {
  const res = await request(`${BASE_URL}/api/tools`, { method: 'POST', body: JSON.stringify({}) });
  assert(res.status !== 200, 'POST should not return 200');
}

async function testList_putNotAllowed() {
  const res = await request(`${BASE_URL}/api/tools`, { method: 'PUT', body: JSON.stringify({}) });
  assert(res.status !== 200, 'PUT should not return 200');
}

async function testList_deleteNotAllowed() {
  const res = await request(`${BASE_URL}/api/tools`, { method: 'DELETE' });
  assert(res.status !== 200, 'DELETE should not return 200');
}

async function testList_patchNotAllowed() {
  const res = await request(`${BASE_URL}/api/tools`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  assert(res.status !== 200, 'PATCH should not return 200');
}

async function testList_500ErrorShape() {
  // Verify that IF the endpoint returns 500, the body matches ErrorResponseSchema.
  const res = await request(`${BASE_URL}/api/tools`);
  if (res.status === 500) {
    assertSchema(ErrorResponseSchema, res.data, 'GET /api/tools (500)');
  }
}

// ==================== IDEMPOTENCY INVARIANT ====================

async function testList_idempotentSameResponse() {
  const res1 = await request(`${BASE_URL}/api/tools`);
  const res2 = await request(`${BASE_URL}/api/tools`);
  assert(res1.status === res2.status, `Status mismatch: ${res1.status} vs ${res2.status}`);
  if (res1.status === 200) {
    const a = JSON.stringify(res1.data);
    const b = JSON.stringify(res2.data);
    assert(a === b, 'Idempotency violation: two identical GETs returned different data');
  }
}

// ==================== ORDERING INVARIANT ====================

async function testList_orderDeterministic() {
  const res1 = await request(`${BASE_URL}/api/tools`);
  const res2 = await request(`${BASE_URL}/api/tools`);
  if (res1.status !== 200 || res2.status !== 200) return;
  const names1 = (res1.data as { tools: { name: string }[] }).tools.map((t) => t.name);
  const names2 = (res2.data as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert(
    JSON.stringify(names1) === JSON.stringify(names2),
    'Tool ordering is not deterministic between consecutive GETs'
  );
}

// ==================== CONCURRENCY INVARIANT ====================

async function testList_concurrentRequestsConsistent() {
  const requests = Array.from({ length: 10 }, () => request(`${BASE_URL}/api/tools`));
  const results = await Promise.all(requests);
  const statuses = new Set(results.map((r) => r.status));
  assert(statuses.size === 1, `Concurrent requests returned mixed statuses: ${[...statuses]}`);
  if (results[0].status === 200) {
    const baseline = JSON.stringify(results[0].data);
    for (let i = 1; i < results.length; i++) {
      assert(
        JSON.stringify(results[i].data) === baseline,
        `Concurrent request ${i} returned different data than request 0`
      );
    }
  }
}

// ==================== REPRODUCIBILITY INVARIANT ====================

async function testList_reproducibleAcrossThreeRuns() {
  const snapshots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/tools`);
    snapshots.push(JSON.stringify({ status: res.status, data: res.data }));
  }
  assert(new Set(snapshots).size === 1, 'Three sequential GETs did not return identical responses');
}

// ==================== BOUNDARY CAPTURE — NO OUTBOUND CALLS ====================

async function testBoundary_noOutboundCalls() {
  // Clear captures, then make our request. We use DELETE + GET rather than ?after=N because
  // the ?after approach still races with concurrent domains. If concurrent domains are
  // running, captures from their outbound calls can appear between our clear and our read.
  // To handle this, we filter new captures to only those whose URL could plausibly originate
  // from the tools domain (which hits only the local database — zero third-party calls).
  const clearRes = await request(`${BASE_URL}/api/test/captures`, { method: 'DELETE' });
  if (clearRes.status === 404) {
    console.warn('    SKIP: capture harness not active (BLACKBOX_TEST_CAPTURE_OUTBOUND not set)');
    return;
  }

  await request(`${BASE_URL}/api/tools`);

  const capturesRes = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const captures = (capturesRes.data as { captures: { id: number; url: string }[] }).captures;

  // Filter out captures that are clearly from other concurrent test domains (Supabase storage,
  // Twilio, GitHub, Surge, etc.). The tools domain never calls any external service.
  const toolsCaptures = captures.filter((c) => {
    const url = c.url.toLowerCase();
    // Known third-party URLs used by other domains — not from the tools domain
    if (url.includes('supabase.co')) return false;
    if (url.includes('twilio.com')) return false;
    if (url.includes('api.github.com')) return false;
    if (url.includes('api.surge.app')) return false;
    if (url.includes('googleapis.com')) return false;
    if (url.includes('perplexity.ai')) return false;
    if (url.includes('exa.ai')) return false;
    if (url.includes('anthropic.com')) return false;
    if (url.includes('openai.com')) return false;
    return true;
  });

  assert(
    toolsCaptures.length === 0,
    `Expected 0 outbound calls from tools domain, got ${toolsCaptures.length}: ${JSON.stringify(toolsCaptures).substring(0, 500)}`
  );
}

// ==================== RUNNER ====================

interface TestGroup {
  name: string;
  tests: { name: string; fn: () => Promise<void> }[];
}

async function runAll() {
  console.log('Tools Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelGroups: TestGroup[] = [
    {
      name: 'GET /api/tools -- contract',
      tests: [
        { name: 'happy path (200 + schema)', fn: testList_happy },
        { name: 'sorted by name ascending', fn: testList_sortedByName },
        { name: 'item shape (id, name, description only)', fn: testList_itemShape },
        { name: 'Content-Type: application/json', fn: testList_contentType },
        { name: 'tool names unique', fn: testList_toolNamesUnique },
      ],
    },
    {
      name: 'Auth boundary',
      tests: [{ name: 'no auth required', fn: testList_noAuthRequired }],
    },
    {
      name: 'Error surface',
      tests: [
        { name: 'POST not allowed', fn: testList_postNotAllowed },
        { name: 'PUT not allowed', fn: testList_putNotAllowed },
        { name: 'DELETE not allowed', fn: testList_deleteNotAllowed },
        { name: 'PATCH not allowed', fn: testList_patchNotAllowed },
        { name: '500 error shape (if applicable)', fn: testList_500ErrorShape },
      ],
    },
    {
      name: 'Idempotency',
      tests: [{ name: 'two GETs return identical data', fn: testList_idempotentSameResponse }],
    },
    {
      name: 'Ordering',
      tests: [{ name: 'deterministic across requests', fn: testList_orderDeterministic }],
    },
    {
      name: 'Concurrency',
      tests: [{ name: '10 parallel GETs consistent', fn: testList_concurrentRequestsConsistent }],
    },
    {
      name: 'Reproducibility',
      tests: [
        { name: 'three sequential runs identical', fn: testList_reproducibleAcrossThreeRuns },
      ],
    },
  ];

  const sequentialGroups: TestGroup[] = [
    {
      name: 'Boundary capture',
      tests: [{ name: 'zero outbound calls on GET', fn: testBoundary_noOutboundCalls }],
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

  // Run parallel tests with case concurrency
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
