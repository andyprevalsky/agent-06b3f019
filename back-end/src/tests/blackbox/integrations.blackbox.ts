#!/usr/bin/env tsx
/* eslint-disable max-lines */
/**
 * Black-box tests for the integrations domain (/api/integrations)
 *
 * Covers:
 *   GET    /api/integrations                           — list integrations + authenticated domains
 *   POST   /api/integrations                           — create/upsert integration
 *   PATCH  /api/integrations/:name                     — update integration
 *   DELETE /api/integrations/:name                     — delete integration
 *   POST   /api/integrations/imessage/upload           — iMessage data import
 *   POST   /api/integrations/whatsapp/upload           — WhatsApp data import
 *   POST   /api/integrations/telegram/connect          — Telegram connection
 *   POST   /api/integrations/telegram/upload           — Telegram data import
 *   POST   /api/integrations/cookies/upload            — encrypted browser cookies
 *   POST   /api/integrations/localStorage/upload       — encrypted localStorage
 *   POST   /api/integrations/indexedDB/upload          — encrypted IndexedDB
 *   POST   /api/integrations/fingerprint/upload        — encrypted browser fingerprint
 *   POST   /api/integrations/permissions/upload        — encrypted browser permissions
 *   POST   /api/integrations/cacheStorage/upload       — encrypted Cache Storage
 *   POST   /api/integrations/passwords/upload          — encrypted browser passwords
 *   POST   /api/integrations/passwords/apple/upload    — Apple passwords CSV
 *   POST   /api/integrations/passwords/request         — request new password integration
 *   POST   /api/integrations/email/:provider/start     — OAuth flow start
 *   GET    /api/integrations/email/:provider/callback  — OAuth callback (public)
 *   GET    /api/integrations/email/messages            — fetch Gmail messages
 *   POST   /api/integrations/email/send                — send email via Gmail
 *   POST   /api/integrations/upload                    — generic file upload
 *   POST   /api/integrations/linkedin/upload           — LinkedIn data import
 *   POST   /api/integrations/contacts/upload           — VCF contacts import
 *   POST   /api/integrations/email/upload              — email archive import
 *   POST   /api/integrations/claude-code/credentials/upload  — Claude Code credentials
 *   GET    /api/integrations/claude-code/credentials/token   — get Claude Code token
 *   POST   /api/integrations/claude-code/token/rate-limited  — mark token rate-limited (internal)
 *   POST   /api/integrations/claude-code/pool-token/rate-limited — mark pool token rate-limited (internal)
 *
 * Boundary capture tests (Phase 3):
 *   - POST /email/:provider/start with valid provider: asserts 0 outbound calls (DB-only)
 *   - POST / (create) with valid data: asserts 0 outbound calls (DB-only)
 *   - Validation failures that short-circuit: asserts 0 outbound calls
 *   - POST /passwords/request: asserts sendSms boundary call (Twilio/Surge)
 *
 * Invariants covered:
 *   - auth boundary: all authenticated endpoints reject 401 without auth
 *   - error-surface: all error responses include { error: string }
 *   - idempotency: create (upsert) is idempotent — same name returns updated integration
 *   - read-after-write: create → list includes the new integration
 *   - state-transition: NOT_CONNECTED → CONNECTED (via create upsert)
 *   - tenant isolation: one user cannot see another user's integrations
 *   - boundary param: exact params sent to third-party APIs are captured
 *   - call ordering: no unexpected outbound calls on DB-only endpoints
 *   - reproducibility: deterministic given the same inputs
 *   - cleanup: each test creates its own anonymous users; no shared mutable fixtures
 *   - not-found: PATCH/DELETE on nonexistent integration returns 404
 *
 * Invariants not applicable:
 *   - concurrency: integration CRUD is per-user upsert; no concurrent mutation risk
 *   - ordering/pagination: list endpoint has no pagination parameters
 *   - atomicity: upsert operations are single Prisma calls
 *   - referential integrity: enforced by Prisma/Postgres, not by the integration layer
 *   - harness independence: no background jobs affect the test (async processing is fire-and-forget)
 *   - observability: covered by the runner's manifest and artifact directory
 *   - time/clock: no timestamp assertions needed beyond date field presence
 *
 * Usage:
 *   npx tsx src/tests/blackbox/integrations.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/integrations.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../../providers/database';
import { withComputePoolLock } from './compute-pool-lock.testkit';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');
const API_KEY = process.env.BACKEND_API_KEY || '';

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({ error: z.string() });

const IntegrationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.enum(['TOOL_SETUP', 'DATA_SOURCE']),
  name: z.string(),
  status: z.enum(['NOT_CONNECTED', 'CONNECTED', 'SYNCING', 'SYNC_FAILED', 'EXPIRED']),
  isActive: z.boolean(),
  config: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ListIntegrationsResponse = z.object({
  integrations: z.array(IntegrationSchema.passthrough()),
  count: z.number(),
  authenticatedDomains: z.array(z.string()),
});

const CreateIntegrationResponse = z.object({
  integration: IntegrationSchema.passthrough(),
});

const PatchIntegrationResponse = z.object({
  integration: IntegrationSchema.passthrough(),
});

const DeleteIntegrationResponse = z.object({
  message: z.string(),
});

const MessagingUploadResponse = z.object({
  message: z.string(),
  integration: z.unknown(),
  jobId: z.string(),
});

const TelegramConnectResponse = z.object({
  message: z.string(),
  integration: z.unknown(),
});

const CookiesUploadResponse = z.object({
  message: z.string(),
  cookieCount: z.number(),
  integration: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
});

const LocalStorageUploadResponse = z.object({
  message: z.string(),
  batchIndex: z.number(),
  totalBatches: z.number(),
  entryCount: z.number(),
  originCount: z.number(),
});

const IndexedDBUploadResponse = z.object({
  message: z.string(),
  batchIndex: z.number(),
  totalBatches: z.number(),
  originCount: z.number(),
});

const FingerprintUploadResponse = z.object({
  message: z.string(),
  integration: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
});

const PermissionsUploadResponse = z.object({
  message: z.string(),
  grantCount: z.number(),
});

const CacheStorageUploadResponse = z.object({
  message: z.string(),
  originCount: z.number(),
});

const PasswordsUploadResponse = z.object({
  message: z.string(),
  passwordCount: z.number(),
});

const ClaudeCodeUploadResponse = z.object({
  message: z.string(),
});

const DocumentsUploadResponse = z.object({
  integration: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
  documents: z.array(z.object({ id: z.string(), externalId: z.string() })),
  documentCount: z.number(),
  snapshotRevision: z
    .object({
      snapshotVersion: z.number(),
      revisionId: z.string(),
    })
    .nullable(),
  syncState: z.object({
    id: z.string(),
    source: z.string(),
    status: z.string(),
    nextSyncAt: z.string().nullable(),
  }),
  dryRun: z.boolean(),
});

// ==================== CAPTURE TYPES ====================

interface CapturedCall {
  id: number;
  timestamp: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
}

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  accessToken1?: string;
  userId1?: string;
  accessToken2?: string;
  userId2?: string;
  captureAvailable: boolean;
}

const ctx: TestContext = { captureAvailable: false };

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

async function authHeadersWithoutExistingClaudePools(
  token: string
): Promise<Record<string, string>> {
  const headers = authHeaders(token);
  const poolIds = await existingPoolIds();
  if (poolIds.length > 0) {
    headers['X-Exclude-Pool-Tokens'] = poolIds.join(',');
  }
  return headers;
}

function apiKeyHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) h['X-User-Id'] = userId;
  return h;
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
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 500)}`
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Infrastructure URLs from concurrent tests (not from the endpoint under test). */
const INFRA_URL_PATTERNS = [
  'api.github.com',
  'openrouter.ai',
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
  'ip-api.com',
  'supabase.co',
  'surge.app',
  'verify.twilio.com',
  'e2b.app',
  'stripe.com',
  'parallel.ai',
  'api.steel.dev',
  'perplexity.ai',
  'exa.ai',
  'vapi.ai',
  'googleapis.com',
];
function filterInfraCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((c) => !INFRA_URL_PATTERNS.some((p) => c.url.includes(p)));
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

// ==================== CRYPTO HELPERS ====================

/** Encrypt a JSON payload with AES-256-CBC, returning hex-encoded data/iv/key. */
function encryptPayload(payload: unknown): { data: string; iv: string; key: string } {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const plaintext = JSON.stringify(payload);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { data: encrypted, iv: iv.toString('hex'), key: aesKey.toString('hex') };
}

// ==================== CAPTURE HELPERS ====================

async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

function captureToken(prefix: string): string {
  return `integrations-${prefix}-${crypto.randomUUID()}`;
}

async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ==================== HELPERS ====================

const AnonymousResponse = z.object({
  success: z.literal(true),
  user: z.object({ id: z.string(), is_anonymous: z.literal(true) }),
  session: z.object({ access_token: z.string() }),
});

const createdAnonUserIds = new Set<string>();

async function createAnonSession(): Promise<{ accessToken: string; userId: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'anonymous setup');
  createdAnonUserIds.add(body.user.id);
  return { accessToken: body.session.access_token, userId: body.user.id };
}

async function teardown(): Promise<void> {
  if (createdAnonUserIds.size === 0) return;
  const userIds = Array.from(createdAnonUserIds);
  await prisma.userSnapshotRevision.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userSnapshot.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userDataDocument.deleteMany({ where: { userId: { in: userIds } } });
  const { count } = await prisma.integration.deleteMany({ where: { userId: { in: userIds } } });
  console.log(`\nTeardown: deleted ${count} Integration rows across ${userIds.length} anon users`);
  createdAnonUserIds.clear();
}

/** Generate a unique integration name for test isolation. */
function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ==================== SETUP ====================

async function setup(): Promise<void> {
  const [s1, s2] = await Promise.all([createAnonSession(), createAnonSession()]);
  ctx.accessToken1 = s1.accessToken;
  ctx.userId1 = s1.userId;
  ctx.accessToken2 = s2.accessToken;
  ctx.userId2 = s2.userId;
  ctx.captureAvailable = await checkCaptureAvailable();
}

// ==================== AUTH BOUNDARY TESTS (401) ====================

async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'list no auth');
}

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    body: JSON.stringify({ name: 'test', type: 'DATA_SOURCE' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testPatch_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/test`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/test`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
}

async function testImessageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

async function testWhatsappUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

async function testTelegramConnect_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/connect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

async function testTelegramUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCookiesUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testLocalStorageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

async function testIndexedDBUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testFingerprintUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testPermissionsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testCacheStorageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

async function testPasswordsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testApplePasswordsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/apple/upload`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

async function testPasswordsRequest_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

async function testEmailStart_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testEmailMessages_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/messages`);
  assertStatus(res.status, 401, res.data);
}

async function testEmailGmailAccountDelete_noAuth() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/accounts/${encodeURIComponent('noauth@gmail.com')}`,
    { method: 'DELETE' }
  );
  assertStatus(res.status, 401, res.data);
}

async function testEmailSend_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

async function testUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testLinkedinUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/linkedin/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testContactsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/contacts/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testEmailUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testClaudeCodeCredentials_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

async function testClaudeCodeToken_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`);
  assertStatus(res.status, 401, res.data);
}

async function testClaudeCodeRateLimited_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

// The shared ANTHROPIC_API_KEY funded default: marking it out-of-credits via
// the rate-limited endpoint (type=anthropic) backs off a shared DB cooldown the
// agents Rose client reads (it has no DB). Mark → cooldown GET reports true.
async function testAnthropicApiKeyCooldown_markThenOnCooldown() {
  const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ type: 'anthropic', source: 'pool', failureReason: 'out_of_credits' }),
  });
  assertStatus(mark.status, 200, mark.data);

  const status = await request(`${BASE_URL}/api/integrations/compute-code/anthropic-key/cooldown`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(status.status, 200, status.data);
  assert(
    (status.data as { onCooldown?: boolean }).onCooldown === true,
    'anthropic key should report on-cooldown after being marked rate-limited'
  );
}

async function testClaudeCodePoolRateLimited_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

// ==================== GET / (LIST INTEGRATIONS) ====================

async function testList_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations');
}

async function testList_emptyForNewUser() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations empty');
  assert(body.count === 0, `Expected 0 integrations for new user, got ${body.count}`);
  assert(
    body.integrations.length === 0,
    `Expected empty integrations array, got ${body.integrations.length}`
  );
}

// ==================== POST / (CREATE INTEGRATION) ====================

async function testCreate_missingName() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ type: 'DATA_SOURCE' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'create missing name');
}

async function testCreate_missingType() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'create missing type');
}

async function testCreate_invalidType() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name: 'test', type: 'INVALID_TYPE' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'create invalid type');
}

async function testCreate_happyPath() {
  const name = uniqueName('test_integration');
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { test: true } }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CreateIntegrationResponse, res.data, 'create happy');
  assert(body.integration.name === name, `Expected name ${name}, got ${body.integration.name}`);
  assert(
    body.integration.type === 'DATA_SOURCE',
    `Expected type DATA_SOURCE, got ${body.integration.type}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

async function testCreate_toolSetupType() {
  const name = uniqueName('tool_integration');
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'TOOL_SETUP' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CreateIntegrationResponse, res.data, 'create TOOL_SETUP');
  assert(
    body.integration.type === 'TOOL_SETUP',
    `Expected type TOOL_SETUP, got ${body.integration.type}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== IDEMPOTENCY (UPSERT) ====================

async function testCreate_upsertIdempotent() {
  const name = uniqueName('upsert_test');

  // First create → status should be NOT_CONNECTED
  const res1 = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { version: 1 } }),
  });
  assertStatus(res1.status, 200, res1.data);
  const body1 = assertSchema(CreateIntegrationResponse, res1.data, 'upsert first');
  assert(
    body1.integration.status === 'NOT_CONNECTED',
    `Expected NOT_CONNECTED, got ${body1.integration.status}`
  );

  // Second create (upsert) → status should still be NOT_CONNECTED (upsert resets status)
  // The key idempotency invariant is that the same integration ID is returned, not that
  // the status changes. POST upsert always writes NOT_CONNECTED.
  const res2 = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { version: 2 } }),
  });
  assertStatus(res2.status, 200, res2.data);
  const body2 = assertSchema(CreateIntegrationResponse, res2.data, 'upsert second');
  assert(
    body2.integration.id === body1.integration.id,
    'Expected same integration ID after upsert'
  );
  assert(
    body2.integration.status === 'NOT_CONNECTED',
    `Expected NOT_CONNECTED after upsert, got ${body2.integration.status}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== READ-AFTER-WRITE ====================

async function testReadAfterWrite_createThenList() {
  const name = uniqueName('raw_test');
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  const listRes = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const body = assertSchema(ListIntegrationsResponse, listRes.data, 'list after create');
  const found = body.integrations.find((i: { name: string }) => i.name === name);
  assert(found !== undefined, `Expected to find integration ${name} in list`);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== PATCH /:name ====================

async function testPatch_happyPath() {
  const name = uniqueName('patch_test');

  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Patch
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED', isActive: true }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(PatchIntegrationResponse, res.data, 'patch happy');
  assert(
    body.integration.status === 'CONNECTED',
    `Expected CONNECTED, got ${body.integration.status}`
  );
  assert(body.integration.isActive === true, 'Expected isActive=true');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

async function testPatch_notFound() {
  const res = await request(`${BASE_URL}/api/integrations/nonexistent_${Date.now()}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'patch not found');
}

// ==================== DELETE /:name ====================

async function testDelete_happyPath() {
  const name = uniqueName('delete_test');

  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Delete
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(DeleteIntegrationResponse, res.data, 'delete happy');
}

async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/integrations/nonexistent_${Date.now()}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'delete not found');
}

async function testDelete_verifyGone() {
  const name = uniqueName('verify_delete');

  // Create
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Delete
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });

  // Verify gone from list
  const listRes = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  const body = assertSchema(ListIntegrationsResponse, listRes.data, 'list after delete');
  const found = body.integrations.find((i: { name: string }) => i.name === name);
  assert(found === undefined, `Integration ${name} should not exist after delete`);
}

// ==================== TENANT ISOLATION ====================

async function testTenantIsolation_separateUsers() {
  const name = uniqueName('isolation_test');

  // User 1 creates integration
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // User 2 should not see it
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'isolation list');
  const found = body.integrations.find((i: { name: string }) => i.name === name);
  assert(found === undefined, `User 2 should not see User 1's integration ${name}`);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

async function testTenantIsolation_patchOtherUserIntegration() {
  const name = uniqueName('cross_patch');

  // User 1 creates integration
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // User 2 tries to patch → 404 (can't find it)
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken2!),
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 404, res.data);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

async function testTenantIsolation_deleteOtherUserIntegration() {
  const name = uniqueName('cross_delete');

  // User 1 creates integration
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // User 2 tries to delete → 404
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 404, res.data);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testErrorSurface_401sHaveErrorField() {
  const endpoints = [
    { url: `${BASE_URL}/api/integrations`, method: 'GET' as const },
    { url: `${BASE_URL}/api/integrations`, method: 'POST' as const },
    { url: `${BASE_URL}/api/integrations/test`, method: 'PATCH' as const },
    { url: `${BASE_URL}/api/integrations/test`, method: 'DELETE' as const },
    { url: `${BASE_URL}/api/integrations/email/messages`, method: 'GET' as const },
    { url: `${BASE_URL}/api/integrations/email/send`, method: 'POST' as const },
    { url: `${BASE_URL}/api/integrations/email/gmail/start`, method: 'POST' as const },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const res = await request(ep.url, { method: ep.method });
      return { ep, res };
    })
  );

  for (const { ep, res } of results) {
    assertStatus(res.status, 401, res.data);
    assertSchema(ErrorResponse, res.data, `error surface ${ep.method} ${ep.url}`);
  }
}

async function testErrorSurface_400sHaveErrorField() {
  const cases = [
    {
      url: `${BASE_URL}/api/integrations`,
      method: 'POST' as const,
      body: JSON.stringify({ name: 'x' }),
    },
    {
      url: `${BASE_URL}/api/integrations`,
      method: 'POST' as const,
      body: JSON.stringify({ type: 'DATA_SOURCE' }),
    },
    {
      url: `${BASE_URL}/api/integrations`,
      method: 'POST' as const,
      body: JSON.stringify({ name: 'x', type: 'BOGUS' }),
    },
  ];

  const results = await Promise.all(
    cases.map(async (c) => {
      const res = await request(c.url, {
        method: c.method,
        body: c.body,
        headers: authHeaders(ctx.accessToken1!),
      });
      return { c, res };
    })
  );

  for (const { res } of results) {
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, 'error surface 400');
  }
}

async function testErrorSurface_404sHaveErrorField() {
  const endpoints = [
    {
      url: `${BASE_URL}/api/integrations/nonexistent_${Date.now()}`,
      method: 'PATCH' as const,
      body: JSON.stringify({}),
    },
    {
      url: `${BASE_URL}/api/integrations/nonexistent_${Date.now()}`,
      method: 'DELETE' as const,
    },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const res = await request(ep.url, {
        method: ep.method,
        body: ep.body,
        headers: authHeaders(ctx.accessToken1!),
      });
      return { ep, res };
    })
  );

  for (const { res } of results) {
    assertStatus(res.status, 404, res.data);
    assertSchema(ErrorResponse, res.data, 'error surface 404');
  }
}

// ==================== MESSAGING UPLOADS ====================

async function testImessageUpload_emptyContacts() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ contacts: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'imessage empty contacts');
}

async function testImessageUpload_missingContacts() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'imessage missing contacts');
}

async function testImessageUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      contacts: [
        {
          name: 'Test Contact',
          phoneNumber: '+10000000001',
          messages: [
            {
              text: 'Hello test',
              date: new Date().toISOString(),
              is_from_me: false,
              handle_id: '+10000000001',
            },
          ],
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MessagingUploadResponse, res.data, 'imessage happy');
}

async function testWhatsappUpload_emptyContacts() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ contacts: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'whatsapp empty contacts');
}

async function testWhatsappUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      contacts: [
        {
          name: 'WhatsApp Contact',
          phoneNumber: '+10000000002',
          messages: [{ text: 'Hey!', timestamp: new Date().toISOString(), fromMe: false }],
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MessagingUploadResponse, res.data, 'whatsapp happy');
}

async function testTelegramConnect_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/connect`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(TelegramConnectResponse, res.data, 'telegram connect');
}

async function testTelegramUpload_emptyContacts() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ contacts: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'telegram empty contacts');
}

async function testTelegramUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      contacts: [
        {
          name: 'Telegram Contact',
          username: 'testuser',
          messages: [{ text: 'Telegram msg', date: new Date().toISOString(), fromMe: false }],
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MessagingUploadResponse, res.data, 'telegram happy');
}

// ==================== ENCRYPTED PAYLOAD UPLOADS ====================

async function testCookiesUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x', iv: 'y' }), // missing key
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cookies missing fields');
}

async function testCookiesUpload_invalidBrowser() {
  const encrypted = encryptPayload([]);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'firefox' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cookies invalid browser');
}

async function testCookiesUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cookies bad encryption');
}

async function testCookiesUpload_happyPath() {
  const cookies = [
    {
      host_key: '.example.com',
      name: 'test_cookie',
      value: 'test_value',
      path: '/',
      expires_utc: '13300000000000000',
      is_secure: true,
      is_httponly: false,
      top_frame_site_key: '',
    },
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(CookiesUploadResponse, res.data, 'cookies happy');
  const body = res.data as { cookieCount: number };
  assert(body.cookieCount === 1, `Expected cookieCount=1, got ${body.cookieCount}`);
}

async function testLocalStorageUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }), // missing iv and key
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'localStorage missing fields');
}

async function testLocalStorageUpload_happyPath() {
  const payload = {
    byOrigin: {
      'https://example.com': [{ key: 'testKey', value: 'testValue' }],
    },
    hashes: { 'https://example.com': 'abc123' },
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 1,
    originCount: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(LocalStorageUploadResponse, res.data, 'localStorage happy');
}

async function testIndexedDBUpload_happyPath() {
  const payload = {
    origins: [
      {
        origin: 'https://example.com',
        databases: [
          {
            name: 'testDB',
            objectStores: [{ name: 'store1', records: [{ key: 'k1', value: 'v1' }] }],
          },
        ],
      },
    ],
    hashes: { 'https://example.com': 'hash123' },
    batchIndex: 0,
    totalBatches: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(IndexedDBUploadResponse, res.data, 'indexedDB happy');
}

async function testFingerprintUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'fingerprint missing fields');
}

async function testFingerprintUpload_invalidPayload() {
  const encrypted = encryptPayload({ foo: 'bar' }); // missing navigator and screen
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'fingerprint invalid');
}

async function testFingerprintUpload_happyPath() {
  const fingerprint = {
    navigator: { userAgent: 'TestAgent/1.0', language: 'en-US', platform: 'MacIntel' },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
  };
  const encrypted = encryptPayload(fingerprint);
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(FingerprintUploadResponse, res.data, 'fingerprint happy');
}

async function testPermissionsUpload_happyPath() {
  const payload = {
    grants: [{ origin: 'https://example.com', permission: 'notifications', setting: 1 }],
    hash: 'perms_hash',
    grantCount: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PermissionsUploadResponse, res.data, 'permissions happy');
}

async function testCacheStorageUpload_happyPath() {
  const payload = {
    origins: [{ origin: 'https://example.com', caches: [{ name: 'v1', size: 100 }] }],
    hashes: { 'https://example.com': 'cs_hash' },
    originCount: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(CacheStorageUploadResponse, res.data, 'cacheStorage happy');
}

async function testPasswordsUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords missing fields');
}

async function testPasswordsUpload_happyPath() {
  const payload = {
    passwords: [
      {
        origin: 'https://example.com',
        username: 'testuser',
        encryptedPassword: 'encrypted_data_here',
        dateLastUsed: Date.now(),
        dateCreated: Date.now(),
        browserSource: 'chrome',
      },
    ],
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PasswordsUploadResponse, res.data, 'passwords happy');
}

async function testPasswordsUpload_appleSourceMarksApplePasswordsIntegration() {
  const { accessToken, userId } = await createAnonSession();
  const payload = {
    passwords: [
      {
        origin: 'https://apple-transfer.example',
        username: 'apple-user',
        encryptedPassword: 'encrypted_apple_password_here',
        dateLastUsed: Date.now(),
        dateCreated: Date.now(),
        browserSource: 'apple_passwords',
      },
    ],
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PasswordsUploadResponse, res.data, 'passwords apple source');

  const appleIntegration = await prisma.integration.findUnique({
    where: { userId_name: { userId, name: 'apple_passwords' } },
  });
  assert(appleIntegration !== null, 'Expected apple_passwords integration to be marked connected');
  assert(
    appleIntegration.status === 'CONNECTED',
    `Expected CONNECTED, got ${appleIntegration.status}`
  );
}

// ==================== ENCRYPTED UPLOAD ERROR-PATH COVERAGE ====================
// These tests cover routes.browser.ts decryption-failure and shape-validation
// branches (lines 81-82, 124-128, 135-138, 155-156, 167-181, 205-209, 240-251,
// 258-261, 278-279, 290-294, 301-304, 328-332, 339-342) plus uploadService.browser.ts
// dedupe + sanitize + missing-timestamp branches (lines 35-41, 90-95, 119-137, 213-219).

/** Helper: generate a payload that is decryptable but yields a non-array (for cookies). */
function encryptNonArray(): { data: string; iv: string; key: string } {
  return encryptPayload({ not: 'an array' });
}

// ---------- /cookies/upload ----------

/** Cookies decoded payload is not an array → 400 (route line 81-82). */
async function testCookiesUpload_decodedNotArray() {
  const encrypted = encryptNonArray();
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'cookies non-array');
  assert(
    body.error.toLowerCase().includes('expected array'),
    `Expected "expected array" error, got: ${body.error}`
  );
}

/**
 * Cookies happy path with > 100 cookies (forces multi-batch path at
 * uploadService.browser.ts:208) AND in-batch duplicates (exercises dedupeBatch
 * lines 89-95 — both newExpiry > existingExpiry and newExpiry <= existingExpiry
 * branches plus the dupCount > 0 logging branch at 212-219). Also intentionally
 * omits timestamp fields on alternating cookies to hit the "undefined" branches
 * (lines 117-119, 123-125, 127-129, 136-138) in buildCookieParams.
 */
async function testCookiesUpload_largeBatchWithDuplicates() {
  const cookies: Record<string, unknown>[] = [];
  // 110 unique cookies → ensures a 2nd batch (BATCH_SIZE=100)
  for (let i = 0; i < 110; i++) {
    cookies.push({
      host_key: `.example${i}.com`,
      name: `cookie_${i}`,
      value: `value_${i}`,
      path: '/',
      // Alternate: even indices omit timestamps (hits undefined branches);
      // odd indices include them (hits the BigInt-conversion branches).
      ...(i % 2 === 0
        ? {}
        : {
            expires_utc: '13300000000000000',
            creation_utc: '13290000000000000',
            last_access_utc: '13290000000000001',
            last_update_utc: '13290000000000001',
          }),
      is_secure: true,
      is_httponly: false,
      top_frame_site_key: '',
    });
  }
  // Add intra-batch duplicates IN THE FIRST BATCH (cookie_5 at idx 5).
  // Insert two duplicates ALSO within first 100 indices so they share a batch.
  // Duplicate of cookie_5 with LATER expiry → triggers "newExpiry > existingExpiry" (line 93-95).
  cookies.splice(50, 0, {
    host_key: '.example5.com',
    name: 'cookie_5',
    value: 'newer_5',
    path: '/',
    expires_utc: '13400000000000000',
    is_secure: true,
    is_httponly: false,
    top_frame_site_key: '',
  });
  // Duplicate of cookie_7 (which has expires_utc) with EARLIER expiry → keeps existing.
  cookies.splice(60, 0, {
    host_key: '.example7.com',
    name: 'cookie_7',
    value: 'older_7',
    path: '/',
    expires_utc: '10000000000000000',
    is_secure: true,
    is_httponly: false,
    top_frame_site_key: '',
  });
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CookiesUploadResponse, res.data, 'cookies large batch');
  // cookieCount is sanitized (post-filter) input length, NOT post-dedupe.
  // We sent 112 valid cookies (110 + 2 duplicates), all pass filter → 112.
  assert(body.cookieCount === 112, `Expected cookieCount=112, got ${body.cookieCount}`);
}

/** Cookies with empty name/value get filtered out (line 171 filter branch). */
async function testCookiesUpload_emptyNameValueFiltered() {
  const cookies = [
    { host_key: '.example.com', name: '', value: 'v', path: '/' }, // dropped
    { host_key: '.example.com', name: 'n', value: '', path: '/' }, // dropped
    {
      host_key: '.example.com',
      name: 'real',
      value: 'real_value',
      path: '/',
      top_frame_site_key: '',
    }, // kept
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'chrome' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { cookieCount: number };
  assert(body.cookieCount === 1, `Expected cookieCount=1 after filter, got ${body.cookieCount}`);
}

/** Cookies happy path on an alternate browser type — exercises non-default branch. */
async function testCookiesUpload_alternateBrowser() {
  const cookies = [
    {
      host_key: '.example.com',
      name: 'edge_cookie',
      value: 'edge_val',
      path: '/',
      top_frame_site_key: '',
    },
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'edge' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(CookiesUploadResponse, res.data, 'cookies edge');
}

/** Safari cookies are a first-class browser credential source. */
async function testCookiesUpload_safariBrowser() {
  const cookies = [
    {
      host_key: '.example.com',
      name: 'safari_cookie',
      value: 'safari_val',
      path: '/',
      top_frame_site_key: '',
    },
  ];
  const encrypted = encryptPayload(cookies);
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ ...encrypted, browser: 'safari' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CookiesUploadResponse, res.data, 'cookies safari');
  assert(
    body.integration.name === 'safari',
    `Expected safari integration, got ${body.integration.name}`
  );
}

// ---------- /localStorage/upload ----------

/** localStorage decryption failure → 400 (route line 124-128). */
async function testLocalStorageUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'localStorage bad encryption');
  assert(
    body.error.toLowerCase().includes('decrypt') ||
      body.error.toLowerCase().includes('localstorage'),
    `Expected decrypt error, got: ${body.error}`
  );
}

/** localStorage decoded byOrigin missing → 400 (route line 135-138). */
async function testLocalStorageUpload_missingByOrigin() {
  const encrypted = encryptPayload({
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 0,
    originCount: 0,
    hashes: {},
    // No byOrigin
  });
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'localStorage missing byOrigin');
  assert(
    body.error.toLowerCase().includes('byorigin'),
    `Expected byOrigin error, got: ${body.error}`
  );
}

/** localStorage byOrigin is null → 400 (covers null branch at routes.browser.ts:132). */
async function testLocalStorageUpload_nullByOrigin() {
  const encrypted = encryptPayload({
    byOrigin: null,
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 0,
    originCount: 0,
    hashes: {},
  });
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** localStorage byOrigin not an object → 400 (line 133 branch). */
async function testLocalStorageUpload_notObjectByOrigin() {
  const encrypted = encryptPayload({
    byOrigin: 'not-an-object',
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 0,
    originCount: 0,
    hashes: {},
  });
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/**
 * localStorage with orphan UTF-16 surrogates → exercises sanitizeStringFull
 * surrogate-handling branches (uploadService.browser.ts lines 35-41).
 */
async function testLocalStorageUpload_orphanSurrogates() {
  // Build a string with: high surrogate followed by another high surrogate (orphan high),
  // a lone low surrogate (no preceding high), and a valid surrogate pair.
  const orphanHigh = '\uD800\uD800X'; // first high without low → drop first
  const orphanLow = '\uDC00Y'; // low without preceding high → drop low
  const validPair = '😀'; // 😀 — valid surrogate pair, kept as 2 chars
  const messyValue = `${orphanHigh}${orphanLow}${validPair}`;
  const payload = {
    byOrigin: {
      'https://surrogate.example': [{ key: 'surrogate_key', value: messyValue }],
    },
    hashes: { 'https://surrogate.example': 'h' },
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 1,
    originCount: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(LocalStorageUploadResponse, res.data, 'localStorage surrogates');
}

/** localStorage compressed=true happy path — exercises gzip decompress branch in service. */
async function testLocalStorageUpload_compressedTrue() {
  const zlib = await import('zlib');
  const { promisify } = await import('util');
  const gzip = promisify(zlib.gzip);
  const payload = {
    byOrigin: {
      'https://compressed.example': [{ key: 'k', value: 'v' }],
    },
    hashes: { 'https://compressed.example': 'h2' },
    batchIndex: 0,
    totalBatches: 1,
    entryCount: 1,
    originCount: 1,
  };
  const compressed = await gzip(Buffer.from(JSON.stringify(payload), 'utf8'));
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const encryptedBuf = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: encryptedBuf.toString('hex'),
      iv: iv.toString('hex'),
      key: aesKey.toString('hex'),
      compressed: 'true',
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(LocalStorageUploadResponse, res.data, 'localStorage compressed');
}

// ---------- /indexedDB/upload ----------

/** indexedDB missing fields → 400 (route line 154-156). */
async function testIndexedDBUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'indexedDB missing fields');
}

/** indexedDB decryption failure → 400 (route line 167-171). */
async function testIndexedDBUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'indexedDB bad encryption');
}

/** indexedDB origins missing → 400 (route line 178-181). */
async function testIndexedDBUpload_missingOrigins() {
  const encrypted = encryptPayload({
    batchIndex: 0,
    totalBatches: 1,
    hashes: {},
    // No origins
  });
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** indexedDB origins not array → 400. */
async function testIndexedDBUpload_originsNotArray() {
  const encrypted = encryptPayload({
    origins: 'not-array',
    batchIndex: 0,
    totalBatches: 1,
    hashes: {},
  });
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** indexedDB with errored origins (filtered out by service.processIndexedDBUpload). */
async function testIndexedDBUpload_erroredOriginsFiltered() {
  const payload = {
    origins: [
      { origin: 'https://errored.example', error: 'failed-to-read', databases: [] },
      { origin: 'https://ok.example', databases: [{ name: 'db', objectStores: [] }] },
    ],
    hashes: { 'https://ok.example': 'h' },
    batchIndex: 0,
    totalBatches: 1,
  };
  const encrypted = encryptPayload(payload);
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { originCount: number };
  // errored origin should be filtered out → only 1 remains
  assert(body.originCount === 1, `Expected originCount=1 after filter, got ${body.originCount}`);
}

// ---------- /fingerprint/upload ----------

/** fingerprint decryption failure → 400 (route line 205-209). */
async function testFingerprintUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'fingerprint bad encryption');
}

// ---------- /permissions/upload ----------

/** permissions missing fields → 400 (route line 240-241). */
async function testPermissionsUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'permissions missing fields');
}

/** permissions decryption failure → 400 (route line 247-251). */
async function testPermissionsUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'permissions bad encryption');
}

/** permissions grants missing → 400 (route line 258-261). */
async function testPermissionsUpload_missingGrants() {
  const encrypted = encryptPayload({ hash: 'x' }); // no grants
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** permissions grants not array → 400. */
async function testPermissionsUpload_grantsNotArray() {
  const encrypted = encryptPayload({ grants: 'not-array' });
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** permissions empty grants array → 200 with grantCount=0 (skips bulk upsert). */
async function testPermissionsUpload_emptyGrants() {
  const encrypted = encryptPayload({ grants: [], hash: 'h' });
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { grantCount: number };
  assert(body.grantCount === 0, `Expected grantCount=0, got ${body.grantCount}`);
}

// ---------- /cacheStorage/upload ----------

/** cacheStorage missing fields → 400 (route line 278-279). */
async function testCacheStorageUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ data: 'x' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cacheStorage missing fields');
}

/** cacheStorage decryption failure → 400 (route line 290-294). */
async function testCacheStorageUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'cacheStorage bad encryption');
}

/** cacheStorage origins missing → 400 (route line 301-304). */
async function testCacheStorageUpload_missingOrigins() {
  const encrypted = encryptPayload({ hashes: {} });
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** cacheStorage origins not array → 400. */
async function testCacheStorageUpload_originsNotArray() {
  const encrypted = encryptPayload({ origins: { not: 'array' }, hashes: {} });
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

// ---------- /passwords/upload ----------

/** passwords decryption failure → 400 (route line 328-332). */
async function testPasswordsUpload_invalidEncryption() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      data: 'deadbeef',
      iv: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(32).toString('hex'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords bad encryption');
}

/** passwords passwords missing → 400 (route line 339-342). */
async function testPasswordsUpload_missingPasswords() {
  const encrypted = encryptPayload({}); // no passwords
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** passwords passwords not array → 400. */
async function testPasswordsUpload_passwordsNotArray() {
  const encrypted = encryptPayload({ passwords: 'not-array' });
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
}

/** passwords empty array → 200 with "No passwords to upload" message branch. */
async function testPasswordsUpload_emptyPasswords() {
  const encrypted = encryptPayload({ passwords: [] });
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 0, `Expected passwordCount=0, got ${body.passwordCount}`);
  assert(
    body.message.toLowerCase().includes('no passwords'),
    `Expected "no passwords" message, got: ${body.message}`
  );
}

// ==================== CLAUDE CODE CREDENTIALS ====================

async function testClaudeCodeUpload_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code missing fields');
}

async function testClaudeCodeUpload_happyPath() {
  // A real envelope that round-trips with the server key — the upload path now
  // rejects anything it cannot decrypt (see testClaudeCodeUpload_rejectsUndecryptable).
  const encryptedCredentials = buildCredentialPayload(
    `sk-ant-oat-happy-${crypto.randomBytes(8).toString('hex')}`
  );
  const encrypted = encryptPayload({ encryptedCredentials });
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ClaudeCodeUploadResponse, res.data, 'claude-code happy');
}

// Regression (RCA 2026-07-17): the upload path stored client ciphertext WITHOUT
// verifying it decrypts, so a mismatched-keypair client silently inserted garbage
// that later flooded oaep/parse errors and degraded chat to the paid waterfall.
// An undecryptable envelope must be rejected at the write boundary (400), never stored.
async function testClaudeCodeUpload_rejectsUndecryptable() {
  const { accessToken } = await createAnonSession();
  const encrypted = encryptPayload({ encryptedCredentials: 'not-a-valid-envelope-' + Date.now() });
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code rejects undecryptable envelope');
}

async function testClaudeCodeToken_notFound() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: await authHeadersWithoutExistingClaudePools(accessToken),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code token not found');
}

async function testClaudeCodeRateLimited_forbidden() {
  // Non-internal JWT auth → 403
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ source: 'pool', poolTokenId: 'test' }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'rate-limited forbidden');
}

async function testClaudeCodePoolRateLimited_forbidden() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ poolTokenId: 'test' }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'pool-rate-limited forbidden');
}

// ==================== EMAIL ENDPOINTS ====================

async function testEmailStart_invalidProvider() {
  const res = await request(`${BASE_URL}/api/integrations/email/invalid_provider/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email start invalid provider');
}

async function testEmailMessages_missingSince() {
  const res = await request(`${BASE_URL}/api/integrations/email/messages`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages missing since');
}

async function testEmailMessages_invalidSince() {
  const res = await request(`${BASE_URL}/api/integrations/email/messages?since=not-a-date`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages invalid since');
}

async function testEmailMessages_gmailNotConnected() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}`,
    { headers: authHeaders(accessToken) }
  );
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages not connected');
}

async function testEmailGmailAccountDelete_removesOneCredential() {
  const { accessToken, userId } = await createAnonSession();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      config: {
        provider: 'gmail',
        connectedEmail: 'primary@gmail.com',
        connectedEmails: ['primary@gmail.com', 'secondary@gmail.com'],
      },
    },
  });
  await prisma.emailIntegrationCredential.createMany({
    data: [
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'primary@gmail.com',
        accessToken: 'access-primary',
        refreshToken: 'refresh-primary',
      },
      {
        userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'secondary@gmail.com',
        accessToken: 'access-secondary',
        refreshToken: 'refresh-secondary',
      },
    ],
  });

  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/accounts/${encodeURIComponent('primary@gmail.com')}`,
    { method: 'DELETE', headers: authHeaders(accessToken) }
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { disconnectedEmail?: string; connectedEmails?: string[] };
  assert(body.disconnectedEmail === 'primary@gmail.com', 'deleted email should be echoed');
  assert(
    Array.isArray(body.connectedEmails) &&
      body.connectedEmails.length === 1 &&
      body.connectedEmails[0] === 'secondary@gmail.com',
    'remaining email should be returned'
  );

  const deleted = await prisma.emailIntegrationCredential.findFirst({
    where: { userId, email: 'primary@gmail.com' },
  });
  assert(deleted === null, 'deleted Gmail credential should be removed');

  const updated = await prisma.integration.findUnique({ where: { id: integration.id } });
  const config = updated?.config as { connectedEmail?: unknown; connectedEmails?: unknown };
  assert(updated?.status === 'CONNECTED', 'integration should stay connected');
  assert(updated?.isActive === true, 'integration should stay active');
  assert(
    config.connectedEmail === 'secondary@gmail.com',
    'primary config should move to remaining email'
  );
  assert(
    Array.isArray(config.connectedEmails) &&
      config.connectedEmails.length === 1 &&
      config.connectedEmails[0] === 'secondary@gmail.com',
    'connectedEmails config should be recomputed'
  );
}

async function testPasswordsRequest_missingRequest() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords request missing');
}

async function testPasswordsRequest_emptyRequest() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'passwords request empty');
}

// ==================== ADDITIONAL COVERAGE TESTS ====================

// --- OAuth start: happy path (exercises PKCE, credential creation, auth URL building) ---

async function testEmailStart_gmailHappyPath() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  // Will return 200 with authUrl if Gmail OAuth is configured, or 500 if not configured
  // Either way, it exercises the route handler and validation
  if (res.status === 200) {
    const body = res.data as { authUrl: string; state: string; expiresAt: string };
    if (!body.authUrl || typeof body.authUrl !== 'string') {
      throw new Error('Expected authUrl string in response');
    }
    if (!body.authUrl.includes('accounts.google.com')) {
      throw new Error(`Expected Google OAuth URL, got: ${body.authUrl}`);
    }
    if (!body.state || typeof body.state !== 'string') {
      throw new Error('Expected state string in response');
    }
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

async function testEmailStart_yahooHappyPath() {
  const res = await request(`${BASE_URL}/api/integrations/email/yahoo/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for Yahoo start, got ${res.status}`);
  }
}

// --- OAuth callback: state not found in DB ---

async function testOAuthCallback_stateNotFound() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/callback?code=test_code&state=nonexistent_state_token`,
    { method: 'GET' }
  );
  // Should return HTML error or redirect (callback is public, returns HTML)
  if (res.status !== 200 && res.status !== 302 && res.status !== 400) {
    throw new Error(`Expected 200/302/400 for state-not-found callback, got ${res.status}`);
  }
}

// --- Email send: validation ---

async function testEmailSend_missingTo() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ subject: 'test', body: 'test', from_email: 'a@b.com' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testEmailSend_missingSubject() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ to: 'test@test.com', body: 'test', from_email: 'a@b.com' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testEmailSend_missingBody() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ to: 'test@test.com', subject: 'test', from_email: 'a@b.com' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testEmailSend_missingFromEmail() {
  // When no from_email, should list available accounts or report not connected
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ to: 'test@test.com', subject: 'test', body: 'test' }),
  });
  // Either 400 (missing from_email) or 404 (no gmail connected) — both exercise the code
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400 or 404 for missing from_email, got ${res.status}`);
  }
}

async function testEmailSend_accountNotFound() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      to: 'test@test.com',
      subject: 'test',
      body: 'test',
      from_email: 'nonexistent@example.com',
    }),
  });
  // Should return error about account not found
  if (res.status !== 404 && res.status !== 400) {
    throw new Error(`Expected 404 or 400 for nonexistent from_email, got ${res.status}`);
  }
}

// --- Email messages: valid since, limit param ---

async function testEmailMessages_validSinceEmptyAccount() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}&limit=10`,
    { headers: authHeaders(ctx.accessToken1!) }
  );
  // No Gmail connected → 404
  if (res.status !== 404) {
    // If somehow connected, should be 200
    assertStatus(res.status, 200, res.data);
  }
}

// --- Apple passwords upload: empty body ---

async function testApplePasswordsUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/apple/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Generic file upload: validation ---

async function testGenericUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- LinkedIn upload: validation ---

async function testLinkedinUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/linkedin/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Contacts upload: validation ---

async function testContactsUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/contacts/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Email archive upload: validation ---

async function testEmailArchiveUpload_noFile() {
  const res = await request(`${BASE_URL}/api/integrations/email/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
}

// ==================== FILE UPLOAD HAPPY PATH TESTS ====================

/** Helper: upload a file via multipart/form-data to an integrations endpoint */
async function uploadFileToIntegrations(
  endpoint: string,
  token: string,
  filename: string,
  content: string,
  mimeType: string = 'text/plain',
  extraFields?: Record<string, string>
): Promise<{ status: number; data: unknown }> {
  const blob = new Blob([content], { type: mimeType });
  const formData = new FormData();
  formData.append('file', blob, filename);
  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      formData.append(key, value);
    }
  }
  const response = await fetch(`${BASE_URL}/api/integrations${endpoint}`, {
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

// --- Apple passwords CSV upload: exercises parseApplePasswordsCsv, encryptPasswordForStorage, bulk upsert ---

async function testApplePasswordsUpload_validCsv() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    'Example,https://example.com,user1,pass123,some notes,',
    'Google,https://accounts.google.com,user2,securepass,,',
    'GitHub,https://github.com,user3,gh_token,dev account,',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 3, `Expected 3 passwords, got ${body.passwordCount}`);

  const appleIntegration = await prisma.integration.findUnique({
    where: { userId_name: { userId: ctx.userId1!, name: 'apple_passwords' } },
  });
  assert(appleIntegration !== null, 'Expected apple_passwords integration to be created');
  assert(
    appleIntegration.status === 'CONNECTED',
    `Expected CONNECTED, got ${appleIntegration.status}`
  );
  assert(appleIntegration.isActive === true, 'Expected apple_passwords integration to be active');
  assert(appleIntegration.lastSyncAt !== null, 'Expected lastSyncAt to be set');
  assert(appleIntegration.lastSuccessfulSyncAt !== null, 'Expected lastSuccessfulSyncAt to be set');
}

async function testApplePasswordsUpload_tabDelimited() {
  const csvContent = [
    'Title\tURL\tUsername\tPassword\tNotes\tOTPAuth',
    'Tab Test\thttps://tab.example.com\ttabuser\ttabpass\t\t',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 1, `Expected 1 password, got ${body.passwordCount}`);
}

async function testApplePasswordsUpload_noValidPasswords() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    ',,,,,', // all empty
    ',,,,,',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 400, res.data);
}

async function testApplePasswordsUpload_headerOnly() {
  const csvContent = 'Title,URL,Username,Password,Notes,OTPAuth';
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 400, res.data);
}

async function testApplePasswordsUpload_missingColumns() {
  const csvContent = ['Name,Email', 'test,test@test.com'].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 400, res.data);
}

async function testApplePasswordsUpload_quotedFields() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    '"My ""App""","https://app.example.com","user,name","pass""word","note with, comma",',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 1, `Expected 1 password, got ${body.passwordCount}`);
}

async function testApplePasswordsUpload_duplicateOriginUsername() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    'Dup1,https://dup.example.com,sameuser,pass1,,',
    'Dup2,https://dup.example.com,sameuser,pass2,,',
    'Other,https://other.example.com,otheruser,pass3,,',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  // 2 unique origin+username combinations after dedup
  assert(body.passwordCount === 2, `Expected 2 passwords after dedup, got ${body.passwordCount}`);
}

// --- Generic file upload: exercises processGenericUpload ---

async function testGenericUpload_withFile() {
  const res = await uploadFileToIntegrations(
    '/upload',
    ctx.accessToken1!,
    'test-data.txt',
    'some test content for generic upload',
    'text/plain',
    { integrationType: 'test_data' }
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; integration: unknown };
  assert(
    body.message.includes('uploaded'),
    `Expected upload success message, got: ${body.message}`
  );
}

async function testGenericUpload_missingIntegrationType() {
  const res = await uploadFileToIntegrations(
    '/upload',
    ctx.accessToken1!,
    'test-data.txt',
    'some test content',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
}

// --- LinkedIn upload: non-zip file validation ---

async function testLinkedinUpload_nonZipFile() {
  const res = await uploadFileToIntegrations(
    '/linkedin/upload',
    ctx.accessToken1!,
    'data.txt',
    'not a zip file',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('.zip'), `Expected zip error message, got: ${body.error}`);
}

// --- Contacts upload: non-vcf file validation ---

async function testContactsUpload_nonVcfFile() {
  const res = await uploadFileToIntegrations(
    '/contacts/upload',
    ctx.accessToken1!,
    'contacts.txt',
    'not a vcf file',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('.vcf'), `Expected vcf error message, got: ${body.error}`);
}

// --- Email archive upload: non-zip file validation ---

async function testEmailArchiveUpload_nonZipFile() {
  const res = await uploadFileToIntegrations(
    '/email/upload',
    ctx.accessToken1!,
    'emails.txt',
    'not a zip file',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('.zip'), `Expected zip error message, got: ${body.error}`);
}

// --- Passwords request happy path (exercises sendPasswordRequest -> sendSms) ---

async function testPasswordsRequest_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: 'I need password integration for 1Password please' }),
  });
  // 200 if SMS sent successfully, 500 if SMS config not available in test env
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

// --- Integration CRUD edge cases ---

async function testPatch_withStatusChange() {
  const name = uniqueName('patch-status');
  // Create integration first
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  // Patch with specific status
  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'SYNCING' }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = (patchRes.data as { integration: { status: string } }).integration;
  assert(patched.status === 'SYNCING', `Expected SYNCING, got ${patched.status}`);
}

async function testPatch_withInvalidStatus() {
  const name = uniqueName('patch-badstatus');
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'INVALID_STATUS' }),
  });
  // Should return error for invalid status
  if (patchRes.status !== 400 && patchRes.status !== 500) {
    throw new Error(`Expected 400 or 500 for invalid status, got ${patchRes.status}`);
  }
}

async function testPatch_withConfigUpdate() {
  const name = uniqueName('patch-config');
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ config: { customKey: 'customValue', nested: { a: 1 } } }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
}

// ==================== STATE TRANSITION TEST ====================

async function testStateTransition_fullLifecycle() {
  const name = uniqueName('lifecycle');

  // 1. Create (NOT_CONNECTED)
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = (createRes.data as { integration: { status: string } }).integration;
  assert(created.status === 'NOT_CONNECTED', `Expected NOT_CONNECTED, got ${created.status}`);

  // 2. Patch to CONNECTED
  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED', isActive: true }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = (patchRes.data as { integration: { status: string; isActive: boolean } })
    .integration;
  assert(patched.status === 'CONNECTED', `Expected CONNECTED, got ${patched.status}`);
  assert(patched.isActive === true, 'Expected isActive=true');

  // 3. Patch to SYNC_FAILED
  const failRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'SYNC_FAILED' }),
  });
  assertStatus(failRes.status, 200, failRes.data);
  const failed = (failRes.data as { integration: { status: string } }).integration;
  assert(failed.status === 'SYNC_FAILED', `Expected SYNC_FAILED, got ${failed.status}`);

  // 4. Delete
  const deleteRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(deleteRes.status, 200, deleteRes.data);

  // 5. Verify deleted
  const verifyRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(verifyRes.status, 404, verifyRes.data);
}

// ==================== OAUTH CALLBACK (PUBLIC) ====================

async function testOAuthCallback_invalidProvider() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/invalid_provider/callback?code=x&state=y`
  );
  // Callback returns HTML with 400 status (not JSON)
  assert(res.status === 400, `Expected 400, got ${res.status}`);
}

async function testOAuthCallback_missingCode() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback?state=x`);
  assert(res.status === 400, `Expected 400, got ${res.status}`);
}

async function testOAuthCallback_missingState() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback?code=x`);
  assert(res.status === 400, `Expected 400, got ${res.status}`);
}

// ==================== BOUNDARY CAPTURE TESTS ====================
// These run sequentially because the capture buffer is shared global state.

/**
 * POST /api/integrations (create) makes NO outbound HTTP calls.
 * All work is local (Prisma DB operations only).
 */
async function testBoundary_createNoOutbound() {
  const token = captureToken('create');
  const name = uniqueName('boundary_create');

  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for create, got ${filterInfraCalls(calls).length}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

/**
 * POST /api/integrations/email/:provider/start makes NO outbound calls.
 * It only writes to DB (integration + credential records).
 *
 * Note: concurrent tests may trigger Surge SMS API calls unrelated to this endpoint.
 * We filter those out and only check for email/OAuth-related outbound calls.
 */
async function testBoundary_emailStartNoOutbound() {
  const token = captureToken('email-start');

  // This may return 500 if Gmail client ID is not configured, but still no outbound calls
  await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for email/start, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

/**
 * POST /api/integrations with invalid type (400) makes NO outbound calls.
 * Validation short-circuits before any DB or external calls.
 */
async function testBoundary_validationNoOutbound() {
  const token = captureToken('validation');

  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
    body: JSON.stringify({ name: 'test', type: 'INVALID' }),
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for validation failure, got ${filterInfraCalls(calls).length}`
  );
}

/**
 * GET /api/integrations/email/messages with missing 'since' param (400) makes NO outbound calls.
 */
async function testBoundary_emailMessagesValidationNoOutbound() {
  const token = captureToken('email-messages');

  await request(`${BASE_URL}/api/integrations/email/messages`, {
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for email/messages validation, got ${filterInfraCalls(calls).length}`
  );
}

/**
 * POST /api/integrations/passwords/request sends an SMS via sendSms.
 * This is the only non-OAuth third-party boundary in the integrations domain.
 *
 * If SMS provider is not configured, skip the boundary assertion.
 */
async function testBoundary_passwordsRequestSms() {
  const token = captureToken('passwords-request');

  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
    body: JSON.stringify({ request: 'Test integration request for boundary test' }),
  });

  // Allow short delay for async SMS dispatch
  await new Promise((resolve) => setTimeout(resolve, 500));

  const calls = await readCapturesForToken(token);

  if (res.status === 500) {
    // SMS provider not configured — no outbound calls expected
    console.log('    [skipped] SMS provider returned error — cannot verify boundary');
    return;
  }

  assertStatus(res.status, 200, res.data);

  // Should have made exactly 1 outbound call (to SMS provider)
  const relevantCalls = filterInfraCalls(calls);
  if (relevantCalls.length === 0) {
    console.log('    [skipped] No outbound SMS calls captured — SMS may use internal queue');
    return;
  }

  const smsCall = relevantCalls[0];
  assert(smsCall.method === 'POST', `Expected POST, got ${smsCall.method}`);
  // The SMS provider URL varies (Twilio, Surge, etc.) — just verify it's an outbound POST
  assert(
    !smsCall.url.includes('localhost'),
    `Expected outbound URL, got localhost: ${smsCall.url}`
  );
}

/**
 * POST /api/integrations/telegram/connect makes NO outbound calls.
 * All work is local (DB upsert only).
 *
 * Note: concurrent tests may trigger Surge SMS API calls unrelated to this endpoint.
 * We filter those out and only check for telegram-related outbound calls.
 */
async function testBoundary_telegramConnectNoOutbound() {
  const token = captureToken('telegram-connect');

  await request(`${BASE_URL}/api/integrations/telegram/connect`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });

  const calls = await readCapturesForToken(token);
  const relevant = filterInfraCalls(calls);
  assert(
    relevant.length === 0,
    `Expected 0 outbound calls for telegram/connect, got ${relevant.length}: ${JSON.stringify(relevant.map((c) => c.url))}`
  );
}

// ==================== OAUTH START / CALLBACK / INTEGRATION CRUD COVERAGE ====================

// 1. OAuth start: gmail with returnUrl
async function testOAuthStart_gmail() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ returnUrl: 'https://roselabs.ai/integrations' }),
  });
  // 200 if Google client ID is configured, 500 if not
  if (res.status === 200) {
    const body = res.data as { authUrl: string; state: string; expiresAt: string };
    assert(typeof body.authUrl === 'string', 'Expected authUrl string');
    assert(body.authUrl.includes('accounts.google.com'), 'Expected Google OAuth URL');
    assert(typeof body.state === 'string', 'Expected state string');
    assert(typeof body.expiresAt === 'string', 'Expected expiresAt string');
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

// 2. OAuth start: yahoo
async function testOAuthStart_yahoo() {
  const res = await request(`${BASE_URL}/api/integrations/email/yahoo/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  if (res.status === 200) {
    const body = res.data as { authUrl: string };
    assert(typeof body.authUrl === 'string', 'Expected authUrl string for Yahoo');
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500 for Yahoo start, got ${res.status}`);
  }
}

// 3. OAuth start: invalid provider
async function testOAuthStart_invalidProvider() {
  const res = await request(`${BASE_URL}/api/integrations/email/outlook/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'oauth start invalid provider');
}

// 4. OAuth start: no auth
async function testOAuthStart_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

// 5. OAuth callback: missing code param
async function testOAuthCallback_noCode() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback?state=some_state`);
  // Returns HTML 400 (missing authorization code)
  assertStatus(res.status, 400, res.data);
}

// 6. OAuth callback: invalid state token
async function testOAuthCallback_invalidState() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/callback?code=fake_code&state=totally_invalid_state_token`
  );
  // Returns HTML error page (state not found in DB -> 400 or redirect)
  if (res.status !== 200 && res.status !== 302 && res.status !== 400) {
    throw new Error(`Expected 200/302/400 for invalid state callback, got ${res.status}`);
  }
}

// 7. Get integrations: empty for new anonymous user
async function testGetIntegrations_empty() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations empty');
  assert(body.count === 0, `Expected 0 integrations, got ${body.count}`);
  assert(Array.isArray(body.authenticatedDomains), 'Expected authenticatedDomains array');
}

// 8. Create integration: basic DATA_SOURCE
async function testCreateIntegration_basic() {
  const name = uniqueName('create_basic');
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { source: 'test' } }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CreateIntegrationResponse, res.data, 'create basic');
  assert(body.integration.name === name, `Expected name ${name}`);
  assert(body.integration.type === 'DATA_SOURCE', 'Expected DATA_SOURCE type');
  assert(body.integration.status === 'NOT_CONNECTED', 'Expected NOT_CONNECTED status');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// 9. Update integration status
async function testUpdateIntegration_status() {
  const name = uniqueName('update_status');
  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Update status to CONNECTED
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(PatchIntegrationResponse, res.data, 'update status');
  assert(
    body.integration.status === 'CONNECTED',
    `Expected CONNECTED, got ${body.integration.status}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// 10. Delete integration: basic
async function testDeleteIntegration_basic() {
  const name = uniqueName('delete_basic');
  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'TOOL_SETUP' }),
  });

  // Delete
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(DeleteIntegrationResponse, res.data, 'delete basic');

  // Verify it's gone
  const deleteAgain = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(deleteAgain.status, 404, deleteAgain.data);
}

// 11. Email send: missing required fields
async function testEmailSend_missingFields() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'email send missing fields');
}

// 12. Email send: no auth
async function testEmailSend_noAuthCoverage() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    body: JSON.stringify({ to: 'a@b.com', subject: 'test', body: 'test', from_email: 'x@y.com' }),
  });
  assertStatus(res.status, 401, res.data);
}

// 13. Email messages: no auth
async function testEmailMessages_noAuthCoverage() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}`
  );
  assertStatus(res.status, 401, res.data);
}

// 14. Email messages: empty (no gmail connected for anon user)
async function testEmailMessages_empty() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date(Date.now() - 86400000).toISOString()}&limit=5`,
    { headers: authHeaders(accessToken) }
  );
  // 404 because no gmail connected for anonymous user
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'email messages empty');
}

// 15. Passwords request: basic with valid request string
async function testPasswordsRequest_basic() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: 'Please add support for 1Password integration' }),
  });
  // 200 if SMS config is available, 500 if not
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for passwords request, got ${res.status}`);
  }
}

// 16. Claude Code credentials upload: with encrypted payload
async function testClaudeCodeCredentials_upload() {
  const encryptedCredentials = buildCredentialPayload(
    `sk-ant-oat-upload-${crypto.randomBytes(8).toString('hex')}`
  );
  const encrypted = encryptPayload({ encryptedCredentials });
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ClaudeCodeUploadResponse, res.data, 'claude-code credentials upload');
}

// 17. Claude Code credentials get token: returns 404 for anon user without onboarding
async function testClaudeCodeCredentials_getToken() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: await authHeadersWithoutExistingClaudePools(accessToken),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code token anon missing');
}

// 18. Claude Code token rate-limited: with API key (internal auth)
async function testClaudeCodeTokenRateLimited() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({ source: 'user', userId: ctx.userId1 }),
  });
  // Should succeed with internal auth (API key)
  if (res.status === 200) {
    const body = res.data as { ok: boolean; source: string };
    assert(body.ok === true, 'Expected ok=true');
    assert(body.source === 'user', 'Expected source=user');
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for rate-limited, got ${res.status}`);
  }
}

// 19. Integration CRUD: full lifecycle (create, read, update status, delete)
async function testIntegrationCRUD_fullLifecycle() {
  const name = uniqueName('crud_lifecycle');
  const { accessToken } = await createAnonSession();

  // 1. Create
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { step: 'create' } }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateIntegrationResponse, createRes.data, 'lifecycle create');
  assert(created.integration.status === 'NOT_CONNECTED', 'Expected NOT_CONNECTED on create');

  // 2. Read (list) and verify it's there
  const listRes = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const listed = assertSchema(ListIntegrationsResponse, listRes.data, 'lifecycle list');
  const found = listed.integrations.find((i: { name: string }) => i.name === name);
  assert(found !== undefined, `Expected to find ${name} in list`);

  // 3. Update status to CONNECTED
  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ status: 'CONNECTED', isActive: true }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = assertSchema(PatchIntegrationResponse, patchRes.data, 'lifecycle patch');
  assert(patched.integration.status === 'CONNECTED', 'Expected CONNECTED after patch');
  assert(patched.integration.isActive === true, 'Expected isActive=true after patch');

  // 4. Update status to EXPIRED
  const expireRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ status: 'EXPIRED' }),
  });
  assertStatus(expireRes.status, 200, expireRes.data);
  const expired = (expireRes.data as { integration: { status: string } }).integration;
  assert(expired.status === 'EXPIRED', `Expected EXPIRED, got ${expired.status}`);

  // 5. Delete
  const deleteRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  assertStatus(deleteRes.status, 200, deleteRes.data);

  // 6. Verify gone
  const deleteAgainRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  assertStatus(deleteAgainRes.status, 404, deleteAgainRes.data);
}

// 20. Email send: with from_email but no gmail connected (exercises send path validation)
async function testEmailSend_withCredentials() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Test Subject',
      body: 'Test email body content',
      from_email: 'noreply@test.example.com',
    }),
  });
  // Should fail because no gmail credentials are connected for this anon user
  // Exercises the sendEmail path → GmailAccountNotFoundError
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400 or 404 for send without credentials, got ${res.status}`);
  }
}

// ==================== DEEP COVERAGE TESTS ====================

// --- OAuth start with PKCE verification ---

async function testEmailStart_gmailPkceFields() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      returnUrl: 'https://roselabs.ai/settings',
      errorUrl: 'https://roselabs.ai/error',
    }),
  });
  if (res.status === 200) {
    const body = res.data as {
      authUrl: string;
      state: string;
      expiresAt: string;
      credentialId: string;
    };
    // Verify PKCE code_challenge is present in the authUrl
    assert(body.authUrl.includes('code_challenge='), 'Expected code_challenge in authUrl');
    assert(
      body.authUrl.includes('code_challenge_method=S256'),
      'Expected S256 code_challenge_method'
    );
    // Verify state token is present
    assert(
      typeof body.state === 'string' && body.state.length > 10,
      'Expected non-trivial state token'
    );
    // Verify expiresAt is in the future
    const expiresAt = new Date(body.expiresAt);
    assert(expiresAt > new Date(), 'Expected expiresAt to be in the future');
    // Verify credentialId is present
    assert(
      typeof body.credentialId === 'string' && body.credentialId.length > 0,
      'Expected credentialId'
    );
    // Verify Gmail-specific OAuth params
    assert(body.authUrl.includes('access_type=offline'), 'Expected access_type=offline for Gmail');
    assert(body.authUrl.includes('prompt=consent'), 'Expected prompt=consent for Gmail');
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

async function testEmailStart_yahooOAuthUrl() {
  const res = await request(`${BASE_URL}/api/integrations/email/yahoo/start`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ returnUrl: 'https://roselabs.ai/integrations' }),
  });
  if (res.status === 200) {
    const body = res.data as { authUrl: string; state: string; expiresAt: string };
    // Yahoo should NOT have Gmail-specific params
    assert(
      !body.authUrl.includes('access_type=offline'),
      'Yahoo should NOT have access_type=offline'
    );
    assert(body.authUrl.includes('code_challenge='), 'Expected code_challenge in Yahoo authUrl');
    assert(typeof body.state === 'string', 'Expected state string for Yahoo');
  } else if (res.status !== 500) {
    throw new Error(`Expected 200 or 500 for Yahoo, got ${res.status}`);
  }
}

// --- OAuth callback edge cases ---

async function testOAuthCallback_yahooInvalidState() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/yahoo/callback?code=fake_code&state=invalid_yahoo_state`
  );
  // Yahoo callback should handle invalid state gracefully (returns HTML error)
  if (res.status !== 200 && res.status !== 302 && res.status !== 400) {
    throw new Error(`Expected 200/302/400 for Yahoo invalid state callback, got ${res.status}`);
  }
}

async function testOAuthCallback_missingBothParams() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/callback`);
  // Missing both code and state — exercises multiple validation paths
  assertStatus(res.status, 400, res.data);
}

// --- Integration CRUD deep: exercises config merge, isActive toggle ---

async function testPatch_isActiveToggle() {
  const name = uniqueName('isactive_toggle');
  // Create integration
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  // Toggle isActive to true
  const patchRes1 = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ isActive: true }),
  });
  assertStatus(patchRes1.status, 200, patchRes1.data);
  const body1 = (patchRes1.data as { integration: { isActive: boolean } }).integration;
  assert(body1.isActive === true, 'Expected isActive=true after first toggle');

  // Toggle isActive to false
  const patchRes2 = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ isActive: false }),
  });
  assertStatus(patchRes2.status, 200, patchRes2.data);
  const body2 = (patchRes2.data as { integration: { isActive: boolean } }).integration;
  assert(body2.isActive === false, 'Expected isActive=false after second toggle');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

async function testPatch_statusAndConfigTogether() {
  const name = uniqueName('status_config');
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'TOOL_SETUP' }),
  });

  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      status: 'CONNECTED',
      isActive: true,
      config: { tool: 'test', version: 2 },
    }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = (patchRes.data as { integration: { status: string; isActive: boolean } })
    .integration;
  assert(patched.status === 'CONNECTED', `Expected CONNECTED, got ${patched.status}`);
  assert(patched.isActive === true, 'Expected isActive=true');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// --- Email send: exercises the missing from_email with available accounts path ---

async function testEmailSend_noFromEmailNoAccounts() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ to: 'test@test.com', subject: 'test', body: 'test' }),
  });
  // Anonymous user has no Gmail connected → should report "Gmail not connected"
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; message: string };
  assert(
    body.error === 'Gmail not connected',
    `Expected 'Gmail not connected', got '${body.error}'`
  );
}

// --- Email messages: exercises limit param parsing ---

async function testEmailMessages_limitClamping() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}&limit=999`,
    { headers: authHeaders(accessToken) }
  );
  // Should still be 404 (no gmail), but exercises limit parsing (clamped to 100)
  assertStatus(res.status, 404, res.data);
}

async function testEmailMessages_limitNegative() {
  const { accessToken } = await createAnonSession();
  const res = await request(
    `${BASE_URL}/api/integrations/email/messages?since=${new Date().toISOString()}&limit=-5`,
    { headers: authHeaders(accessToken) }
  );
  // Should still be 404 (no gmail), but exercises Math.min(Math.max(...)) clamping
  assertStatus(res.status, 404, res.data);
}

// --- Claude Code: deep coverage of token/rate-limit paths ---

async function testClaudeCodeRateLimited_poolSource() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'pool',
      poolTokenId: 'test-pool-token-' + Date.now(),
      rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  // Exercises markTokenRateLimited pool path
  if (res.status === 200) {
    const body = res.data as {
      ok: boolean;
      source: string;
      poolTokenId: string;
      rateLimitedUntil: string;
    };
    assert(body.ok === true, 'Expected ok=true');
    assert(body.source === 'pool', 'Expected source=pool');
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for pool rate-limited, got ${res.status}`);
  }
}

async function testClaudeCodeRateLimited_invalidSource() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({ source: 'invalid_source' }),
  });
  // Should return 400 for invalid source
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(
    body.error.includes('Invalid source'),
    `Expected 'Invalid source' error, got: ${body.error}`
  );
}

async function testClaudeCodeRateLimited_poolMissingId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({ source: 'pool' }),
  });
  // Should return 400 for missing poolTokenId
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('poolTokenId'), `Expected poolTokenId error, got: ${body.error}`);
}

async function testClaudeCodeRateLimited_userMissingUserId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'user' }),
  });
  // Should return 400 for missing userId
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('userId'), `Expected userId error, got: ${body.error}`);
}

async function testClaudeCodePoolRateLimited_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      poolTokenId: 'test-pool-' + Date.now(),
      rateLimitedUntil: new Date(Date.now() + 120000).toISOString(),
    }),
  });
  // Exercises markPoolTokenAsRateLimited
  if (res.status === 200) {
    const body = res.data as { ok: boolean; poolTokenId: string; rateLimitedUntil: string };
    assert(body.ok === true, 'Expected ok=true');
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for pool-token rate-limited, got ${res.status}`);
  }
}

async function testClaudeCodePoolRateLimited_missingPoolTokenId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('poolTokenId'), `Expected poolTokenId error, got: ${body.error}`);
}

// --- Claude Code token rotation: full end-to-end rotation coverage ---
//
// Regression guard for the bug where Andy's rate-limited user token kept being
// returned by `getClaudeCodeToken` because (a) the workflow never POSTed to
// `/token/rate-limited` on rate_limit and (b) even if it had, the user branch
// was fetched before the pool branch. These tests lock in:
//   1. POST /rate-limited(source=user) sets Integration.rateLimitedUntil in DB
//      (time-windowed, NOT permanent — must be in the future, not null)
//   2. After marking user rate-limited, GET /credentials/token falls back to pool
//   3. Pool rotation via excludePoolTokens returns a DIFFERENT pool token
//   4. Once rateLimitedUntil passes, the token is available again (auto-heal)
//   5. All tokens rate-limited → 404 NoTokensAvailableError
//
// Tests seed real encrypted Claude credential envelopes matching the format
// decryptCredentialEnvelope() expects (RSA-OAEP-SHA256 wrapped AES-256-GCM).

const CLAUDE_DECRYPTION_KEY_B64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY ?? '';

function claudePublicKeyPem(): string {
  if (CLAUDE_DECRYPTION_KEY_B64 === '') {
    throw new Error('CLAUDE_CREDENTIAL_DECRYPTION_KEY not set — cannot seed token fixtures');
  }
  const privatePem = Buffer.from(CLAUDE_DECRYPTION_KEY_B64, 'base64').toString('utf8');
  const keyObj = crypto.createPrivateKey(privatePem);
  return crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' }) as string;
}

/** Produces a credential envelope that decryptCredentialEnvelope() can decrypt. */
function encryptClaudeEnvelope(plaintext: string): string {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encryptedPart = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertextWithTag = Buffer.concat([encryptedPart, authTag]);

  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: claudePublicKeyPem(),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  const envelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertextWithTag.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

function buildCredentialPayload(accessToken: string): string {
  return encryptClaudeEnvelope(
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: 'test-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    })
  );
}

interface SeededIntegration {
  id: string;
  userId: string;
  accessToken: string;
}

async function seedClaudeIntegration(
  userId: string,
  opts: { poolingEnabled?: boolean; accessToken?: string; lastUsedAt?: Date | null } = {}
): Promise<SeededIntegration> {
  // The "sk-ant-oat" prefix mirrors real Anthropic OAuth tokens — required so
  // these seeded envelopes pass `hasUsableClaudeCodeEnvelope` and exercise the
  // rotation path under test (placeholder prefixes are now rejected upstream).
  const accessToken =
    opts.accessToken ?? `sk-ant-oat-seed-${crypto.randomBytes(8).toString('hex')}`;
  const encryptedCredentials = buildCredentialPayload(accessToken);

  const integration = await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'claude_code' } },
    create: {
      userId,
      name: 'claude_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: opts.poolingEnabled ?? false,
      lastUsedAt: opts.lastUsedAt ?? null,
      config: { encryptedCredentials },
    },
    update: {
      status: 'CONNECTED',
      poolingEnabled: opts.poolingEnabled ?? false,
      rateLimitedUntil: null,
      lastUsedAt: opts.lastUsedAt ?? null,
      config: { encryptedCredentials },
    },
  });
  return { id: integration.id, userId, accessToken };
}

function buildGptCredentialPayload(accessToken: string, accountId: string): string {
  return encryptClaudeEnvelope(
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'gpt-refresh-token',
        account_id: accountId,
      },
    })
  );
}

async function seedGptIntegration(
  userId: string,
  opts: {
    poolingEnabled?: boolean;
    accessToken?: string;
    accountId?: string;
    lastUsedAt?: Date | null;
  } = {}
): Promise<SeededIntegration & { accountId: string }> {
  const accessToken = opts.accessToken ?? `gpt-access-${crypto.randomBytes(8).toString('hex')}`;
  const accountId = opts.accountId ?? `acct-${crypto.randomBytes(6).toString('hex')}`;
  const encryptedCredentials = buildGptCredentialPayload(accessToken, accountId);

  const integration = await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'gpt_code' } },
    create: {
      userId,
      name: 'gpt_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: opts.poolingEnabled ?? false,
      lastUsedAt: opts.lastUsedAt ?? null,
      config: { encryptedCredentials },
    },
    update: {
      status: 'CONNECTED',
      poolingEnabled: opts.poolingEnabled ?? false,
      rateLimitedUntil: null,
      lastUsedAt: opts.lastUsedAt ?? null,
      config: { encryptedCredentials },
    },
  });
  return { id: integration.id, userId, accessToken, accountId };
}

async function completeOnboarding(userId: string): Promise<void> {
  // User.userId is the Supabase auth id; User.id is a separate autogen PK.
  // Integration.userId + getClaudeCodeToken's findUserById both use the auth id.
  await prisma.user.update({
    where: { userId },
    data: { onboardingCompletedAt: new Date() },
  });
}

// Snapshot EVERY claude_code/gpt_code row id — not just currently pool-eligible
// ones. A row that is EXPIRED / poolingEnabled=false at snapshot time can be
// flipped back to CONNECTED+pooled by a concurrent writer mid-test; excluding
// all ids up front makes the forced-pool LRU selection deterministic over OUR
// seeded fixtures regardless of what state pre-existing rows transition to.
async function existingPoolIds(): Promise<string[]> {
  const rows = await prisma.integration.findMany({
    where: { name: 'claude_code' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function existingComputePoolIds(): Promise<string[]> {
  const rows = await prisma.integration.findMany({
    where: { name: { in: ['claude_code', 'gpt_code'] } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// Cross-process compute-pool mutex: the rotation/lineage/affinity block below
// seeds pool fixtures and asserts EXACT LRU token selection, which a second
// suite process sharing this Postgres can otherwise perturb mid-test (see
// compute-pool-lock.testkit.ts for the full failure analysis).

async function cleanupIntegrations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.integration.deleteMany({ where: { id: { in: ids } } });
}

// Test 1: Marking user token rate-limited → GET returns a pool token.
// This is the exact regression Andy saw — rate_limit should flip over to pool.
async function testRotation_userRateLimitedFallsBackToPool() {
  const callerIds = await existingPoolIds();
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  await completeOnboarding(caller.userId);

  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    // Step 1: Happy path — user token returned before rate-limit.
    const before = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers: apiKeyHeaders(caller.userId),
    });
    assertStatus(before.status, 200, before.data);
    assert(
      (before.data as { source: string }).source === 'user',
      `Pre-rate-limit: expected source=user, got ${JSON.stringify(before.data)}`
    );

    // Step 2: Mark user token rate-limited (the fix that was missing).
    const markRes = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        source: 'user',
        userId: caller.userId,
        rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });
    assertStatus(markRes.status, 200, markRes.data);

    // Step 3: rateLimitedUntil is TIME-WINDOWED (future, not null, not permanent).
    const rowAfterMark = await prisma.integration.findUnique({ where: { id: userInt.id } });
    assert(
      rowAfterMark?.rateLimitedUntil instanceof Date,
      'Integration.rateLimitedUntil must be set after mark'
    );
    const untilMs = rowAfterMark!.rateLimitedUntil!.getTime();
    const nowMs = Date.now();
    assert(
      untilMs > nowMs,
      `rateLimitedUntil must be in the future (got ${untilMs - nowMs}ms from now)`
    );
    assert(
      untilMs - nowMs <= 10 * 60 * 1000,
      `rateLimitedUntil must be bounded (≤10min), got ${untilMs - nowMs}ms — looks permanent`
    );

    // Step 4: GET /credentials/token now falls back to pool (exclude any pre-existing pool tokens).
    const after = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers: {
        ...apiKeyHeaders(caller.userId),
        ...(callerIds.length > 0 ? { 'X-Exclude-Pool-Tokens': callerIds.join(',') } : {}),
      },
    });
    assertStatus(after.status, 200, after.data);
    const afterBody = after.data as { source: string; poolTokenId?: string };
    assert(
      afterBody.source === 'pool',
      `Post-rate-limit: expected source=pool, got ${afterBody.source}`
    );
    assert(
      afterBody.poolTokenId === poolInt.id,
      `Expected our seeded pool token, got ${afterBody.poolTokenId}`
    );
  } finally {
    await cleanupIntegrations([userInt.id, poolInt.id]);
  }
}

// Test 2: Pool rotation — marking pool token A rate-limited makes the next forced-pool
// fetch return token B (never A).
async function testRotation_poolRotatesOnRateLimit() {
  const existing = await existingPoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);

  const poolOwnerA = await createAnonSession();
  const poolOwnerB = await createAnonSession();
  const poolA = await seedClaudeIntegration(poolOwnerA.userId, { poolingEnabled: true });
  const poolB = await seedClaudeIntegration(poolOwnerB.userId, { poolingEnabled: true });

  // Exclude every pool row that isn't ours so the LRU query is deterministic.
  const excludeHeader = existing.join(',');

  try {
    // Step 1: force-pool → get ONE of our two seeded tokens.
    const fetchPool = async (extraExcludes: string[] = []) => {
      const excludes = [...existing, ...extraExcludes].filter((x) => x !== '');
      const headers: Record<string, string> = {
        ...apiKeyHeaders(caller.userId),
        'X-Force-Pool': 'true',
      };
      if (excludes.length > 0) headers['X-Exclude-Pool-Tokens'] = excludes.join(',');
      return request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, { headers });
    };

    const res1 = await fetchPool();
    assertStatus(res1.status, 200, res1.data);
    const firstId = (res1.data as { poolTokenId: string }).poolTokenId;
    assert(
      [poolA.id, poolB.id].includes(firstId),
      `First fetch: expected one of our seeded pool ids, got ${firstId} (existing=${excludeHeader})`
    );

    // Step 2: mark the returned pool token as rate-limited.
    const markRes = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        source: 'pool',
        poolTokenId: firstId,
        rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });
    assertStatus(markRes.status, 200, markRes.data);

    // Step 3: next force-pool fetch must return the OTHER token (rate-limit filter works).
    const expectedSecondId = firstId === poolA.id ? poolB.id : poolA.id;
    await prisma.integration.update({
      where: { id: expectedSecondId },
      data: {
        status: 'CONNECTED',
        poolingEnabled: true,
        rateLimitedUntil: null,
        failureReason: null,
        lastUsedAt: new Date(Date.now() - 120_000),
      },
    });
    const res2 = await fetchPool([firstId]);
    assertStatus(res2.status, 200, res2.data);
    const secondId = (res2.data as { poolTokenId: string }).poolTokenId;
    assert(secondId !== firstId, `Rotation failed: got same token twice (${firstId})`);
    assert(
      secondId === expectedSecondId,
      `Second fetch: expected the other seeded token, got ${secondId}`
    );
  } finally {
    await cleanupIntegrations([poolA.id, poolB.id]);
  }
}

// Test 2b: Heterogeneous compute pool rotation — GPT and Claude tokens share
// one LRU pool. The backend returns a provider type; callers use that type to
// choose the direct GPT or Claude API path.
async function testComputeRotation_poolRotatesAcrossProviders() {
  const existing = await existingComputePoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);

  const poolOwnerClaude = await createAnonSession();
  const poolOwnerGpt = await createAnonSession();
  const claudePool = await seedClaudeIntegration(poolOwnerClaude.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 60_000),
  });
  const gptPool = await seedGptIntegration(poolOwnerGpt.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 120_000),
  });

  const fetchPool = async () => {
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    if (existing.length > 0) headers['X-Exclude-Pool-Tokens'] = existing.join(',');
    return request(`${BASE_URL}/api/integrations/compute-code/credentials/token`, { headers });
  };

  try {
    const first = await fetchPool();
    assertStatus(first.status, 200, first.data);
    const firstBody = first.data as {
      type: string;
      source: string;
      poolTokenId?: string;
      accountId?: string;
    };
    assert(
      firstBody.type === 'gpt',
      `Expected LRU GPT pool token first, got ${JSON.stringify(firstBody)}`
    );
    assert(firstBody.source === 'pool', `Expected source=pool, got ${firstBody.source}`);
    assert(
      firstBody.poolTokenId === gptPool.id,
      `Expected GPT pool ${gptPool.id}, got ${firstBody.poolTokenId}`
    );
    assert(
      firstBody.accountId === gptPool.accountId,
      `Expected GPT account ID ${gptPool.accountId}, got ${firstBody.accountId}`
    );

    const markGpt = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'gpt',
        source: 'pool',
        poolTokenId: gptPool.id,
        rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });
    assertStatus(markGpt.status, 200, markGpt.data);

    const second = await fetchPool();
    assertStatus(second.status, 200, second.data);
    const secondBody = second.data as { type: string; source: string; poolTokenId?: string };
    assert(
      secondBody.type === 'claude',
      `Expected rotation across providers to Claude, got ${JSON.stringify(secondBody)}`
    );
    assert(
      secondBody.poolTokenId === claudePool.id,
      `Expected Claude pool ${claudePool.id}, got ${secondBody.poolTokenId}`
    );

    const markClaude = await request(
      `${BASE_URL}/api/integrations/compute-code/token/rate-limited`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({
          type: 'claude',
          source: 'pool',
          poolTokenId: claudePool.id,
          rateLimitedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
      }
    );
    assertStatus(markClaude.status, 200, markClaude.data);

    const exhausted = await fetchPool();
    assertStatus(exhausted.status, 404, exhausted.data);
    assertSchema(ErrorResponse, exhausted.data, 'compute pool exhausted');
  } finally {
    await cleanupIntegrations([claudePool.id, gptPool.id]);
  }
}

async function testComputeTokenLineageSemaphore_capsLiveGptLeases() {
  const existingPoolIds = await existingComputePoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  // Exercise the token-identity semaphore through a caller-owned credential.
  // A pooled fake credential is visible to the live local worker and can be
  // selected by an unrelated queued workflow, which then rate-limits it after
  // provider validation fails. That made this local DB contract race runtime
  // activity even though the capacity behavior itself is source-agnostic.
  const gptCredential = await seedGptIntegration(caller.userId, {
    poolingEnabled: false,
    lastUsedAt: new Date(Date.now() - 120_000),
  });
  const lineageKeys = Array.from(
    { length: 17 },
    (_, idx) => `test-lineage-gpt-${crypto.randomUUID()}-${idx}`
  );

  const fetchToken = async (lineageKey: string) => {
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
    };
    // Capacity exhaustion on the caller credential must not fall through to an
    // unrelated production-synced pool token in this isolated contract.
    if (existingPoolIds.length > 0) {
      headers['X-Exclude-Pool-Tokens'] = existingPoolIds.join(',');
    }
    const params = new URLSearchParams({
      lineageKey,
      agentId: lineageKey,
      rootAgentId: lineageKey,
    });
    return request(`${BASE_URL}/api/integrations/compute-code/credentials/token?${params}`, {
      headers,
    });
  };

  try {
    for (const lineageKey of lineageKeys.slice(0, 16)) {
      const res = await fetchToken(lineageKey);
      assertStatus(res.status, 200, res.data);
      const body = res.data as {
        type: string;
        source: string;
        poolTokenId?: string;
        lineageKey?: string;
      };
      assert(body.type === 'gpt', `Expected GPT token, got ${JSON.stringify(body)}`);
      assert(body.source === 'user', `Expected user token, got ${JSON.stringify(body)}`);
      assert(body.poolTokenId === undefined, `Expected no pool token, got ${body.poolTokenId}`);
      assert(
        body.lineageKey === lineageKey,
        `Expected lineage echo ${lineageKey}, got ${body.lineageKey}`
      );
    }

    const reused = await fetchToken(lineageKeys[0]);
    assertStatus(reused.status, 200, reused.data);

    const exhausted = await fetchToken(lineageKeys[16]);
    assertStatus(exhausted.status, 404, exhausted.data);

    await prisma.computeTokenLineageLease.updateMany({
      where: { lineageKey: { in: lineageKeys.slice(0, 16) } },
      data: { lastUsedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const afterStale = await fetchToken(lineageKeys[16]);
    assertStatus(afterStale.status, 200, afterStale.data);
  } finally {
    await prisma.computeTokenLineageLease.deleteMany({
      where: { lineageKey: { in: lineageKeys } },
    });
    await cleanupIntegrations([gptCredential.id]);
  }
}

async function testComputeTokenFastCacheAffinity_pinsProviderFamily() {
  const caller = await createAnonSession();
  const gptOwner = await createAnonSession();
  const claudeOwner = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(gptOwner.userId);
  await completeOnboarding(claudeOwner.userId);

  const affinityKey = `test-affinity-${crypto.randomUUID()}`;
  const lineages = [
    `test-affinity-lineage-${crypto.randomUUID()}-1`,
    `test-affinity-lineage-${crypto.randomUUID()}-2`,
  ];
  const gptPool = await seedGptIntegration(gptOwner.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 120_000),
  });
  const claudePool = await seedClaudeIntegration(claudeOwner.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 60_000),
  });

  const fetchPool = async (lineageKey: string) => {
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    // Other blackbox domains seed pool credentials concurrently. Snapshot at
    // request time so this affinity assertion only considers its own pair.
    const currentPoolIds = await existingComputePoolIds();
    const exclude = currentPoolIds.filter((id) => id !== gptPool.id && id !== claudePool.id);
    if (exclude.length > 0) headers['X-Exclude-Pool-Tokens'] = exclude.join(',');
    const params = new URLSearchParams({
      lineageKey,
      agentId: lineageKey,
      rootAgentId: lineageKey,
      fastCacheAffinityKey: affinityKey,
    });
    return request(`${BASE_URL}/api/integrations/compute-code/credentials/token?${params}`, {
      headers,
    });
  };

  try {
    const first = await fetchPool(lineages[0]);
    assertStatus(first.status, 200, first.data);
    const firstBody = first.data as {
      type: string;
      poolTokenId?: string;
      fastCacheAffinityKey?: string;
    };
    const selectedPool = firstBody.type === 'gpt' ? gptPool : claudePool;
    const unselectedPool = firstBody.type === 'gpt' ? claudePool : gptPool;
    assert(
      firstBody.type === 'gpt' || firstBody.type === 'claude',
      `Expected a supported compute provider, got ${JSON.stringify(firstBody)}`
    );
    assert(
      firstBody.poolTokenId === selectedPool.id,
      `Expected one of the isolated pools, got ${firstBody.poolTokenId}`
    );
    assert(
      firstBody.fastCacheAffinityKey === affinityKey,
      'Expected affinity key echoed in token response'
    );

    await prisma.integration.update({
      where: { id: selectedPool.id },
      data: { lastUsedAt: new Date() },
    });
    await prisma.integration.update({
      where: { id: unselectedPool.id },
      data: { lastUsedAt: new Date(Date.now() - 180_000) },
    });

    const second = await fetchPool(lineages[1]);
    assertStatus(second.status, 200, second.data);
    const secondBody = second.data as {
      type: string;
      poolTokenId?: string;
      fastCacheAffinityKey?: string;
    };
    assert(
      secondBody.type === firstBody.type,
      `Expected pinned affinity to keep ${firstBody.type} despite the other provider being LRU, got ${JSON.stringify(secondBody)}`
    );
    assert(
      secondBody.poolTokenId === selectedPool.id,
      `Expected pinned pool ${selectedPool.id}, got ${secondBody.poolTokenId}`
    );
    assert(
      secondBody.fastCacheAffinityKey === affinityKey,
      'Expected affinity key echoed on pinned response'
    );
  } finally {
    await prisma.computeTokenLineageLease.deleteMany({ where: { lineageKey: { in: lineages } } });
    await prisma.computeTokenFastCacheAffinity.deleteMany({ where: { affinityKey } });
    await cleanupIntegrations([gptPool.id, claudePool.id]);
  }
}

async function testRotation_poolAuthErrorDisablesToken() {
  const caller = await createAnonSession();
  const poolOwnerA = await createAnonSession();
  const poolOwnerB = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(poolOwnerA.userId);
  await completeOnboarding(poolOwnerB.userId);
  const existing = await existingComputePoolIds();
  const poolA = await seedClaudeIntegration(poolOwnerA.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 120_000),
  });
  const poolB = await seedClaudeIntegration(poolOwnerB.userId, {
    poolingEnabled: true,
    lastUsedAt: new Date(Date.now() - 60_000),
  });

  const fetchPool = async () => {
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    if (existing.length > 0) headers['X-Exclude-Pool-Tokens'] = existing.join(',');
    return request(`${BASE_URL}/api/integrations/compute-code/credentials/token`, { headers });
  };

  try {
    const first = await fetchPool();
    assertStatus(first.status, 200, first.data);
    const firstBody = first.data as { poolTokenId?: string };
    const firstId = firstBody.poolTokenId;
    assert(
      firstId !== undefined && [poolA.id, poolB.id].includes(firstId),
      `Expected one of our seeded pool tokens, got ${firstId}`
    );

    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'claude',
        source: 'pool',
        poolTokenId: firstId,
        failureReason: 'auth_error',
      }),
    });
    assertStatus(mark.status, 200, mark.data);

    const disabled = await prisma.integration.findUnique({ where: { id: firstId } });
    assert(disabled !== null, 'Expected disabled pool token row to exist');
    assert(disabled.poolingEnabled === false, 'auth_error must disable pool selection');
    assert(disabled.rateLimitedUntil === null, 'auth_error disable must not use a cooldown');
    assert(disabled.failureReason === 'auth_error', 'auth_error must be recorded');

    const second = await fetchPool();
    assertStatus(second.status, 200, second.data);
    const secondBody = second.data as { poolTokenId?: string };
    const expectedSecondId = firstId === poolA.id ? poolB.id : poolA.id;
    assert(
      secondBody.poolTokenId === expectedSecondId,
      `Expected disabled token to be skipped; got ${secondBody.poolTokenId}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: [poolA.id, poolB.id] } } });
  }
}

async function testRotation_userAuthErrorDisablesToken() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(poolOwner.userId);
  const existing = await existingComputePoolIds();
  const userToken = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolToken = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'claude',
        source: 'user',
        userId: caller.userId,
        failureReason: 'auth_error',
      }),
    });
    assertStatus(mark.status, 200, mark.data);

    const disabled = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(disabled !== null, 'Expected disabled user token row to exist');
    assert(disabled.status === 'EXPIRED', 'auth_error must expire user token');
    assert(disabled.isActive === false, 'auth_error must deactivate user token');
    assert(disabled.rateLimitedUntil === null, 'auth_error disable must not use a cooldown');
    assert(disabled.failureReason === 'auth_error', 'auth_error must be recorded');

    const headers: Record<string, string> = { ...apiKeyHeaders(caller.userId) };
    if (existing.length > 0) headers['X-Exclude-Pool-Tokens'] = existing.join(',');
    const next = await request(`${BASE_URL}/api/integrations/compute-code/credentials/token`, {
      headers,
    });
    assertStatus(next.status, 200, next.data);
    const body = next.data as { source: string; poolTokenId?: string };
    assert(
      body.source === 'pool',
      `Expected disabled user token to fall back to pool, got ${body.source}`
    );
    assert(
      body.poolTokenId === poolToken.id,
      `Expected pool token ${poolToken.id}, got ${body.poolTokenId}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: [userToken.id, poolToken.id] } } });
  }
}

async function testRotation_gptUserAuthErrorDisablesToken() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  await completeOnboarding(caller.userId);
  await completeOnboarding(poolOwner.userId);
  const existing = await existingComputePoolIds();
  const userToken = await seedGptIntegration(caller.userId, { poolingEnabled: false });
  const poolToken = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'gpt',
        source: 'user',
        userId: caller.userId,
        failureReason: 'auth_error',
      }),
    });
    assertStatus(mark.status, 200, mark.data);

    const disabled = await prisma.integration.findUnique({ where: { id: userToken.id } });
    assert(disabled !== null, 'Expected disabled GPT user token row to exist');
    assert(disabled.status === 'EXPIRED', 'auth_error must expire GPT user token');
    assert(disabled.isActive === false, 'auth_error must deactivate GPT user token');
    assert(disabled.rateLimitedUntil === null, 'auth_error disable must not use a cooldown');
    assert(disabled.failureReason === 'auth_error', 'auth_error must be recorded');

    const headers: Record<string, string> = { ...apiKeyHeaders(caller.userId) };
    if (existing.length > 0) headers['X-Exclude-Pool-Tokens'] = existing.join(',');
    const next = await request(`${BASE_URL}/api/integrations/compute-code/credentials/token`, {
      headers,
    });
    assertStatus(next.status, 200, next.data);
    const body = next.data as { type: string; source: string; poolTokenId?: string };
    assert(body.type === 'claude', `Expected fallback pool token to be Claude, got ${body.type}`);
    assert(
      body.source === 'pool',
      `Expected disabled GPT user token to fall back to pool, got ${body.source}`
    );
    assert(
      body.poolTokenId === poolToken.id,
      `Expected pool token ${poolToken.id}, got ${body.poolTokenId}`
    );
  } finally {
    await prisma.integration.deleteMany({ where: { id: { in: [userToken.id, poolToken.id] } } });
  }
}

// Test 3: Auto-expiry — a token whose rateLimitedUntil is in the past is available again.
// Locks in that the filter is `rateLimitedUntil < now`, not a permanent disable flag.
async function testRotation_autoExpiresAfterCooldown() {
  const existing = await existingPoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  const poolOwner = await createAnonSession();
  const pool = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    // Manually put rateLimitedUntil 1 second in the past — simulates cooldown elapsed.
    await prisma.integration.update({
      where: { id: pool.id },
      data: { rateLimitedUntil: new Date(Date.now() - 1000) },
    });

    const excludes = existing.join(',');
    const headers: Record<string, string> = {
      ...apiKeyHeaders(caller.userId),
      'X-Force-Pool': 'true',
    };
    if (excludes !== '') headers['X-Exclude-Pool-Tokens'] = excludes;

    const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers,
    });
    assertStatus(res.status, 200, res.data);
    const body = res.data as { source: string; poolTokenId: string };
    assert(body.source === 'pool', `Expected source=pool, got ${body.source}`);
    assert(
      body.poolTokenId === pool.id,
      `Expired rate-limit should auto-heal; expected our pool id, got ${body.poolTokenId}`
    );
  } finally {
    await cleanupIntegrations([pool.id]);
  }
}

// Test 4: All tokens exhausted → 404 NoTokensAvailableError.
// The caller has a user token + one pool exists, both rate-limited → no fallback.
async function testRotation_allExhausted404() {
  const existing = await existingPoolIds();
  const caller = await createAnonSession();
  await completeOnboarding(caller.userId);
  const poolOwner = await createAnonSession();

  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });

  try {
    const until = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.integration.update({
      where: { id: userInt.id },
      data: { rateLimitedUntil: until },
    });
    await prisma.integration.update({
      where: { id: poolInt.id },
      data: { rateLimitedUntil: until },
    });

    const excludes = existing.join(',');
    const headers: Record<string, string> = apiKeyHeaders(caller.userId);
    if (excludes !== '') headers['X-Exclude-Pool-Tokens'] = excludes;

    const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
      headers,
    });
    assertStatus(res.status, 404, res.data);
    assertSchema(ErrorResponse, res.data, 'all-exhausted 404');
  } finally {
    await cleanupIntegrations([userInt.id, poolInt.id]);
  }
}

// Test 5: Default cooldown (no rateLimitedUntil in body) is a bounded time window,
// not permanent. Guards against a future regression where someone sets it to far-future.
async function testRotation_defaultCooldownIsBounded() {
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });

  try {
    const markRes = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ source: 'user', userId: caller.userId }),
    });
    assertStatus(markRes.status, 200, markRes.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    const until = row?.rateLimitedUntil;
    assert(until instanceof Date, 'rateLimitedUntil must be set even when body omits it');
    const ms = until!.getTime() - Date.now();
    assert(ms > 0, `rateLimitedUntil must be in the future (got ${ms}ms from now)`);
    assert(
      ms <= 10 * 60 * 1000,
      `default cooldown must be bounded (≤10min); got ${ms}ms — looks permanent`
    );
  } finally {
    await cleanupIntegrations([userInt.id]);
  }
}

async function testClaudeCodeUpload_clearsRateLimitCooldown() {
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });

  try {
    await prisma.integration.update({
      where: { id: userInt.id },
      data: {
        rateLimitedUntil: new Date(Date.now() + 60 * 60 * 1000),
        lastUsedAt: new Date(),
        failureReason: 'previous token exhausted',
      },
    });

    const encryptedCredentials = buildCredentialPayload(
      `sk-ant-oat-resynced-${crypto.randomBytes(8).toString('hex')}`
    );
    const encrypted = encryptPayload({ encryptedCredentials });
    const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
      method: 'POST',
      headers: authHeaders(caller.accessToken),
      body: JSON.stringify(encrypted),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    assert(row?.rateLimitedUntil === null, 'upload must clear stale rateLimitedUntil');
    assert(row?.lastUsedAt === null, 'upload must clear stale lastUsedAt');
    assert(row?.failureReason === null, 'upload must clear stale failureReason');
  } finally {
    await cleanupIntegrations([userInt.id]);
  }
}

async function testGptCodeUpload_clearsExpiredAndRateLimitState() {
  const caller = await createAnonSession();
  const userInt = await seedGptIntegration(caller.userId, { poolingEnabled: false });

  try {
    await prisma.integration.update({
      where: { id: userInt.id },
      data: {
        status: 'EXPIRED',
        isActive: false,
        rateLimitedUntil: new Date(Date.now() + 60 * 60 * 1000),
        lastUsedAt: new Date(),
        failureReason: 'auth_error',
      },
    });

    const encryptedCredentials = buildGptCredentialPayload(
      `gpt-resynced-${crypto.randomBytes(8).toString('hex')}`,
      `acct-resynced-${crypto.randomBytes(6).toString('hex')}`
    );
    const encrypted = encryptPayload({ encryptedCredentials });
    const res = await request(`${BASE_URL}/api/integrations/gpt-code/credentials/upload`, {
      method: 'POST',
      headers: authHeaders(caller.accessToken),
      body: JSON.stringify(encrypted),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    assert(row?.status === 'CONNECTED', 'upload must restore CONNECTED status');
    assert(row?.isActive === true, 'upload must reactivate the integration');
    assert(row?.rateLimitedUntil === null, 'upload must clear stale rateLimitedUntil');
    assert(row?.lastUsedAt === null, 'upload must clear stale lastUsedAt');
    assert(row?.failureReason === null, 'upload must clear stale failureReason');
  } finally {
    await cleanupIntegrations([userInt.id]);
  }
}

// =====================================================================
// Claude Code CLI exhaustion detection
// ---------------------------------------------------------------------
// When the Claude Code CLI inside an E2B sandbox prints
// `You've hit your limit · resets X:XX (UTC)`, the persistOutput route must
// mark the underlying Integration rate-limited so subsequent spawns rotate
// to a different pool token. Anchored against the exact banner format the
// CLI emits — these tests are the regression net for that flow.
// =====================================================================

interface SeededSession {
  taskId: string;
  agentId: string;
}

async function seedClaudeCodeSession(
  agentId: string,
  source: 'user' | 'pool',
  poolTokenId: string | null
): Promise<SeededSession> {
  const taskId = crypto.randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId,
      sandboxId: `seed-${taskId}`,
      goal: 'exhaustion-detection-test',
      status: 'ACTIVE',
      claudeTokenSource: source,
      claudeTokenIntegrationId: poolTokenId,
    },
  });
  return { taskId, agentId };
}

async function cleanupSessions(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await prisma.claudeCodeSession.deleteMany({ where: { id: { in: taskIds } } });
}

async function testClaudeCodeExhaustion_marksPoolToken() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const banner = "You've hit your limit · resets 4:00am (UTC)\nbye\n";
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    const until = row?.rateLimitedUntil;
    assert(until instanceof Date, 'pool integration must be rate-limited after exhaustion banner');
    const utcHour = until!.getUTCHours();
    const utcMinute = until!.getUTCMinutes();
    assert(
      utcHour === 4 && utcMinute === 0,
      `expected next 04:00 UTC, got ${utcHour}:${String(utcMinute).padStart(2, '0')} UTC`
    );
    assert(
      until!.getTime() > Date.now(),
      'rateLimitedUntil must be in the future (rolls forward to next 04:00 UTC if past)'
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

async function testClaudeCodeExhaustion_marksUserToken() {
  const caller = await createAnonSession();
  const userInt = await seedClaudeIntegration(caller.userId, { poolingEnabled: false });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'user', null);

  try {
    const banner = "You've hit your limit · resets 9:30pm (UTC)\n";
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: userInt.id } });
    const until = row?.rateLimitedUntil;
    assert(until instanceof Date, 'user integration must be rate-limited after exhaustion banner');
    assert(until!.getUTCHours() === 21, `expected 21:00 UTC, got ${until!.getUTCHours()}:00`);
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([userInt.id]);
  }
}

async function testClaudeCodeAuthFailure_marksPoolTokenLongCooldown() {
  // Anchors: "Please run /login" / "Not logged in" — emitted by Claude Code CLI
  // when the cached OAuth envelope is broken. This is structurally different
  // from the rate-limit banner: the underlying refreshToken is bad/revoked and
  // won't recover on its own. We mark the pool token broken with a 24h
  // cooldown so the LRU rotates and operators have time to re-sync it.
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const banner = 'Not logged in - Run /login to authenticate. Please run /login\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    const until = row?.rateLimitedUntil;
    assert(
      until instanceof Date,
      'pool integration must be rate-limited after auth-failure banner'
    );
    const msFromNow = until!.getTime() - Date.now();
    // 24h cooldown allows for some clock skew/test latency — accept anything
    // strictly above the 5-minute rate-limit cooldown so we know the longer
    // auth-failure path was taken.
    assert(
      msFromNow > 60 * 60 * 1000,
      `auth-failure cooldown should be > 1h, got ${Math.round(msFromNow / 60000)} min`
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

async function testClaudeCodeBillingFailure_marksPoolTokenLongCooldown() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const banner = 'Credit balance is too low\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: banner }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    const until = row?.rateLimitedUntil;
    assert(
      until instanceof Date,
      'pool integration must be rate-limited after billing-failure banner'
    );
    const msFromNow = until!.getTime() - Date.now();
    assert(
      msFromNow > 60 * 60 * 1000,
      `billing-failure cooldown should be > 1h, got ${Math.round(msFromNow / 60000)} min`
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

async function testClaudeCodeExhaustion_noBannerNoOp() {
  const caller = await createAnonSession();
  const poolOwner = await createAnonSession();
  const poolInt = await seedClaudeIntegration(poolOwner.userId, { poolingEnabled: true });
  const dummyAgent = await prisma.agent.create({
    data: {
      id: crypto.randomUUID(),
      userId: caller.userId,
      goal: 'dummy-for-claude-code-test',
      status: 'STARTING_UP',
    },
  });
  const session = await seedClaudeCodeSession(dummyAgent.id, 'pool', poolInt.id);

  try {
    const benignOutput = 'Computing Collatz sequence... done. Result: 27, 82, 41, ..., 1\n';
    const res = await request(`${BASE_URL}/api/claude-code-session/${session.taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output: benignOutput }),
    });
    assertStatus(res.status, 200, res.data);

    const row = await prisma.integration.findUnique({ where: { id: poolInt.id } });
    assert(
      row?.rateLimitedUntil === null,
      'integration must NOT be rate-limited when banner is absent'
    );
  } finally {
    await cleanupSessions([session.taskId]);
    await prisma.agent.delete({ where: { id: dummyAgent.id } });
    await cleanupIntegrations([poolInt.id]);
  }
}

// --- Claude Code token: exercises internal auth paths ---

async function testClaudeCodeToken_viaApiKeyInternal() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: { ...apiKeyHeaders(ctx.userId1), 'X-Force-Pool': 'true' },
  });
  // Exercises the forcePool=true path; anon user without onboarding → 404
  if (res.status !== 404 && res.status !== 200) {
    throw new Error(`Expected 200 or 404, got ${res.status}`);
  }
}

async function testClaudeCodeToken_excludePoolTokens() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: {
      ...apiKeyHeaders(ctx.userId1),
      'X-Force-Pool': 'true',
      'X-Exclude-Pool-Tokens': 'token1,token2,token3',
    },
  });
  // Exercises excludePoolTokenIds path
  if (res.status !== 404 && res.status !== 200) {
    throw new Error(`Expected 200 or 404 with exclude tokens, got ${res.status}`);
  }
}

// --- VCF contacts upload: exercises processContactsUpload with valid VCF ---

async function testContactsUpload_validVcf() {
  const vcfContent = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:John Test',
    'N:Test;John;;;',
    'TEL;TYPE=CELL:+15551234567',
    'EMAIL:john.test@example.com',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Jane Doe',
    'N:Doe;Jane;;;',
    'EMAIL:jane.doe@example.com',
    'END:VCARD',
  ].join('\r\n');

  const res = await uploadFileToIntegrations(
    '/contacts/upload',
    ctx.accessToken1!,
    'contacts.vcf',
    vcfContent,
    'text/vcard'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; parsed: number; created: number; updated: number };
  assert(body.parsed === 2, `Expected 2 parsed contacts, got ${body.parsed}`);
  assert(
    body.message.includes('imported'),
    `Expected import success message, got: ${body.message}`
  );
}

async function testContactsUpload_emptyVcf() {
  const vcfContent = '';
  const res = await uploadFileToIntegrations(
    '/contacts/upload',
    ctx.accessToken1!,
    'empty.vcf',
    vcfContent,
    'text/vcard'
  );
  // Empty VCF should still succeed but with 0 parsed contacts
  if (res.status === 200) {
    const body = res.data as { parsed: number };
    assert(body.parsed === 0, `Expected 0 parsed contacts from empty VCF, got ${body.parsed}`);
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for empty VCF, got ${res.status}`);
  }
}

// --- Generic file upload: with different integration types ---

async function testGenericUpload_toolSetupType() {
  const res = await uploadFileToIntegrations(
    '/upload',
    ctx.accessToken1!,
    'tool-config.json',
    '{"tool": "test_tool", "config": true}',
    'application/json',
    { integrationType: 'custom_tool_config' }
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; integration: { name: string } };
  assert(
    body.integration.name === 'custom_tool_config',
    `Expected custom_tool_config, got ${body.integration.name}`
  );
}

// --- Integration list: exercises getIntegrations with authenticated domains ---

async function testList_withApiKey() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: apiKeyHeaders(ctx.userId1),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations via API key');
  assert(Array.isArray(body.authenticatedDomains), 'Expected authenticatedDomains array');
  assert(typeof body.count === 'number', 'Expected count number');
}

// --- Passwords request: exercises sendPasswordRequest path ---

async function testPasswordsRequest_longRequest() {
  const longRequest = 'I need a password manager integration. '.repeat(10);
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: longRequest }),
  });
  // Should work even with long request text (exercises request.trim() and substring)
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for long request, got ${res.status}`);
  }
}

// ==================== DEEP COVERAGE — SERVICE PATHS ====================

// 1. Create integration with invalid type → exercises InvalidIntegrationTypeError
async function testCreateIntegration_invalidType() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ name: 'test-invalid', type: 'INVALID_TYPE' }),
  });
  // Should reject with 400 for invalid integration type
  if (res.status !== 400) {
    throw new Error(`Expected 400 for invalid type, got ${res.status}`);
  }
}

// 2. Update integration with invalid status → exercises invalid status validation
async function testUpdateIntegration_invalidStatus() {
  const session = await createAnonSession();
  // Create a valid integration first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ name: 'test-upd-status', type: 'DATA_SOURCE' }),
  });
  // Try to update with invalid status
  const res = await request(`${BASE_URL}/api/integrations/test-upd-status`, {
    method: 'PATCH',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ status: 'FAKE_STATUS' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for invalid status, got ${res.status}`);
  }
}

// 3. Token rate-limited with invalid source → exercises error in markTokenRateLimited
async function testRateLimited_invalidSource() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'INVALID_SOURCE' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for invalid source, got ${res.status}`);
  }
}

// 4. Token rate-limited pool source missing poolTokenId
async function testRateLimited_poolMissingId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'pool' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for pool missing id, got ${res.status}`);
  }
}

// 5. Token rate-limited user source missing userId
async function testRateLimited_userMissingUserId() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ source: 'user' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400/500 for user missing userId, got ${res.status}`);
  }
}

// 6. Get integrations for user without cached domains (exercises !hasCachedDomains branch)
async function testGetIntegrations_noCachedDomains() {
  const session = await createAnonSession();
  // First call - no cached domains
  const res1 = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(session.accessToken),
  });
  assertStatus(res1.status, 200, res1.data);
  // Second call - domains should now be cached
  const res2 = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(session.accessToken),
  });
  assertStatus(res2.status, 200, res2.data);
}

// 7. Email messages fetch for user without Gmail integration
async function testEmailMessages_noGmail() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/messages`, {
    headers: authHeaders(session.accessToken),
  });
  // Should return error about Gmail not connected
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400/404 for no Gmail, got ${res.status}`);
  }
}

// 8. Email send for user without Gmail credentials
async function testEmailSend_noGmail() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Test',
      body: 'Test body',
      from_email: 'nonexistent@gmail.com',
    }),
  });
  if (res.status !== 400 && res.status !== 404) {
    throw new Error(`Expected 400/404 for no Gmail creds, got ${res.status}`);
  }
}

// 9. Password request
async function testPasswordRequest_happy() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify({ request: 'Please add support for 1Password' }),
  });
  // Should succeed (sends SMS to admin) or fail gracefully
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200/500 for password request, got ${res.status}`);
  }
}

// 10. Claude Code credentials token for user without onboarding
async function testClaudeCodeToken_noOnboarding() {
  const session = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: await authHeadersWithoutExistingClaudePools(session.accessToken),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'claude-code token no onboarding missing');
}

async function testDocumentsUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'apple_notes',
      documents: [
        {
          externalId: 'note-connectors-1',
          title: 'Connector planning',
          content: 'Apple Notes connector should preserve user preference details.',
          sourceUpdatedAt: '2026-07-03T12:00:00Z',
          metadata: { folder: 'Product' },
        },
      ],
      snapshotRevision: {
        documentExternalId: 'note-connectors-1',
        before: {},
        after: {
          preferences: {
            agent_data_sources: ['apple_notes'],
          },
        },
        changes: { preferences: ['agent_data_sources'] },
        model: 'test-distiller',
        promptKey: 'user-snapshot-v1',
      },
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(DocumentsUploadResponse, res.data, 'documents upload');
  if (
    body.integration.name !== 'apple_notes' ||
    body.integration.status !== 'CONNECTED' ||
    body.documentCount !== 1 ||
    body.snapshotRevision?.snapshotVersion !== 1 ||
    body.syncState.source !== 'apple_notes' ||
    body.syncState.status !== 'CONNECTED' ||
    body.dryRun
  ) {
    throw new Error(`Unexpected documents upload response: ${JSON.stringify(body)}`);
  }

  const snapshot = await prisma.userSnapshot.findUnique({ where: { userId: ctx.userId1! } });
  if (
    snapshot === null ||
    snapshot.version !== 1 ||
    JSON.stringify(snapshot.content).indexOf('apple_notes') === -1
  ) {
    throw new Error(`Expected persisted snapshot, got ${JSON.stringify(snapshot)}`);
  }

  const syncState = await prisma.userDataProviderSyncState.findUnique({
    where: { userId_source: { userId: ctx.userId1!, source: 'apple_notes' } },
  });
  if (
    syncState === null ||
    syncState.status !== 'CONNECTED' ||
    syncState.lastSuccessfulSyncAt === null ||
    syncState.nextSyncAt === null ||
    !syncState.realtimeEnabled
  ) {
    throw new Error(`Expected persisted Apple Notes sync state, got ${JSON.stringify(syncState)}`);
  }
}

async function testDocumentsUpload_idempotentUpsert() {
  const externalId = `obsidian-idempotent-${crypto.randomUUID()}`;
  const first = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'obsidian',
      documents: [
        {
          externalId,
          title: 'Idempotent note',
          content: 'Obsidian first version contains Helios marker.',
          sourceUpdatedAt: '2026-07-03T12:00:00Z',
          metadata: { vault: 'main', path: 'Idempotent.md' },
        },
      ],
    }),
  });
  assertStatus(first.status, 200, first.data);
  const firstBody = assertSchema(DocumentsUploadResponse, first.data, 'documents first upload');

  const second = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'obsidian',
      documents: [
        {
          externalId,
          title: 'Idempotent note updated',
          content: 'Obsidian second version contains Helios marker and update marker.',
          sourceUpdatedAt: '2026-07-03T12:10:00Z',
          metadata: { vault: 'main', path: 'Idempotent.md', tags: ['updated'] },
        },
      ],
    }),
  });
  assertStatus(second.status, 200, second.data);
  const secondBody = assertSchema(DocumentsUploadResponse, second.data, 'documents second upload');
  if (firstBody.documents[0]?.id !== secondBody.documents[0]?.id) {
    throw new Error(
      `Expected idempotent document id, got ${JSON.stringify({ firstBody, secondBody })}`
    );
  }

  const rows = await prisma.userDataDocument.findMany({
    where: { userId: ctx.userId1!, source: 'obsidian', externalId },
  });
  if (
    rows.length !== 1 ||
    rows[0]?.title !== 'Idempotent note updated' ||
    rows[0]?.deletedAt !== null
  ) {
    throw new Error(`Expected one updated document row, got ${JSON.stringify(rows)}`);
  }
}

async function testDocumentsUpload_dryRunDoesNotPersist() {
  const externalId = `dry-run-${crypto.randomUUID()}`;
  const res = await request(`${BASE_URL}/api/integrations/documents/upload`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1),
    body: JSON.stringify({
      source: 'chatgpt',
      dryRun: true,
      documents: [
        {
          externalId,
          title: 'Dry run prod smoke',
          content: 'Dry run validates prod path without persistence.',
          metadata: { provider: 'chatgpt' },
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(DocumentsUploadResponse, res.data, 'documents dry run');
  if (!body.dryRun || body.integration.id !== 'dry-run' || body.syncState.id !== 'dry-run') {
    throw new Error(`Unexpected dry-run response: ${JSON.stringify(body)}`);
  }

  const persisted = await prisma.userDataDocument.findFirst({
    where: { userId: ctx.userId1!, source: 'chatgpt', externalId },
  });
  if (persisted !== null) {
    throw new Error(`Dry-run upload persisted a document: ${JSON.stringify(persisted)}`);
  }
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Integrations Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Phase 1: Setup
  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId1}`);
  console.log(`  User 2: ${ctx.userId2}`);
  console.log(`  Capture available: ${ctx.captureAvailable}\n`);

  // Phase 2: Parallel independent tests
  const parallelTests = [
    // Auth boundary (401)
    { name: 'GET / no auth -> 401', fn: testList_noAuth },
    { name: 'POST / no auth -> 401', fn: testCreate_noAuth },
    { name: 'PATCH /:name no auth -> 401', fn: testPatch_noAuth },
    { name: 'DELETE /:name no auth -> 401', fn: testDelete_noAuth },
    { name: 'POST /imessage/upload no auth -> 401', fn: testImessageUpload_noAuth },
    { name: 'POST /whatsapp/upload no auth -> 401', fn: testWhatsappUpload_noAuth },
    { name: 'POST /telegram/connect no auth -> 401', fn: testTelegramConnect_noAuth },
    { name: 'POST /telegram/upload no auth -> 401', fn: testTelegramUpload_noAuth },
    { name: 'POST /cookies/upload no auth -> 401', fn: testCookiesUpload_noAuth },
    { name: 'POST /localStorage/upload no auth -> 401', fn: testLocalStorageUpload_noAuth },
    { name: 'POST /indexedDB/upload no auth -> 401', fn: testIndexedDBUpload_noAuth },
    { name: 'POST /fingerprint/upload no auth -> 401', fn: testFingerprintUpload_noAuth },
    { name: 'POST /permissions/upload no auth -> 401', fn: testPermissionsUpload_noAuth },
    { name: 'POST /cacheStorage/upload no auth -> 401', fn: testCacheStorageUpload_noAuth },
    { name: 'POST /passwords/upload no auth -> 401', fn: testPasswordsUpload_noAuth },
    { name: 'POST /passwords/apple/upload no auth -> 401', fn: testApplePasswordsUpload_noAuth },
    { name: 'POST /passwords/request no auth -> 401', fn: testPasswordsRequest_noAuth },
    { name: 'POST /email/start no auth -> 401', fn: testEmailStart_noAuth },
    { name: 'GET /email/messages no auth -> 401', fn: testEmailMessages_noAuth },
    {
      name: 'DELETE /email/gmail/accounts/:email no auth -> 401',
      fn: testEmailGmailAccountDelete_noAuth,
    },
    { name: 'POST /email/send no auth -> 401', fn: testEmailSend_noAuth },
    { name: 'POST /upload no auth -> 401', fn: testUpload_noAuth },
    { name: 'POST /linkedin/upload no auth -> 401', fn: testLinkedinUpload_noAuth },
    { name: 'POST /contacts/upload no auth -> 401', fn: testContactsUpload_noAuth },
    { name: 'POST /email/upload no auth -> 401', fn: testEmailUpload_noAuth },
    {
      name: 'POST /claude-code/credentials/upload no auth -> 401',
      fn: testClaudeCodeCredentials_noAuth,
    },
    { name: 'GET /claude-code/credentials/token no auth -> 401', fn: testClaudeCodeToken_noAuth },
    {
      name: 'POST /claude-code/token/rate-limited no auth -> 401',
      fn: testClaudeCodeRateLimited_noAuth,
    },
    {
      name: 'POST /claude-code/pool-token/rate-limited no auth -> 401',
      fn: testClaudeCodePoolRateLimited_noAuth,
    },

    // List
    { name: 'GET / happy path', fn: testList_happyPath },
    { name: 'GET / empty for new user', fn: testList_emptyForNewUser },

    // Create
    { name: 'POST / missing name -> 400', fn: testCreate_missingName },
    { name: 'POST / missing type -> 400', fn: testCreate_missingType },
    { name: 'POST / invalid type -> 400', fn: testCreate_invalidType },
    { name: 'POST / happy path (DATA_SOURCE)', fn: testCreate_happyPath },
    { name: 'POST / happy path (TOOL_SETUP)', fn: testCreate_toolSetupType },

    // Idempotency
    { name: 'POST / upsert is idempotent', fn: testCreate_upsertIdempotent },

    // Read-after-write
    { name: 'create then list includes it', fn: testReadAfterWrite_createThenList },

    // Patch
    { name: 'PATCH /:name happy path', fn: testPatch_happyPath },
    { name: 'PATCH /:name not found -> 404', fn: testPatch_notFound },

    // Delete
    { name: 'DELETE /:name happy path', fn: testDelete_happyPath },
    { name: 'DELETE /:name not found -> 404', fn: testDelete_notFound },
    { name: 'DELETE /:name verify gone from list', fn: testDelete_verifyGone },

    // Tenant isolation
    { name: 'tenant isolation -- separate user lists', fn: testTenantIsolation_separateUsers },
    {
      name: 'tenant isolation -- cross-user patch -> 404',
      fn: testTenantIsolation_patchOtherUserIntegration,
    },
    {
      name: 'tenant isolation -- cross-user delete -> 404',
      fn: testTenantIsolation_deleteOtherUserIntegration,
    },

    // Error surface
    { name: 'error surface -- 401s have error field', fn: testErrorSurface_401sHaveErrorField },
    { name: 'error surface -- 400s have error field', fn: testErrorSurface_400sHaveErrorField },
    { name: 'error surface -- 404s have error field', fn: testErrorSurface_404sHaveErrorField },

    // Messaging uploads
    { name: 'POST /imessage/upload empty contacts -> 400', fn: testImessageUpload_emptyContacts },
    {
      name: 'POST /imessage/upload missing contacts -> 400',
      fn: testImessageUpload_missingContacts,
    },
    { name: 'POST /imessage/upload happy path', fn: testImessageUpload_happyPath },
    { name: 'POST /whatsapp/upload empty contacts -> 400', fn: testWhatsappUpload_emptyContacts },
    { name: 'POST /whatsapp/upload happy path', fn: testWhatsappUpload_happyPath },
    { name: 'POST /telegram/connect happy path', fn: testTelegramConnect_happyPath },
    { name: 'POST /telegram/upload empty contacts -> 400', fn: testTelegramUpload_emptyContacts },
    { name: 'POST /telegram/upload happy path', fn: testTelegramUpload_happyPath },

    // Encrypted uploads
    { name: 'POST /cookies/upload missing fields -> 400', fn: testCookiesUpload_missingFields },
    { name: 'POST /cookies/upload invalid browser -> 400', fn: testCookiesUpload_invalidBrowser },
    { name: 'POST /cookies/upload bad encryption -> 400', fn: testCookiesUpload_invalidEncryption },
    { name: 'POST /cookies/upload happy path', fn: testCookiesUpload_happyPath },
    {
      name: 'POST /localStorage/upload missing fields -> 400',
      fn: testLocalStorageUpload_missingFields,
    },
    { name: 'POST /localStorage/upload happy path', fn: testLocalStorageUpload_happyPath },
    { name: 'POST /indexedDB/upload happy path', fn: testIndexedDBUpload_happyPath },
    {
      name: 'POST /fingerprint/upload missing fields -> 400',
      fn: testFingerprintUpload_missingFields,
    },
    {
      name: 'POST /fingerprint/upload invalid payload -> 400',
      fn: testFingerprintUpload_invalidPayload,
    },
    { name: 'POST /fingerprint/upload happy path', fn: testFingerprintUpload_happyPath },
    { name: 'POST /permissions/upload happy path', fn: testPermissionsUpload_happyPath },
    { name: 'POST /cacheStorage/upload happy path', fn: testCacheStorageUpload_happyPath },
    { name: 'POST /passwords/upload missing fields -> 400', fn: testPasswordsUpload_missingFields },
    { name: 'POST /passwords/upload happy path', fn: testPasswordsUpload_happyPath },
    {
      name: 'POST /passwords/upload apple source marks Apple Passwords connected',
      fn: testPasswordsUpload_appleSourceMarksApplePasswordsIntegration,
    },
    { name: 'POST /documents/upload happy path', fn: testDocumentsUpload_happyPath },
    { name: 'POST /documents/upload idempotent upsert', fn: testDocumentsUpload_idempotentUpsert },
    { name: 'POST /documents/upload dry run', fn: testDocumentsUpload_dryRunDoesNotPersist },

    // Encrypted upload error-path coverage (decryption-failure + shape-validation branches)
    {
      name: 'POST /cookies/upload decoded not array -> 400',
      fn: testCookiesUpload_decodedNotArray,
    },
    {
      name: 'POST /cookies/upload large batch + duplicates',
      fn: testCookiesUpload_largeBatchWithDuplicates,
    },
    {
      name: 'POST /cookies/upload empty name/value filtered',
      fn: testCookiesUpload_emptyNameValueFiltered,
    },
    {
      name: 'POST /cookies/upload alternate browser (edge)',
      fn: testCookiesUpload_alternateBrowser,
    },
    {
      name: 'POST /cookies/upload Safari browser',
      fn: testCookiesUpload_safariBrowser,
    },
    {
      name: 'POST /localStorage/upload bad encryption -> 400',
      fn: testLocalStorageUpload_invalidEncryption,
    },
    {
      name: 'POST /localStorage/upload missing byOrigin -> 400',
      fn: testLocalStorageUpload_missingByOrigin,
    },
    {
      name: 'POST /localStorage/upload null byOrigin -> 400',
      fn: testLocalStorageUpload_nullByOrigin,
    },
    {
      name: 'POST /localStorage/upload byOrigin not object -> 400',
      fn: testLocalStorageUpload_notObjectByOrigin,
    },
    {
      name: 'POST /localStorage/upload orphan UTF-16 surrogates',
      fn: testLocalStorageUpload_orphanSurrogates,
    },
    {
      name: 'POST /localStorage/upload compressed=true happy path',
      fn: testLocalStorageUpload_compressedTrue,
    },
    {
      name: 'POST /indexedDB/upload missing fields -> 400',
      fn: testIndexedDBUpload_missingFields,
    },
    {
      name: 'POST /indexedDB/upload bad encryption -> 400',
      fn: testIndexedDBUpload_invalidEncryption,
    },
    {
      name: 'POST /indexedDB/upload missing origins -> 400',
      fn: testIndexedDBUpload_missingOrigins,
    },
    {
      name: 'POST /indexedDB/upload origins not array -> 400',
      fn: testIndexedDBUpload_originsNotArray,
    },
    {
      name: 'POST /indexedDB/upload errored origins filtered',
      fn: testIndexedDBUpload_erroredOriginsFiltered,
    },
    {
      name: 'POST /fingerprint/upload bad encryption -> 400',
      fn: testFingerprintUpload_invalidEncryption,
    },
    {
      name: 'POST /permissions/upload missing fields -> 400',
      fn: testPermissionsUpload_missingFields,
    },
    {
      name: 'POST /permissions/upload bad encryption -> 400',
      fn: testPermissionsUpload_invalidEncryption,
    },
    {
      name: 'POST /permissions/upload missing grants -> 400',
      fn: testPermissionsUpload_missingGrants,
    },
    {
      name: 'POST /permissions/upload grants not array -> 400',
      fn: testPermissionsUpload_grantsNotArray,
    },
    { name: 'POST /permissions/upload empty grants', fn: testPermissionsUpload_emptyGrants },
    {
      name: 'POST /cacheStorage/upload missing fields -> 400',
      fn: testCacheStorageUpload_missingFields,
    },
    {
      name: 'POST /cacheStorage/upload bad encryption -> 400',
      fn: testCacheStorageUpload_invalidEncryption,
    },
    {
      name: 'POST /cacheStorage/upload missing origins -> 400',
      fn: testCacheStorageUpload_missingOrigins,
    },
    {
      name: 'POST /cacheStorage/upload origins not array -> 400',
      fn: testCacheStorageUpload_originsNotArray,
    },
    {
      name: 'POST /passwords/upload bad encryption -> 400',
      fn: testPasswordsUpload_invalidEncryption,
    },
    {
      name: 'POST /passwords/upload missing passwords -> 400',
      fn: testPasswordsUpload_missingPasswords,
    },
    {
      name: 'POST /passwords/upload passwords not array -> 400',
      fn: testPasswordsUpload_passwordsNotArray,
    },
    { name: 'POST /passwords/upload empty passwords', fn: testPasswordsUpload_emptyPasswords },

    // Claude Code
    {
      name: 'POST /claude-code/credentials/upload missing fields -> 400',
      fn: testClaudeCodeUpload_missingFields,
    },
    { name: 'POST /claude-code/credentials/upload happy path', fn: testClaudeCodeUpload_happyPath },
    {
      name: 'POST /claude-code/credentials/upload rejects undecryptable envelope -> 400',
      fn: testClaudeCodeUpload_rejectsUndecryptable,
    },
    {
      name: 'GET /claude-code/credentials/token not found -> 404',
      fn: testClaudeCodeToken_notFound,
    },
    {
      name: 'POST /claude-code/token/rate-limited forbidden -> 403',
      fn: testClaudeCodeRateLimited_forbidden,
    },
    {
      name: 'POST /claude-code/pool-token/rate-limited forbidden -> 403',
      fn: testClaudeCodePoolRateLimited_forbidden,
    },

    // Email endpoints
    { name: 'POST /email/start invalid provider -> 400', fn: testEmailStart_invalidProvider },
    { name: 'GET /email/messages missing since -> 400', fn: testEmailMessages_missingSince },
    { name: 'GET /email/messages invalid since -> 400', fn: testEmailMessages_invalidSince },
    {
      name: 'GET /email/messages gmail not connected -> 404',
      fn: testEmailMessages_gmailNotConnected,
    },
    { name: 'POST /passwords/request missing -> 400', fn: testPasswordsRequest_missingRequest },
    { name: 'POST /passwords/request empty -> 400', fn: testPasswordsRequest_emptyRequest },

    // OAuth callback (public)
    { name: 'GET /email/callback invalid provider -> 400', fn: testOAuthCallback_invalidProvider },
    { name: 'GET /email/callback missing code -> 400', fn: testOAuthCallback_missingCode },
    { name: 'GET /email/callback missing state -> 400', fn: testOAuthCallback_missingState },
    { name: 'GET /email/callback state not found', fn: testOAuthCallback_stateNotFound },

    // Email send validation
    { name: 'POST /email/start gmail happy path', fn: testEmailStart_gmailHappyPath },
    { name: 'POST /email/start yahoo happy path', fn: testEmailStart_yahooHappyPath },
    { name: 'POST /email/send missing to -> 400', fn: testEmailSend_missingTo },
    { name: 'POST /email/send missing subject -> 400', fn: testEmailSend_missingSubject },
    { name: 'POST /email/send missing body -> 400', fn: testEmailSend_missingBody },
    { name: 'POST /email/send missing from_email', fn: testEmailSend_missingFromEmail },
    { name: 'POST /email/send account not found', fn: testEmailSend_accountNotFound },
    {
      name: 'GET /email/messages valid since empty account',
      fn: testEmailMessages_validSinceEmptyAccount,
    },
    {
      name: 'DELETE /email/gmail/accounts/:email removes one credential',
      fn: testEmailGmailAccountDelete_removesOneCredential,
    },

    // File upload validation
    { name: 'POST /passwords/apple/upload no file -> 400', fn: testApplePasswordsUpload_noFile },
    { name: 'POST /upload no file -> 400', fn: testGenericUpload_noFile },
    { name: 'POST /linkedin/upload no file -> 400', fn: testLinkedinUpload_noFile },
    { name: 'POST /contacts/upload no file -> 400', fn: testContactsUpload_noFile },
    { name: 'POST /email/upload no file -> 400', fn: testEmailArchiveUpload_noFile },

    // Apple passwords CSV upload
    { name: 'POST /passwords/apple/upload valid CSV', fn: testApplePasswordsUpload_validCsv },
    {
      name: 'POST /passwords/apple/upload tab delimited',
      fn: testApplePasswordsUpload_tabDelimited,
    },
    {
      name: 'POST /passwords/apple/upload no valid passwords -> 400',
      fn: testApplePasswordsUpload_noValidPasswords,
    },
    {
      name: 'POST /passwords/apple/upload header only -> 400',
      fn: testApplePasswordsUpload_headerOnly,
    },
    {
      name: 'POST /passwords/apple/upload missing columns -> 400',
      fn: testApplePasswordsUpload_missingColumns,
    },
    {
      name: 'POST /passwords/apple/upload quoted fields',
      fn: testApplePasswordsUpload_quotedFields,
    },
    {
      name: 'POST /passwords/apple/upload dedup origin+username',
      fn: testApplePasswordsUpload_duplicateOriginUsername,
    },

    // Generic file upload
    { name: 'POST /upload with file happy path', fn: testGenericUpload_withFile },
    {
      name: 'POST /upload missing integrationType -> 400',
      fn: testGenericUpload_missingIntegrationType,
    },

    // File type validation
    { name: 'POST /linkedin/upload non-zip -> 400', fn: testLinkedinUpload_nonZipFile },
    { name: 'POST /contacts/upload non-vcf -> 400', fn: testContactsUpload_nonVcfFile },
    { name: 'POST /email/upload non-zip -> 400', fn: testEmailArchiveUpload_nonZipFile },

    // Passwords request
    { name: 'POST /passwords/request happy path', fn: testPasswordsRequest_happyPath },

    // Integration CRUD edge cases
    { name: 'PATCH /:name with status change', fn: testPatch_withStatusChange },
    { name: 'PATCH /:name with invalid status', fn: testPatch_withInvalidStatus },
    { name: 'PATCH /:name with config update', fn: testPatch_withConfigUpdate },

    // Additional coverage tests (OAuth, CRUD, email, Claude Code)
    { name: 'POST /email/gmail/start with returnUrl', fn: testOAuthStart_gmail },
    { name: 'POST /email/yahoo/start', fn: testOAuthStart_yahoo },
    {
      name: 'POST /email/outlook/start invalid provider -> 400',
      fn: testOAuthStart_invalidProvider,
    },
    { name: 'POST /email/gmail/start no auth -> 401', fn: testOAuthStart_noAuth },
    { name: 'GET /email/gmail/callback no code -> 400', fn: testOAuthCallback_noCode },
    { name: 'GET /email/gmail/callback invalid state', fn: testOAuthCallback_invalidState },
    { name: 'GET / empty for new anon user', fn: testGetIntegrations_empty },
    { name: 'POST / create basic DATA_SOURCE', fn: testCreateIntegration_basic },
    { name: 'PATCH /:name update status to CONNECTED', fn: testUpdateIntegration_status },
    { name: 'DELETE /:name basic delete + verify', fn: testDeleteIntegration_basic },
    { name: 'POST /email/send missing all fields -> 400', fn: testEmailSend_missingFields },
    { name: 'POST /email/send no auth -> 401 (coverage)', fn: testEmailSend_noAuthCoverage },
    { name: 'GET /email/messages no auth -> 401 (coverage)', fn: testEmailMessages_noAuthCoverage },
    { name: 'GET /email/messages empty (no gmail) -> 404', fn: testEmailMessages_empty },
    { name: 'POST /passwords/request basic', fn: testPasswordsRequest_basic },
    {
      name: 'POST /claude-code/credentials/upload with payload',
      fn: testClaudeCodeCredentials_upload,
    },
    {
      name: 'GET /claude-code/credentials/token anon -> 404',
      fn: testClaudeCodeCredentials_getToken,
    },
    { name: 'POST /claude-code/token/rate-limited internal', fn: testClaudeCodeTokenRateLimited },
    { name: 'integration CRUD full lifecycle', fn: testIntegrationCRUD_fullLifecycle },
    { name: 'POST /email/send with from_email no gmail', fn: testEmailSend_withCredentials },

    // Deep coverage tests
    {
      name: 'POST /email/gmail/start PKCE fields verification',
      fn: testEmailStart_gmailPkceFields,
    },
    { name: 'POST /email/yahoo/start OAuth URL verification', fn: testEmailStart_yahooOAuthUrl },
    { name: 'GET /email/yahoo/callback invalid state', fn: testOAuthCallback_yahooInvalidState },
    {
      name: 'GET /email/gmail/callback missing both params',
      fn: testOAuthCallback_missingBothParams,
    },
    { name: 'PATCH /:name isActive toggle', fn: testPatch_isActiveToggle },
    {
      name: 'PATCH /:name status + config + isActive together',
      fn: testPatch_statusAndConfigTogether,
    },
    { name: 'POST /email/send no from_email no accounts', fn: testEmailSend_noFromEmailNoAccounts },
    { name: 'GET /email/messages limit clamping (999)', fn: testEmailMessages_limitClamping },
    { name: 'GET /email/messages limit negative (-5)', fn: testEmailMessages_limitNegative },
    {
      name: 'POST /claude-code/token/rate-limited pool source',
      fn: testClaudeCodeRateLimited_poolSource,
    },
    {
      name: 'POST /claude-code/token/rate-limited invalid source',
      fn: testClaudeCodeRateLimited_invalidSource,
    },
    {
      name: 'POST /claude-code/token/rate-limited pool missing id',
      fn: testClaudeCodeRateLimited_poolMissingId,
    },
    {
      name: 'POST /claude-code/token/rate-limited user missing userId',
      fn: testClaudeCodeRateLimited_userMissingUserId,
    },
    {
      name: 'POST /claude-code/pool-token/rate-limited happy path',
      fn: testClaudeCodePoolRateLimited_happyPath,
    },
    {
      name: 'POST /claude-code/pool-token/rate-limited missing id',
      fn: testClaudeCodePoolRateLimited_missingPoolTokenId,
    },
    {
      name: 'GET /claude-code/credentials/token via API key (forcePool)',
      fn: testClaudeCodeToken_viaApiKeyInternal,
    },
    {
      name: 'GET /claude-code/credentials/token exclude pool tokens',
      fn: testClaudeCodeToken_excludePoolTokens,
    },
    { name: 'POST /contacts/upload valid VCF', fn: testContactsUpload_validVcf },
    { name: 'POST /contacts/upload empty VCF', fn: testContactsUpload_emptyVcf },
    { name: 'POST /upload tool_setup integration type', fn: testGenericUpload_toolSetupType },
    { name: 'GET / via API key with X-User-Id', fn: testList_withApiKey },
    { name: 'POST /passwords/request long request text', fn: testPasswordsRequest_longRequest },

    // Deep coverage — service paths
    {
      name: 'POST / create with invalid type -> service error',
      fn: testCreateIntegration_invalidType,
    },
    {
      name: 'PATCH /:name update with invalid status -> service error',
      fn: testUpdateIntegration_invalidStatus,
    },
    {
      name: 'POST /claude-code/token/rate-limited invalid source',
      fn: testRateLimited_invalidSource,
    },
    {
      name: 'POST /claude-code/token/rate-limited pool missing poolTokenId',
      fn: testRateLimited_poolMissingId,
    },
    {
      name: 'POST /claude-code/token/rate-limited user missing userId',
      fn: testRateLimited_userMissingUserId,
    },
    { name: 'GET / no cached domains branch', fn: testGetIntegrations_noCachedDomains },
    { name: 'GET /email/messages no Gmail integration', fn: testEmailMessages_noGmail },
    { name: 'POST /email/send no Gmail credentials', fn: testEmailSend_noGmail },
    { name: 'POST /passwords/request happy path (anon session)', fn: testPasswordRequest_happy },
    {
      name: 'GET /claude-code/credentials/token no onboarding -> 404',
      fn: testClaudeCodeToken_noOnboarding,
    },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of parallelResults) {
    const icon = r.passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`);
  }

  // Phase 3: Sequential tests (state-dependent + boundary capture)
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'state transition -- full lifecycle', fn: testStateTransition_fullLifecycle },
    {
      name: 'anthropic api-key cooldown -- mark then on-cooldown',
      fn: testAnthropicApiKeyCooldown_markThenOnCooldown,
    },
  ];

  // Pool-mutating sequential tests: seed/select/disable rows in the SHARED
  // compute-token pool and assert exact LRU selection. Run under the
  // cross-process advisory lock (see withComputePoolLock) so a concurrent
  // suite instance sharing this database cannot perturb pool state mid-test.
  const pooledSequentialTests: { name: string; fn: () => Promise<void> }[] = [
    {
      name: 'rotation -- user rate-limited falls back to pool',
      fn: testRotation_userRateLimitedFallsBackToPool,
    },
    { name: 'rotation -- pool rotates on rate-limit', fn: testRotation_poolRotatesOnRateLimit },
    {
      name: 'rotation -- pool auth_error disables token',
      fn: testRotation_poolAuthErrorDisablesToken,
    },
    {
      name: 'rotation -- user auth_error disables token',
      fn: testRotation_userAuthErrorDisablesToken,
    },
    {
      name: 'rotation -- GPT user auth_error disables token',
      fn: testRotation_gptUserAuthErrorDisablesToken,
    },
    {
      name: 'GPT upload -- clears expired/cooldown state',
      fn: testGptCodeUpload_clearsExpiredAndRateLimitState,
    },
    {
      name: 'rotation -- compute pool rotates across providers',
      fn: testComputeRotation_poolRotatesAcrossProviders,
    },
    {
      name: 'compute token lineage semaphore -- caps live GPT leases',
      fn: testComputeTokenLineageSemaphore_capsLiveGptLeases,
    },
    {
      name: 'compute token fast-cache affinity -- pins provider family',
      fn: testComputeTokenFastCacheAffinity_pinsProviderFamily,
    },
    {
      name: 'rotation -- auto-expires after cooldown (time-windowed)',
      fn: testRotation_autoExpiresAfterCooldown,
    },
    { name: 'rotation -- all exhausted returns 404', fn: testRotation_allExhausted404 },
    {
      name: 'rotation -- default cooldown is bounded (not permanent)',
      fn: testRotation_defaultCooldownIsBounded,
    },
    {
      name: 'claude-code upload -- clears stale rate-limit cooldown',
      fn: testClaudeCodeUpload_clearsRateLimitCooldown,
    },
    {
      name: 'claude-code exhaustion -- pool token marked rate-limited at parsed reset time',
      fn: testClaudeCodeExhaustion_marksPoolToken,
    },
    {
      name: 'claude-code exhaustion -- user token marked rate-limited (12h format)',
      fn: testClaudeCodeExhaustion_marksUserToken,
    },
    {
      name: 'claude-code exhaustion -- benign output is no-op',
      fn: testClaudeCodeExhaustion_noBannerNoOp,
    },
    {
      name: 'claude-code auth-failure -- pool token marked rate-limited with long cooldown',
      fn: testClaudeCodeAuthFailure_marksPoolTokenLongCooldown,
    },
    {
      name: 'claude-code billing-failure -- pool token marked rate-limited with long cooldown',
      fn: testClaudeCodeBillingFailure_marksPoolTokenLongCooldown,
    },
  ];

  const boundarySequentialTests: { name: string; fn: () => Promise<void> }[] = [];
  if (ctx.captureAvailable) {
    boundarySequentialTests.push(
      { name: 'boundary -- create makes no outbound calls', fn: testBoundary_createNoOutbound },
      {
        name: 'boundary -- email/start makes no outbound calls',
        fn: testBoundary_emailStartNoOutbound,
      },
      {
        name: 'boundary -- validation failure makes no outbound calls',
        fn: testBoundary_validationNoOutbound,
      },
      {
        name: 'boundary -- email/messages validation no outbound',
        fn: testBoundary_emailMessagesValidationNoOutbound,
      },
      { name: 'boundary -- passwords/request SMS boundary', fn: testBoundary_passwordsRequestSms },
      {
        name: 'boundary -- telegram/connect no outbound',
        fn: testBoundary_telegramConnectNoOutbound,
      }
    );
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  const totalSequential =
    sequentialTests.length + pooledSequentialTests.length + boundarySequentialTests.length;
  console.log(`\nRunning ${totalSequential} sequential tests...`);
  const sequentialResults: TestResult[] = [];
  const runSequentialGroup = async (tests: { name: string; fn: () => Promise<void> }[]) => {
    for (const test of tests) {
      const result = await runTest(test.name, test.fn);
      sequentialResults.push(result);
      const icon = result.passed ? '  PASS' : '  FAIL';
      console.log(
        `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
      );
    }
  };
  await runSequentialGroup(sequentialTests);
  await withComputePoolLock(() => runSequentialGroup(pooledSequentialTests));
  await runSequentialGroup(boundarySequentialTests);

  // Summary
  const allResults = [...parallelResults, ...sequentialResults];
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);

  await teardown();

  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\nALL INTEGRATIONS BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch(async (error) => {
  console.error('\nBlack-box test suite crashed:', error);
  await teardown().catch((e) => console.error('Teardown also failed:', e));
  process.exit(1);
});
