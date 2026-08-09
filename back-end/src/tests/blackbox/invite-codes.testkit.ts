/**
 * Shared test infrastructure for the invite-codes black-box suites:
 * response schemas, HTTP helpers, anon-session setup, capture helpers, and
 * the parallel test-pool runner. Imported by invite-codes.blackbox.ts and
 * invite-codes.part2.blackbox.ts; not a `*.blackbox.ts` file, so it is not
 * run as a domain.
 */

import { z } from 'zod';

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
export const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');

export const MASTER_CODE = 181818;

// ==================== RESPONSE SCHEMAS ====================

export const ErrorResponse = z.object({
  error: z.string(),
});

export const MyCodeResponse = z.object({
  inviteCode: z.number(),
  uses: z.number(),
  usesRemaining: z.number(),
});

export const UseCodeResponse = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const CheckResponse = z.object({
  needsInviteCode: z.boolean(),
  offWaitlist: z.boolean(),
});

export const AnonymousResponse = z.object({
  success: z.literal(true),
  user: z.object({ id: z.string() }),
  session: z.object({
    access_token: z.string(),
    expires_in: z.number(),
  }),
});

export const UsageResponse = z.object({
  total: z.number(),
  used: z.number(),
  remaining: z.number(),
});

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
    throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

export function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

export function assert(condition: boolean, message: string): void {
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

// ==================== CAPTURE HELPERS ====================

export async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

export function captureToken(prefix: string): string {
  return `invite-codes-${prefix}-${crypto.randomUUID()}`;
}

export async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ==================== SESSION HELPERS ====================

export async function createAnonSession(): Promise<{ accessToken: string; userId: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'anonymous setup');
  return { accessToken: body.session.access_token, userId: body.user.id };
}

// ==================== REPORTING ====================

export function printResults(results: TestResult[]): void {
  for (const r of results) {
    const icon = r.passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`);
  }
}

export function summarizeAndExit(allResults: TestResult[], suiteLabel: string): never {
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);

  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log(`\nALL ${suiteLabel} BLACK-BOX TESTS PASSED\n`);
  process.exit(0);
}
