import { config } from 'dotenv';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import {
  processGoogleDataPurge,
  runGoogleDataPurgeJob,
} from '../../services/integrations/googleDataPurge';
import { revokeQueuedGoogleGrants } from '../../services/integrations/googleDisconnect';
import { upsertPersonAndMessageRecords } from '../../services/integrations/personMessageManager';
import {
  classifyEmailAuthFailure,
  markCredentialFailure,
} from '../../services/integrations/emailCredentialHealth';
import {
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
} from '../../providers/computeCredentials';
import {
  fetchClaudeCodeCredentialsWithMeta,
  markUserTokenRateLimited,
} from '../../providers/claudeCredentials';
import { withComputePoolLock } from './compute-pool-lock.testkit';
import { cooldownIsLive, waitForServerFundedKeyCooldown } from './funded-key-cooldown.support';
import { generateSupabaseSession } from '../../providers/sessionTokens';
import { testLanternCredentials } from './integrations.lantern.cases';
import { AnonymousResponse } from './integrations.schemas';
export {
  ErrorResponse,
  IntegrationSchema,
  ListIntegrationsResponse,
  CreateIntegrationResponse,
  PatchIntegrationResponse,
  DeleteIntegrationResponse,
  MessagingUploadResponse,
  TelegramConnectResponse,
  CookiesUploadResponse,
  LocalStorageUploadResponse,
  IndexedDBUploadResponse,
  FingerprintUploadResponse,
  PermissionsUploadResponse,
  CacheStorageUploadResponse,
  PasswordsUploadResponse,
  ClaudeCodeUploadResponse,
  DocumentsUploadResponse,
  AnonymousResponse,
} from './integrations.schemas';
export {
  config,
  z,
  crypto,
  prisma,
  retryWithBackoff,
  processGoogleDataPurge,
  runGoogleDataPurgeJob,
  revokeQueuedGoogleGrants,
  upsertPersonAndMessageRecords,
  classifyEmailAuthFailure,
  markCredentialFailure,
  __resetAnthropicApiKeyCooldown,
  isAnthropicApiKeyOnCooldown,
  fetchClaudeCodeCredentialsWithMeta,
  markUserTokenRateLimited,
  withComputePoolLock,
  cooldownIsLive,
  waitForServerFundedKeyCooldown,
  generateSupabaseSession,
  testLanternCredentials,
};

config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

export const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');

export const API_KEY = process.env.BACKEND_API_KEY || '';

// ==================== CAPTURE TYPES ====================

export interface CapturedCall {
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

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

export interface TestContext {
  accessToken1?: string;
  userId1?: string;
  accessToken2?: string;
  userId2?: string;
  captureAvailable: boolean;
}

export const ctx: TestContext = { captureAvailable: false };

export async function request(
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

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function authHeadersWithoutExistingClaudePools(
  token: string
): Promise<Record<string, string>> {
  const headers = authHeaders(token);
  const poolIds = await existingPoolIds();
  if (poolIds.length > 0) {
    headers['X-Exclude-Pool-Tokens'] = poolIds.join(',');
  }
  return headers;
}

export function apiKeyHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) h['X-User-Id'] = userId;
  return h;
}

export async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
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

export function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 500)}`
    );
  }
}

export function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Infrastructure URLs from concurrent tests (not from the endpoint under test). */
export const INFRA_URL_PATTERNS = [
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
  'connect.steelbrowser.com',
  'connect.steel.dev',
  'api.steel.dev',
  'perplexity.ai',
  'exa.ai',
  'vapi.ai',
  'googleapis.com',
];

export function filterInfraCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((c) => !INFRA_URL_PATTERNS.some((p) => c.url.includes(p)));
}

export async function runPool(
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
export function encryptPayload(payload: unknown): { data: string; iv: string; key: string } {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const plaintext = JSON.stringify(payload);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { data: encrypted, iv: iv.toString('hex'), key: aesKey.toString('hex') };
}

// ==================== CAPTURE HELPERS ====================

export async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

export function captureToken(prefix: string): string {
  return `integrations-${prefix}-${crypto.randomUUID()}`;
}

export async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

export const createdAnonUserIds = new Set<string>();

export async function createAnonSession(): Promise<{ accessToken: string; userId: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'anonymous setup');
  createdAnonUserIds.add(body.user.id);
  return { accessToken: body.session.access_token, userId: body.user.id };
}

export async function teardown(): Promise<void> {
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
export function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ==================== SETUP ====================

export async function setup(): Promise<void> {
  const [s1, s2] = await Promise.all([createAnonSession(), createAnonSession()]);
  ctx.accessToken1 = s1.accessToken;
  ctx.userId1 = s1.userId;
  ctx.accessToken2 = s2.accessToken;
  ctx.userId2 = s2.userId;
  ctx.captureAvailable = await checkCaptureAvailable();
}

// The shared ANTHROPIC_API_KEY funded default: marking it out-of-credits via
// the rate-limited endpoint (type=anthropic) backs off a shared DB cooldown the
// agents Rose client reads (it has no DB). Mark → cooldown GET reports true.
export const ANTHROPIC_COOLDOWN_USER_ID = '00000000-0000-0000-0000-000000000000';

export const ANTHROPIC_COOLDOWN_NAME = 'anthropic_api_key_cooldown';

export const GPT_API_KEY_COOLDOWN_NAME = 'gpt_api_key_cooldown';

export async function snapshotAnthropicApiKeyCooldown() {
  return prisma.integration.findUnique({
    where: {
      userId_name_accountId: {
        userId: ANTHROPIC_COOLDOWN_USER_ID,
        name: ANTHROPIC_COOLDOWN_NAME,
        accountId: '',
      },
    },
    select: { id: true, rateLimitedUntil: true, failureReason: true, updatedAt: true },
  });
}

export async function restoreAnthropicApiKeyCooldown(
  previous: Awaited<ReturnType<typeof snapshotAnthropicApiKeyCooldown>>
) {
  if (previous === null) {
    await prisma.integration.deleteMany({
      where: {
        userId: ANTHROPIC_COOLDOWN_USER_ID,
        name: ANTHROPIC_COOLDOWN_NAME,
      },
    });
    return;
  }
  await prisma.integration.update({
    where: { id: previous.id },
    data: {
      rateLimitedUntil: previous.rateLimitedUntil,
      failureReason: previous.failureReason,
      updatedAt: previous.updatedAt,
    },
  });
}

// ==================== IMPERSONATION CONTAINMENT ====================
//
// An impersonated session is an admin VIEWING another account, and every one of
// these endpoints ingests data harvested from the CALLER'S OWN MACHINE. Because
// the mac-app authenticates as the current session, an unguarded upload writes
// the operator's cookies, passwords, iMessage history and provider credentials
// into the viewed user's account — silent cross-account corruption that no later
// fix can un-write. The `act` claim the backend already stamps on impersonated
// tokens is the server-signed signal, so containment belongs HERE and not only
// in the desktop client: a client-side guard is reintroduced by any stale build.

/** Mint a genuine impersonated session, exactly as POST /api/admin-health/impersonate does. */
export function impersonatedTokenFor(targetUserId: string, actorUserId: string): string {
  return generateSupabaseSession(targetUserId, '', { actorUserId }).access_token;
}

/**
 * Every route that ingests machine-harvested data. Enumerated so a new upload
 * endpoint that forgets containment fails this test rather than silently
 * reopening the leak.
 */
export const MACHINE_DATA_INGEST_ROUTES: { path: string; method?: string; body: () => unknown }[] =
  [
    {
      path: '/api/integrations/cookies/upload',
      body: () => ({ ...encryptPayload([]), browser: 'chrome' }),
    },
    { path: '/api/integrations/localStorage/upload', body: () => encryptPayload({ origins: [] }) },
    { path: '/api/integrations/indexedDB/upload', body: () => encryptPayload({ origins: [] }) },
    { path: '/api/integrations/cacheStorage/upload', body: () => encryptPayload({ origins: [] }) },
    {
      path: '/api/integrations/permissions/upload',
      body: () => encryptPayload({ permissions: [] }),
    },
    { path: '/api/integrations/passwords/upload', body: () => encryptPayload([]) },
    {
      path: '/api/integrations/fingerprint/upload',
      body: () => encryptPayload({ navigator: {}, screen: {} }),
    },
    { path: '/api/integrations/passkeys/upload', body: () => encryptPayload([]) },
    { path: '/api/integrations/imessage/upload', body: () => ({ messages: [] }) },
    { path: '/api/integrations/whatsapp/upload', body: () => ({ messages: [] }) },
    { path: '/api/integrations/telegram/upload', body: () => ({ messages: [] }) },
    { path: '/api/integrations/telegram/connect', body: () => ({}) },
    {
      path: '/api/integrations/claude-code/credentials/upload',
      body: () => encryptPayload({ accessToken: 'x' }),
    },
    {
      path: '/api/integrations/gpt-code/credentials/upload',
      body: () => encryptPayload({ accessToken: 'x' }),
    },
    { path: '/api/integrations/upload', body: () => ({ integrationType: 'generic' }) },
    { path: '/api/integrations/linkedin/upload', body: () => ({}) },
    // The export agent reports the session account's LinkedIn sync phases.
    {
      path: '/api/integrations/linkedin/sync/phase',
      body: () => ({ agent_id: 'impersonation-probe', phase: 'export_requested' }),
    },
    { path: '/api/integrations/contacts/upload', body: () => ({}) },
    { path: '/api/integrations/email/upload', body: () => ({}) },
    { path: '/api/integrations/documents/upload', body: () => ({ documents: [] }) },
    { path: '/api/integrations/passwords/apple/upload', body: () => ({}) },
    // Sync progress reports describe THIS machine's sync for the session's account.
    {
      path: '/api/integrations/imessage/accounts/impersonation-probe/progress',
      body: () => ({ runId: 'impersonation-probe', state: 'syncing' }),
    },
    // Outside /api/integrations — these were missed by the first version of this
    // list, and POST /api/upload is the same class as /documents/upload.
    { path: '/api/upload', body: () => ({}) },
    { path: '/api/download-telemetry', body: () => ({ event: 'download_started' }) },
    // Claiming a queued message registers THIS machine as the account's iMessage
    // bridge and sends from it — never on behalf of a viewed user.
    { path: '/api/imessage/queue/pop', method: 'GET', body: () => undefined },
    {
      path: '/api/imessage/queue/00000000-0000-0000-0000-000000000000/result',
      body: () => ({ success: true }),
    },
  ];

// ==================== ENCRYPTED UPLOAD ERROR-PATH COVERAGE ====================
// These tests cover routes.browser.ts decryption-failure and shape-validation
// branches (lines 81-82, 124-128, 135-138, 155-156, 167-181, 205-209, 240-251,
// 258-261, 278-279, 290-294, 301-304, 328-332, 339-342) plus uploadService.browser.ts
// dedupe + sanitize + missing-timestamp branches (lines 35-41, 90-95, 119-137, 213-219).

/** Helper: generate a payload that is decryptable but yields a non-array (for cookies). */
export function encryptNonArray(): { data: string; iv: string; key: string } {
  return encryptPayload({ not: 'an array' });
}

// ==================== FILE UPLOAD HAPPY PATH TESTS ====================

/** Helper: upload a file via multipart/form-data to an integrations endpoint */
export async function uploadFileToIntegrations(
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

export const CLAUDE_DECRYPTION_KEY_B64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY ?? '';

export function claudePublicKeyPem(): string {
  if (CLAUDE_DECRYPTION_KEY_B64 === '') {
    throw new Error('CLAUDE_CREDENTIAL_DECRYPTION_KEY not set — cannot seed token fixtures');
  }
  const privatePem = Buffer.from(CLAUDE_DECRYPTION_KEY_B64, 'base64').toString('utf8');
  const keyObj = crypto.createPrivateKey(privatePem);
  return crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' }) as string;
}

/** Produces a credential envelope that decryptCredentialEnvelope() can decrypt. */
export function encryptClaudeEnvelope(plaintext: string): string {
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

export function buildCredentialPayload(
  accessToken: string,
  expiresAt: number = Date.now() + 60 * 60 * 1000
): string {
  return encryptClaudeEnvelope(
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: 'test-refresh',
        expiresAt,
      },
    })
  );
}

export interface SeededIntegration {
  id: string;
  userId: string;
  accessToken: string;
}

export async function seedClaudeIntegration(
  userId: string,
  opts: {
    poolingEnabled?: boolean;
    accessToken?: string;
    lastUsedAt?: Date | null;
    expiresAt?: number;
  } = {}
): Promise<SeededIntegration> {
  // The "sk-ant-oat" prefix mirrors real Anthropic OAuth tokens — required so
  // these seeded envelopes pass `hasUsableClaudeCodeEnvelope` and exercise the
  // rotation path under test (placeholder prefixes are now rejected upstream).
  const accessToken =
    opts.accessToken ?? `sk-ant-oat-seed-${crypto.randomBytes(8).toString('hex')}`;
  const encryptedCredentials = buildCredentialPayload(accessToken, opts.expiresAt);

  const integration = await prisma.integration.upsert({
    where: { userId_name_accountId: { userId, name: 'claude_code', accountId: '' } },
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

export function buildGptCredentialPayload(accessToken: string, accountId: string): string {
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

export async function seedGptIntegration(
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
    where: { userId_name_accountId: { userId, name: 'gpt_code', accountId: '' } },
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

export async function completeOnboarding(userId: string): Promise<void> {
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
export async function existingPoolIds(): Promise<string[]> {
  const rows = await prisma.integration.findMany({
    where: { name: 'claude_code' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function existingComputePoolIds(): Promise<string[]> {
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

export async function cleanupIntegrations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.integration.deleteMany({ where: { id: { in: ids } } });
}

// =====================================================================
// Account-level token pooling default
// ---------------------------------------------------------------------
// `User.poolTokensByDefault` is an ACCOUNT policy: when on, every compute
// credential that account syncs must land pool-eligible, so the pool is never
// a single point of failure when the owner's own token hits its rate-limit
// window. `Integration.poolingEnabledOverride` is the explicit per-integration
// choice and always wins; null means "inherit the account default".
// Regression net for the 3-agent benchmark wipeout where the only connected
// claude_code row had pool=false and fetchPoolToken had nothing to rotate to.
// =====================================================================

export async function setAccountPoolDefault(userId: string, enabled: boolean): Promise<void> {
  // User.userId is the Supabase auth id — the same key Integration.userId uses.
  await prisma.user.update({ where: { userId }, data: { poolTokensByDefault: enabled } });
}

export async function uploadClaudeCredentials(accessToken: string): Promise<void> {
  const encryptedCredentials = buildCredentialPayload(
    `sk-ant-oat-acctdefault-${crypto.randomBytes(8).toString('hex')}`
  );
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encryptPayload({ encryptedCredentials })),
  });
  assertStatus(res.status, 200, res.data);
}

export async function uploadGptCredentials(accessToken: string): Promise<void> {
  const encryptedCredentials = buildGptCredentialPayload(
    `gpt-acctdefault-${crypto.randomBytes(8).toString('hex')}`,
    `acct-${crypto.randomBytes(6).toString('hex')}`
  );
  const res = await request(`${BASE_URL}/api/integrations/gpt-code/credentials/upload`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(encryptPayload({ encryptedCredentials })),
  });
  assertStatus(res.status, 200, res.data);
}

export async function readCredentialRow(userId: string, name: 'claude_code' | 'gpt_code') {
  // GPT uploads stamp the envelope account_id onto the Integration row (blank-key
  // upsert, then persistRecoveredIntegrationAccountId). Lookup must not require
  // accountId === ''.
  return prisma.integration.findFirst({
    where: { userId, name },
    orderBy: { updatedAt: 'desc' },
  });
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

export interface SeededSession {
  taskId: string;
  agentId: string;
}

export async function seedClaudeCodeSession(
  agentId: string,
  source: 'user' | 'pool' | 'anthropic',
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

export async function cleanupSessions(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await prisma.claudeCodeSession.deleteMany({ where: { id: { in: taskIds } } });
}
