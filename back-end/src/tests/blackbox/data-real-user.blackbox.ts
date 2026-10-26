#!/usr/bin/env tsx
/**
 * Black-box tests for /api/data — real-user pipeline coverage.
 *
 * Uses the real test user (1f85ff25...) who has tens of thousands of messages
 * across hundreds of threads/contacts. Exercises the FULL unified Grep pipeline
 * (regex search → grepRepo → format) against real prod-synced data, across all
 * three sources and the messages-only `person`/`since` narrowing.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/data-real-user.blackbox.ts
 */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// Real test user with tens of thousands of messages across hundreds of threads.
const TEST_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

async function seedDeterministicCorpus(): Promise<string[]> {
  await prisma.user.upsert({
    where: { userId: TEST_USER_ID },
    create: { userId: TEST_USER_ID, isAnonymous: true },
    update: {},
  });

  const suffix = randomUUID();
  const mom = await prisma.person.create({
    data: {
      userId: TEST_USER_ID,
      firstName: 'Mom',
      lastName: `Blackbox-${suffix}`,
      email: `mom-${suffix}@data-blackbox.local`,
      relation: 'family',
      messagesExchanged: 3,
    },
  });
  const maya = await prisma.person.create({
    data: {
      userId: TEST_USER_ID,
      firstName: 'Maya',
      lastName: `Blackbox-${suffix}`,
      email: `maya-${suffix}@data-blackbox.local`,
      company: 'Atlas Planning',
      messagesExchanged: 2,
    },
  });

  const now = Date.now();
  await prisma.messageRecord.createMany({
    data: [
      {
        personId: mom.id,
        userId: TEST_USER_ID,
        channel: 'IMESSAGE',
        from: '+15550000001',
        to: '+15550000002',
        timestamp: new Date(now - 2 * 60 * 60 * 1000),
        externalId: `dinner-${suffix}`,
        message: 'Thanks for arranging dinner. The family meetup is at seven.',
      },
      {
        personId: maya.id,
        userId: TEST_USER_ID,
        channel: 'EMAIL',
        from: `maya-${suffix}@data-blackbox.local`,
        to: 'owner@data-blackbox.local',
        timestamp: new Date(now - 60 * 60 * 1000),
        externalId: `meeting-${suffix}`,
        message: 'The Atlas planning meeting is confirmed. Thanks again.',
      },
    ],
  });

  return [mom.id, maya.id];
}

async function cleanupDeterministicCorpus(personIds: string[]): Promise<void> {
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
}

// ==================== RESPONSE SCHEMAS (unified Grep contract) ====================

const GrepMatch = z.object({
  source: z.enum(['messages', 'network', 'agent_network']),
  path: z.string(),
  pointer: z.string(),
  timestamp: z.string(),
  role: z.enum(['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']).optional(),
  location: z.object({}).passthrough(),
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
      latest_message: z
        .object({
          timestamp: z.string(),
          channel: z.string(),
          from: z.string(),
          to: z.string(),
          text: z.string(),
        })
        .nullable(),
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

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

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
  if (ct?.includes('application/json') === true) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data, headers: response.headers };
}

function testUserHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-User-Id': TEST_USER_ID };
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

async function grep(body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
  return request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify(body),
  });
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

// ==================== REAL-USER TESTS (new unified contract) ====================

// 1. Messages regex match against real data — full pipeline returns flat matches.
async function testGrep_realUserWithMatches() {
  const res = await grep({ pattern: 'dinner', source: 'messages', head_limit: 3 });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user matches)');
  if (body.total_matches === 0) {
    throw new Error('Expected matches for "dinner" with real user, got 0');
  }
  if (body.matches.length === 0) {
    throw new Error('Expected formatted matches, got empty array');
  }
  for (const m of body.matches) {
    if (m.source !== 'messages') throw new Error(`Expected source=messages, got ${m.source}`);
    if (m.content.length === 0) throw new Error('Expected non-empty match content');
  }
}

// 2. Empty pattern returns recent messages (exercises the empty-pattern scan path).
async function testGrep_realUserEmptyPattern() {
  const res = await grep({ pattern: '', source: 'messages', head_limit: 5 });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user empty pattern)');
  if (body.total_matches === 0) {
    throw new Error('Expected matches for empty pattern with real user');
  }
}

// 3. Explicit source resolution.
async function testGrep_realUserExplicitSource() {
  const res = await grep({ pattern: 'meeting', source: 'messages', head_limit: 3 });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user explicit source)');
  if (body.sources.join(',') !== 'messages') {
    throw new Error(`Expected sources=[messages], got ${body.sources.join(',')}`);
  }
}

// 4. `since` narrowing (messages-only) — both ISO and relative forms accepted.
async function testGrep_realUserWithSince() {
  for (const since of ['2024-01-01T00:00:00Z', '365d']) {
    const res = await grep({ pattern: '', source: 'messages', since, head_limit: 5 });
    assertStatus(res.status, 200, res.data);
    assertSchema(GrepResponse, res.data, `POST /grep (real user since=${since})`);
  }
}

// 5. head_limit caps returned matches.
async function testGrep_realUserHeadLimit1() {
  const res = await grep({ pattern: 'thanks', source: 'messages', head_limit: 1 });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user head_limit=1)');
  if (body.matches.length > 1) {
    throw new Error(`Expected at most 1 match, got ${body.matches.length}`);
  }
  if (body.applied_limit !== 1) {
    throw new Error(`Expected applied_limit=1, got ${body.applied_limit}`);
  }
}

// 6. Regex pattern over real data (not just literal).
async function testGrep_realUserRegex() {
  const res = await grep({ pattern: 'meet(ing|up)', source: 'messages', head_limit: 5 });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (real user regex)');
}

// 7. Summary pipeline over real data.
async function testSummary_realUser() {
  const res = await request(`${BASE_URL}/api/data/summary`, { headers: testUserHeaders() });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (real user)');
  const msgs = body.sources.messages;
  if (msgs.total_threads === 0) throw new Error('Expected non-zero threads for real user');
  if (msgs.total_messages === 0) throw new Error('Expected non-zero messages for real user');
  if (msgs.date_range.from === null || msgs.date_range.to === null) {
    throw new Error('Expected non-null date range for real user');
  }
  if (Object.keys(msgs.channels).length === 0) {
    throw new Error('Expected non-empty channels for real user');
  }
  if (msgs.threads.length === 0) throw new Error('Expected non-empty threads for real user');
}

// 8. Summary formatTimeAgo suffixes.
async function testSummary_realUserThreadTimestamps() {
  const res = await request(`${BASE_URL}/api/data/summary`, { headers: testUserHeaders() });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (timestamps)');
  const validSuffixes = ['m ago', 'h ago', 'd ago', 'mo ago'];
  for (const thread of body.sources.messages.threads.slice(0, 5)) {
    const hasValidSuffix = validSuffixes.some((s) => thread.last_message.endsWith(s));
    if (!hasValidSuffix && thread.last_message !== 'unknown') {
      throw new Error(`Expected time-ago suffix, got: ${thread.last_message}`);
    }
  }
}

// 9. Large head_limit (= MAX_RESULTS) — exercises the result cap.
async function testGrep_realUserLargeLimit() {
  const res = await grep({ pattern: '', source: 'messages', head_limit: 50 });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user large limit)');
  if (body.total_matches > 0 && body.matches.length === 0) {
    throw new Error('Expected formatted matches when total_matches > 0');
  }
}

// 10. `person` narrowing (messages-only) — resolves email/phone/name; unknown → empty 200.
async function testGrep_realUserPersonNarrowing() {
  const res = await grep({ pattern: '', source: 'messages', person: 'Mom', head_limit: 3 });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (person narrowing)');

  const unknown = await grep({
    pattern: '',
    source: 'messages',
    person: 'definitely-nobody@example.invalid',
    head_limit: 3,
  });
  assertStatus(unknown.status, 200, unknown.data);
  const body = assertSchema(GrepResponse, unknown.data, 'POST /grep (person unknown)');
  if (body.total_matches !== 0) {
    throw new Error(`Expected 0 matches for unknown person, got ${body.total_matches}`);
  }
}

// 11. agent_network over a real, freshly-created agent.
async function testGrepAgentNetwork_realUserAgent() {
  const agentId = await createAgentWithRetry(testUserHeaders(), {
    goal: 'coverage test agent for agent network grep',
  });
  try {
    const res = await grep({
      pattern: '',
      source: 'agent_network',
      agent_id: agentId,
      head_limit: 10,
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(GrepResponse, res.data, 'agent_network real user');
    for (const m of body.matches) {
      if (m.source !== 'agent_network') {
        throw new Error(`Expected source=agent_network, got ${m.source}`);
      }
    }
  } finally {
    const deleteRes = await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: testUserHeaders(),
    });
    if (deleteRes.status !== 200 && deleteRes.status !== 204) {
      console.error(`Agent cleanup failed: status ${deleteRes.status}`);
    }
  }
}

// 12. network source — empty pattern returns top contacts (unified flat matches).
async function testGrepNetwork_realUserTopContacts() {
  const res = await grep({ pattern: '', source: 'network', head_limit: 20 });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (network top contacts)');
  if (body.total_matches === 0) {
    throw new Error('Expected non-empty top contacts for real user');
  }
  for (const m of body.matches) {
    if (m.source !== 'network') throw new Error(`Expected source=network, got ${m.source}`);
  }
}

// 13. network source — keyword match over real contacts.
async function testGrepNetwork_realUserKeyword() {
  const res = await grep({ pattern: 'a', source: 'network', '-i': true, head_limit: 10 });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (network keyword)');
  if (body.matches.length === 0) {
    throw new Error("Expected matches for 'a' pattern in real user network");
  }
}

// 14. Omitted source searches all three buckets in one call.
async function testGrep_realUserAllSources() {
  const agentId = await createAgentWithRetry(testUserHeaders(), {
    goal: 'coverage test agent for all-source grep',
  });
  try {
    const res = await grep({ pattern: 'a', agent_id: agentId, '-i': true, head_limit: 30 });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(GrepResponse, res.data, 'POST /grep (all sources)');
    if (body.sources.join(',') !== 'messages,network,agent_network') {
      throw new Error(`Expected all three sources, got ${body.sources.join(',')}`);
    }
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: testUserHeaders(),
    });
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Data Real-User Pipeline Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Using real test user: ${TEST_USER_ID}\n`);

  const personIds = await seedDeterministicCorpus();
  const parallelTests = [
    {
      name: 'POST /data/grep -- real user with matches (full pipeline)',
      fn: testGrep_realUserWithMatches,
    },
    { name: 'POST /data/grep -- real user empty pattern', fn: testGrep_realUserEmptyPattern },
    { name: 'POST /data/grep -- real user explicit source', fn: testGrep_realUserExplicitSource },
    { name: 'POST /data/grep -- real user since narrowing', fn: testGrep_realUserWithSince },
    { name: 'POST /data/grep -- real user head_limit=1', fn: testGrep_realUserHeadLimit1 },
    { name: 'POST /data/grep -- real user regex', fn: testGrep_realUserRegex },
    { name: 'GET /data/summary -- real user with messages', fn: testSummary_realUser },
    {
      name: 'GET /data/summary -- real user thread timestamps',
      fn: testSummary_realUserThreadTimestamps,
    },
    { name: 'POST /data/grep -- real user large limit', fn: testGrep_realUserLargeLimit },
    { name: 'POST /data/grep -- real user person narrowing', fn: testGrep_realUserPersonNarrowing },
    { name: 'POST /data/grep -- real user agent network', fn: testGrepAgentNetwork_realUserAgent },
    { name: 'POST /data/grep -- network top contacts', fn: testGrepNetwork_realUserTopContacts },
    { name: 'POST /data/grep -- network keyword match', fn: testGrepNetwork_realUserKeyword },
    { name: 'POST /data/grep -- omitted source searches all', fn: testGrep_realUserAllSources },
  ];

  console.log(`Running ${parallelTests.length} tests (concurrency=${CASE_CONCURRENCY})...`);
  let results: TestResult[];
  try {
    results = await runPool(parallelTests, CASE_CONCURRENCY);
  } finally {
    await cleanupDeterministicCorpus(personIds);
  }

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
    results.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    throw new Error(`${failed} data real-user black-box test(s) failed`);
  }
  console.log('\nALL DATA REAL-USER TESTS PASSED\n');
}

runAll()
  .catch((error) => {
    console.error('\nCrashed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
