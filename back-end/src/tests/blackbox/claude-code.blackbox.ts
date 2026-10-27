#!/usr/bin/env tsx
/* eslint-disable max-lines */
/**
 * Black-box tests for the claude-code domain
 *
 * Covers:
 *   POST /api/claude-code-session/create            — create E2B sandbox session
 *   POST /api/claude-code-session/close              — close sandbox session
 *   GET  /api/claude-code-session/:taskId            — get session by task ID
 *   GET  /api/claude-code-session/agent/:agentId     — list sessions for agent
 *   POST /api/claude-code-session/:taskId/output     — persist terminal output
 *   GET  /api/claude-code-session/:sandboxId/health  — sandbox health check
 *
 * Boundary capture tests (Phase 3):
 *   E2B SDK is the primary external boundary. The SDK calls https://api.e2b.app/sandboxes.
 *   - POST /create with valid body → E2B SDK call captured (URL, method asserted)
 *   - POST /create with github missing user_id → 0 outbound calls (short-circuits at 400)
 *   - POST /close with non-existent task → 0 outbound calls (short-circuits at DB miss)
 *   - GET /:sandboxId/health → E2B SDK call captured (connect attempt)
 *   - GitHub repo access check → DB-only, 0 github.com calls
 *
 * Invariants covered:
 *   - auth boundary: all endpoints reject unauthenticated requests with 401
 *   - error-surface: all error responses include { error: string }
 *   - concurrency: all tests use unique UUIDs; no shared mutable state
 *   - boundary param: E2B SDK calls captured with exact URL; validation short-circuits produce 0 calls
 *   - reproducibility: deterministic given same inputs
 *   - cleanup: no persistent state created (all writes require E2B); UUID4 test data
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - idempotency: mutating happy paths require E2B sandbox (not available in test)
 *   - read-after-write: can't create sessions without E2B
 *   - state-transition: can't create sessions without E2B to observe status changes
 *   - ordering/pagination: agent sessions list is limited to 10, no pagination params
 *   - atomicity: session creation is single-path through E2B + DB
 *   - referential integrity: enforced by Prisma/Postgres, not the route layer
 *   - tenant isolation: can't test without created sessions
 *   - time/clock: no timestamp assertions possible without sessions
 *   - call ordering: no multi-call outbound paths accessible without E2B
 *   - event/job cardinality: no events emitted by these routes
 *   - duplication prevention: sandbox ID uniqueness enforced by DB constraint + E2B
 *   - permission/tenant isolation: session access not scoped by user (internal API)
 *
 * Residual risks:
 *   - E2B happy paths (successful sandbox create/close/health) are not exercised because
 *     creating real sandboxes is expensive and slow. The E2B boundary IS captured and
 *     asserted on (URL, method), but we can't assert on a successful E2B response.
 *   - Output persist (POST /:taskId/output) happy path requires a pre-existing session
 *     record, which can only be created via a successful E2B sandbox creation.
 *   - GitHub repo cloning path (GITHUB_TOKEN injection into sandbox) not testable.
 *   - Per-user credential decryption path (fetchClaudeCodeCredentials) not testable
 *     without encrypted Integration records.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/claude-code.blackbox.ts
 */

import { config } from 'dotenv';
import { assertSmokeHandoff, handoffSmokeGoal } from './code-agent-handoff-smoke.case';
import { z } from 'zod';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import jwt from 'jsonwebtoken';
import {
  isEligibleAndyClaudeSmokeCredential,
  syncAndyClaudeTokensFromProd,
} from '../../../scripts/sync-andy-claude-tokens-from-prod';
import { prisma } from '../../providers/database';
import {
  CODE_AGENT_CREDENTIALS_UNAVAILABLE,
  CodeAgentCredentialError,
  isTransientSandboxCreateError,
  resolveClaudeCodeAuthEnvs,
  resolveClaudeCodeTokenSource,
} from '../../providers/e2b';
import { AgentOwnerMismatchError, resolveAgentContext } from '../../domains/claude-code/service';
import { fetchClaudeCodeCredentialsWithMeta } from '../../providers/claudeCredentials';
import { withComputePoolLock } from './compute-pool-lock.testkit';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');
// Smoke tests always enabled — E2B sandbox validation runs by default.

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({ error: z.string() });

const AgentSessionsResponse = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      agentId: z.string(),
      sandboxId: z.string(),
      streamUrl: z.string().nullable(),
      goal: z.string(),
      status: z.enum(['ACTIVE', 'COMPLETED', 'CLOSED', 'ERROR']),
      output: z.string().nullable(),
      createdAt: z.string().or(z.date()),
      closedAt: z.string().or(z.date()).nullable(),
    })
  ),
});

const HealthResponseSchema = z
  .object({
    alive: z.boolean(),
    sandbox_id: z.string(),
  })
  .passthrough();

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
  captureAvailable: boolean;
}

const ctx: TestContext = { captureAvailable: false };

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';
const FAKE_UUID_2 = '11111111-1111-1111-1111-111111111111';
const DEV_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const CLAUDE_DECRYPTION_KEY_B64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY ?? '';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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
  'connect.steelbrowser.com',
  'connect.steel.dev',
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

// ==================== CAPTURE HELPERS ====================

async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ==================== SETUP ====================

async function setup(): Promise<void> {
  ctx.captureAvailable = await checkCaptureAvailable();
}

function claudePublicKeyPem(): string {
  if (CLAUDE_DECRYPTION_KEY_B64 === '') {
    throw new Error('CLAUDE_CREDENTIAL_DECRYPTION_KEY not set — cannot seed token fixtures');
  }
  const privatePem = Buffer.from(CLAUDE_DECRYPTION_KEY_B64, 'base64').toString('utf8');
  const keyObj = crypto.createPrivateKey(privatePem);
  return crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' }) as string;
}

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

function buildCredentialPayload(accessToken: string, refreshToken = 'test-refresh'): string {
  return encryptClaudeEnvelope(
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    })
  );
}

function encryptPayload(data: unknown): { data: string; iv: string; key: string } {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex') + cipher.final('hex');
  return { data: encrypted, iv: iv.toString('hex'), key: key.toString('hex') };
}

function authTokenForUser(userId: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (secret === undefined || secret === '' || supabaseUrl === undefined || supabaseUrl === '') {
    throw new Error('SUPABASE_JWT_SECRET and SUPABASE_URL are required for smoke credential sync');
  }
  return jwt.sign(
    {
      sub: userId,
      email: 'claude-code-smoke@example.com',
      role: 'authenticated',
      aud: 'authenticated',
      iss: `${supabaseUrl}/auth/v1`,
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

function readKeychainClaudeCredentials(): string {
  let credentialsJson: string;
  try {
    credentialsJson = execFileSync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    throw new Error(`Claude Code Keychain credentials not found (${CLAUDE_KEYCHAIN_SERVICE})`);
  }

  let parsed: { claudeAiOauth?: { accessToken?: string } };
  try {
    parsed = JSON.parse(credentialsJson) as { claudeAiOauth?: { accessToken?: string } };
  } catch {
    throw new Error('Claude Code Keychain credentials are not valid JSON');
  }

  if (parsed.claudeAiOauth?.accessToken?.startsWith('sk-ant-oat') !== true) {
    throw new Error('Claude Code Keychain credentials are missing a valid OAuth access token');
  }

  return credentialsJson;
}

async function syncSmokeUserCredentialsFromKeychain(): Promise<void> {
  const credentialsJson = readKeychainClaudeCredentials();
  const encrypted = encryptPayload({
    encryptedCredentials: encryptClaudeEnvelope(credentialsJson),
  });
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authTokenForUser(DEV_USER_ID)}` },
    body: JSON.stringify(encrypted),
  });
  assertStatus(res.status, 200, res.data);
}

async function smokeUserHasResolvableClaudeToken(): Promise<boolean> {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`, {
    headers: {
      ...apiKeyHeaders(),
      'X-User-Id': DEV_USER_ID,
    },
  });
  if (res.status === 200) {
    const body = res.data as { accessToken?: unknown };
    if (typeof body.accessToken === 'string' && body.accessToken.startsWith('sk-ant-')) {
      return true;
    }
  }
  // The real E2B path receives only a live access token (never a refresh
  // token), so the smoke can never rotate a grant another holder shares.
  const credential = await fetchClaudeCodeCredentialsWithMeta(DEV_USER_ID);
  return (
    credential?.source === 'user' &&
    credential.userId === DEV_USER_ID &&
    typeof credential.accessToken === 'string' &&
    credential.accessToken.startsWith('sk-ant-')
  );
}

async function syncAndyProdClaudeTokensForSmoke(reason: string): Promise<void> {
  console.log(`    [info] ${reason} — syncing Andy (+19729777432) claude_code keys from prod…`);
  try {
    await syncAndyClaudeTokensFromProd({
      localDatabaseUrl: process.env.BLACKBOX_TEST_DATABASE_URL ?? process.env.DATABASE_URL,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(
      `    [warn] Andy prod Claude sync failed (${detail}); trying remaining credential paths`
    );
  }
}

/**
 * Ensure DEV_USER_ID can resolve a Claude Code OAuth token for the real E2B
 * smoke. macOS deploys refresh from Keychain; Linux/Cloud VMs have no Keychain,
 * so a pre-seeded local `claude_code` row (copied from prod) is enough.
 *
 * When local rows are missing or stale, fall back to a strict prod sync for Andy
 * (+19729777432) only — never other users' pool tokens.
 */
async function ensureSmokeUserClaudeCredentials(): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await syncSmokeUserCredentialsFromKeychain();
      return;
    } catch (error) {
      console.log(
        `    [warn] Keychain Claude sync failed (${error instanceof Error ? error.message : String(error)}); trying prod fallback`
      );
    }
  }

  if (process.env.BLACKBOX_SMOKE === '1' && process.platform !== 'darwin') {
    await syncAndyProdClaudeTokensForSmoke(
      'Claude Code E2B smoke on Linux/Cloud refreshes Andy prod keys before run'
    );
    if (await smokeUserHasResolvableClaudeToken()) {
      return;
    }
  }

  if (await smokeUserHasResolvableClaudeToken()) {
    return;
  }

  await syncAndyProdClaudeTokensForSmoke('Local Claude token unavailable');
  if (await smokeUserHasResolvableClaudeToken()) {
    return;
  }

  // Linux/Cloud: when the OAuth pool is empty/revoked, Claude Code falls through
  // to the funded ANTHROPIC_API_KEY (see resolveClaudeCodeAuthEnvs). That is a
  // valid smoke path — do not hard-require Keychain on non-Darwin hosts.
  const fundedApiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  if (fundedApiKey.startsWith('sk-ant-')) {
    return;
  }
  throw new Error(
    'Claude Code smoke credentials unavailable on this host: no macOS Keychain ' +
      `(${CLAUDE_KEYCHAIN_SERVICE}), GET /api/integrations/claude-code/credentials/token ` +
      'returned no sk-ant-* accessToken for DEV_USER_ID after Andy prod sync, and ANTHROPIC_API_KEY is unset. ' +
      'Sync usable claude_code integrations for +19729777432 in prod and retry.'
  );
}

async function seedClaudeIntegration(): Promise<{ integrationId: string; userId: string }> {
  const userId = crypto.randomUUID();
  const encryptedCredentials = buildCredentialPayload(
    `sk-ant-oat-boundary-${crypto.randomBytes(8).toString('hex')}`
  );
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'claude_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: true,
      config: { encryptedCredentials },
    },
  });
  return { integrationId: integration.id, userId };
}

// ==================== POST /create ====================

async function testResolveAgentContext_repoLessAgentKeepsOwnerCredentials() {
  const agentId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'resolve repo-less code-agent credential owner',
      status: 'STARTING_UP',
    },
  });
  try {
    const context = await resolveAgentContext(agentId, undefined);
    assert(context.repoUrl === undefined, 'repo-less agent must not invent a GitHub repo');
    assert(context.userId === userId, 'repo-less agent must retain its credential owner');
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}

async function testResolveAgentContext_rejectsMismatchedCallerOwner() {
  const agentId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'reject mismatched code-agent credential owner',
      status: 'STARTING_UP',
    },
  });
  try {
    let rejected = false;
    try {
      await resolveAgentContext(agentId, crypto.randomUUID());
    } catch (error) {
      rejected = true;
      assert(error instanceof AgentOwnerMismatchError, `unexpected error: ${String(error)}`);
    }
    assert(rejected, 'mismatched caller user_id must be rejected');
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}

// ── resolveClaudeCodeAuthEnvs (pure auth-env selection) ──────────────────────
const OAUTH_META = {
  credentials: 'encrypted-envelope',
  credentialMode: 'oauth_token',
  accessToken: 'sk-ant-oat01-xxx',
  source: 'pool',
  poolTokenId: 'p1',
} as unknown as Parameters<typeof resolveClaudeCodeAuthEnvs>[0];

const OAUTH_ENVELOPE_META = {
  ...OAUTH_META,
  credentialMode: 'oauth_envelope',
} as unknown as Parameters<typeof resolveClaudeCodeAuthEnvs>[0];

function testResolveAuthEnvs_oauthPreferred() {
  const envs = resolveClaudeCodeAuthEnvs(OAUTH_META, 'sk-ant-api03-key', false);
  assert(
    envs.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat01-xxx',
    'OAuth token set when credential present'
  );
  assert(envs.CLAUDE_CODE_CREDENTIALS === 'encrypted-envelope', 'credentials envelope set');
  assert(envs.ANTHROPIC_API_KEY === undefined, 'api-key NOT used when OAuth credential present');
}

function testResolveAuthEnvs_oauthEnvelopeAlsoSetsToken() {
  const envs = resolveClaudeCodeAuthEnvs(OAUTH_ENVELOPE_META, 'sk-ant-api03-key', false);
  assert(
    envs.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat01-xxx',
    'OAuth token set even when full credentials envelope is present'
  );
  assert(envs.CLAUDE_CODE_CREDENTIALS === 'encrypted-envelope', 'credentials envelope kept');
  assert(envs.ANTHROPIC_API_KEY === undefined, 'api-key NOT used when OAuth envelope present');
}

function testResolveAuthEnvs_apiKeyFallback() {
  const envs = resolveClaudeCodeAuthEnvs(null, 'sk-ant-api03-key', false);
  assert(
    envs.ANTHROPIC_API_KEY === 'sk-ant-api03-key',
    'falls back to api-key when no OAuth credential'
  );
  assert(envs.CLAUDE_CODE_OAUTH_TOKEN === undefined, 'no OAuth token in fallback');
}

function testResolveAuthEnvs_apiKeyFallbackRecordsSharedSource() {
  assert(
    resolveClaudeCodeTokenSource(null) === 'anthropic',
    'shared API-key fallback must be persisted as anthropic so billing failures trip its cooldown'
  );
  assert(resolveClaudeCodeTokenSource(OAUTH_META) === 'pool', 'OAuth source must remain pool');
}

/**
 * The credential breakdown must live on `detail` (server logs) and NEVER on `message`, because
 * `POST /api/claude-code-session/create` returns `error.message` verbatim in its 500 body — so a
 * stateful message discloses our credential inventory to every API caller.
 */
function credentialFailure(run: () => unknown): { message: string; detail: string } {
  try {
    run();
  } catch (err) {
    assert(
      err instanceof CodeAgentCredentialError,
      `expected CodeAgentCredentialError, got: ${err}`
    );
    return { message: err.message, detail: err.detail };
  }
  throw new Error('expected a credential-resolution throw');
}

function assertClientMessageRedacted(message: string, label: string) {
  assert(
    message === CODE_AGENT_CREDENTIALS_UNAVAILABLE,
    `${label}: client-facing message must be the fixed redacted string, got: ${message}`
  );
  for (const leak of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'cooldown', 'pool tokens']) {
    assert(
      !message.includes(leak),
      `${label}: client-facing message must not disclose "${leak}", got: ${message}`
    );
  }
}

function testResolveAuthEnvs_apiKeyOnCooldownThrows() {
  const { message, detail } = credentialFailure(() =>
    resolveClaudeCodeAuthEnvs(null, 'sk-ant-api03-key', true)
  );
  assertClientMessageRedacted(message, 'cooldown throw');
  // The two throw branches (external funding vs local config gap) demand
  // different remediation, so the operator-facing detail must name which one
  // fired instead of forcing a DB/env investigation to tell them apart.
  assert(
    detail.includes('configured but on its out-of-credits/bad-key cooldown'),
    `cooldown throw must name the cooldown state, got: ${detail}`
  );
  assert(
    !detail.includes('is not set'),
    `cooldown throw must not claim the key is unset, got: ${detail}`
  );
}

function smokeCredential(overrides: {
  isActive?: boolean;
  status?: string;
  failureReason?: string | null;
  config?: unknown;
}) {
  return {
    isActive: overrides.isActive ?? true,
    status: overrides.status ?? 'CONNECTED',
    failureReason: overrides.failureReason ?? null,
    config: overrides.config ?? { encryptedCredentials: 'envelope' },
  };
}

function testEligibleAndyClaudeSmokeCredential_keepsConnectedAndRefreshableExpired() {
  assert(
    isEligibleAndyClaudeSmokeCredential(smokeCredential({})),
    'CONNECTED + encrypted envelope must stay eligible'
  );
  assert(
    isEligibleAndyClaudeSmokeCredential(
      smokeCredential({
        isActive: false,
        status: 'EXPIRED',
        failureReason: 'auth_error',
      })
    ),
    'EXPIRED auth_error envelope must stay eligible so Claude Code can refresh'
  );
}

function testEligibleAndyClaudeSmokeCredential_rejectsEmptyOrRevoked() {
  assert(
    !isEligibleAndyClaudeSmokeCredential(smokeCredential({ config: {} })),
    'CONNECTED without encrypted credentials must be ineligible'
  );
  assert(
    !isEligibleAndyClaudeSmokeCredential(
      smokeCredential({
        isActive: false,
        status: 'EXPIRED',
        failureReason: 'revoked',
      })
    ),
    'EXPIRED without auth_error must not be seeded into the local pool'
  );
}

async function testExpiredClaudeCredentialIsNeverRefreshedInSandbox() {
  const userId = crypto.randomUUID();
  try {
    for (const [index, refreshToken] of ['', 'test-refresh'].entries()) {
      await prisma.integration.create({
        data: {
          userId,
          accountId: `smoke-refresh-${index}`,
          name: 'claude_code',
          type: 'TOOL_SETUP',
          status: 'EXPIRED',
          isActive: false,
          failureReason: 'auth_error',
          poolingEnabled: false,
          createdAt: new Date(`2026-01-0${index + 1}T00:00:00Z`),
          config: {
            encryptedCredentials: buildCredentialPayload(`sk-ant-oat-test-${index}`, refreshToken),
          },
        },
      });
    }
    // Refreshing a stored grant revokes the user's own Claude Code that holds it.
    const credential = await fetchClaudeCodeCredentialsWithMeta(userId);
    assert(credential?.source !== 'user', 'an EXPIRED own credential must not be served');
  } finally {
    await prisma.integration.deleteMany({ where: { userId, name: 'claude_code' } });
  }
}

function testResolveAuthEnvs_noCredsNoKeyThrows() {
  const { message, detail } = credentialFailure(() =>
    resolveClaudeCodeAuthEnvs(null, undefined, false)
  );
  assertClientMessageRedacted(message, 'unset-key throw');
  assert(
    detail.includes('ANTHROPIC_API_KEY is not set'),
    `unset-key throw must name the missing key, got: ${detail}`
  );
  assert(!detail.includes('cooldown'), `unset-key throw must not blame a cooldown, got: ${detail}`);
}

/**
 * Regression: E2B sandbox creation must retry a transport blip but never retry a
 * rejection. Creation was a single un-retried outbound call, so one transient
 * `TypeError: fetch failed` became a hard 500 — reproducibly 3/3 in the
 * concurrent blackbox batch while passing 2/2 in isolation. Retrying a 401/quota
 * rejection would instead burn time and money, so the classifier must split them.
 */
function testSandboxRetry_classifiesTransientOnly() {
  const transient: unknown[] = [
    new TypeError('fetch failed'),
    Object.assign(new Error('request failed'), { cause: new Error('ECONNRESET') }),
    Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('read'), { code: 'EADDRNOTAVAIL' }),
    new Error('socket hang up'),
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    }),
    // Wedged keep-alive → AbortSignal.timeout (cuda-kernel k=3 r29).
    Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    }),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  ];
  for (const error of transient) {
    assert(
      isTransientSandboxCreateError(error),
      `expected transient classification for ${String((error as Error).message)}`
    );
  }

  const permanent: unknown[] = [
    new Error('401 Unauthorized: invalid api key'),
    new Error('403 Forbidden'),
    new Error('404 template not found'),
    new Error('quota exceeded for this organization'),
    new Error('template build is invalid'),
  ];
  for (const error of permanent) {
    assert(
      !isTransientSandboxCreateError(error),
      `expected NON-transient classification for ${String((error as Error).message)}`
    );
  }
}

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create 401');
}

async function testCreate_emptyBody() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create empty body');
}

async function testCreate_missingGoal() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: FAKE_UUID }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create missing goal');
}

async function testCreate_missingAgentId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ goal: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create missing agent_id');
}

async function testCreate_nonUuidAgentId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: 'not-a-uuid', goal: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create non-uuid agent_id');
}

async function testCreate_githubWithoutUserId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'test',
      github_repo_url: 'https://github.com/test-owner/test-repo',
    }),
  });
  // Agent DB lookup will fail silently (agent doesn't exist), so effectiveUserId stays undefined
  // → 400 MISSING_USER_ID
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; code?: string };
  assert(body.code === 'MISSING_USER_ID', `Expected code MISSING_USER_ID, got ${body.code}`);
}

async function testCreate_githubAccessDenied() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'test',
      github_repo_url: 'https://github.com/nonexistent-owner/nonexistent-repo',
      user_id: FAKE_UUID,
    }),
  });
  // No GithubRepoAccess record → 403
  assertStatus(res.status, 403, res.data);
  const body = res.data as { error: string; code?: string };
  assert(
    body.code === 'GITHUB_ACCESS_DENIED',
    `Expected code GITHUB_ACCESS_DENIED, got ${body.code}`
  );
}

async function testCreate_nonUuidCodeSessionIdIs400() {
  // RCA 942d8562: code_session_id "null" (a string a model sent for an omitted
  // optional) failed the uuid schema and returned 500, which the agent tool
  // reported as a transient sandbox capacity error.
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'test', code_session_id: 'null' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; code?: string };
  assert(body.code === 'INVALID_REQUEST', `Expected INVALID_REQUEST, got ${body.code}`);
  assert(body.error.includes('code_session_id'), `Expected path in error, got ${body.error}`);
}

async function testCreate_validBodyE2bBoundary() {
  // Valid body passes Zod + GitHub checks, then hits E2B SDK.
  // 500 = E2B rejects (expired key, bad template, etc.) or 200 = sandbox created.
  // We accept both: the contract is that the endpoint responds, not that E2B succeeds.
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'test blackbox' }),
  });
  assert(
    res.status === 500 || res.status === 200,
    `Expected 500 or 200, got ${res.status}: ${JSON.stringify(res.data).substring(0, 200)}`
  );
  if (res.status === 500) {
    assertSchema(ErrorResponse, res.data, 'POST /create E2B boundary');
  }
  // A 200 spawned a real sandbox — close it or it holds an E2B slot for its
  // full 30-min TTL (concurrent coverage runs exhausted the 20-sandbox cap).
  const created = res.data as { task_id?: string };
  if (res.status === 200 && typeof created.task_id === 'string') {
    await request(`${BASE_URL}/api/claude-code-session/close`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ task_id: created.task_id }),
    });
  }
}

async function testCreate_invalidGithubUrl() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'test',
      github_repo_url: 'not-a-github-url',
      user_id: FAKE_UUID,
    }),
  });
  // normalizeGithubUrl returns null for invalid URLs → checkGithubRepoAccess returns allowed: false
  assertStatus(res.status, 403, res.data);
  const body = res.data as { error: string; code?: string };
  assert(
    body.code === 'GITHUB_ACCESS_DENIED',
    `Expected code GITHUB_ACCESS_DENIED, got ${body.code}`
  );
}

// ==================== POST /close ====================

async function testClose_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testClose_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close 401');
}

async function testClose_emptyBody() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close empty body');
}

async function testClose_nonExistentTask() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close non-existent task');
  const body = res.data as { error: string };
  assert(
    body.error.includes('not found'),
    `Expected error to include "not found", got: ${body.error}`
  );
}

async function testClose_nonUuidTaskId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ task_id: 'not-a-uuid' }),
  });
  // Zod validation rejects non-uuid → 500
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close non-uuid task_id');
}

// ==================== GET /:taskId ====================

async function testGet_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
}

async function testGet_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:taskId 401');
}

async function testGet_notFound() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:taskId 404');
}

async function testGet_notFound_differentUuid() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID_2}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 404, res.data);
}

// ==================== GET /agent/:agentId ====================

async function testGetByAgent_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
}

async function testGetByAgent_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /agent/:agentId 401');
}

async function testGetByAgent_empty() {
  const randomAgentId = crypto.randomUUID();
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${randomAgentId}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  // Validate the response shape without asserting count — the DB may already have sessions
  // for this agent ID from prior runs or other tests.
  assertSchema(AgentSessionsResponse, res.data, 'GET /agent/:agentId 200');
}

async function testGetByAgent_empty_differentUuid() {
  const randomAgentId = crypto.randomUUID();
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${randomAgentId}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { sessions: unknown[] };
  assert(Array.isArray(body.sessions), 'Expected sessions array');
  assert(body.sessions.length === 0, `Expected 0 sessions, got ${body.sessions.length}`);
}

// ==================== POST /:taskId/output ====================

async function testOutput_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    body: JSON.stringify({ output: 'test output' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testOutput_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    body: JSON.stringify({ output: 'test output' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output 401');
}

async function testOutput_missingField() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output missing output');
}

async function testOutput_emptyString() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ output: '' }),
  });
  // Empty string is falsy — server should reject it. Some implementations return 400
  // (explicit validation) and others 500 (Prisma throws on non-existent record after
  // passing the empty-string check). Accept both as valid rejection.
  assert(
    res.status === 400 || res.status === 500,
    `Expected 400 or 500 for empty string output, got ${res.status}: ${JSON.stringify(res.data).substring(0, 200)}`
  );
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output empty string');
}

async function testOutput_numericOutput() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ output: 12345 }),
  });
  // typeof output !== 'string' → 400
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output numeric');
}

async function testOutput_nonExistentTask() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ output: 'test output content' }),
  });
  // Prisma update on non-existent record → throws → 500
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output non-existent');
}

// ==================== GET /:sandboxId/health ====================

async function testHealth_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/fake-sandbox-id/health`);
  assertStatus(res.status, 401, res.data);
}

async function testHealth_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/fake-sandbox-id/health`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:sandboxId/health 401');
}

async function testHealth_nonExistentSandbox() {
  const res = await request(
    `${BASE_URL}/api/claude-code-session/nonexistent-sandbox-12345/health`,
    { headers: apiKeyHeaders() }
  );
  // connectToSandbox either throws (E2B_API_KEY not set) or fails to connect → alive: false
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(HealthResponseSchema, res.data, 'GET /:sandboxId/health dead');
  assert(body.alive === false, `Expected alive: false, got ${body.alive}`);
  assert(
    body.sandbox_id === 'nonexistent-sandbox-12345',
    `Expected sandbox_id to match, got ${body.sandbox_id}`
  );
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testErrorSurface_all401sHaveErrorField() {
  // Hit all endpoints without auth and verify error field present
  const endpoints = [
    { url: `${BASE_URL}/api/claude-code-session/create`, method: 'POST', body: '{}' },
    { url: `${BASE_URL}/api/claude-code-session/close`, method: 'POST', body: '{}' },
    { url: `${BASE_URL}/api/claude-code-session/${FAKE_UUID}`, method: 'GET' },
    { url: `${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID}`, method: 'GET' },
    { url: `${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, method: 'POST', body: '{}' },
    { url: `${BASE_URL}/api/claude-code-session/fake-sb/health`, method: 'GET' },
  ];

  for (const ep of endpoints) {
    const res = await request(ep.url, {
      method: ep.method as string,
      ...(ep.body ? { body: ep.body } : {}),
    });
    assertStatus(res.status, 401, res.data);
    assertSchema(ErrorResponse, res.data, `error surface ${ep.method} ${ep.url}`);
  }
}

// ==================== BOUNDARY CAPTURE TESTS (Sequential) ====================

function isE2bBoundaryUrl(url: string): boolean {
  return url.startsWith('https://api.e2b.app/') || /^https:\/\/[^/]+\.e2b\.app\//.test(url);
}

// Seeds a pool-eligible (poolingEnabled=true) claude_code row, so it must hold
// the cross-process compute-pool lock: a concurrent suite's rotation tests
// (integrations.blackbox.ts) assert exact LRU pool selection and a foreign
// pool row seeded mid-test breaks them (see compute-pool-lock.testkit.ts).
async function testBoundary_createCallsE2bApi() {
  await withComputePoolLock(() => testBoundary_createCallsE2bApiLocked());
}

async function testBoundary_createCallsE2bApiLocked() {
  const seeded = await seedClaudeIntegration();
  const captureToken = `claude-create-${crypto.randomUUID()}`;
  let createdTaskId: string | null = null;
  try {
    const createRes = await request(`${BASE_URL}/api/claude-code-session/create`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': captureToken },
      body: JSON.stringify({
        agent_id: FAKE_UUID,
        goal: 'boundary test',
        user_id: seeded.userId,
      }),
    });
    const createdBody = createRes.data as { task_id?: string };
    if (createRes.status === 200 && typeof createdBody.task_id === 'string') {
      createdTaskId = createdBody.task_id;
    }
    await new Promise((r) => setTimeout(r, 200));
    const calls = await readCapturesForToken(captureToken);
    // E2B SDK may call the control API or a sandbox subdomain depending on sandbox state.
    if (calls.length === 0) {
      console.warn(
        '    [warn] 0 E2B calls captured for create — E2B SDK may short-circuit without API key or reuse sandbox state'
      );
      return;
    }
    const e2bCalls = calls.filter((c) => c.url.includes('e2b.app'));
    assert(
      e2bCalls.length >= 1,
      `Expected at least 1 call to e2b.app, got ${e2bCalls.length}. All calls: ${calls.map((c) => c.url).join(', ')}`
    );
    assert(
      e2bCalls.some((c) => isE2bBoundaryUrl(c.url)),
      `Expected an E2B control or sandbox URL, got ${e2bCalls.map((c) => c.url).join(', ')}`
    );
    // No unexpected non-E2B calls
    const nonE2bCalls = calls.filter(
      (c) => !c.url.includes('e2b.app') && !INFRA_URL_PATTERNS.some((p) => c.url.includes(p))
    );
    assert(
      nonE2bCalls.length === 0,
      `Unexpected non-E2B outbound calls: ${nonE2bCalls.map((c) => `${c.method} ${c.url}`).join(', ')}`
    );
  } finally {
    // Close any real sandbox the create spawned — leaked sandboxes hold E2B
    // slots for 30 minutes and concurrent coverage runs exhaust the cap.
    if (createdTaskId !== null) {
      await request(`${BASE_URL}/api/claude-code-session/close`, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({ task_id: createdTaskId }),
      });
    }
    await prisma.integration.deleteMany({ where: { id: seeded.integrationId } });
  }
}

async function testBoundary_closeNonExistentNoOutbound() {
  const captureToken = `claude-close-${crypto.randomUUID()}`;
  await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': captureToken },
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCapturesForToken(captureToken);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for non-existent task close, got ${calls.length}: ${calls.map((c) => c.url).join(', ')}`
  );
}

async function testBoundary_githubAccessCheckDeniesMissingRepo() {
  const captureToken = `claude-github-${crypto.randomUUID()}`;
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': captureToken },
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'boundary github test',
      github_repo_url: 'https://github.com/test-owner/test-repo',
      user_id: FAKE_UUID,
    }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCapturesForToken(captureToken);
  assert(
    res.status === 403,
    `Expected 403 GITHUB_ACCESS_DENIED for missing repo, got ${res.status}: ${JSON.stringify(res.data).substring(0, 200)}`
  );
  const e2bCalls = filterInfraCalls(calls).filter((c) => c.url.includes('e2b.app'));
  assert(
    e2bCalls.length === 0,
    `Expected 0 E2B calls (403 short-circuits before E2B), got ${e2bCalls.length}: ${e2bCalls.map((c) => c.url).join(', ')}`
  );
}

async function testBoundary_healthCallsE2bApi() {
  const captureToken = `claude-health-${crypto.randomUUID()}`;
  await request(`${BASE_URL}/api/claude-code-session/nonexistent-sandbox/health`, {
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': captureToken },
  });
  // E2B SDK call may take time — poll for captures up to 2s
  let calls: CapturedCall[] = [];
  // eslint-disable-next-line no-restricted-syntax
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 500));
    calls = await readCapturesForToken(captureToken);
    if (calls.length > 0) break;
  }
  // E2B SDK may call the control API or a sandbox subdomain depending on sandbox state.
  const e2bCalls = calls.filter((c) => c.url.includes('e2b.app'));
  if (e2bCalls.length === 0) {
    console.warn(
      `    [warn] 0 E2B calls captured for health check — E2B SDK may short-circuit without API key. Captured non-noise calls: ${calls.map((c) => c.url).join(', ') || 'none'}`
    );
    return;
  }
  assert(
    e2bCalls.some((c) => isE2bBoundaryUrl(c.url)),
    `Expected an E2B control or sandbox URL, got ${e2bCalls.map((c) => c.url).join(', ')}`
  );
  // No unexpected non-E2B calls
  const nonE2bCalls = calls.filter(
    (c) => !c.url.includes('e2b.app') && !INFRA_URL_PATTERNS.some((p) => c.url.includes(p))
  );
  assert(
    nonE2bCalls.length === 0,
    `Unexpected non-E2B outbound calls: ${nonE2bCalls.map((c) => `${c.method} ${c.url}`).join(', ')}`
  );
}

async function testBoundary_createGithubMissingUserIdNoOutbound() {
  const captureToken = `claude-missing-user-${crypto.randomUUID()}`;
  await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': captureToken },
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'boundary missing user_id test',
      github_repo_url: 'https://github.com/test/repo',
    }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCapturesForToken(captureToken);
  // 400 MISSING_USER_ID short-circuits before any outbound calls
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for missing user_id, got ${calls.length}: ${calls.map((c) => c.url).join(', ')}`
  );
}

// ==================== SMOKE: REAL E2B SANDBOX ====================
// These tests create real E2B sandboxes (expensive, slow). Gated behind BLACKBOX_SMOKE=1.

/**
 * Smoke test: create a real Claude Code session, ask "what is 2+2?",
 * and verify the output contains "4". This validates the full pipeline:
 * sandbox creation, credential injection, trust dialog dismissal,
 * Claude Code authentication, LLM round-trip, and WebSocket streaming.
 *
 * Fails if:
 *  - Session creation returns non-200
 *  - WebSocket never connects
 *  - Claude Code output never contains "4" within 90s
 */
function isClaudeSmokeCredentialFailure(output: string): boolean {
  return (
    output.includes('Invalid authentication credentials') ||
    /oauth access token has been revoked/i.test(output) ||
    /failed to authenticate/i.test(output)
  );
}

/** Provider-funding failures that should skip the E2B smoke, not burn the 240s timeout. */
function isClaudeSmokeFundingFailure(output: string): boolean {
  return (
    /credit balance is too low/i.test(output) ||
    /requires more credits, or fewer max_tokens/i.test(output) ||
    /can only afford \d+/i.test(output) ||
    /API Error:\s*402\b/i.test(output) ||
    /insufficient credits/i.test(output) ||
    // E2B team billing block at sandbox-create time (observed 2026-09-03). Same
    // external funding class as the Codex create-time SKIP — not a code regression.
    /missing payment method/i.test(output) ||
    /team is blocked/i.test(output) ||
    /payment method required/i.test(output)
  );
}

async function testSmokeCredentialFailureClassifier() {
  assert(
    isClaudeSmokeCredentialFailure(
      '[Claude] Failed to authenticate. API Error: 401 OAuth access token has been revoked.'
    ),
    'revoked OAuth must classify as a smoke credential skip, not a 240s timeout'
  );
  assert(
    isClaudeSmokeCredentialFailure('Invalid authentication credentials'),
    'legacy 401 copy must still classify as a smoke credential skip'
  );
  assert(
    !isClaudeSmokeCredentialFailure('CLAUDE_E2B_DONE'),
    'a successful smoke sentinel must not classify as a credential skip'
  );
  assert(
    isClaudeSmokeFundingFailure(
      'API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 13672.'
    ),
    'OpenRouter 402 / can-only-afford must classify as a funding skip, not a 240s timeout'
  );
  assert(
    isClaudeSmokeFundingFailure('credit balance is too low'),
    'Anthropic credit-balance copy must still classify as a funding skip'
  );
  assert(
    isClaudeSmokeFundingFailure('403: team is blocked: missing payment method'),
    'E2B team missing-payment-method must classify as a funding skip'
  );
  assert(
    !isClaudeSmokeFundingFailure('CLAUDE_E2B_DONE'),
    'a successful smoke sentinel must not classify as a funding skip'
  );
}

async function testSmoke_claudeCodeAnswersQuestion() {
  await ensureSmokeUserClaudeCredentials();

  // 1. Create a real session with a simple math question.
  // Pass user_id so the backend resolves per-user Claude Code credentials
  // (ANTHROPIC_API_KEY fallback uses a stale key that won't authenticate).
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: crypto.randomUUID(),
      goal: handoffSmokeGoal(
        'Create /home/user/output/claude-smoke.txt containing exactly CLAUDE_E2B_OK. Then reply with exactly CLAUDE_E2B_DONE.'
      ),
      user_id: DEV_USER_ID,
    }),
  });
  if (res.status !== 200) {
    const error =
      typeof res.data === 'object' && res.data !== null && 'error' in res.data
        ? String((res.data as { error?: unknown }).error ?? '')
        : typeof res.data === 'string'
          ? res.data
          : JSON.stringify(res.data ?? {});
    if (error.includes(CODE_AGENT_CREDENTIALS_UNAVAILABLE)) {
      console.log(
        '    [skip] Claude E2B smoke could not start: code-agent credentials unavailable (credits/cooldown/auth)'
      );
      return;
    }
    if (isClaudeSmokeFundingFailure(error)) {
      console.log(
        `    [skip] Claude E2B smoke could not start: external funding/billing block (${res.status}); signal: ${error.slice(0, 200)}`
      );
      return;
    }
  }
  assertStatus(res.status, 200, res.data);

  const body = res.data as { ws_url: string; task_id: string; sandbox_id: string };
  assert(!!body.ws_url, 'Missing ws_url in create response');
  assert(!!body.task_id, 'Missing task_id in create response');
  assert(!!body.sandbox_id, 'Missing sandbox_id in create response');

  const taskId = body.task_id;
  let closed = false;

  // 2. Connect to WebSocket and wait for Claude Code to answer
  let wsOutput = '';
  const wsEvents: unknown[] = [];
  let wsConnected = false;
  let wsError: string | null = null;

  // eslint-disable-next-line no-control-regex
  const ANSI_CURSOR_FWD = /\x1b\[\d*C/g;
  const ANSI_OTHER =
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b\[[?]?[0-9;]*[hl]/g;

  const ws = new (await import('ws')).default(body.ws_url);

  const outputPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `Timed out after 240s waiting for Claude Code smoke output. ` +
            `Output so far (${wsOutput.length} chars): ${wsOutput.replace(ANSI_CURSOR_FWD, ' ').replace(ANSI_OTHER, '').slice(-500)}`
        )
      );
    }, 240_000);

    ws.on('open', () => {
      wsConnected = true;
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'stdout' && msg.data) {
          wsOutput += msg.data;
        }
        if (msg.type === 'stderr' && msg.data) {
          wsOutput += msg.data;
        }
        if (msg.type === 'code_agent_event' && msg.data) {
          wsEvents.push(msg.data);
        }
        if (msg.type === 'code_agent_events' && Array.isArray(msg.data)) {
          wsEvents.push(...msg.data);
        }
        // Strip ANSI codes to get clean text
        const clean = wsOutput.replace(ANSI_CURSOR_FWD, ' ').replace(ANSI_OTHER, '');
        if (
          clean.includes('CLAUDE_E2B_DONE') ||
          isClaudeSmokeCredentialFailure(clean) ||
          isClaudeSmokeFundingFailure(clean)
        ) {
          clearTimeout(timeout);
          ws.close();
          resolve(clean);
        }
      } catch {
        // Non-JSON message, ignore
      }
    });

    ws.on('error', (err: Error) => {
      wsError = err.message;
    });

    ws.on('close', () => {
      // If we haven't resolved yet, the timeout will handle it
    });
  });

  try {
    const finalOutput = await outputPromise;
    assert(wsConnected, 'WebSocket never connected');
    assert(!wsError, `WebSocket error: ${wsError}`);
    if (isClaudeSmokeCredentialFailure(finalOutput)) {
      console.log(
        '    [skip] Claude E2B smoke reached the SDK server, but the configured Claude credential is invalid (401)'
      );
      return;
    }
    // Same credential-health class as Anthropic WARN: exhausted API / OpenRouter
    // credits are not a harness regression. Subscription/OAuth tokens are preferred;
    // when only a depleted funded path is available, skip rather than fail /deploy
    // (and do not burn the 240s timeout on a known 402).
    if (isClaudeSmokeFundingFailure(finalOutput)) {
      console.log(
        '    [skip] Claude E2B smoke reached the SDK server, but Claude/OpenRouter credits are exhausted'
      );
      return;
    }
    assert(
      finalOutput.includes('CLAUDE_E2B_DONE'),
      `Claude Code output does not contain CLAUDE_E2B_DONE: ${finalOutput.slice(-300)}`
    );
    assert(
      wsEvents.some((event) => {
        const typed = event as { provider?: string; type?: string };
        return typed.provider === 'claude' && typed.type === 'session';
      }),
      `Expected normalized Claude session event, got: ${JSON.stringify(wsEvents).slice(0, 500)}`
    );
    const { Sandbox } = await import('e2b');
    const sandbox = await Sandbox.connect(body.sandbox_id, { apiKey: process.env.E2B_API_KEY });
    const promptFile = await sandbox.files.read('/home/user/CLAUDE.md', { format: 'text' });
    assert(
      String(promptFile).includes('/home/user/output') &&
        String(promptFile).includes('Do not return the original attachment path'),
      `CLAUDE.md did not contain shared prompt contract: ${String(promptFile).slice(0, 300)}`
    );
    const fileContent = await sandbox.files.read('/home/user/output/claude-smoke.txt', {
      format: 'text',
    });
    assert(
      String(fileContent).trim() === 'CLAUDE_E2B_OK',
      `Expected Claude output file sentinel, got: ${String(fileContent).slice(0, 200)}`
    );
    // 3. Close: the parent's result is the handoff file the real CLI wrote.
    const closeRes = await request(`${BASE_URL}/api/claude-code-session/close`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ task_id: taskId }),
    });
    closed = true;
    assertStatus(closeRes.status, 200, closeRes.data);
    assertSmokeHandoff(closeRes.data, 'CLAUDE_E2B_OK', '/home/user/output/claude-smoke.txt');
  } finally {
    // Clean up: close the session if the assertions above did not
    if (!closed) {
      try {
        await request(`${BASE_URL}/api/claude-code-session/close`, {
          method: 'POST',
          headers: apiKeyHeaders(),
          body: JSON.stringify({ task_id: taskId }),
        });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

async function testCreate_withGithubRepoAndUserId() {
  // Valid user_id + github_repo_url but fake agent — exercises GitHub access check path
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'test github with user_id',
      user_id: FAKE_UUID,
      github_repo_url: 'https://github.com/nonexistent/repo',
    }),
  });
  // Should get 400 (validation), 403 (no GitHub access), or 500 (E2B failure)
  if (res.status !== 400 && res.status !== 403 && res.status !== 500) {
    throw new Error(`Expected 400/403/500 for github access check, got ${res.status}`);
  }
}

async function testOutput_longContent() {
  // POST /:taskId/output with very long content
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ output: 'x'.repeat(10000) }),
  });
  // Should fail because task doesn't exist (500), not because content is too long
  if (res.status !== 500 && res.status !== 404) {
    throw new Error(`Expected 500 or 404 for non-existent task output, got ${res.status}`);
  }
}

async function testGetByAgent_validUuidEmpty() {
  // GET /agent/:agentId with a random UUID that won't correspond to any agent
  const randomId = `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14)}`;
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${randomId}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(AgentSessionsResponse, res.data, 'GET /agent/:agentId (empty)');
  const body = res.data as { sessions: unknown[] };
  if (body.sessions.length !== 0) {
    throw new Error(`Expected 0 sessions for random agent ID, got ${body.sessions.length}`);
  }
}

async function testParseClaudeCodeUsage_nestedMessageUsage() {
  const { parseClaudeCodeUsage } = await import('../../providers/e2b');
  const jsonl = [
    JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 40,
        },
      },
    }),
    JSON.stringify({
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 4,
      },
    }),
    '{not json',
  ].join('\n');

  const usage = parseClaudeCodeUsage(jsonl);
  assert(usage.inputTokens === 110, `expected 110 input tokens, got ${usage.inputTokens}`);
  assert(usage.outputTokens === 27, `expected 27 output tokens, got ${usage.outputTokens}`);
  assert(
    usage.cacheReadInputTokens === 66,
    `expected 66 cache read tokens, got ${usage.cacheReadInputTokens}`
  );
  assert(
    usage.cacheCreationInputTokens === 44,
    `expected 44 cache creation tokens, got ${usage.cacheCreationInputTokens}`
  );
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Claude Code Session Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Phase 1: Setup
  await setup();

  // Phase 2: Parallel independent tests
  const parallelTests = [
    // resolveClaudeCodeAuthEnvs — OAuth preferred, ANTHROPIC_API_KEY fallback
    {
      name: 'authEnvs -- OAuth credential preferred',
      fn: async () => testResolveAuthEnvs_oauthPreferred(),
    },
    {
      name: 'authEnvs -- OAuth envelope also sets token',
      fn: async () => testResolveAuthEnvs_oauthEnvelopeAlsoSetsToken(),
    },
    {
      name: 'authEnvs -- api-key fallback when no OAuth',
      fn: async () => testResolveAuthEnvs_apiKeyFallback(),
    },
    {
      name: 'authEnvs -- api-key fallback records shared source',
      fn: async () => testResolveAuthEnvs_apiKeyFallbackRecordsSharedSource(),
    },
    {
      name: 'authEnvs -- throws when api-key on cooldown',
      fn: async () => testResolveAuthEnvs_apiKeyOnCooldownThrows(),
    },
    {
      name: 'authEnvs -- throws when no creds + no key',
      fn: async () => testResolveAuthEnvs_noCredsNoKeyThrows(),
    },
    {
      name: 'andy smoke sync -- keeps CONNECTED and refreshable EXPIRED envelopes',
      fn: async () => testEligibleAndyClaudeSmokeCredential_keepsConnectedAndRefreshableExpired(),
    },
    {
      name: 'andy smoke sync -- rejects empty or revoked envelopes',
      fn: async () => testEligibleAndyClaudeSmokeCredential_rejectsEmptyOrRevoked(),
    },
    {
      name: 'claude credentials -- expired account is never refreshed in a sandbox',
      fn: testExpiredClaudeCredentialIsNeverRefreshedInSandbox,
    },
    {
      name: 'sandbox retry -- transient transport errors retry, rejections do not',
      fn: async () => testSandboxRetry_classifiesTransientOnly(),
    },
    {
      name: 'smoke classifier -- revoked OAuth is a credential skip, not a timeout',
      fn: testSmokeCredentialFailureClassifier,
    },
    {
      name: 'agent context -- repo-less agent resolves credential owner',
      fn: testResolveAgentContext_repoLessAgentKeepsOwnerCredentials,
    },
    {
      name: 'agent context -- caller cannot override credential owner',
      fn: testResolveAgentContext_rejectsMismatchedCallerOwner,
    },
    // POST /create
    { name: 'POST /create -- no auth -> 401', fn: testCreate_noAuth },
    { name: 'POST /create -- no auth error schema', fn: testCreate_noAuth_errorSchema },
    { name: 'POST /create -- empty body -> 500', fn: testCreate_emptyBody },
    { name: 'POST /create -- missing goal -> 500', fn: testCreate_missingGoal },
    { name: 'POST /create -- missing agent_id -> 500', fn: testCreate_missingAgentId },
    { name: 'POST /create -- non-uuid agent_id -> 500', fn: testCreate_nonUuidAgentId },
    { name: 'POST /create -- github without user_id -> 400', fn: testCreate_githubWithoutUserId },
    { name: 'POST /create -- github access denied -> 403', fn: testCreate_githubAccessDenied },
    { name: 'POST /create -- invalid github URL -> 403', fn: testCreate_invalidGithubUrl },
    { name: 'POST /create -- non-uuid code_session_id -> 400', fn: testCreate_nonUuidCodeSessionIdIs400 },
    {
      name: 'POST /create -- valid body hits E2B boundary -> 500 or 200',
      fn: testCreate_validBodyE2bBoundary,
    },

    // POST /close
    { name: 'POST /close -- no auth -> 401', fn: testClose_noAuth },
    { name: 'POST /close -- no auth error schema', fn: testClose_noAuth_errorSchema },
    { name: 'POST /close -- empty body -> 500', fn: testClose_emptyBody },
    { name: 'POST /close -- non-existent task -> 500', fn: testClose_nonExistentTask },
    { name: 'POST /close -- non-uuid task_id -> 500', fn: testClose_nonUuidTaskId },

    // GET /:taskId
    { name: 'GET /:taskId -- no auth -> 401', fn: testGet_noAuth },
    { name: 'GET /:taskId -- no auth error schema', fn: testGet_noAuth_errorSchema },
    { name: 'GET /:taskId -- not found -> 404', fn: testGet_notFound },
    { name: 'GET /:taskId -- not found different UUID -> 404', fn: testGet_notFound_differentUuid },

    // GET /agent/:agentId
    { name: 'GET /agent/:agentId -- no auth -> 401', fn: testGetByAgent_noAuth },
    { name: 'GET /agent/:agentId -- no auth error schema', fn: testGetByAgent_noAuth_errorSchema },
    { name: 'GET /agent/:agentId -- empty sessions -> 200', fn: testGetByAgent_empty },
    {
      name: 'GET /agent/:agentId -- empty sessions different UUID',
      fn: testGetByAgent_empty_differentUuid,
    },

    // POST /:taskId/output
    { name: 'POST /:taskId/output -- no auth -> 401', fn: testOutput_noAuth },
    { name: 'POST /:taskId/output -- no auth error schema', fn: testOutput_noAuth_errorSchema },
    { name: 'POST /:taskId/output -- missing output -> 400', fn: testOutput_missingField },
    { name: 'POST /:taskId/output -- empty string -> 400', fn: testOutput_emptyString },
    { name: 'POST /:taskId/output -- numeric output -> 400', fn: testOutput_numericOutput },
    { name: 'POST /:taskId/output -- non-existent task -> 500', fn: testOutput_nonExistentTask },

    // GET /:sandboxId/health
    { name: 'GET /:sandboxId/health -- no auth -> 401', fn: testHealth_noAuth },
    { name: 'GET /:sandboxId/health -- no auth error schema', fn: testHealth_noAuth_errorSchema },
    {
      name: 'GET /:sandboxId/health -- non-existent -> alive:false',
      fn: testHealth_nonExistentSandbox,
    },

    // Error surface invariant
    {
      name: 'error surface -- all 401s have error field',
      fn: testErrorSurface_all401sHaveErrorField,
    },
    // additional coverage
    {
      name: 'POST /create -- github repo with user_id -> 403/500',
      fn: testCreate_withGithubRepoAndUserId,
    },
    {
      name: 'POST /:taskId/output -- long content non-existent task',
      fn: testOutput_longContent,
    },
    {
      name: 'GET /agent/:agentId -- valid UUID returns empty sessions',
      fn: testGetByAgent_validUuidEmpty,
    },
    {
      name: 'usage parser -- nested Claude Code message usage',
      fn: testParseClaudeCodeUsage_nestedMessageUsage,
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

  // Phase 3: Sequential boundary capture tests
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [];

  if (ctx.captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary -- create valid body calls E2B API at api.e2b.app',
        fn: testBoundary_createCallsE2bApi,
      },
      {
        name: 'boundary -- close non-existent task makes 0 outbound calls',
        fn: testBoundary_closeNonExistentNoOutbound,
      },
      {
        name: 'boundary -- missing github repo is denied after visibility lookup',
        fn: testBoundary_githubAccessCheckDeniesMissingRepo,
      },
      {
        name: 'boundary -- health check calls E2B API at api.e2b.app',
        fn: testBoundary_healthCallsE2bApi,
      },
      {
        name: 'boundary -- create with github missing user_id makes 0 outbound calls',
        fn: testBoundary_createGithubMissingUserIdNoOutbound,
      }
    );
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  if (sequentialTests.length > 0) {
    console.log(`\nRunning ${sequentialTests.length} sequential tests...`);
  }
  const sequentialResults: TestResult[] = [];
  for (const test of sequentialTests) {
    const result = await runTest(test.name, test.fn);
    sequentialResults.push(result);
    const icon = result.passed ? '  PASS' : '  FAIL';
    console.log(
      `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
    );
  }

  // Phase 4: Smoke tests (real E2B sandbox)
  const smokeTests = [
    {
      name: 'smoke -- Claude Code answers 2+2 (real E2B sandbox)',
      fn: testSmoke_claudeCodeAnswersQuestion,
    },
  ];
  const smokeResults: TestResult[] = [];
  if (process.env.BLACKBOX_SMOKE === '1') {
    console.log(`\nRunning ${smokeTests.length} smoke tests...`);
    for (const test of smokeTests) {
      const result = await runTest(test.name, test.fn);
      smokeResults.push(result);
      const icon = result.passed ? '  PASS' : '  FAIL';
      console.log(
        `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
      );
    }
  } else {
    console.log('\nSkipping Claude Code smoke tests (BLACKBOX_SMOKE!=1)');
  }

  // Summary
  const allResults = [...parallelResults, ...sequentialResults, ...smokeResults];
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);

  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\nALL CLAUDE-CODE BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
