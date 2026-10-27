/** Shared fixtures, contracts, and registration for the agents black-box suite. */
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { geoFromDeliveryAddress } from '../../providers/geoip';
import { CreateAgentResponse } from './agents-blackbox-contracts';

export * from './agents-blackbox-contracts';
export { randomUUID, z, prisma, geoFromDeliveryAddress };

config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
export const API_KEY = process.env.BACKEND_API_KEY || '';
export const FAKE_UUID = '00000000-0000-0000-0000-000000000000';
export const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;
export const rawCaseConcurrency =
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY || process.env.CONTRACT_TEST_CASE_CONCURRENCY;
export const CASE_CONCURRENCY = rawCaseConcurrency ? Number(rawCaseConcurrency) : 30;
export const EFFECTIVE_CASE_CONCURRENCY = 1;

if (!Number.isInteger(CASE_CONCURRENCY) || CASE_CONCURRENCY <= 0) {
  throw new Error(`Invalid BLACKBOX_TEST_CASE_CONCURRENCY: ${rawCaseConcurrency}`);
}

// ---------------------------------------------------------------------------
// Tracking for cleanup
// ---------------------------------------------------------------------------
export const trackedAgentIds = new Set<string>();
export const trackedUserIds = new Set<string>();

// ---------------------------------------------------------------------------
// Capture types
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

export interface AnonymousSessionData {
  session: { access_token: string };
  user: { id: string };
}

export interface RequestOptions extends RequestInit {
  body?: string;
}

export function isTransientDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Can't reach database server") ||
    message.includes('Server has closed the connection') ||
    message.includes('Timed out fetching a new connection') ||
    message.includes('P1001') ||
    message.includes('P1017') ||
    message.includes('P2024')
  );
}

/** Coverage load can reset sockets mid-request (`fetch failed` / UND_ERR). */
export function isTransientFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? `${error.cause.message} ${error.cause.name}`
      : error instanceof Error && error.cause !== undefined
        ? String(error.cause)
        : '';
  const haystack = `${message} ${cause}`;
  return (
    haystack.includes('fetch failed') ||
    haystack.includes('other side closed') ||
    haystack.includes('socket hang up') ||
    haystack.includes('ECONNRESET') ||
    haystack.includes('ECONNREFUSED') ||
    haystack.includes('UND_ERR')
  );
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTransientDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 6
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === attempts) throw error;
      console.warn(
        `[retry] ${label} attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function apiKeyHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) h['X-User-Id'] = userId;
  return h;
}

export async function request(
  url: string,
  options: RequestOptions = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || attempt === maxAttempts) throw error;
      console.warn(
        `[retry] request ${url} attempt ${attempt}/${maxAttempts}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      await sleep(250 * attempt);
    }
  }
  throw lastError;
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

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, workerIndex: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function runWorker(workerIndex: number): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], workerIndex);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(i)));
  return results;
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
  if (!result.success)
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}

export function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export async function createAnonymousSession(label: string): Promise<AnonymousSessionData> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
    if (res.status === 200) {
      const data = res.data as AnonymousSessionData;
      trackedUserIds.add(data.user.id);
      return data;
    }
    const transientFailure =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data;
    if (!transientFailure || attempt === 6) {
      assertStatus(res.status, 200, res.data);
    }
    console.warn(`[retry] auth anonymous for ${label} attempt ${attempt}/6`);
    await sleep(250 * attempt);
  }
  throw new Error(`Anonymous session setup exhausted retries for ${label}`);
}

/**
 * Create an agent via API key auth. Root agents are created in chat mode
 * (no start_phase), so chatHandler and GitHub repo creation still fire in the
 * background and these tests do not wait for them.
 *
 * Retries on:
 *  - Network errors (fetch throws): connection refused, DNS failures
 *  - HTTP 500 with "Failed to create agent": the server's creation pipeline
 *    failed (e.g., OpenRouter model pricing timeout under concurrency). The 500
 *    means the agent was NOT created, so retry is safe. Any partial DB rows are
 *    tracked and cleaned up.
 * Does NOT retry on other status codes (400, 401, 403, 404, 422, etc.).
 */
export async function createTestAgent(
  userId: string,
  goal?: string,
  extraBody?: Record<string, unknown>
): Promise<string> {
  const finalGoal = goal || `Blackbox test agent ${RUN_ID} ${randomUUID().slice(0, 8)}`;
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: { status: number; data: unknown; headers: Headers };
    try {
      res = await request(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers: apiKeyHeaders(userId),
        body: JSON.stringify({ goal: finalGoal, ...extraBody }),
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        console.warn(
          `[retry] createTestAgent attempt ${attempt}/${maxAttempts} network error: ${err}`
        );
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
    if (res.status === 201) {
      const body = assertSchema(CreateAgentResponse, res.data, 'createTestAgent');
      trackedAgentIds.add(body.agent_id);
      return body.agent_id;
    }
    // Only retry the specific "Failed to create agent" 500 — that means the
    // creation pipeline failed before persisting (e.g., OpenRouter pricing timeout).
    // Other 500s might indicate partial creation, so don't retry those.
    const isRetryable =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: unknown }).error === 'Failed to create agent';
    if (isRetryable && attempt < maxAttempts) {
      console.warn(`[retry] createTestAgent attempt ${attempt}/${maxAttempts} got retryable 500`);
      await sleep(1000 * attempt + Math.random() * 500);
      continue;
    }
    assertStatus(res.status, 201, res.data);
  }
  throw new Error('createTestAgent exhausted retries');
}

/**
 * POST /api/agents with retry on 500 "Failed to create agent".
 * Returns the full { status, data, headers } response on the first non-retryable result.
 * Only retries on 500 with error === 'Failed to create agent'; all other statuses are
 * returned immediately so callers can assert on them normally.
 */
export async function postAgentWithRetry(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  maxAttempts = 5
): Promise<{ status: number; data: unknown; headers: Headers }> {
  let lastRes: { status: number; data: unknown; headers: Headers } | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    lastRes = res;
    const isRetryable =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: unknown }).error === 'Failed to create agent';
    if (!isRetryable || attempt === maxAttempts) return res;
    console.warn(`[retry] postAgentWithRetry attempt ${attempt}/${maxAttempts} got 500`);
    await sleep(500 * attempt);
  }
  return lastRes!;
}

export async function deleteTestAgent(agentId: string, userId: string): Promise<void> {
  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(userId),
  });
}

export async function prepareTestParentWorkflow(parentId: string): Promise<void> {
  await prisma.agent.update({
    where: { id: parentId },
    data: { temporalWorkflowId: parentId },
  });
}

// ---------------------------------------------------------------------------
// Capture helpers (for boundary tests)
// ---------------------------------------------------------------------------
export async function clearCaptures(): Promise<void> {
  const res = await request(`${BASE_URL}/api/test/captures`, { method: 'DELETE' });
  assertStatus(res.status, 200, res.data);
}

export async function readCaptures(): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

export async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test definitions — each test is self-contained with its own fixtures
// ---------------------------------------------------------------------------
export interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

export const tests: TestCase[] = [];
export function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

export interface AgentRowOverrides {
  title?: string | null;
  pinnedAt?: Date | null;
  deletedAt?: Date | null;
  createdAt?: Date;
  status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  isBenchmark?: boolean;
  statusMessage?: string;
  parentAgentId?: string;
}

/**
 * Create an agent row directly, bypassing POST /api/agents.
 *
 * Two reasons the HTTP create path is wrong for some cases here:
 *  1. It fires `generateAgentTitle` for ROOT agents, which writes `title`
 *     asynchronously. Any case that asserts `title === null` would race it.
 *  2. `createdAt`/`deletedAt` cannot be chosen, and the ordering and limit cases
 *     need exact, non-adjacent timestamps rather than sleep-separated ones.
 *
 * The routes under test (PATCH /:id, GET /, GET /archived, POST /:id/unarchive)
 * are still exercised over HTTP — only the fixture is seeded directly, matching
 * the existing prisma-seeded cases in agents-cost-resume.cases.ts.
 */
export async function createAgentRow(
  userId: string,
  goal: string,
  overrides: AgentRowOverrides = {}
): Promise<string> {
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-sidebar-agent-row', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal,
        status: 'ACTIVE',
        busId: agentId,
        ...overrides,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });
  return agentId;
}
