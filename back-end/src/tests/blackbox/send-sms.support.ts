import { config } from 'dotenv';
import { randomUUID, randomInt } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { listArchivedObjects } from '../../providers/traceArchive';
import { notificationFixtureKey } from '../../providers/smsSupervisor/notificationLlm';

config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

export const API_KEY = process.env.BACKEND_API_KEY || '';

export const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// Own the channel fixture; restored users can legitimately have WhatsApp enabled.
export const TEST_USER_ID = `bb-send-sms-${randomUUID()}`;

export const TEST_PHONE = `+1929${String(randomInt(10_000_000)).padStart(7, '0')}`;

export const FAKE_AGENT_ID = '00000000-0000-0000-0000-fakeagent001';

// The domain's one Prisma client is the app's own: a second client constructed before the first
// connect reads process.env while that connect's engine setenv()s SSL_CERT_FILE/SSL_CERT_DIR on
// another thread, and the process dies with SIGSEGV and no output (PR #2104 FLAKY fe640f0e).
export { prisma };

export async function createTestUser(): Promise<void> {
  await prisma.user.create({
    data: {
      userId: TEST_USER_ID,
      phone: TEST_PHONE,
      isAnonymous: true,
      whatsappReachable: false,
    },
  });
}

export async function cleanupTestUser(): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId: TEST_USER_ID } });
  await prisma.smsSession.deleteMany({ where: { userId: TEST_USER_ID } });
  await prisma.user.deleteMany({ where: { userId: TEST_USER_ID } });
}

// ==================== RESPONSE SCHEMAS ====================
export const SendSuccessSchema = z.object({
  success: z.literal(true),
  message_id: z.string(),
  phone_number: z.string(),
  provider: z.literal('surge'),
});

export const ErrorSchema = z.object({ error: z.string() });

export const NotifySuccessSchema = z.object({ success: z.literal(true) });

export const NotifyZodErrorSchema = z.object({
  error: z.string(),
  details: z.array(z.unknown()),
});

// ==================== TEST INFRASTRUCTURE ====================
export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

export interface CapturedCall {
  id: number;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  cached: boolean;
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
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data, headers: response.headers };
}

export function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
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
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ` + `${JSON.stringify(data).substring(0, 300)}`
    );
}

export function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(
      `${label} schema validation failed: ${result.error.message}\n` +
        `Actual data: ${JSON.stringify(data).substring(0, 500)}`
    );
  return result.data;
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export async function createNotifyAgent(goal: string) {
  return prisma.agent.create({
    data: {
      userId: TEST_USER_ID,
      goal,
      status: 'ACTIVE',
      source: 'SMS',
      progress: 0.25,
    },
  });
}

/**
 * Internal routing identifiers must never leak into SMS copy — even now that we
 * intentionally embed the per-agent deep link. The bracketed prefix, raw
 * attention id, and approval shortcode are all opaque routing tokens; the
 * `agent-id=` deep link is the one URL we DO want (asserted separately).
 */
export function assertNoRoutingLeaks(message: string, agentId: string): void {
  const prefix = agentId.substring(0, 6);
  assert(!message.includes(`[${prefix}]`), `Expected no agent prefix in SMS, got: ${message}`);
  assert(
    !/\battn[_-][a-z0-9-]+/i.test(message),
    `Expected no attention id in SMS, got: ${message}`
  );
  assert(
    !/\b(?:reply\s+)?approve\s+[A-Z0-9]{5}\b/i.test(message),
    `Expected no approval shortcode instruction in SMS, got: ${message}`
  );
}

/** The per-agent deep link (roselabs.ai?agent-id=…) must be present. */
export function assertAgentLinkPresent(message: string, agentId: string): void {
  assert(
    message.includes(`agent-id=${agentId}`),
    `Expected per-agent deep link (agent-id=${agentId}) in SMS, got: ${message}`
  );
}

/**
 * Every outbound Surge request MUST disable link shortening. Left at the account
 * default, Surge rewrites our branded roselabs.ai deep link into a generic
 * `srgv.co` shortlink, which carriers filter as "unwanted or malicious"
 * (failure_reason `message_filtered`) — silently dropping every link-bearing
 * SMS. Regression guard for that prod failure.
 */
export function assertLinkShorteningDisabled(body: Record<string, unknown>): void {
  const settings = body.settings as Record<string, unknown> | undefined;
  assert(
    settings?.link_shortening === 'disabled',
    `Expected settings.link_shortening="disabled" on the Surge request (else the ` +
      `branded link is shortened to srgv.co and carrier-filtered), got: ${JSON.stringify(
        body.settings
      )}`
  );
}

/**
 * The agent deep link is the ONLY URL allowed to survive sanitization; all
 * merchant/product/page URLs must still be stripped for carrier deliverability.
 */
export function assertOnlyAgentLinkUrl(message: string, agentId: string): void {
  assertAgentLinkPresent(message, agentId);
  const withoutAgentLink = message.replace(/https?:\/\/\S*agent-id=\S+/gi, '');
  assert(
    !/https?:\/\//i.test(withoutAgentLink),
    `Expected no non-agent URL in SMS body, got: ${message}`
  );
}

// ==================== CAPTURE HELPERS ====================
export async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

export function captureToken(prefix: string): string {
  return `send-sms-${prefix}-${crypto.randomUUID()}`;
}

/** Filter Surge calls and match on a specific body substring to isolate from concurrent tests. */
export function filterSurgeCalls(calls: CapturedCall[], bodySubstring?: string): CapturedCall[] {
  return calls.filter((c) => {
    if (!c.url.includes('surge.app')) return false;
    if (bodySubstring && c.requestBody) {
      return c.requestBody.includes(bodySubstring);
    }
    return bodySubstring === undefined;
  });
}

export async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function listSmsArchivePaths(rootAgentId: string): Promise<string[]> {
  const archivedObjects = await listArchivedObjects(rootAgentId);
  return archivedObjects
    .map((entry) => entry.path)
    .filter((entry) => entry.startsWith('provider/sms/surge/'))
    .sort();
}

/**
 * Whether the target backend has the trace archive disabled
 * (TRACE_ARCHIVE_ENABLED=0 — the /deploy Step-5 stack config). agent-start
 * responds `fixture: null` ONLY in that case; every real archive failure
 * throws server-side instead. Probed lazily — only when an archive assertion
 * is about to fail — so archive-enabled stacks see no extra writes.
 */
export async function archiveDisabledOnBackend(agentId: string): Promise<boolean> {
  const res = await request(`${BASE_URL}/api/archive/agent-start`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agentId }),
  });
  return res.status === 200 && (res.data as { fixture?: unknown | null }).fixture === null;
}

export async function setNotificationFixture(agentId: string, fixture: unknown): Promise<void> {
  const response = await request(`${BASE_URL}/api/test/sms-supervisor-fixture`, {
    method: 'POST',
    body: JSON.stringify({
      userId: notificationFixtureKey(agentId),
      fixture: JSON.stringify(fixture),
    }),
  });
  assertStatus(response.status, 200, response.data);
}

export async function clearNotificationFixture(agentId: string): Promise<void> {
  await request(
    `${BASE_URL}/api/test/sms-supervisor-fixture?userId=${encodeURIComponent(notificationFixtureKey(agentId))}`,
    { method: 'DELETE' }
  );
}
