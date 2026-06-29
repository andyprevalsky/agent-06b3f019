#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/data additional coverage.
 *
 * See also: data.blackbox.ts, data-grep.blackbox.ts, data-real-user.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
import { retryWithBackoff } from '../../providers/retry';
import { prisma } from '../../providers/database';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

const GrepMatch = z.object({
  source: z.enum(['messages', 'network', 'agent_network']),
  path: z.string(),
  pointer: z.string(),
  timestamp: z.string(),
  role: z.enum(['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']).optional(),
  location: z.object({
    source: z.enum(['messages', 'network', 'agent_network']),
    path: z.string(),
    agent_id: z.string().optional(),
    message_id: z.string().optional(),
    role: z.enum(['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']).optional(),
    thread: z.string().optional(),
    contact_id: z.string().optional(),
    field: z.string().optional(),
  }),
  content: z.string(),
});

const GrepResponse = z.object({
  matches: z.array(GrepMatch),
  total_matches: z.number(),
  truncated: z.boolean(),
  pattern: z.string(),
  sources: z.array(z.enum(['messages', 'network', 'agent_network'])),
  applied_limit: z.number(),
  applied_offset: z.number(),
  message: z.string().optional(),
});

const SummaryResponse = z.object({
  sources: z.object({
    messages: z.object({
      total_threads: z.number(),
      total_messages: z.number(),
      channels: z.record(z.number()),
      date_range: z.object({
        from: z.string().nullable(),
        to: z.string().nullable(),
      }),
      threads: z.array(
        z.object({
          name: z.string(),
          message_count: z.number(),
          last_message: z.string(),
        })
      ),
    }),
  }),
});

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  accessToken?: string;
  userId?: string;
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

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
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

async function setup(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  if (res.status !== 200) {
    throw new Error(
      `Setup failed: expected status 200, got ${res.status}: ${JSON.stringify(res.data).substring(0, 300)}`
    );
  }
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token;
  ctx.userId = d.user.id;
}

async function createAgentWithRetry(
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<string> {
  return retryWithBackoff(
    async () => {
      const createRes = await request(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (createRes.status !== 201) {
        const err = new Error(
          `Agent create failed: status ${createRes.status}: ${JSON.stringify(createRes.data).substring(0, 200)}`
        );
        Object.assign(err, { retryable: true });
        throw err;
      }
      return (createRes.data as { agent_id: string }).agent_id;
    },
    { maxRetries: 5, initialBackoffMs: 500, component: 'createAgentWithRetry' }
  );
}

async function deleteAgent(agentId: string): Promise<void> {
  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
}

async function testGrep_noMatchesMessageSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'xyzzy_never_matches_anything', source: 'messages' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (no matches message)');
  if (body.total_matches !== 0) {
    throw new Error(`Expected 0 total_matches, got ${body.total_matches}`);
  }
  if (!body.message?.includes('No matches')) {
    throw new Error(`Expected no-matches message, got: ${body.message}`);
  }
}

async function testGrep_removedParamRejected(param: string, value: unknown) {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', source: 'messages', [param]: value }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error?: string; message?: string };
  if (body.error !== 'INVALID_GREP_PARAM') {
    throw new Error(`Expected INVALID_GREP_PARAM for ${param}, got: ${JSON.stringify(body)}`);
  }
}

async function testGrep_removedSourceRejected(source: string) {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', source }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error?: string };
  if (body.error !== 'SOURCE_NOT_FOUND') {
    throw new Error(`Expected SOURCE_NOT_FOUND for ${source}, got: ${JSON.stringify(body)}`);
  }
}

async function testSummary_freshUserShapeDeep() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (deep shape)');
  const msgs = body.sources.messages;
  if (msgs.total_threads !== 0) {
    throw new Error(`Expected 0 total_threads, got ${msgs.total_threads}`);
  }
  if (msgs.total_messages !== 0) {
    throw new Error(`Expected 0 total_messages, got ${msgs.total_messages}`);
  }
  if (msgs.date_range.from !== null || msgs.date_range.to !== null) {
    throw new Error(`Expected null date range, got ${JSON.stringify(msgs.date_range)}`);
  }
  if (Object.keys(msgs.channels).length !== 0) {
    throw new Error(`Expected empty channels, got ${JSON.stringify(msgs.channels)}`);
  }
  if (msgs.threads.length !== 0) {
    throw new Error(`Expected 0 threads, got ${msgs.threads.length}`);
  }
}

async function testSummary_viaApiKeyDeep() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (API key deep)');
  const jwtRes = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const jwtBody = assertSchema(SummaryResponse, jwtRes.data, 'GET /summary (JWT cross-check)');
  if (body.sources.messages.total_messages !== jwtBody.sources.messages.total_messages) {
    throw new Error('API key and JWT summary disagree on total_messages');
  }
}

async function testGrep_invalidPatternType(value: unknown) {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: value }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'INVALID_PATTERN') {
    throw new Error(`Expected INVALID_PATTERN, got: ${body.error}`);
  }
}

async function seedAgentMessage(
  agentId: string,
  role: 'USER' | 'ASSISTANT' | 'TOOL',
  text: string
) {
  await prisma.message.create({
    data: {
      agentId,
      role,
      text,
      metadata: { blackbox: 'data-coverage', role },
    },
  });
}

async function testGrep_agentNetworkUnifiedSourceRouting() {
  const agentId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'unified agent network source routing test' }
  );

  try {
    await seedAgentMessage(agentId, 'USER', 'Unified source USER evidence');
    await seedAgentMessage(agentId, 'ASSISTANT', 'Unified source ASSISTANT evidence');
    await seedAgentMessage(agentId, 'TOOL', 'Unified source TOOL evidence');

    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      body: JSON.stringify({
        pattern: 'Unified source',
        source: 'agent_network',
        agent_id: agentId,
      }),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(GrepResponse, res.data, 'agent_network unified source routing');
    for (const role of ['USER', 'ASSISTANT', 'TOOL'] as const) {
      if (!body.matches.some((match) => match.role === role && match.location.role === role)) {
        throw new Error(`Expected agent_network match with ${role} role metadata`);
      }
    }
  } finally {
    await deleteAgent(agentId);
  }
}

async function testGrep_agentNetworkMultiLevelTree() {
  const rootId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'multi-level tree root' }
  );

  try {
    const childId = await createAgentWithRetry(
      { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      { goal: 'multi-level tree child', parent_agent_id: rootId }
    );
    const grandchildId = await createAgentWithRetry(
      { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      { goal: 'multi-level tree grandchild', parent_agent_id: childId }
    );

    try {
      await seedAgentMessage(rootId, 'USER', 'Tree walk root evidence');
      await seedAgentMessage(childId, 'ASSISTANT', 'Tree walk child evidence');
      await seedAgentMessage(grandchildId, 'TOOL', 'Tree walk grandchild evidence');

      const res = await request(`${BASE_URL}/api/data/grep`, {
        method: 'POST',
        headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
        body: JSON.stringify({
          pattern: 'Tree walk',
          source: 'agent_network',
          agent_id: grandchildId,
        }),
      });
      assertStatus(res.status, 200, res.data);
      const body = assertSchema(GrepResponse, res.data, 'agent_network multi-level tree');
      for (const expected of ['root evidence', 'child evidence', 'grandchild evidence']) {
        if (!body.matches.some((match) => match.content.includes(expected))) {
          throw new Error(`Expected tree result containing "${expected}"`);
        }
      }
    } finally {
      await deleteAgent(grandchildId);
      await deleteAgent(childId);
    }
  } finally {
    await deleteAgent(rootId);
  }
}

async function runAll() {
  console.log('Data Additional-Coverage Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  const parallelTests = [
    { name: 'POST /data/grep -- no matches message source', fn: testGrep_noMatchesMessageSource },
    {
      name: 'POST /data/grep -- removed param person_id rejected',
      fn: () => testGrep_removedParamRejected('person_id', 'nonexistent-person@example.com'),
    },
    {
      name: 'POST /data/grep -- removed param since rejected',
      fn: () => testGrep_removedParamRejected('since', '2025-06-01T00:00:00Z'),
    },
    {
      name: 'POST /data/grep -- removed param limit rejected',
      fn: () => testGrep_removedParamRejected('limit', 5),
    },
    {
      name: 'POST /data/grep -- removed source agent_network_user_messages rejected',
      fn: () => testGrep_removedSourceRejected('agent_network_user_messages'),
    },
    {
      name: 'POST /data/grep -- removed source agent_network_tool_results rejected',
      fn: () => testGrep_removedSourceRejected('agent_network_tool_results'),
    },
    { name: 'GET /data/summary -- fresh user deep shape', fn: testSummary_freshUserShapeDeep },
    { name: 'GET /data/summary -- API key vs JWT cross-check', fn: testSummary_viaApiKeyDeep },
    {
      name: 'POST /data/grep -- boolean pattern -> 400',
      fn: () => testGrep_invalidPatternType(true),
    },
    {
      name: 'POST /data/grep -- array pattern -> 400',
      fn: () => testGrep_invalidPatternType(['hello']),
    },
    {
      name: 'POST /data/grep -- object pattern -> 400',
      fn: () => testGrep_invalidPatternType({ foo: 'bar' }),
    },
    {
      name: 'POST /data/grep -- agent_network unified source returns all roles',
      fn: testGrep_agentNetworkUnifiedSourceRouting,
    },
    {
      name: 'POST /data/grep -- agent_network 3-level tree walks parent chain',
      fn: testGrep_agentNetworkMultiLevelTree,
    },
  ];

  console.log(`Running ${parallelTests.length} tests (concurrency=${CASE_CONCURRENCY})...`);
  const results = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    for (const r of results.filter((result) => !result.passed)) {
      console.log(`   ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

runAll().catch((error) => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
