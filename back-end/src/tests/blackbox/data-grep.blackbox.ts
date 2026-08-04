#!/usr/bin/env tsx
/* eslint-disable max-lines */
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
  source: z.enum(['messages', 'network', 'agent_network', 'transactions', 'documents']),
  path: z.string(),
  pointer: z.string(),
  timestamp: z.string(),
  role: z.enum(['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']).optional(),
  location: z.object({
    source: z.enum(['messages', 'network', 'agent_network', 'transactions', 'documents']),
    path: z.string(),
    agent_id: z.string().optional(),
    message_id: z.string().optional(),
    transaction_id: z.string().optional(),
    account_id: z.string().optional(),
    document_id: z.string().optional(),
    source_name: z.string().optional(),
    role: z.enum(['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']).optional(),
    thread: z.string().optional(),
    contact_id: z.string().optional(),
    field: z.string().optional(),
  }),
  content: z.string(),
  records: z
    .array(
      z.object({
        message_id: z.string(),
        channel: z.string(),
        from: z.string(),
        to: z.string(),
        timestamp: z.string(),
        message: z.string(),
        relation: z.enum(['before', 'match', 'after']),
      })
    )
    .optional(),
});

const GrepResponse = z.object({
  matches: z.array(GrepMatch),
  total_matches: z.number(),
  truncated: z.boolean(),
  pattern: z.string(),
  sources: z.array(
    z.enum([
      'messages',
      'gmail',
      'email',
      'imessage',
      'whatsapp',
      'sms',
      'network',
      'agent_network',
      'transactions',
      'documents',
    ])
  ),
  applied_limit: z.number(),
  applied_offset: z.number(),
  returned: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  display_order: z.enum(['oldest_first', 'newest_first']),
  context_unit: z.enum(['message_record', 'logical_line', 'mixed']),
  summaries: z
    .object({
      transactions: z
        .object({
          totals_include_pending: z.boolean(),
          currencies: z.array(
            z.object({
              currency: z.string(),
              outflow: z.string(),
              inflow: z.string(),
              net: z.string(),
              count: z.number(),
            })
          ),
        })
        .optional(),
    })
    .optional(),
  message: z.string().optional(),
});

const SummaryResponse = z.object({
  sources: z.object({
    transactions: z
      .object({
        total_transactions: z.number(),
        account_count: z.number(),
        institutions: z.array(z.string()),
        date_range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
      })
      .optional(),
    documents: z
      .object({
        total_documents: z.number(),
        sources: z.record(z.number()),
        date_range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
      })
      .optional(),
  }),
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

async function requestSummary(userId: string) {
  const response = await fetch(`${BASE_URL}/api/data/summary`, {
    headers: apiHeaders(userId),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function requestSourceStatus(userId: string, sources: string) {
  const response = await fetch(
    `${BASE_URL}/api/data/source-status?sources=${encodeURIComponent(sources)}`,
    { headers: apiHeaders(userId) }
  );
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

function requireInvalidGrepParam(data: unknown, label: string): void {
  if ((data as { error?: string }).error !== 'INVALID_GREP_PARAM') {
    throw new Error(`Expected INVALID_GREP_PARAM for ${label}, got ${JSON.stringify(data)}`);
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
  await prisma.plaidTransaction.deleteMany({ where: { userId } });
  await prisma.plaidAccount.deleteMany({ where: { userId } });
  await prisma.plaidItem.deleteMany({ where: { userId } });
  // Defensive: clear any Integration / email-credential rows for this user.
  // (source-status no longer mints a Gmail OAuth URL at probe time.)
  await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
  await prisma.userDataDocument.deleteMany({ where: { userId } });
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
        timestamp: new Date('2026-01-01T09:00:00Z'),
        externalId: `before-context-${randomUUID()}`,
        message: 'Before-context evidence: finance owner noted',
      },
      {
        personId: lighthouse.id,
        channel: 'EMAIL',
        from: 'lighthouse@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date('2026-01-01T10:00:00Z'),
        externalId: `quarterly-${randomUUID()}`,
        message: 'Aurora budget: phase-17 approved',
      },
      {
        personId: lighthouse.id,
        channel: 'EMAIL',
        from: 'lighthouse@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date('2026-01-01T11:00:00Z'),
        externalId: `after-context-${randomUUID()}`,
        message: 'After-context evidence: forecast packet delivered',
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

  await seedPlaidFixture(userId);
  await seedDocumentFixture(userId);

  return { userId, agentId: child.id };
}

async function seedDocumentFixture(userId: string): Promise<void> {
  await prisma.integration.create({
    data: {
      userId,
      type: 'DATA_SOURCE',
      name: 'chatgpt',
      status: 'CONNECTED',
      isActive: true,
      config: { documentCount: 2 },
    },
  });
  await prisma.userDataDocument.createMany({
    data: [
      {
        userId,
        source: 'chatgpt',
        externalId: `chatgpt-${randomUUID()}`,
        title: 'Launch planning conversation',
        content: 'The user prefers concise launch memos with Nimbus milestone details.',
        contentHash: `hash-${randomUUID()}`,
        sourceUpdatedAt: new Date('2026-01-06T10:00:00Z'),
        metadata: { provider: 'chatgpt', conversationId: 'conv-launch', tags: ['llm-export'] },
      },
      {
        userId,
        source: 'claude',
        externalId: `claude-${randomUUID()}`,
        title: 'Research memory conversation',
        content: 'Claude export: Meridian research preference should stay searchable.',
        contentHash: `hash-${randomUUID()}`,
        sourceUpdatedAt: new Date('2026-01-06T11:00:00Z'),
        metadata: { provider: 'claude', chatId: 'claude-meridian', tags: ['llm-export'] },
      },
      {
        userId,
        source: 'apple_notes',
        externalId: `apple-notes-${randomUUID()}`,
        title: 'Connector checklist',
        content: 'Apple Notes entry: Solstice notebook keeps provider sync reminders.',
        contentHash: `hash-${randomUUID()}`,
        sourceUpdatedAt: new Date('2026-01-07T09:00:00Z'),
        metadata: { folder: 'Product', tags: ['connector'] },
      },
      {
        userId,
        source: 'obsidian',
        externalId: `obsidian-${randomUUID()}`,
        title: 'Project notes',
        content: 'Obsidian note: Calypso archive includes vendor follow-ups.',
        contentHash: `hash-${randomUUID()}`,
        sourceUpdatedAt: new Date('2026-01-08T10:00:00Z'),
        metadata: { vault: 'main', path: 'Projects/Calypso.md', tags: ['vendor'] },
      },
    ],
  });
}

async function seedPlaidFixture(userId: string): Promise<void> {
  const integration = await prisma.integration.create({
    data: {
      userId,
      type: 'DATA_SOURCE',
      name: 'plaid',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  const item = await prisma.plaidItem.create({
    data: {
      userId,
      integrationId: integration.id,
      plaidItemId: `item-${randomUUID()}`,
      plaidInstitutionId: 'ins_109508',
      institutionName: 'First Platypus Bank',
      encryptedAccessToken: 'encrypted-test-token',
      status: 'ACTIVE',
      products: ['transactions'],
      cursor: 'cursor-test',
      lastSyncAt: new Date('2026-01-05T00:00:00Z'),
    },
  });
  const checking = await prisma.plaidAccount.create({
    data: {
      userId,
      plaidItemId: item.id,
      plaidAccountId: `account-checking-${randomUUID()}`,
      name: 'Main Checking',
      officialName: 'Plaid Gold Standard Checking',
      mask: '0000',
      type: 'depository',
      subtype: 'checking',
    },
  });
  const credit = await prisma.plaidAccount.create({
    data: {
      userId,
      plaidItemId: item.id,
      plaidAccountId: `account-credit-${randomUUID()}`,
      name: 'Rewards Card',
      officialName: 'Plaid Rewards Credit Card',
      mask: '1111',
      type: 'credit',
      subtype: 'credit card',
    },
  });
  await prisma.plaidTransaction.createMany({
    data: [
      {
        userId,
        plaidItemId: item.id,
        plaidAccountId: checking.id,
        plaidTransactionId: `tx-posted-${randomUUID()}`,
        plaidAccountExternalId: checking.plaidAccountId,
        date: new Date('2025-01-10T00:00:00Z'),
        name: 'Starbucks Coffee',
        merchantName: 'Starbucks',
        amount: '5.25',
        absoluteAmount: '5.25',
        direction: 'OUTFLOW',
        isoCurrencyCode: 'USD',
        category: ['Food and Drink', 'Coffee Shop'],
        paymentChannel: 'in store',
        locationSummary: 'Seattle, WA',
        pending: false,
      },
      {
        userId,
        plaidItemId: item.id,
        plaidAccountId: checking.id,
        plaidTransactionId: `tx-pending-${randomUUID()}`,
        plaidAccountExternalId: checking.plaidAccountId,
        date: new Date('2025-01-11T00:00:00Z'),
        name: 'Starbucks Pending Latte',
        merchantName: 'Starbucks',
        amount: '7.00',
        absoluteAmount: '7.00',
        direction: 'OUTFLOW',
        isoCurrencyCode: 'USD',
        category: ['Food and Drink', 'Coffee Shop'],
        paymentChannel: 'in store',
        pending: true,
      },
      {
        userId,
        plaidItemId: item.id,
        plaidAccountId: checking.id,
        plaidTransactionId: `tx-payroll-${randomUUID()}`,
        plaidAccountExternalId: checking.plaidAccountId,
        date: new Date('2025-01-15T00:00:00Z'),
        name: 'Payroll Deposit',
        merchantName: 'Acme Payroll',
        amount: '-1000.00',
        absoluteAmount: '1000.00',
        direction: 'INFLOW',
        isoCurrencyCode: 'USD',
        category: ['Payroll'],
        paymentChannel: 'other',
        pending: false,
      },
      {
        userId,
        plaidItemId: item.id,
        plaidAccountId: credit.id,
        plaidTransactionId: `tx-card-${randomUUID()}`,
        plaidAccountExternalId: credit.plaidAccountId,
        date: new Date('2025-01-20T00:00:00Z'),
        name: 'Coffee Supplies Warehouse',
        merchantName: 'Coffee Supplies',
        amount: '125.00',
        absoluteAmount: '125.00',
        direction: 'OUTFLOW',
        isoCurrencyCode: 'USD',
        category: ['Shops'],
        paymentChannel: 'online',
        pending: false,
      },
    ],
  });
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

  res = await requestGrep(userId, {
    pattern: 'Nimbus milestone|Calypso archive',
    source: 'documents',
    '-i': true,
  });
  assertStatus(res.status, 200, res.data);
  const documents = assertBody(res.data);
  if (
    documents.total_matches !== 2 ||
    !documents.matches.every((match) => match.source === 'documents') ||
    !documents.matches.some((match) => match.location.source_name === 'chatgpt') ||
    !documents.matches.some((match) => match.location.source_name === 'obsidian')
  ) {
    throw new Error(`Expected document grep matches, got ${JSON.stringify(documents)}`);
  }
}

async function testDocumentFilters(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'Meridian research preference',
    source: 'documents',
    filters: { document_source: 'claude' },
  });
  assertStatus(res.status, 200, res.data);
  const claudeOnly = assertBody(res.data);
  if (claudeOnly.total_matches !== 1 || claudeOnly.matches[0]?.location.source_name !== 'claude') {
    throw new Error(`Expected only Claude document match, got ${JSON.stringify(claudeOnly)}`);
  }

  res = await requestGrep(userId, {
    pattern: 'Calypso archive',
    source: 'documents',
    filters: { path: 'Projects/Calypso.md', tag: 'vendor' },
  });
  assertStatus(res.status, 200, res.data);
  const byPathAndTag = assertBody(res.data);
  if (
    byPathAndTag.total_matches !== 1 ||
    byPathAndTag.matches[0]?.path !== 'documents/obsidian/main/Projects/Calypso.md'
  ) {
    throw new Error(`Expected Obsidian path/tag match, got ${JSON.stringify(byPathAndTag)}`);
  }

  res = await requestGrep(userId, {
    pattern: 'provider sync reminders',
    source: 'documents',
    filters: { since: '2026-01-07', until: '2026-01-07T23:59:59.000Z' },
  });
  assertStatus(res.status, 200, res.data);
  const byDate = assertBody(res.data);
  if (byDate.total_matches !== 1 || byDate.matches[0]?.location.source_name !== 'apple_notes') {
    throw new Error(`Expected Apple Notes date-filtered match, got ${JSON.stringify(byDate)}`);
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
  const contextRecords = context.matches[0]?.records;
  if (
    contextRecords?.map((record) => record.relation).join(',') !== 'before,match,after' ||
    contextRecords[0]?.message !== 'Before-context evidence: finance owner noted' ||
    contextRecords[1]?.message !== 'Aurora budget: phase-17 approved' ||
    contextRecords[2]?.message !== 'After-context evidence: forecast packet delivered'
  ) {
    throw new Error(
      `Expected aligned oldest-first message records, got ${JSON.stringify(context)}`
    );
  }

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
  requireContent(paged, 'Ledger entry 21');
  if (paged.applied_limit !== 5 || paged.applied_offset !== 20) {
    throw new Error(`Expected pagination metadata, got ${JSON.stringify(paged)}`);
  }
  if (
    paged.returned !== 5 ||
    paged.has_more !== true ||
    paged.next_offset !== 25 ||
    paged.display_order !== 'oldest_first' ||
    paged.context_unit !== 'message_record'
  ) {
    throw new Error(
      `Expected explicit message pagination/order metadata, got ${JSON.stringify(paged)}`
    );
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

  // Top-level `person` must also merge on the multi-source `sources` path (a
  // message-family source selected via `sources`, not singular `source`).
  // Regression: an unknown person here must still scope to zero — if `person`
  // were dropped on the plural path the query would return unscoped matches.
  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    sources: ['messages'],
    person: 'Nobody Here',
  });
  assertStatus(res.status, 200, res.data);
  if (assertBody(res.data).total_matches !== 0) {
    throw new Error(
      `Expected 0 matches for unknown person via sources[], got ${JSON.stringify(res.data)}`
    );
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

/**
 * Regression for prod agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc (2026-08-03).
 *
 * grep printed `network/Andy H. Ramcke.contact` and
 * `messages/<thread>.thread/<id>`; the explore agent fed them back as
 * `filters.path` and got HTTP 400 INVALID_GREP_PARAM, then tried web_fetch on the
 * same strings and burned four paid provider calls. grep advertises grep
 * semantics, so an address it prints must be an address it accepts.
 *
 * This drives real emitted values -- it greps first, then feeds the returned
 * `path` back verbatim. It does not hard-code a path, so it cannot pass by
 * agreeing with a fixture.
 */
async function testEmittedPathRoundTrips(userId: string): Promise<void> {
  // network: grep -> take the emitted path -> feed it back
  let res = await requestGrep(userId, { pattern: 'Lighthouse', source: 'network' });
  assertStatus(res.status, 200, res.data);
  const network = assertBody(res.data);
  if (network.matches.length === 0) {
    throw new Error('network seed produced no match to round-trip');
  }
  const networkPath = network.matches[0].path;

  res = await requestGrep(userId, {
    pattern: 'Lighthouse',
    source: 'network',
    filters: { path: networkPath },
  });
  assertStatus(res.status, 200, res.data);
  const networkScoped = assertBody(res.data);
  if (networkScoped.matches.length !== 1 || networkScoped.matches[0].path !== networkPath) {
    throw new Error(
      `network path ${networkPath} did not select its own record: ${JSON.stringify(networkScoped)}`
    );
  }

  // messages: the same round-trip, and a thread prefix addresses the whole thread
  res = await requestGrep(userId, { pattern: 'Ledger entry', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  const messages = assertBody(res.data);
  if (messages.matches.length === 0) {
    throw new Error('messages seed produced no match to round-trip');
  }
  const messagePath = messages.matches[0].path;

  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    filters: { path: messagePath },
  });
  assertStatus(res.status, 200, res.data);
  const messageScoped = assertBody(res.data);
  if (messageScoped.matches.length !== 1 || messageScoped.matches[0].path !== messagePath) {
    throw new Error(
      `message path ${messagePath} did not select its own record: ${JSON.stringify(messageScoped)}`
    );
  }

  const threadPrefix = messagePath.slice(0, messagePath.lastIndexOf('/'));
  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    filters: { path: threadPrefix },
  });
  assertStatus(res.status, 200, res.data);
  const threadScoped = assertBody(res.data);
  if (threadScoped.matches.length < 1) {
    throw new Error(`thread prefix ${threadPrefix} selected nothing`);
  }
  for (const match of threadScoped.matches) {
    if (!match.path.startsWith(`${threadPrefix}/`)) {
      throw new Error(`thread prefix leaked a foreign match: ${match.path}`);
    }
  }

  // transactions, documents, agent_network: same invariant, every emitting source.
  for (const [source, pattern] of [
    ['transactions', 'Starbucks'],
    ['documents', 'Calypso'],
  ] as const) {
    res = await requestGrep(userId, { pattern, source });
    assertStatus(res.status, 200, res.data);
    const seed = assertBody(res.data);
    if (seed.matches.length === 0) {
      throw new Error(`${source} seed produced no match to round-trip`);
    }
    const emitted = seed.matches[0].path;

    res = await requestGrep(userId, { pattern, source, filters: { path: emitted } });
    assertStatus(res.status, 200, res.data);
    const scoped = assertBody(res.data);
    if (scoped.matches.length !== 1 || scoped.matches[0].path !== emitted) {
      throw new Error(
        `${source} path ${emitted} did not select its own record: ${JSON.stringify(scoped)}`
      );
    }
  }

  // The printed account label must also round-trip: results show `<name> ****<mask>`,
  // which previously matched neither a.name nor a.mask and returned nothing.
  res = await requestGrep(userId, { pattern: 'Starbucks', source: 'transactions' });
  assertStatus(res.status, 200, res.data);
  const txn = assertBody(res.data);
  const accountLine = /account: (.+)/.exec(txn.matches[0]?.content ?? '');
  if (accountLine) {
    res = await requestGrep(userId, {
      pattern: 'Starbucks',
      source: 'transactions',
      filters: { account: accountLine[1].trim() },
    });
    assertStatus(res.status, 200, res.data);
    const byAccount = assertBody(res.data);
    if (byAccount.matches.length === 0) {
      throw new Error(`printed account label "${accountLine[1].trim()}" selected nothing`);
    }
  }

  // A path printed for another source is a caller error, not an empty result.
  res = await requestGrep(userId, {
    pattern: 'anything',
    source: 'network',
    filters: { path: messagePath },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'cross-source path');

  // And the string the agent invented is still rejected.
  res = await requestGrep(userId, {
    pattern: 'anything',
    source: 'network',
    filters: { path: 'https://internal/messages/+19729777432.thread' },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'non-grep path');
}

async function testSourceSpecificFilterValidation(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'Starbucks',
    source: 'transactions',
    filters: { person: 'Lighthouse Archive' },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'unsupported transaction filter');

  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    filters: { person: 'Lighthouse Archive', min_amount: 1 },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'unsupported message filter');

  // Filters against a purely-local `sources` selection (no filterable family)
  // must be rejected, not silently dropped — the multi-source path had bypassed
  // rejectUnsupportedFilters entirely.
  res = await requestGrep(userId, {
    pattern: 'anything',
    sources: ['network'],
    filters: { min_amount: 1 },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'unsupported local-source filter');

  res = await requestGrep(userId, {
    pattern: 'Starbucks',
    source: 'transactions',
    filters: ['status'],
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'non-object filters');

  for (const [label, filters] of [
    ['invalid transaction min_amount', { min_amount: '1' }],
    ['invalid transaction status', { status: 'settled' }],
    ['invalid transaction since', { since: 'not-a-date' }],
    ['invalid transaction include_pending_in_totals', { include_pending_in_totals: 'true' }],
    ['invalid message person', { person: ['Lighthouse Archive'] }],
    ['invalid message since', { since: 'not-a-date' }],
  ] as const) {
    res = await requestGrep(userId, {
      pattern: label.includes('message') ? 'Ledger entry' : 'Starbucks',
      source: label.includes('message') ? 'messages' : 'transactions',
      filters,
    });
    assertStatus(res.status, 400, res.data);
    requireInvalidGrepParam(res.data, label);
  }

  res = await requestGrep(userId, {
    pattern: 'Nimbus',
    source: 'documents',
    filters: { tag: 123 },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'invalid document tag');
}

async function testTransactionFiltersAndAggregates(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'starbucks|coffee',
    source: 'transactions',
    '-i': true,
    filters: {
      since: '2025-01-01',
      until: '2025-12-31',
      account: 'checking',
      min_amount: 0,
      max_amount: 10,
      status: 'all',
      include_pending_in_totals: false,
    },
    head_limit: 1,
  });
  assertStatus(res.status, 200, res.data);
  const defaultTotals = assertBody(res.data);
  if (defaultTotals.total_matches !== 2 || defaultTotals.matches.length !== 1) {
    throw new Error(
      `Expected full transaction total with one returned row, got ${JSON.stringify(defaultTotals)}`
    );
  }
  const currency = defaultTotals.summaries?.transactions?.currencies.find(
    (row) => row.currency === 'USD'
  );
  if (
    defaultTotals.summaries?.transactions?.totals_include_pending !== false ||
    currency?.count !== 1 ||
    currency.outflow !== '5.25'
  ) {
    throw new Error(
      `Expected posted-only aggregate over full filtered set, got ${JSON.stringify(defaultTotals)}`
    );
  }
  requireContent(defaultTotals, 'Starbucks');

  res = await requestGrep(userId, {
    pattern: 'starbucks|coffee',
    source: 'transactions',
    '-i': true,
    filters: {
      since: '2025-01-01',
      until: '2025-12-31',
      account: 'checking',
      min_amount: 0,
      max_amount: 10,
      status: 'all',
      include_pending_in_totals: true,
    },
    head_limit: 1,
  });
  assertStatus(res.status, 200, res.data);
  const withPendingTotals = assertBody(res.data);
  const withPendingCurrency = withPendingTotals.summaries?.transactions?.currencies.find(
    (row) => row.currency === 'USD'
  );
  if (
    withPendingTotals.summaries?.transactions?.totals_include_pending !== true ||
    withPendingCurrency?.count !== 2 ||
    withPendingCurrency.outflow !== '12.25'
  ) {
    throw new Error(
      `Expected pending-inclusive aggregate, got ${JSON.stringify(withPendingTotals)}`
    );
  }

  res = await requestGrep(userId, {
    pattern: 'starbucks|coffee',
    source: 'transactions',
    '-i': true,
    filters: { status: 'posted' },
  });
  assertStatus(res.status, 200, res.data);
  const postedOnly = assertBody(res.data);
  if (postedOnly.matches.some((match) => match.content.includes('status: pending'))) {
    throw new Error(
      `Expected posted filter to hide pending rows, got ${JSON.stringify(postedOnly)}`
    );
  }
  const postedStarbucks = postedOnly.matches.find((match) => match.content.includes('Starbucks'));
  if (
    postedStarbucks === undefined ||
    !postedStarbucks.content.includes('date: 2025-01-10') ||
    !postedStarbucks.content.includes('amount: 5.25 USD')
  ) {
    throw new Error(
      `Expected default transaction row snippet to include core date/amount fields, got ${JSON.stringify(postedOnly)}`
    );
  }
}

async function testTransactionTenantIsolation(userId: string): Promise<void> {
  const otherUserId = `grep-other-${randomUUID()}`;
  await cleanup(otherUserId);
  await prisma.user.create({ data: { userId: otherUserId, isAnonymous: true } });
  await seedPlaidFixture(otherUserId);
  try {
    const res = await requestGrep(userId, {
      pattern: 'Payroll|Coffee Supplies',
      source: 'transactions',
      '-i': true,
    });
    assertStatus(res.status, 200, res.data);
    const body = assertBody(res.data);
    if (body.total_matches !== 2) {
      throw new Error(
        `Expected only current user's transaction matches, got ${JSON.stringify(body)}`
      );
    }
  } finally {
    await cleanup(otherUserId);
  }
}

async function testTransactionSummary(userId: string): Promise<void> {
  const res = await requestSummary(userId);
  assertStatus(res.status, 200, res.data);
  const body = SummaryResponse.parse(res.data);
  const transactions = body.sources.transactions;
  if (
    transactions === undefined ||
    transactions.total_transactions !== 4 ||
    transactions.account_count !== 2 ||
    !transactions.institutions.includes('First Platypus Bank') ||
    transactions.date_range.from?.slice(0, 10) !== '2025-01-10' ||
    transactions.date_range.to?.slice(0, 10) !== '2025-01-20'
  ) {
    throw new Error(`Expected transaction summary, got ${JSON.stringify(body)}`);
  }
}

async function testDocumentSummary(userId: string): Promise<void> {
  const res = await requestSummary(userId);
  assertStatus(res.status, 200, res.data);
  const body = SummaryResponse.parse(res.data);
  const documents = body.sources.documents;
  if (
    documents === undefined ||
    documents.total_documents !== 4 ||
    documents.sources.chatgpt !== 1 ||
    documents.sources.claude !== 1 ||
    documents.sources.apple_notes !== 1 ||
    documents.sources.obsidian !== 1 ||
    documents.date_range.from?.slice(0, 10) !== '2026-01-06' ||
    documents.date_range.to?.slice(0, 10) !== '2026-01-08'
  ) {
    throw new Error(`Expected document summary, got ${JSON.stringify(body)}`);
  }
}

const SourceStatusResponse = z.object({
  statuses: z.array(
    z.object({
      source: z.string(),
      connector: z.string().nullable(),
      connected: z.boolean(),
      connectUrl: z.string().nullable(),
    })
  ),
});

// Multi-source grep: `sources:['email','imessage']` searches MessageRecord and
// returns 200. The seeded fixture only has EMAIL-channel rows, so email matches
// (channel-filtered) while imessage returns nothing — proving channel routing.
async function testMultiSourceGrep(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    sources: ['email', 'imessage'],
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  if (body.sources.join(',') !== 'email,imessage') {
    throw new Error(`Expected echoed sources email,imessage, got ${body.sources.join(',')}`);
  }
  requireContent(body, 'Aurora budget');

  // imessage alone must find nothing (no IMESSAGE-channel rows in the fixture),
  // confirming the channel WHERE clause actually restricts the search.
  res = await requestGrep(userId, { pattern: 'Aurora budget', source: 'imessage' });
  assertStatus(res.status, 200, res.data);
  if (assertBody(res.data).total_matches !== 0) {
    throw new Error(
      `Expected imessage-only grep to find 0 EMAIL rows, got ${JSON.stringify(res.data)}`
    );
  }

  // email alone must find the same EMAIL row that `messages` finds.
  res = await requestGrep(userId, { pattern: 'Aurora budget', source: 'email' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Aurora budget');

  // unknown source in the array → 400 SOURCE_NOT_FOUND (not a 500).
  res = await requestGrep(userId, { pattern: 'x', sources: ['email', 'not_a_source'] });
  assertStatus(res.status, 400, res.data);
  if ((res.data as { error?: string }).error !== 'SOURCE_NOT_FOUND') {
    throw new Error(
      `Expected SOURCE_NOT_FOUND for bad sources entry, got ${JSON.stringify(res.data)}`
    );
  }
}

// Per-source connectivity: local source (network) is always connected with no
// connectUrl; a connector-backed source with no Integration row (email→gmail)
// is disconnected with a mintable connectUrl.
async function testSourceStatus(userId: string): Promise<void> {
  const res = await requestSourceStatus(userId, 'email,network');
  assertStatus(res.status, 200, res.data);
  const body = SourceStatusResponse.parse(res.data);

  const email = body.statuses.find((s) => s.source === 'email');
  if (
    email === undefined ||
    email.connector !== 'gmail' ||
    email.connected !== false ||
    email.connectUrl === null ||
    !email.connectUrl.startsWith('http')
  ) {
    throw new Error(`Expected disconnected email with connectUrl, got ${JSON.stringify(body)}`);
  }

  const network = body.statuses.find((s) => s.source === 'network');
  if (
    network === undefined ||
    network.connector !== null ||
    network.connected !== true ||
    network.connectUrl !== null
  ) {
    throw new Error(
      `Expected local network connected with no connectUrl, got ${JSON.stringify(body)}`
    );
  }

  // A non-gmail connector-backed source returns the stub connect URL.
  const smsRes = await requestSourceStatus(userId, 'sms');
  assertStatus(smsRes.status, 200, smsRes.data);
  const smsBody = SourceStatusResponse.parse(smsRes.data);
  const sms = smsBody.statuses[0];
  if (sms?.connectUrl !== 'https://roselabs.ai/connect/sms' || sms.connected !== false) {
    throw new Error(`Expected sms stub connect URL, got ${JSON.stringify(smsBody)}`);
  }

  // Documents is an umbrella grep source; concrete document providers are
  // separate connector keys for source-connect gates.
  const notesRes = await requestSourceStatus(userId, 'apple_notes');
  assertStatus(notesRes.status, 200, notesRes.data);
  const notesBody = SourceStatusResponse.parse(notesRes.data);
  const notes = notesBody.statuses[0];
  if (
    notes?.source !== 'apple_notes' ||
    notes.connector !== 'apple_notes' ||
    notes.connected !== false ||
    notes.connectUrl !== 'https://roselabs.ai/connect/apple_notes'
  ) {
    throw new Error(
      `Expected apple_notes provider source status, got ${JSON.stringify(notesBody)}`
    );
  }

  // Unknown source key → 400, not 500.
  const badRes = await requestSourceStatus(userId, 'not_a_source');
  assertStatus(badRes.status, 400, badRes.data);
  if ((badRes.data as { error?: string }).error !== 'SOURCE_NOT_FOUND') {
    throw new Error(`Expected SOURCE_NOT_FOUND, got ${JSON.stringify(badRes.data)}`);
  }
}

async function requestSnapshot(userId: string) {
  const response = await fetch(`${BASE_URL}/api/data/snapshot`, {
    headers: apiHeaders(userId),
  });
  const data = await response.json();
  return { status: response.status, data };
}

// GET /api/data/snapshot returns the distilled user snapshot plus its recent
// revision ledger (repo.getUserSnapshot). Seed a snapshot + one revision, then
// read it back through the authenticated route.
async function testSnapshotEndpoint(userId: string): Promise<void> {
  const snapshot = await prisma.userSnapshot.create({
    data: {
      userId,
      content: { headline: 'Lighthouse archive lead', focus: ['signal', 'cartography'] },
      version: 3,
    },
  });
  await prisma.userSnapshotRevision.create({
    data: {
      userId,
      snapshotId: snapshot.id,
      source: 'grep-blackbox',
      changes: { added: ['focus'] },
      model: 'rose-1-lite',
      promptKey: 'snapshot.distill',
    },
  });

  const res = await requestSnapshot(userId);
  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    snapshot: {
      content?: { headline?: string };
      version?: number;
      revisions?: Array<{ source?: string; model?: string }>;
    } | null;
  };
  if (body.snapshot === null) {
    throw new Error(`Expected a snapshot, got null: ${JSON.stringify(res.data)}`);
  }
  if (
    body.snapshot.version !== 3 ||
    body.snapshot.content?.headline !== 'Lighthouse archive lead'
  ) {
    throw new Error(`Unexpected snapshot content/version: ${JSON.stringify(body.snapshot)}`);
  }
  if (
    !body.snapshot.revisions?.some((r) => r.source === 'grep-blackbox' && r.model === 'rose-1-lite')
  ) {
    throw new Error(`Expected the seeded revision in the ledger: ${JSON.stringify(body.snapshot)}`);
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
    ['source-specific filters are validated', () => testSourceSpecificFilterValidation(userId)],
    ['emitted path round-trips as filters.path', () => testEmittedPathRoundTrips(userId)],
    ['documents filters work', () => testDocumentFilters(userId)],
    ['transactions filters and aggregates work', () => testTransactionFiltersAndAggregates(userId)],
    ['transaction grep is tenant isolated', () => testTransactionTenantIsolation(userId)],
    ['summary includes transactions', () => testTransactionSummary(userId)],
    ['summary includes documents', () => testDocumentSummary(userId)],
    ['multi-source grep with channel routing', () => testMultiSourceGrep(userId)],
    ['per-source connectivity status', () => testSourceStatus(userId)],
    [
      'snapshot endpoint returns distilled snapshot + revisions',
      () => testSnapshotEndpoint(userId),
    ],
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
