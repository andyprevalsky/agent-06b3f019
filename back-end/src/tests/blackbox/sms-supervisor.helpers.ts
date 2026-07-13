/**
 * Shared helpers for sms-supervisor blackbox tests.
 *
 * Lives in a sibling file (rather than inlined in the test file) to keep the
 * test module under the project-wide max-lines limit. Contains:
 *   - HTTP request/assertion utilities
 *   - Surge capture lookup helpers
 *   - Per-user fixture-override wiring (POST/DELETE /api/test/sms-supervisor-fixture)
 *   - Unique-phone + user provisioning + cleanup
 */

import type { PrismaClient } from '@prisma/client';
import { buildSmsContext } from '../../providers/smsSupervisor/contextBuilder';

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

// ==================== HTTP ====================

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

export function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

// ==================== CAPTURE HARNESS ====================

export interface CapturedCall {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  captureToken: string | null;
}

export function captureToken(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

export async function readCapturesAfter(cursor: number): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

export function capturedSmsBody(call: CapturedCall): { to?: unknown; body?: unknown } | null {
  if (!call.requestBody) {
    return null;
  }
  try {
    return JSON.parse(call.requestBody) as { to?: unknown; body?: unknown };
  } catch {
    return null;
  }
}

export async function findSurgeCallForReply(
  token: string,
  cursor: number,
  phone: string,
  replyText: string
): Promise<CapturedCall | null> {
  const tokenCalls = await readCapturesForToken(token);
  const cursorCalls = await readCapturesAfter(cursor);
  const calls = [...tokenCalls, ...cursorCalls];
  return (
    calls.find((call) => {
      if (!call.url.includes('surge.app') || !call.url.endsWith('/messages')) {
        return false;
      }
      const body = capturedSmsBody(call);
      return body?.to === phone && body?.body === replyText;
    }) ?? null
  );
}

export async function dedupedSurgeRepliesFor(
  token: string,
  cursor: number,
  phone: string,
  replyText: string
): Promise<string[]> {
  const tokenCalls = await readCapturesForToken(token);
  const cursorCalls = await readCapturesAfter(cursor);
  const matches = [...tokenCalls, ...cursorCalls].filter((call) => {
    if (!call.url.includes('surge.app') || !call.url.endsWith('/messages')) {
      return false;
    }
    const body = capturedSmsBody(call);
    return body?.to === phone && body?.body === replyText;
  });
  const dedup = new Set(matches.map((c) => `${c.url}|${(c.requestBody ?? '').toString()}`));
  return [...dedup];
}

// ==================== POLLING ====================

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 7000,
  intervalMs = 100
): Promise<T> {
  // Recursive poll instead of while + setTimeout — eslint no-restricted-syntax
  // bans hand-rolled retry loops with WhileStatement:has(setTimeout).
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<T> => {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    return poll();
  };
  return poll();
}

// ==================== USER PROVISIONING ====================

const SMS_TEST_PHONE_PREFIX = '+1928'; // disjoint from sms-webhook's +1925
let nextPhoneCounter = 0;

export function uniqueSmsPhone(): string {
  nextPhoneCounter++;
  const rand = Math.floor(1000 + Math.random() * 9000);
  const counter = String(nextPhoneCounter).padStart(3, '0');
  return `${SMS_TEST_PHONE_PREFIX}${rand}${counter}`;
}

export async function provisionUserWithPhone(prisma: PrismaClient, phone: string): Promise<string> {
  const userId = `bb-sup-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  await prisma.user.create({
    data: { userId, phone, isAnonymous: true },
  });
  return userId;
}

// ==================== FIXTURE OVERRIDE ====================

// Keep in sync with BYPASS_FIXTURE_REAL_LLM in supervisorHandler.ts. The
// supervisor recognizes this exact sentinel as "skip fixture, run real LLM."
export const BYPASS_FIXTURE_REAL_LLM = '__bypass_real_llm__';

export async function setFixtureOverride(userId: string, fixture: string): Promise<void> {
  const res = await request(`${BASE_URL}/api/test/sms-supervisor-fixture`, {
    method: 'POST',
    body: JSON.stringify({ userId, fixture }),
  });
  assertStatus(res.status, 200, res.data);
}

export async function clearFixtureOverride(userId: string): Promise<void> {
  await request(
    `${BASE_URL}/api/test/sms-supervisor-fixture?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );
}

export function buildStartNewAgentFixture(
  goal: string,
  replyText: string,
  budgetDollars = 0.5,
  delayMs = 0
): string {
  return JSON.stringify({
    reasoning: 'spawn agent then send sms',
    tool_calls: [
      { tool: 'start_new_agent', arguments: { goal, budget_dollars: budgetDollars } },
      { tool: 'send_user_message', arguments: { message: replyText } },
      { tool: 'attempt_completion', arguments: {} },
    ],
    ...(delayMs > 0 ? { delay_ms: delayMs } : {}),
  });
}

/**
 * Fixture with a grep call followed by attempt_completion. All grep argument
 * keys are present (null when unused) because the fixture is validated with
 * SmsSupervisorResponseSchema, whose nullable fields are still required keys.
 */
export function buildGrepFixture(params: {
  pattern: string;
  source: string | null;
  replyText: string;
}): string {
  return JSON.stringify({
    reasoning: 'search user data then send sms',
    tool_calls: [
      {
        tool: 'grep',
        arguments: {
          pattern: params.pattern,
          source: params.source,
          '-B': null,
          '-A': null,
          '-C': null,
          context: null,
          '-n': null,
          '-i': null,
          head_limit: null,
          offset: null,
          multiline: null,
          filters: null,
          person: null,
          since: null,
        },
      },
      { tool: 'send_user_message', arguments: { message: params.replyText } },
      { tool: 'attempt_completion', arguments: {} },
    ],
  });
}

export function fixtureSmsReply(): string | null {
  const raw = process.env.BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON;
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as {
    tool_calls?: { tool?: string; arguments?: { message?: unknown } }[];
  };
  const send = parsed.tool_calls?.find((tc) => tc.tool === 'send_user_message');
  return typeof send?.arguments?.message === 'string' ? send.arguments.message : null;
}

// ==================== CLEANUP ====================

export async function cleanupAgentScopedUser(prisma: PrismaClient, userId: string): Promise<void> {
  await clearFixtureOverride(userId);
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.smsSession.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

export async function cleanupSessionScopedUser(
  prisma: PrismaClient,
  userId: string
): Promise<void> {
  await prisma.smsSession.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

// ==================== CONTEXT ASSERTIONS ====================

export async function assertRecentCompletedRootStaysInHierarchy(
  prisma: PrismaClient
): Promise<void> {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const recentSummary = 'Recent completion summary for SMS context retention';
  const oldSummary = 'Old completion summary should not be visible';

  try {
    const recentAgent = await prisma.agent.create({
      data: {
        userId,
        goal: 'Recent completed SMS root',
        status: 'COMPLETED',
        source: 'SMS',
        progress: 1,
      },
    });
    await prisma.message.create({
      data: {
        agentId: recentAgent.id,
        role: 'TOOL',
        text: recentSummary,
        metadata: {
          isFinalSummary: true,
          toolName: 'completion_summary',
          title: 'Completion summary',
          completionSummary: { summary: recentSummary },
        },
      },
    });

    const oldAgent = await prisma.agent.create({
      data: {
        userId,
        goal: 'Old completed SMS root',
        status: 'COMPLETED',
        source: 'SMS',
        progress: 1,
      },
    });
    await prisma.message.create({
      data: {
        agentId: oldAgent.id,
        role: 'TOOL',
        text: oldSummary,
        metadata: {
          isFinalSummary: true,
          toolName: 'completion_summary',
          title: 'Completion summary',
          completionSummary: { summary: oldSummary },
        },
      },
    });
    await prisma.$executeRaw`
      UPDATE "Agent"
      SET "updatedAt" = NOW() - INTERVAL '8 days'
      WHERE id = ${oldAgent.id}
    `;

    const context = await buildSmsContext(userId);

    if (!context.contextUserMessage.includes('Recent completed SMS root')) {
      throw new Error(
        `Expected recent completed root in hierarchy:\n${context.contextUserMessage}`
      );
    }
    if (!context.contextUserMessage.includes('COMPLETED')) {
      throw new Error(`Expected completed status in hierarchy:\n${context.contextUserMessage}`);
    }
    if (!context.contextUserMessage.includes(recentSummary)) {
      throw new Error(
        `Expected recent completion summary in context:\n${context.contextUserMessage}`
      );
    }
    if (context.contextUserMessage.includes('Old completed SMS root')) {
      throw new Error(
        `Did not expect old completed root in hierarchy:\n${context.contextUserMessage}`
      );
    }
    if (context.contextUserMessage.includes(oldSummary)) {
      throw new Error(
        `Did not expect old completion summary in context:\n${context.contextUserMessage}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

// ==================== TEST RUNNER ====================

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
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
