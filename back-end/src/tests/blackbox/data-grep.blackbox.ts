#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for the DB-backed Grep contract.
 */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { z } from 'zod';
import { prisma } from '../../providers/database';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

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

type GrepBody = z.infer<typeof GrepResponse>;

function apiHeaders(userId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
    'X-User-Id': userId,
  };
}

async function requestGrep(userId: string, body: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

function assertBody(data: unknown): GrepBody {
  return GrepResponse.parse(data);
}

function requireContent(body: GrepBody, expected: string): void {
  if (!body.matches.some((match) => match.content.includes(expected))) {
    throw new Error(`Expected grep result containing ${expected}, got ${JSON.stringify(body)}`);
  }
}

function forbidLineNumbers(body: GrepBody): void {
  for (const match of body.matches) {
    if (/^\d+:/m.test(match.content)) {
      throw new Error(`Expected no line numbers, got ${match.content}`);
    }
  }
}

async function cleanup(userId: string): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function seedFixture() {
  const userId = `grep-contract-${randomUUID()}`;
  await cleanup(userId);
  await prisma.user.create({ data: { userId, isAnonymous: true } });

  const lighthouse = await prisma.person.create({
    data: {
      userId,
      firstName: 'Lighthouse',
      lastName: 'Archive',
      email: `lighthouse-${randomUUID()}@grep-benchmark.local`,
      messagesExchanged: 40,
    },
  });
  await prisma.messageRecord.createMany({
    data: [
      {
        personId: lighthouse.id,
        channel: 'EMAIL',
        from: 'lighthouse@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date('2026-01-01T10:00:00Z'),
        externalId: `quarterly-${randomUUID()}`,
        message: [
          'Before-context evidence: finance owner noted',
          'Aurora budget: phase-17 approved',
          'After-context evidence: forecast packet delivered',
        ].join('\n'),
      },
      {
        personId: lighthouse.id,
        channel: 'EMAIL',
        from: 'lighthouse@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date('2026-01-02T10:00:00Z'),
        externalId: `multiline-${randomUUID()}`,
        message: [
          'Multiline incident START',
          'requires cross-line search',
          'incident END',
          'MiXeDcAsE Beacon',
        ].join('\n'),
      },
      ...Array.from({ length: 30 }, (_, idx) => ({
        personId: lighthouse.id,
        channel: 'EMAIL' as const,
        from: 'ledger@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date(`2026-01-03T10:${String(idx).padStart(2, '0')}:00Z`),
        externalId: `ledger-${idx + 1}-${randomUUID()}`,
        message: `Ledger entry ${idx + 1}: ${idx + 1 === 21 ? 'offset target confirmed' : 'ordinary ledger row'}`,
      })),
    ],
  });

  await prisma.person.create({
    data: {
      userId,
      firstName: 'Mara',
      lastName: 'Voss',
      email: `mara-${randomUUID()}@grep-benchmark.local`,
      company: 'Northstar Calibration Group',
      title: 'Principal Signal Cartographer',
      relation: 'benchmark verification contact',
      communicationFrequency: 'quarterly lighthouse cadence',
      messagesExchanged: 90,
    },
  });

  const root = await prisma.agent.create({
    data: {
      userId,
      goal: 'grep contract root',
      status: 'COMPLETED',
      depth: 0,
    },
  });
  const child = await prisma.agent.create({
    data: {
      userId,
      goal: 'grep contract child',
      status: 'COMPLETED',
      parentAgentId: root.id,
      depth: 1,
    },
  });
  await prisma.message.createMany({
    data: [
      {
        agentId: root.id,
        role: 'USER',
        text: 'Atlas handoff was confirmed by the user.',
        metadata: { benchmark: 'grep', roleCase: 'user' },
        createdAt: new Date('2026-01-04T10:00:00Z'),
      },
      {
        agentId: child.id,
        role: 'ASSISTANT',
        text: 'Atlas handoff confirmed in assistant response.',
        metadata: { benchmark: 'grep', roleCase: 'assistant' },
        createdAt: new Date('2026-01-04T10:01:00Z'),
      },
      {
        agentId: child.id,
        role: 'TOOL',
        text: 'Grep tool returned Atlas handoff tool evidence.',
        metadata: { benchmark: 'grep', roleCase: 'tool', toolStatus: 'FINISHED' },
        createdAt: new Date('2026-01-04T10:02:00Z'),
      },
      {
        agentId: child.id,
        role: 'SYSTEM',
        text: 'Atlas handoff system breadcrumb.',
        metadata: { benchmark: 'grep', roleCase: 'system' },
        createdAt: new Date('2026-01-04T10:03:00Z'),
      },
    ],
  });

  return { userId, agentId: child.id };
}

async function testSchemaAndRemovedParams(userId: string): Promise<void> {
  for (const param of [
    'path',
    'glob',
    'type',
    'output_mode',
    'person_id',
    'limit',
    'roles',
    'search_in',
    'tool_name',
    'tool_status',
  ]) {
    const res = await requestGrep(userId, { pattern: 'x', [param]: 'bad' });
    assertStatus(res.status, 400, res.data);
    if ((res.data as { error?: string }).error !== 'INVALID_GREP_PARAM') {
      throw new Error(`Expected INVALID_GREP_PARAM for ${param}, got ${JSON.stringify(res.data)}`);
    }
  }

  for (const source of ['agent_network_user_messages', 'agent_network_tool_results']) {
    const res = await requestGrep(userId, { pattern: 'x', source });
    assertStatus(res.status, 400, res.data);
    if ((res.data as { error?: string }).error !== 'SOURCE_NOT_FOUND') {
      throw new Error(`Expected SOURCE_NOT_FOUND for ${source}, got ${JSON.stringify(res.data)}`);
    }
  }
}

async function testAllSources(userId: string, agentId: string): Promise<void> {
  const res = await requestGrep(userId, {
    pattern: 'Aurora|Northstar|Atlas',
    agent_id: agentId,
    head_limit: 20,
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  if (body.sources.join(',') !== 'messages,network,agent_network') {
    throw new Error(`Expected all sources, got ${body.sources.join(',')}`);
  }
  for (const source of ['messages', 'network', 'agent_network'] as const) {
    if (!body.matches.some((match) => match.source === source)) {
      throw new Error(`Expected omitted source search to include ${source}`);
    }
  }
}

async function testRegexAndSources(userId: string, agentId: string): Promise<void> {
  let res = await requestGrep(userId, { pattern: 'phase-[0-9]+ approved', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'phase-17 approved');

  res = await requestGrep(userId, { pattern: 'Signal Cartographer', source: 'network' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Principal Signal Cartographer');

  res = await requestGrep(userId, {
    pattern: 'Atlas handoff',
    source: 'agent_network',
    agent_id: agentId,
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  for (const role of ['USER', 'ASSISTANT', 'TOOL', 'SYSTEM'] as const) {
    if (!body.matches.some((match) => match.role === role && match.location.role === role)) {
      throw new Error(
        `Expected agent_network result with role ${role}, got ${JSON.stringify(body)}`
      );
    }
  }
}

async function testFlags(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'mixedcase beacon',
    source: 'messages',
    '-i': true,
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'MiXeDcAsE Beacon');

  res = await requestGrep(userId, {
    pattern: 'Multiline incident START.*incident END',
    source: 'messages',
    multiline: true,
  });
  assertStatus(res.status, 200, res.data);
  const multiline = assertBody(res.data);
  requireContent(multiline, 'Multiline incident START');
  requireContent(multiline, 'incident END');

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    '-A': 1,
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'After-context evidence');

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    '-B': 1,
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Before-context evidence');

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    context: 1,
  });
  assertStatus(res.status, 200, res.data);
  const context = assertBody(res.data);
  requireContent(context, 'Before-context evidence');
  requireContent(context, 'After-context evidence');

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    '-n': false,
  });
  assertStatus(res.status, 200, res.data);
  forbidLineNumbers(assertBody(res.data));

  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    head_limit: 5,
    offset: 20,
  });
  assertStatus(res.status, 200, res.data);
  const paged = assertBody(res.data);
  requireContent(paged, 'Ledger entry 10');
  if (paged.applied_limit !== 5 || paged.applied_offset !== 20) {
    throw new Error(`Expected pagination metadata, got ${JSON.stringify(paged)}`);
  }
}

async function testInvalidRegex(userId: string): Promise<void> {
  const res = await requestGrep(userId, { pattern: '[' });
  assertStatus(res.status, 400, res.data);
  if ((res.data as { error?: string }).error !== 'INVALID_PATTERN') {
    throw new Error(`Expected INVALID_PATTERN, got ${JSON.stringify(res.data)}`);
  }
}

// Catastrophic-backtracking patterns must be rejected (fast 400) before they
// reach Postgres `~`, which would otherwise run for seconds-to-minutes.
async function testRedosGuardRejects(userId: string): Promise<void> {
  for (const pattern of ['(a+)+$', '([a-z]+)*$', '(.*a){20}$', '(\\w+\\s?)+$', '(a|a)*$']) {
    const res = await requestGrep(userId, { pattern, source: 'messages' });
    assertStatus(res.status, 400, res.data);
    if ((res.data as { error?: string }).error !== 'INVALID_PATTERN') {
      throw new Error(
        `Expected INVALID_PATTERN for ReDoS pattern ${pattern}, got ${JSON.stringify(res.data)}`
      );
    }
  }
}

// Regex features that are valid in JS but not Postgres ARE must be normalized
// and succeed (200), not 500: named groups → plain groups, inline (?i) → -i.
async function testDialectNormalization(userId: string): Promise<void> {
  let res = await requestGrep(userId, { pattern: '(?<grp>phase)-17', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'phase-17 approved');

  res = await requestGrep(userId, { pattern: '(?i)aurora budget', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Aurora budget');
}

// Realistic, safe (degree ≤ 2) regexes the model actually emits must NOT be
// caught by the ReDoS guard — guards against false-positives nerfing the model.
async function testRealisticPatternsAllowed(userId: string): Promise<void> {
  for (const pattern of [
    '\\$[0-9,]+(\\.[0-9]{2})?',
    '(invoice|receipt|order)\\s+#?[0-9]+',
    'meeting.*tomorrow',
    '[\\w.]+@[\\w.]+',
    'v[0-9]+\\.[0-9]+\\.[0-9]+',
    '\\bphase-[0-9]+\\b',
    '[A-Z]{2,4}-[0-9]{2,5}',
  ]) {
    const res = await requestGrep(userId, { pattern, source: 'messages' });
    assertStatus(res.status, 200, res.data);
  }
}

// messages-only narrowing: `person` scopes to one contact, `since` to a time cutoff.
async function testPersonAndSinceFilters(userId: string): Promise<void> {
  // person resolves Lighthouse Archive (who has the seeded messages).
  let res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    person: 'Lighthouse Archive',
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Ledger entry');

  // unknown person → zero matches (not a silent unscoped search).
  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    person: 'Nobody Here',
  });
  assertStatus(res.status, 200, res.data);
  if (assertBody(res.data).total_matches !== 0) {
    throw new Error(`Expected 0 matches for unknown person, got ${JSON.stringify(res.data)}`);
  }

  // since excludes the 2026-01-01 Aurora message but keeps the 2026-01-03 ledger.
  res = await requestGrep(userId, {
    pattern: 'Aurora budget|Ledger entry',
    source: 'messages',
    since: '2026-01-03T00:00:00Z',
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  requireContent(body, 'Ledger entry');
  for (const match of body.matches) {
    if (match.content.includes('Aurora budget: phase-17 approved')) {
      throw new Error(
        `Expected 'since' to exclude the older Aurora message, got ${JSON.stringify(match)}`
      );
    }
  }
}

async function runAll(): Promise<void> {
  const { userId, agentId } = await seedFixture();
  const tests = [
    ['schema rejects removed params/sources', () => testSchemaAndRemovedParams(userId)],
    ['omitted source searches all buckets', () => testAllSources(userId, agentId)],
    ['regex and explicit sources work', () => testRegexAndSources(userId, agentId)],
    ['grep flags work', () => testFlags(userId)],
    ['invalid regex returns 400', () => testInvalidRegex(userId)],
    ['ReDoS-catastrophic patterns rejected with 400', () => testRedosGuardRejects(userId)],
    ['dialect patterns normalized and succeed', () => testDialectNormalization(userId)],
    ['realistic safe patterns are allowed', () => testRealisticPatternsAllowed(userId)],
    ['person and since narrow messages', () => testPersonAndSinceFilters(userId)],
  ] as const;

  try {
    for (const [name, fn] of tests) {
      await fn();
      console.log(`PASS ${name}`);
    }
  } finally {
    await cleanup(userId);
    await prisma.$disconnect();
  }
}

runAll().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
