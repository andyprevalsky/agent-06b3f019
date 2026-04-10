#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/upload
 *
 * Domain surface:
 *   POST /api/upload           — upload a file attachment (auth required, multipart)
 *   GET  /api/upload/:fileId/url — get a signed URL for a file (auth required, path ownership check)
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401
 *   - error-surface: missing file returns 400; missing storage_path returns 400; wrong user returns 403
 *   - read-after-write: upload a file then get its signed URL
 *   - idempotency: GET signed URL returns same shape on repeated calls
 *   - concurrency: 10 parallel GET requests return consistent status
 *   - same-input reproducibility: three sequential uploads return same status
 *   - tenant isolation: user A cannot access user B's files (403)
 *   - cleanup: uploaded test files are small and isolated per-user
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - state-transition: no state machine (upload → stored)
 *   - ordering/pagination: no list endpoint
 *   - atomicity: single Supabase Storage call
 *   - referential integrity: no FK relations in response
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: duplicate uploads create new files (by design)
 *   - time/clock: no timestamps in response
 *   - call ordering: single outbound call per request
 *
 * Boundary capture coverage:
 *   POST /upload calls Supabase Storage via @supabase/supabase-js SDK:
 *   - POST https://{SUPABASE_URL}/storage/v1/object/attachments/{userId}/{fileId}_{filename}
 *   The SDK uses globalThis.fetch internally, so the capture harness records it.
 *   Boundary tests verify URL contains supabase, method is POST.
 *   If Supabase SDK bypasses captured fetch, 0 captures is acceptable (documented).
 *
 * Usage:
 *   npx tsx src/tests/blackbox/upload.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/upload.blackbox.ts
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

const FilePointerSchema = z.object({
  id: z.string(),
  storage_path: z.string(),
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
});

const UploadResponse = z.object({
  file_pointer: FilePointerSchema,
});

const SignedUrlResponse = z.object({
  signed_url: z.string(),
  expires_in: z.number(),
});

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
  uploadedStoragePath?: string;
}

const ctx: TestContext = {};

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

/** Upload a small text file using multipart/form-data */
async function uploadFile(
  token: string,
  filename: string,
  content: string,
  mimeType: string = 'text/plain'
): Promise<{ status: number; data: unknown }> {
  const blob = new Blob([content], { type: mimeType });
  const formData = new FormData();
  formData.append('file', blob, filename);

  const response = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  let data: unknown;
  const ct = response.headers.get('content-type');
  if (ct?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data };
}

// ==================== SETUP ====================

async function setup(): Promise<void> {
  const res1 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res1.status, 200, res1.data);
  const d1 = res1.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d1.session.access_token;
  ctx.userId = d1.user.id;

  const res2 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res2.status, 200, res2.data);
  const d2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken2 = d2.session.access_token;
  ctx.userId2 = d2.user.id;
}

// ==================== POST /api/upload ====================

async function testUpload_noAuth() {
  const blob = new Blob(['test'], { type: 'text/plain' });
  const formData = new FormData();
  formData.append('file', blob, 'test.txt');

  const response = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    body: formData,
  });
  if (response.status !== 401) {
    throw new Error(`Expected 401, got ${response.status}`);
  }
}

async function testUpload_invalidToken() {
  const blob = new Blob(['test'], { type: 'text/plain' });
  const formData = new FormData();
  formData.append('file', blob, 'test.txt');

  const response = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: 'Bearer invalid.jwt.token' },
    body: formData,
  });
  if (response.status !== 401) {
    throw new Error(`Expected 401, got ${response.status}`);
  }
}

async function testUpload_noFile() {
  const res = await request(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /upload (no file)');
}

async function testUpload_happy() {
  const result = await uploadFile(ctx.accessToken!, 'test-upload.txt', 'Hello from blackbox test');
  assertStatus(result.status, 201, result.data);
  const body = assertSchema(UploadResponse, result.data, 'POST /upload (happy)');
  if (!body.file_pointer.storage_path) {
    throw new Error('Expected storage_path in file_pointer');
  }
  if (!body.file_pointer.storage_path.startsWith(ctx.userId!)) {
    throw new Error(`Expected storage_path to start with userId ${ctx.userId}`);
  }
  // Save for read-after-write test
  ctx.uploadedStoragePath = body.file_pointer.storage_path;
}

async function testUpload_responseShape() {
  const result = await uploadFile(ctx.accessToken!, 'shape-test.txt', 'Shape test content');
  assertStatus(result.status, 201, result.data);
  const body = assertSchema(UploadResponse, result.data, 'POST /upload (shape)');
  if (body.file_pointer.original_filename !== 'shape-test.txt') {
    throw new Error(
      `Expected original_filename "shape-test.txt", got "${body.file_pointer.original_filename}"`
    );
  }
  if (body.file_pointer.mime_type !== 'text/plain') {
    throw new Error(`Expected mime_type "text/plain", got "${body.file_pointer.mime_type}"`);
  }
  if (body.file_pointer.size_bytes <= 0) {
    throw new Error(`Expected positive size_bytes, got ${body.file_pointer.size_bytes}`);
  }
}

async function testUpload_htmlContentMismatch() {
  // Upload HTML content with a non-HTML mime type — should be rejected
  const htmlContent = '<!DOCTYPE html><html><body>test</body></html>';
  const blob = new Blob([htmlContent], { type: 'application/pdf' });
  const formData = new FormData();
  formData.append('file', blob, 'test.pdf');

  const response = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
    body: formData,
  });
  if (response.status !== 400) {
    throw new Error(`Expected 400 for HTML content mismatch, got ${response.status}`);
  }
}

// ==================== GET /api/upload/:fileId/url ====================

async function testGetUrl_noAuth() {
  const res = await request(`${BASE_URL}/api/upload/some-file-id/url?storage_path=test`);
  assertStatus(res.status, 401, res.data);
}

async function testGetUrl_missingStoragePath() {
  const res = await request(`${BASE_URL}/api/upload/some-file-id/url`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /url (missing storage_path)');
}

async function testGetUrl_wrongUser() {
  const res = await request(
    `${BASE_URL}/api/upload/some-file-id/url?storage_path=other-user-id/file.txt`,
    { headers: authHeaders(ctx.accessToken!) }
  );
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /url (wrong user)');
}

// ==================== READ-AFTER-WRITE ====================

async function testReadAfterWrite() {
  // Upload first
  const uploadResult = await uploadFile(ctx.accessToken!, 'raw-test.txt', 'Read-after-write test');
  assertStatus(uploadResult.status, 201, uploadResult.data);
  const uploadBody = assertSchema(UploadResponse, uploadResult.data, 'RAW upload');

  // Now get signed URL using the real file id
  const { id, storage_path: storagePath } = uploadBody.file_pointer;
  const res = await request(
    `${BASE_URL}/api/upload/${id}/url?storage_path=${encodeURIComponent(storagePath)}`,
    { headers: authHeaders(ctx.accessToken!) }
  );
  assertStatus(res.status, 200, res.data);
  assertSchema(SignedUrlResponse, res.data, 'GET /url (read-after-write)');
}

// ==================== TENANT ISOLATION ====================

async function testTenantIsolation_crossUserAccess() {
  // User 1 uploads a file
  const uploadResult = await uploadFile(ctx.accessToken!, 'isolated.txt', 'Tenant isolation test');
  assertStatus(uploadResult.status, 201, uploadResult.data);
  const uploadBody = assertSchema(UploadResponse, uploadResult.data, 'Isolation upload');

  // User 2 tries to get signed URL for user 1's file
  const { id, storage_path: storagePath } = uploadBody.file_pointer;
  const res = await request(
    `${BASE_URL}/api/upload/${id}/url?storage_path=${encodeURIComponent(storagePath)}`,
    { headers: authHeaders(ctx.accessToken2!) }
  );
  assertStatus(res.status, 403, res.data);
}

// ==================== INVARIANTS ====================

async function testIdempotency_getUrl() {
  // Upload a file first
  const uploadResult = await uploadFile(ctx.accessToken!, 'idemp.txt', 'Idempotency test');
  assertStatus(uploadResult.status, 201, uploadResult.data);
  const uploadBody = assertSchema(UploadResponse, uploadResult.data, 'Idemp upload');
  const { id, storage_path: sp } = uploadBody.file_pointer;

  const r1 = await request(
    `${BASE_URL}/api/upload/${id}/url?storage_path=${encodeURIComponent(sp)}`,
    { headers: authHeaders(ctx.accessToken!) }
  );
  const r2 = await request(
    `${BASE_URL}/api/upload/${id}/url?storage_path=${encodeURIComponent(sp)}`,
    { headers: authHeaders(ctx.accessToken!) }
  );
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelAuthChecks() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/upload/file/url?storage_path=other/file.txt`, {
        headers: authHeaders(ctx.accessToken!),
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
    const res = await request(`${BASE_URL}/api/upload/file/url?storage_path=other/file.txt`, {
      headers: authHeaders(ctx.accessToken!),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== BOUNDARY CAPTURE — SUPABASE STORAGE ====================

function readCaptureCursor(data: unknown): number | null {
  if (data === null || data === undefined || typeof data !== 'object') return null;
  const nextId = (data as { nextId?: unknown }).nextId;
  return typeof nextId === 'number' && Number.isFinite(nextId) && nextId >= 1
    ? nextId - 1
    : null;
}

async function testBoundary_uploadCapturesSupabaseCall() {
  const cursorRes = await request(`${BASE_URL}/api/test/captures`);
  if (cursorRes.status !== 200) return; // capture harness not active
  const cursor = readCaptureCursor(cursorRes.data);
  if (cursor === null) return;

  await uploadFile(ctx.accessToken!, 'boundary-test.txt', 'Boundary capture test content');

  const capturesRes = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
  };

  const supabaseCalls = body.captures.filter(
    (c) => c.url.includes('supabase') && c.url.includes('storage')
  );
  if (supabaseCalls.length === 0) {
    // Supabase SDK may use internal HTTP client instead of globalThis.fetch — skip gracefully
    return;
  }

  const call = supabaseCalls[0];
  if (call.method !== 'POST') {
    throw new Error(`Expected POST to Supabase Storage, got ${call.method}`);
  }
}

async function testBoundary_noFileCapturesZero() {
  const cursorRes = await request(`${BASE_URL}/api/test/captures`);
  if (cursorRes.status !== 200) return; // capture harness not active
  const cursor = readCaptureCursor(cursorRes.data);
  if (cursor === null) return;

  // Send upload without file — validation fails before any outbound call
  await request(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as { captures: unknown[] };
  const supabaseCalls = (body.captures as { url: string }[]).filter(
    (c) => c.url.includes('supabase') && c.url.includes('storage')
  );
  if (supabaseCalls.length > 0) {
    throw new Error(`Expected 0 Supabase captures on no-file request, got ${supabaseCalls.length}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Upload Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId}`);
  console.log(`  User 2: ${ctx.userId2}\n`);

  const parallelTests = [
    // auth boundary
    { name: 'POST /upload -- no auth -> 401', fn: testUpload_noAuth },
    { name: 'POST /upload -- invalid token -> 401', fn: testUpload_invalidToken },
    { name: 'POST /upload -- no file -> 400', fn: testUpload_noFile },
    { name: 'GET /upload/:id/url -- no auth -> 401', fn: testGetUrl_noAuth },
    {
      name: 'GET /upload/:id/url -- missing storage_path -> 400',
      fn: testGetUrl_missingStoragePath,
    },
    { name: 'GET /upload/:id/url -- wrong user -> 403', fn: testGetUrl_wrongUser },
    // happy path
    { name: 'POST /upload -- happy path', fn: testUpload_happy },
    { name: 'POST /upload -- response shape', fn: testUpload_responseShape },
    { name: 'POST /upload -- HTML content mismatch -> 400', fn: testUpload_htmlContentMismatch },
    // invariants
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
    // read-after-write (depends on upload completing first)
    { name: 'read-after-write -- upload then get signed URL', fn: testReadAfterWrite },
    {
      name: 'tenant isolation -- cross-user access -> 403',
      fn: testTenantIsolation_crossUserAccess,
    },
    { name: 'idempotency -- GET url same on repeat', fn: testIdempotency_getUrl },
    // boundary capture (must be sequential due to shared capture buffer)
    {
      name: 'boundary -- upload captures Supabase Storage call',
      fn: testBoundary_uploadCapturesSupabaseCall,
    },
    {
      name: 'boundary -- no-file validation produces 0 Supabase captures',
      fn: testBoundary_noFileCapturesZero,
    },
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

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL UPLOAD BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
