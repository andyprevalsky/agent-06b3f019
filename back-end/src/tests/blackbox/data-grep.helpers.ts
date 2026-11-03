/**
 * Shared schemas, request/assert helpers and fixtures for the data-grep black-box domain.
 */

import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { z } from 'zod';
import { prisma } from '../../providers/database';
config();

export const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
export const API_KEY = process.env.BACKEND_API_KEY || '';

export const WORD_BOUNDARY_MESSAGES = [
  'Josépassport',
  'épassport',
  'αpassport',
  'passporté',
  'passportα',
  'xpassport',
  'passport_',
  '9passport',
  'αpassport_',
  'PASSPORT',
];

export const GrepMatch = z.object({
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

export const GrepResponse = z.object({
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

export const SummaryResponse = z.object({
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

export type GrepBody = z.infer<typeof GrepResponse>;

export function apiHeaders(userId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
    'X-User-Id': userId,
  };
}

export async function requestGrep(userId: string, body: Record<string, unknown>) {
  const response = await fetch(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: apiHeaders(userId),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

export async function requestSummary(userId: string) {
  const response = await fetch(`${BASE_URL}/api/data/summary`, {
    headers: apiHeaders(userId),
  });
  const data = await response.json();
  return { status: response.status, data };
}

export async function requestSourceStatus(userId: string, sources: string) {
  const response = await fetch(
    `${BASE_URL}/api/data/source-status?sources=${encodeURIComponent(sources)}`,
    { headers: apiHeaders(userId) }
  );
  const data = await response.json();
  return { status: response.status, data };
}

export function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

export function assertBody(data: unknown): GrepBody {
  return GrepResponse.parse(data);
}

export function requireContent(body: GrepBody, expected: string): void {
  if (!body.matches.some((match) => match.content.includes(expected))) {
    throw new Error(`Expected grep result containing ${expected}, got ${JSON.stringify(body)}`);
  }
}

export function requireInvalidGrepParam(data: unknown, label: string): void {
  if ((data as { error?: string }).error !== 'INVALID_GREP_PARAM') {
    throw new Error(`Expected INVALID_GREP_PARAM for ${label}, got ${JSON.stringify(data)}`);
  }
}

export function forbidLineNumbers(body: GrepBody): void {
  for (const match of body.matches) {
    if (/^\d+:/m.test(match.content)) {
      throw new Error(`Expected no line numbers, got ${match.content}`);
    }
  }
}

export async function cleanup(userId: string): Promise<void> {
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

export async function seedFixture() {
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
        userId,
        channel: 'EMAIL',
        from: 'lighthouse@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date('2026-01-01T09:00:00Z'),
        externalId: `before-context-${randomUUID()}`,
        message: 'Before-context evidence: finance owner noted',
      },
      {
        personId: lighthouse.id,
        userId,
        channel: 'EMAIL',
        from: 'lighthouse@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date('2026-01-01T10:00:00Z'),
        externalId: `quarterly-${randomUUID()}`,
        message: 'Aurora budget: phase-17 approved',
      },
      {
        personId: lighthouse.id,
        userId,
        channel: 'EMAIL',
        from: 'lighthouse@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date('2026-01-01T11:00:00Z'),
        externalId: `after-context-${randomUUID()}`,
        message: 'After-context evidence: forecast packet delivered',
      },
      {
        personId: lighthouse.id,
        userId,
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
        userId,
        channel: 'EMAIL' as const,
        from: 'ledger@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date(`2026-01-03T10:${String(idx).padStart(2, '0')}:00Z`),
        externalId: `ledger-${idx + 1}-${randomUUID()}`,
        message: `Ledger entry ${idx + 1}: ${idx + 1 === 21 ? 'offset target confirmed' : 'ordinary ledger row'}`,
      })),
      ...WORD_BOUNDARY_MESSAGES.map((message, index) => ({
        personId: lighthouse.id,
        userId,
        channel: 'EMAIL' as const,
        from: 'boundary@example.com',
        to: 'benchmark@example.com',
        timestamp: new Date(`2026-01-04T10:${String(index).padStart(2, '0')}:00Z`),
        externalId: `word-boundary-${randomUUID()}`,
        message,
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

export async function seedDocumentFixture(userId: string): Promise<void> {
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

export async function seedPlaidFixture(userId: string): Promise<void> {
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
