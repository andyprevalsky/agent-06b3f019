#!/usr/bin/env tsx

import { createHash, randomUUID } from 'node:crypto';
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

async function cleanup(userId: string, operationKeys: string[] = []) {
  if (operationKeys.length > 0) {
    await prisma.toolSideEffect.deleteMany({ where: { operationKey: { in: operationKeys } } });
  }
  await prisma.agentIdentity.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

function headers(userId?: string): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    ...(userId !== undefined ? { 'X-User-Id': userId } : {}),
  };
}

function outboundOperationKey(userId: string, agentId: string, idempotencyKey: string) {
  const digest = createHash('sha256')
    .update(`${userId}\0${agentId}\0${idempotencyKey}`)
    .digest('hex');
  return `agentphone.message:${digest}`;
}

function outboundPayload(userId: string, idempotencyKey: string) {
  return {
    user_id: userId,
    agent_id: 'agent-1',
    idempotency_key: idempotencyKey,
    phone_number: '+19729777432',
    message: 'Immediate AgentPhone boundary test',
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

test('outbound Agent SMS enforces auth, validation, and configured sender identity', async () => {
  const userId = await createUser();
  try {
    const noAuth = await request(`${BASE_URL}/api/agentphone/messages/send`, {
      method: 'POST',
      body: JSON.stringify(outboundPayload(userId, 'no-auth')),
    });
    assert(noAuth.status === 401, `expected outbound auth boundary, got ${noAuth.status}`);

    const invalid = await request(`${BASE_URL}/api/agentphone/messages/send`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        ...outboundPayload(userId, 'invalid-phone'),
        phone_number: '9729777432',
      }),
    });
    assert(invalid.status === 400, `expected invalid phone 400, got ${invalid.status}`);

    const noIdentity = await request(`${BASE_URL}/api/agentphone/messages/send`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(outboundPayload(userId, 'no-identity')),
    });
    assert(noIdentity.status === 409, `expected missing sender 409, got ${noIdentity.status}`);
  } finally {
    await cleanup(userId);
  }
});

test('outbound Agent SMS replays completed receipt without another provider send', async () => {
  const userId = await createUser();
  const idempotencyKey = 'completed-replay';
  const operationKey = outboundOperationKey(userId, 'agent-1', idempotencyKey);
  try {
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phone: '+19125550100',
        phoneProvider: 'agentphone',
        phoneProviderAgentId: 'provider-agent-1',
        phoneProviderNumberId: 'number-1',
      },
    });
    const response = {
      success: true,
      status: 'sent',
      message_id: 'msg-existing',
      provider: 'agentphone',
      provider_channel: 'sms',
      from_number: '+19125550100',
      to_number: '+19729777432',
      conversation_id: 'conv-existing',
    };
    await prisma.toolSideEffect.create({
      data: {
        operationKey,
        operationType: 'agentphone.message',
        status: 'SUCCEEDED',
        externalId: 'msg-existing',
        request: outboundPayload(userId, idempotencyKey),
        response,
      },
    });
    const queueCountBefore = await prisma.imessageQueue.count({ where: { userId } });

    const replay = await request(`${BASE_URL}/api/agentphone/messages/send`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(outboundPayload(userId, idempotencyKey)),
    });
    assert(replay.status === 200, `completed replay failed: ${JSON.stringify(replay.data)}`);
    assert(
      (replay.data as { message_id?: unknown }).message_id === 'msg-existing',
      'completed replay lost provider receipt'
    );

    const conflict = await request(`${BASE_URL}/api/agentphone/messages/send`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        ...outboundPayload(userId, idempotencyKey),
        message: 'Different payload must not reuse the receipt',
      }),
    });
    assert(conflict.status === 409, `expected idempotency conflict 409, got ${conflict.status}`);
    const queueCountAfter = await prisma.imessageQueue.count({ where: { userId } });
    assert(
      queueCountAfter === queueCountBefore,
      'AgentPhone replay/conflict path mutated the user iMessage queue'
    );
  } finally {
    await cleanup(userId, [operationKey]);
  }
});

test('outbound Agent SMS refuses an ambiguous retry instead of duplicating a text', async () => {
  const userId = await createUser();
  const idempotencyKey = 'ambiguous-start';
  const operationKey = outboundOperationKey(userId, 'agent-1', idempotencyKey);
  try {
    await prisma.agentIdentity.create({
      data: {
        userId,
        email: `${userId}@example.test`,
        phone: '+19125550100',
        phoneProvider: 'agentphone',
        phoneProviderAgentId: 'provider-agent-1',
        phoneProviderNumberId: 'number-1',
      },
    });
    await prisma.toolSideEffect.create({
      data: {
        operationKey,
        operationType: 'agentphone.message',
        status: 'STARTED',
        request: outboundPayload(userId, idempotencyKey),
      },
    });
    const ambiguous = await request(`${BASE_URL}/api/agentphone/messages/send`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(outboundPayload(userId, idempotencyKey)),
    });
    assert(ambiguous.status === 409, `expected ambiguous retry 409, got ${ambiguous.status}`);
    assert(
      String((ambiguous.data as { error?: unknown }).error)
        .toLowerCase()
        .includes('refusing'),
      `ambiguous retry error was not explicit: ${JSON.stringify(ambiguous.data)}`
    );
  } finally {
    await cleanup(userId, [operationKey]);
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
