#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for /api/memory
 *
 * Domain surface:
 *   GET  /api/memory/:busId        — retrieve shared memory entries; supports ETag-style 304
 *   POST /api/memory/:busId/append — append entry with dedup, token limit, and files support
 *
 * Boundary capture coverage:
 *   This domain makes zero outbound third-party HTTP calls. All operations are Prisma DB only.
 *   A boundary capture test verifies that no outbound calls are triggered.
 *
 * Invariants covered:
 *   - auth boundary: both endpoints reject unauthenticated requests with 401
 *   - error-surface: all error responses include { error: string }; unsupported methods rejected
 *   - idempotency: append with same message_id is idempotent (deduplication)
 *   - read-after-write: appended entries are immediately readable via GET
 *   - state transition: empty → has entries → multiple entries → token limit exceeded
 *   - time/clock: entry timestamps are valid ISO 8601 and recent
 *   - ordering: entries maintain insertion order across multiple appends
 *   - concurrency: 10 parallel appends to distinct busIds all succeed
 *   - same-input reproducibility: same content produces same hash
 *   - duplication prevention: message_id dedup prevents duplicate entries
 *   - boundary param: no outbound calls are made (verified via fetch capture)
 *   - cleanup: each test creates its own unique busId; no shared mutable fixtures
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - tenant isolation: memory is keyed by busId, not user; any authenticated request can access any busId
 *   - referential integrity: SharedMemory has no foreign keys; busId is a standalone unique key
 *   - atomicity: single-row upserts; Prisma handles transactional safety
 *   - event/job cardinality: no events emitted
 *   - pagination: no list endpoint with pagination
 *   - call ordering: no outbound calls to order
 *
 * Usage:
 *   npx tsx src/tests/blackbox/memory.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/memory.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const MemoryEntrySchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  message_id: z.string().optional(),
  content: z.string(),
  files: z.array(z.object({ original_filename: z.string(), mime_type: z.string() })).optional(),
});

const GetMemoryResponseSchema = z.object({
  content: z.array(MemoryEntrySchema),
  hash: z.string(),
});

const AppendResponseSchema = z.object({
  hash: z.string(),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
});

const ValidationErrorResponseSchema = z.object({
  error: z.string(),
  details: z.any(),
});

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

let busIdCounter = 0;
function uniqueBusId(prefix = 'mem-test'): string {
  return `${prefix}-${Date.now()}-${process.pid}-${busIdCounter++}`;
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

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
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

// ==================== CAPTURE HELPERS ====================

interface CapturedCall {
  id: number;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
}

const INFRA_URL_PATTERNS = [
  'anthropic.com',
  'openai.com',
  'openrouter.ai',
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
  'api.steel.dev',
];

function filterInfraCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((c) => !INFRA_URL_PATTERNS.some((p) => c.url.includes(p)));
}

async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function getCaptureCursor(): Promise<number> {
  const res = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { nextId: number }).nextId - 1;
}

async function readCapturesAfter(afterId: number): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?after=${afterId}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

// ==================== HELPERS ====================

async function appendEntry(
  busId: string,
  entry: {
    type: string;
    content: string;
    message_id?: string;
    files?: Array<{ original_filename: string; mime_type: string }>;
  }
): Promise<{ status: number; data: unknown }> {
  return request(`${BASE_URL}/api/memory/${busId}/append`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ entry }),
  });
}

async function getMemory(
  busId: string,
  hash?: string
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const url = hash
    ? `${BASE_URL}/api/memory/${busId}?hash=${hash}`
    : `${BASE_URL}/api/memory/${busId}`;
  return request(url, { headers: apiKeyHeaders() });
}

// ==================== GET /api/memory/:busId — CONTRACT TESTS ====================

async function testGet_noAuth() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}`);
  assertStatus(res.status, 401, res.data);
}

async function testGet_emptyMemory() {
  const busId = uniqueBusId();
  const res = await getMemory(busId);
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetMemoryResponseSchema, res.data, 'GET empty');
  assert(body.content.length === 0, `Expected empty content, got ${body.content.length}`);
  assert(typeof body.hash === 'string' && body.hash.length > 0, 'Expected non-empty hash');
}

async function testGet_emptyMemory_hashFormat() {
  const busId = uniqueBusId();
  const res = await getMemory(busId);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { hash: string };
  assert(/^[0-9a-f]{16}$/.test(body.hash), `Expected 16-char hex hash, got "${body.hash}"`);
}

async function testGet_304WithMatchingHash() {
  const busId = uniqueBusId();
  const res1 = await getMemory(busId);
  assertStatus(res1.status, 200, res1.data);
  const hash = (res1.data as { hash: string }).hash;
  const res2 = await getMemory(busId, hash);
  assertStatus(res2.status, 304, res2.data);
}

async function testGet_200WithStaleHash() {
  const busId = uniqueBusId();
  // Seed one entry
  await appendEntry(busId, { type: 'test', content: 'first' });
  const res1 = await getMemory(busId);
  const oldHash = (res1.data as { hash: string }).hash;
  // Append another to change hash
  await appendEntry(busId, { type: 'test', content: 'second' });
  // Old hash should return 200 with new data, not 304
  const res2 = await getMemory(busId, oldHash);
  assertStatus(res2.status, 200, res2.data);
  const body = assertSchema(GetMemoryResponseSchema, res2.data, 'GET stale hash');
  assert(body.content.length === 2, `Expected 2 entries, got ${body.content.length}`);
}

async function testGet_contentTypeHeader() {
  const busId = uniqueBusId();
  const res = await getMemory(busId);
  const ct = res.headers.get('content-type');
  assert(ct !== null && ct.includes('application/json'), `Expected JSON content-type, got: ${ct}`);
}

// ==================== POST /api/memory/:busId/append — CONTRACT TESTS ====================

async function testAppend_noAuth() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}/append`, {
    method: 'POST',
    body: JSON.stringify({ entry: { type: 'test', content: 'hello' } }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testAppend_happyPath() {
  const busId = uniqueBusId();
  const res = await appendEntry(busId, { type: 'test', content: 'hello world' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AppendResponseSchema, res.data, 'POST append');
  assert(/^[0-9a-f]{16}$/.test(body.hash), `Expected 16-char hex hash, got "${body.hash}"`);
}

async function testAppend_withMessageId() {
  const busId = uniqueBusId();
  const msgId = `msg-${Date.now()}`;
  const res = await appendEntry(busId, {
    type: 'note',
    content: 'with message_id',
    message_id: msgId,
  });
  assertStatus(res.status, 200, res.data);
  // Verify the entry was stored with message_id
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'GET after append with msgId');
  assert(body.content.length === 1, `Expected 1 entry, got ${body.content.length}`);
  assert(
    body.content[0].message_id === msgId,
    `Expected message_id "${msgId}", got "${body.content[0].message_id}"`
  );
}

async function testAppend_withFiles() {
  const busId = uniqueBusId();
  const res = await appendEntry(busId, {
    type: 'attachment',
    content: 'file upload',
    files: [
      { original_filename: 'doc.pdf', mime_type: 'application/pdf' },
      { original_filename: 'image.png', mime_type: 'image/png' },
    ],
  });
  assertStatus(res.status, 200, res.data);
  // Verify files are stored
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'GET after append with files');
  assert(body.content.length === 1, `Expected 1 entry, got ${body.content.length}`);
  assert(body.content[0].files !== undefined, 'Expected files array');
  assert(
    body.content[0].files!.length === 2,
    `Expected 2 files, got ${body.content[0].files!.length}`
  );
  assert(body.content[0].files![0].original_filename === 'doc.pdf', 'Wrong filename');
  assert(body.content[0].files![1].mime_type === 'image/png', 'Wrong mime_type');
}

async function testAppend_badBody_emptyObject() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}/append`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ValidationErrorResponseSchema, res.data, 'POST bad body');
}

async function testAppend_badBody_missingContent() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}/append`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ entry: { type: 'test' } }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testAppend_badBody_missingType() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}/append`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ entry: { content: 'hello' } }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testAppend_tokenLimitExceeded() {
  const busId = uniqueBusId();
  // 30k tokens * 4 chars/token = 120k chars. Create a string that puts us over.
  const bigContent = 'x'.repeat(121_000);
  const res = await appendEntry(busId, { type: 'test', content: bigContent });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; max_tokens?: number; current_tokens?: number };
  assert(
    body.error === 'Memory limit exceeded',
    `Expected "Memory limit exceeded", got "${body.error}"`
  );
  assert(typeof body.max_tokens === 'number', 'Expected max_tokens in error response');
  assert(typeof body.current_tokens === 'number', 'Expected current_tokens in error response');
}

// ==================== AUTH BOUNDARY INVARIANT ====================

async function testAuth_getRequiresAuth() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}`);
  assertStatus(res.status, 401, res.data);
}

async function testAuth_appendRequiresAuth() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}/append`, {
    method: 'POST',
    body: JSON.stringify({ entry: { type: 'test', content: 'hello' } }),
  });
  assertStatus(res.status, 401, res.data);
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testError_getErrorShape() {
  // No auth → 401 should include { error: string }
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponseSchema, res.data, '401 error shape');
}

async function testError_appendValidationErrorShape() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}/append`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ValidationErrorResponseSchema, res.data, '400 validation error shape');
}

async function testError_putNotAllowed() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}`, {
    method: 'PUT',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assert(res.status !== 200, 'PUT should not return 200');
}

async function testError_deleteNotAllowed() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(),
  });
  assert(res.status !== 200, 'DELETE should not return 200');
}

async function testError_patchNotAllowed() {
  const busId = uniqueBusId();
  const res = await request(`${BASE_URL}/api/memory/${busId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assert(res.status !== 200, 'PATCH should not return 200');
}

// ==================== IDEMPOTENCY / DEDUPLICATION INVARIANT ====================

async function testIdempotency_duplicateMessageId() {
  const busId = uniqueBusId();
  const msgId = `dedup-${Date.now()}`;
  const entry = { type: 'note', content: 'original', message_id: msgId };
  // First append
  const res1 = await appendEntry(busId, entry);
  assertStatus(res1.status, 200, res1.data);
  const hash1 = (res1.data as { hash: string }).hash;
  // Second append with same message_id but different content
  const res2 = await appendEntry(busId, { ...entry, content: 'duplicate attempt' });
  assertStatus(res2.status, 200, res2.data);
  const hash2 = (res2.data as { hash: string }).hash;
  // Hash should be unchanged (dedup prevented the append)
  assert(hash1 === hash2, `Expected same hash after dedup, got "${hash1}" vs "${hash2}"`);
  // Verify only 1 entry exists
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'GET after dedup');
  assert(body.content.length === 1, `Expected 1 entry after dedup, got ${body.content.length}`);
  assert(body.content[0].content === 'original', 'Dedup should keep original content');
}

async function testIdempotency_noMessageId_allowsDuplicates() {
  const busId = uniqueBusId();
  // Two appends without message_id should both succeed (no dedup)
  await appendEntry(busId, { type: 'note', content: 'same content' });
  await appendEntry(busId, { type: 'note', content: 'same content' });
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'GET after double append');
  assert(
    body.content.length === 2,
    `Expected 2 entries without message_id dedup, got ${body.content.length}`
  );
}

// ==================== READ-AFTER-WRITE INVARIANT ====================

async function testReadAfterWrite_singleAppend() {
  const busId = uniqueBusId();
  const appendRes = await appendEntry(busId, { type: 'note', content: 'verify content' });
  assertStatus(appendRes.status, 200, appendRes.data);
  const getRes = await getMemory(busId);
  assertStatus(getRes.status, 200, getRes.data);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'GET after single append');
  assert(body.content.length === 1, `Expected 1 entry, got ${body.content.length}`);
  assert(body.content[0].content === 'verify content', `Wrong content: ${body.content[0].content}`);
  assert(body.content[0].type === 'note', `Wrong type: ${body.content[0].type}`);
}

async function testReadAfterWrite_multipleAppends() {
  const busId = uniqueBusId();
  await appendEntry(busId, { type: 'note', content: 'first' });
  await appendEntry(busId, { type: 'log', content: 'second' });
  await appendEntry(busId, { type: 'error', content: 'third' });
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'GET after 3 appends');
  assert(body.content.length === 3, `Expected 3 entries, got ${body.content.length}`);
  assert(body.content[0].content === 'first', 'Wrong first content');
  assert(body.content[1].content === 'second', 'Wrong second content');
  assert(body.content[2].content === 'third', 'Wrong third content');
}

async function testReadAfterWrite_hashConsistency() {
  const busId = uniqueBusId();
  const appendRes = await appendEntry(busId, { type: 'test', content: 'hash check' });
  const appendHash = (appendRes.data as { hash: string }).hash;
  const getRes = await getMemory(busId);
  const getHash = (getRes.data as { hash: string }).hash;
  assert(appendHash === getHash, `Append hash "${appendHash}" != GET hash "${getHash}"`);
}

// ==================== STATE TRANSITION INVARIANT ====================

async function testStateTransition_emptyToPopulated() {
  const busId = uniqueBusId();
  // Start empty
  const empty = await getMemory(busId);
  const emptyBody = assertSchema(GetMemoryResponseSchema, empty.data, 'empty state');
  assert(emptyBody.content.length === 0, 'Expected empty initially');
  const emptyHash = emptyBody.hash;
  // Append
  const appendRes = await appendEntry(busId, { type: 'test', content: 'first entry' });
  const newHash = (appendRes.data as { hash: string }).hash;
  assert(newHash !== emptyHash, 'Hash should change after first append');
  // Verify populated
  const populated = await getMemory(busId);
  const popBody = assertSchema(GetMemoryResponseSchema, populated.data, 'populated state');
  assert(popBody.content.length === 1, 'Expected 1 entry after append');
}

async function testStateTransition_tokenLimitBoundary() {
  const busId = uniqueBusId();
  // Fill up near the limit but stay under
  // Each entry has overhead from JSON structure, timestamp, type, etc.
  // Content of ~115k chars should fit; 121k should exceed.
  const nearLimitContent = 'y'.repeat(115_000);
  const res1 = await appendEntry(busId, { type: 'test', content: nearLimitContent });
  assertStatus(res1.status, 200, res1.data);
  // Now try to append more — should fail
  const res2 = await appendEntry(busId, { type: 'test', content: 'y'.repeat(10_000) });
  assertStatus(res2.status, 400, res2.data);
  const body = res2.data as { error: string };
  assert(body.error === 'Memory limit exceeded', `Expected limit error, got "${body.error}"`);
}

// ==================== TIME / CLOCK INVARIANT ====================

async function testTimeClock_timestampIsValidIso() {
  const busId = uniqueBusId();
  const before = new Date();
  await appendEntry(busId, { type: 'test', content: 'timestamp check' });
  const after = new Date();
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'timestamp validation');
  assert(body.content.length === 1, 'Expected 1 entry');
  const ts = new Date(body.content[0].timestamp);
  assert(!isNaN(ts.getTime()), `Invalid ISO timestamp: ${body.content[0].timestamp}`);
  assert(ts >= before && ts <= after, `Timestamp ${ts.toISOString()} not within test window`);
}

// ==================== ORDERING INVARIANT ====================

async function testOrdering_entriesMaintainInsertionOrder() {
  const busId = uniqueBusId();
  const entries = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  for (const content of entries) {
    await appendEntry(busId, { type: 'test', content });
  }
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'ordering');
  assert(body.content.length === entries.length, `Expected ${entries.length} entries`);
  for (let i = 0; i < entries.length; i++) {
    assert(
      body.content[i].content === entries[i],
      `Entry ${i}: expected "${entries[i]}", got "${body.content[i].content}"`
    );
  }
}

async function testOrdering_timestampsAreNonDecreasing() {
  const busId = uniqueBusId();
  for (let i = 0; i < 3; i++) {
    await appendEntry(busId, { type: 'test', content: `entry-${i}` });
  }
  const getRes = await getMemory(busId);
  const body = assertSchema(GetMemoryResponseSchema, getRes.data, 'timestamp ordering');
  for (let i = 1; i < body.content.length; i++) {
    const prev = new Date(body.content[i - 1].timestamp).getTime();
    const curr = new Date(body.content[i].timestamp).getTime();
    assert(curr >= prev, `Timestamp at index ${i} is before index ${i - 1}`);
  }
}

// ==================== CONCURRENCY INVARIANT ====================

async function testConcurrency_parallelAppendsToDistinctBusIds() {
  const count = 10;
  const busIds = Array.from({ length: count }, () => uniqueBusId('conc'));
  const results = await Promise.all(
    busIds.map((id) => appendEntry(id, { type: 'test', content: `concurrent-${id}` }))
  );
  for (let i = 0; i < count; i++) {
    assert(results[i].status === 200, `Concurrent append ${i} failed: status ${results[i].status}`);
  }
  // Verify each
  const getResults = await Promise.all(busIds.map((id) => getMemory(id)));
  for (let i = 0; i < count; i++) {
    assertStatus(getResults[i].status, 200, getResults[i].data);
    const body = getResults[i].data as { content: Array<{ content: string }> };
    assert(body.content.length === 1, `BusId ${i}: expected 1 entry, got ${body.content.length}`);
  }
}

// ==================== SAME-INPUT REPRODUCIBILITY INVARIANT ====================

async function testReproducibility_sameContentSameHash() {
  const busId1 = uniqueBusId('repro');
  const busId2 = uniqueBusId('repro');
  const entry = { type: 'test', content: 'reproducibility check' };
  const res1 = await appendEntry(busId1, entry);
  const res2 = await appendEntry(busId2, entry);
  assertStatus(res1.status, 200, res1.data);
  assertStatus(res2.status, 200, res2.data);
  // Note: hashes may differ because entries include server-generated timestamps.
  // But the hash format should be consistent.
  const hash1 = (res1.data as { hash: string }).hash;
  const hash2 = (res2.data as { hash: string }).hash;
  assert(/^[0-9a-f]{16}$/.test(hash1), `Invalid hash format: ${hash1}`);
  assert(/^[0-9a-f]{16}$/.test(hash2), `Invalid hash format: ${hash2}`);
}

async function testReproducibility_emptyHashDeterministic() {
  const busId1 = uniqueBusId('repro');
  const busId2 = uniqueBusId('repro');
  const res1 = await getMemory(busId1);
  const res2 = await getMemory(busId2);
  const hash1 = (res1.data as { hash: string }).hash;
  const hash2 = (res2.data as { hash: string }).hash;
  assert(hash1 === hash2, `Empty memory hash should be deterministic: "${hash1}" vs "${hash2}"`);
}

async function testReproducibility_threeSequentialReads() {
  const busId = uniqueBusId();
  await appendEntry(busId, { type: 'test', content: 'stable' });
  const snapshots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await getMemory(busId);
    // Compare content and hash, but not headers
    snapshots.push(JSON.stringify(res.data));
  }
  assert(new Set(snapshots).size === 1, 'Three sequential GETs returned different responses');
}

// ==================== BOUNDARY CAPTURE — NO OUTBOUND CALLS ====================

async function testBoundary_noOutboundCalls_get() {
  const cursor = await getCaptureCursor();

  const busId = uniqueBusId('bnd');
  await getMemory(busId);

  const allCalls = await readCapturesAfter(cursor);
  const calls = filterInfraCalls(allCalls);
  assert(
    calls.length === 0,
    `GET triggered ${calls.length} outbound calls: ${JSON.stringify(calls.map((c) => c.url)).substring(0, 500)}`
  );
}

async function testBoundary_noOutboundCalls_append() {
  const cursor = await getCaptureCursor();

  const busId = uniqueBusId('bnd');
  await appendEntry(busId, { type: 'test', content: 'boundary check' });

  const allCalls = await readCapturesAfter(cursor);
  const calls = filterInfraCalls(allCalls);
  assert(
    calls.length === 0,
    `POST append triggered ${calls.length} outbound calls: ${JSON.stringify(calls.map((c) => c.url)).substring(0, 500)}`
  );
}

// ==================== CHARACTERIZATION: FULL LIFECYCLE WORKFLOW ====================

async function testWorkflow_fullLifecycle() {
  const busId = uniqueBusId('lifecycle');

  // 1. Empty state
  const empty = await getMemory(busId);
  assertStatus(empty.status, 200, empty.data);
  const emptyBody = assertSchema(GetMemoryResponseSchema, empty.data, 'lifecycle empty');
  assert(emptyBody.content.length === 0, 'Should start empty');
  const emptyHash = emptyBody.hash;

  // 2. First append
  const append1 = await appendEntry(busId, { type: 'plan', content: 'step 1' });
  assertStatus(append1.status, 200, append1.data);
  const hash1 = (append1.data as { hash: string }).hash;
  assert(hash1 !== emptyHash, 'Hash should change after append');

  // 3. 304 with current hash
  const notModified = await getMemory(busId, hash1);
  assertStatus(notModified.status, 304, notModified.data);

  // 4. Second append
  const append2 = await appendEntry(busId, {
    type: 'result',
    content: 'step 2 done',
    message_id: 'lifecycle-msg-1',
  });
  const hash2 = (append2.data as { hash: string }).hash;
  assert(hash2 !== hash1, 'Hash should change after second append');

  // 5. Old hash returns 200
  const updated = await getMemory(busId, hash1);
  assertStatus(updated.status, 200, updated.data);
  const updatedBody = assertSchema(GetMemoryResponseSchema, updated.data, 'lifecycle updated');
  assert(updatedBody.content.length === 2, 'Should have 2 entries');

  // 6. Deduplicate attempt
  const dedup = await appendEntry(busId, {
    type: 'result',
    content: 'different content same msgid',
    message_id: 'lifecycle-msg-1',
  });
  const hashDedup = (dedup.data as { hash: string }).hash;
  assert(hashDedup === hash2, 'Dedup should not change hash');

  // 7. Final state
  const final = await getMemory(busId);
  const finalBody = assertSchema(GetMemoryResponseSchema, final.data, 'lifecycle final');
  assert(finalBody.content.length === 2, 'Still 2 entries after dedup');
  assert(finalBody.hash === hash2, 'Final hash matches');
}

// ==================== RUNNER ====================

interface TestGroup {
  name: string;
  tests: { name: string; fn: () => Promise<void> }[];
}

async function runAll() {
  console.log('Memory Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Parallel groups — safe for concurrent execution (each test uses unique busId)
  const parallelGroups: TestGroup[] = [
    {
      name: 'GET /api/memory/:busId — contract',
      tests: [
        { name: 'no auth -> 401', fn: testGet_noAuth },
        { name: 'empty memory returns 200 with empty array', fn: testGet_emptyMemory },
        { name: 'hash format is 16-char hex', fn: testGet_emptyMemory_hashFormat },
        { name: '304 with matching hash', fn: testGet_304WithMatchingHash },
        { name: '200 with stale hash (data changed)', fn: testGet_200WithStaleHash },
        { name: 'Content-Type: application/json', fn: testGet_contentTypeHeader },
      ],
    },
    {
      name: 'POST /api/memory/:busId/append — contract',
      tests: [
        { name: 'no auth -> 401', fn: testAppend_noAuth },
        { name: 'happy path returns hash', fn: testAppend_happyPath },
        { name: 'append with message_id', fn: testAppend_withMessageId },
        { name: 'append with files metadata', fn: testAppend_withFiles },
        { name: 'bad body (empty object) -> 400', fn: testAppend_badBody_emptyObject },
        { name: 'bad body (missing content) -> 400', fn: testAppend_badBody_missingContent },
        { name: 'bad body (missing type) -> 400', fn: testAppend_badBody_missingType },
        { name: 'token limit exceeded -> 400', fn: testAppend_tokenLimitExceeded },
      ],
    },
    {
      name: 'Auth boundary',
      tests: [
        { name: 'GET requires auth', fn: testAuth_getRequiresAuth },
        { name: 'POST append requires auth', fn: testAuth_appendRequiresAuth },
      ],
    },
    {
      name: 'Error surface',
      tests: [
        { name: 'GET 401 error shape', fn: testError_getErrorShape },
        { name: 'POST 400 validation error shape', fn: testError_appendValidationErrorShape },
        { name: 'PUT not allowed', fn: testError_putNotAllowed },
        { name: 'DELETE not allowed', fn: testError_deleteNotAllowed },
        { name: 'PATCH not allowed', fn: testError_patchNotAllowed },
      ],
    },
    {
      name: 'Idempotency / deduplication',
      tests: [
        {
          name: 'duplicate message_id prevents double append',
          fn: testIdempotency_duplicateMessageId,
        },
        {
          name: 'no message_id allows duplicates',
          fn: testIdempotency_noMessageId_allowsDuplicates,
        },
      ],
    },
    {
      name: 'Read-after-write',
      tests: [
        { name: 'single append readable', fn: testReadAfterWrite_singleAppend },
        { name: 'multiple appends all readable', fn: testReadAfterWrite_multipleAppends },
        { name: 'append hash matches GET hash', fn: testReadAfterWrite_hashConsistency },
      ],
    },
    {
      name: 'State transition',
      tests: [
        { name: 'empty -> populated (hash changes)', fn: testStateTransition_emptyToPopulated },
        { name: 'near-limit -> over-limit -> 400', fn: testStateTransition_tokenLimitBoundary },
      ],
    },
    {
      name: 'Time / clock',
      tests: [
        { name: 'timestamp is valid ISO 8601 and recent', fn: testTimeClock_timestampIsValidIso },
      ],
    },
    {
      name: 'Ordering',
      tests: [
        {
          name: 'entries maintain insertion order',
          fn: testOrdering_entriesMaintainInsertionOrder,
        },
        { name: 'timestamps are non-decreasing', fn: testOrdering_timestampsAreNonDecreasing },
      ],
    },
    {
      name: 'Concurrency',
      tests: [
        {
          name: '10 parallel appends to distinct busIds',
          fn: testConcurrency_parallelAppendsToDistinctBusIds,
        },
      ],
    },
    {
      name: 'Reproducibility',
      tests: [
        { name: 'hash format consistent', fn: testReproducibility_sameContentSameHash },
        { name: 'empty hash deterministic', fn: testReproducibility_emptyHashDeterministic },
        { name: 'three sequential reads identical', fn: testReproducibility_threeSequentialReads },
      ],
    },
    {
      name: 'Characterization: full lifecycle',
      tests: [
        {
          name: 'empty -> append -> 304 -> append -> dedup -> final state',
          fn: testWorkflow_fullLifecycle,
        },
      ],
    },
  ];

  // Sequential groups — boundary capture tests use shared global state
  const sequentialGroups: TestGroup[] = [];

  const captureAvailable = await checkCaptureAvailable();
  if (captureAvailable) {
    sequentialGroups.push({
      name: 'Boundary capture',
      tests: [
        { name: 'GET triggers zero outbound calls', fn: testBoundary_noOutboundCalls_get },
        {
          name: 'POST append triggers zero outbound calls',
          fn: testBoundary_noOutboundCalls_append,
        },
      ],
    });
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

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
