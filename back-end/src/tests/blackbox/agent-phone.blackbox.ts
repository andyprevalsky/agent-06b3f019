#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';

config();

type TestFn = () => Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

async function createUser() {
  const userId = `agent-phone-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  return userId;
}

async function cleanup(userId: string) {
  await prisma.agentIdentity.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

function headers(userId?: string): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    ...(userId !== undefined ? { 'X-User-Id': userId } : {}),
  };
}

test('agent phone messages route enforces auth and validates query params', async () => {
  const noAuth = await request(`${BASE_URL}/api/agentphone/messages?since=2026-01-01T00:00:00Z`);
  assert(noAuth.status === 401, 'expected auth boundary');

  const missingUser = await request(
    `${BASE_URL}/api/agentphone/messages?since=2026-01-01T00:00:00Z`,
    { headers: headers() }
  );
  assert(missingUser.status === 400, 'expected missing user validation');

  const missingSince = await request(`${BASE_URL}/api/agentphone/messages`, {
    headers: headers('agent-phone-user'),
  });
  assert(missingSince.status === 400, 'expected missing since validation');

  const invalidSince = await request(`${BASE_URL}/api/agentphone/messages?since=not-a-date`, {
    headers: headers('agent-phone-user'),
  });
  assert(invalidSince.status === 400, 'expected invalid since validation');
});

test('agent phone messages route returns empty list without an AgentPhone identity', async () => {
  const userId = await createUser();
  try {
    const none = await request(
      `${BASE_URL}/api/agentphone/messages?since=2026-01-01T00:00:00Z&limit=200`,
      { headers: headers(userId) }
    );
    assert(none.status === 200, `expected 200, got ${none.status}`);
    const noneBody = none.data as { count?: unknown; messages?: unknown; since?: unknown };
    assert(noneBody.count === 0, 'expected no messages without identity');
    assert(Array.isArray(noneBody.messages), 'expected messages array');

    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.com`,
        phone: '',
        phoneProvider: 'manual',
        phoneProviderAgentId: null,
        phoneProviderNumberId: null,
      },
    });
    const unsupported = await request(
      `${BASE_URL}/api/agentphone/messages?since=2026-01-01T00:00:00Z&limit=0`,
      { headers: headers(userId) }
    );
    assert(unsupported.status === 200, `expected 200, got ${unsupported.status}`);
    const unsupportedBody = unsupported.data as { count?: unknown };
    assert(unsupportedBody.count === 0, 'expected no messages for non-AgentPhone identity');
  } finally {
    await cleanup(userId);
  }
});

async function main() {
  const results: Array<{ name: string; passed: boolean; error?: string; duration: number }> = [];
  for (const { name, fn } of tests) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, duration: Date.now() - start });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start,
      });
    }
  }

  console.log(`Agent Phone Black-box Tests (${tests.length} cases, runId=${RUN_ID})`);
  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(
      `  ${status} ${result.name}${result.passed ? '' : ` - ${result.error}`} (${result.duration}ms)`
    );
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
