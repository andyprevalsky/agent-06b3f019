#!/usr/bin/env tsx
/**
 * The local data inventory (grep `sources: ["summary"]`, and the explore
 * agent's prompt through the same endpoint). The expected text is the
 * rendering the agents layer produced before the formatter moved here.
 */

import assert from 'node:assert';

import { formatLocalDataSummary } from '../../domains/data/format.summary';
import type { SummaryResult } from '../../domains/data/types.summary';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function messages(
  overrides: Partial<SummaryResult['sources']['messages']> = {}
): SummaryResult['sources']['messages'] {
  return {
    total_threads: 0,
    total_messages: 0,
    channels: {},
    date_range: { from: null, to: null },
    latest_message: null,
    threads: [],
    ...overrides,
  };
}

test('empty data reads as no local data', () => {
  assert.strictEqual(
    formatLocalDataSummary({ sources: { messages: messages() } }),
    'No local data available.'
  );
});

test('renders every section exactly as the agents layer did', () => {
  const threads = [
    { name: 'Alice Smith.thread', message_count: 1200, last_message: '2 hours ago' },
    {
      name: 'A very long contact name that exceeds forty chars.thread',
      message_count: 12,
      last_message: '3 days ago',
    },
    ...Array.from({ length: 16 }, (_, i) => ({
      name: `t${i + 3}.thread`,
      message_count: 3,
      last_message: 'x',
    })),
  ];
  const text = formatLocalDataSummary({
    sources: {
      messages: messages({
        total_threads: 18,
        total_messages: 12345,
        channels: { imessage: 10000, email: 2345 },
        date_range: { from: '2024-01-02T03:04:05.000Z', to: '2026-11-05T10:00:00.000Z' },
        latest_message: {
          timestamp: '2026-11-05T10:00:00.000Z',
          channel: 'imessage',
          from: '+1555 "Bob"',
          to: 'me',
          text: 'héllo\nthere \\ ok',
        },
        threads,
      }),
      transactions: {
        total_transactions: 4321,
        account_count: 3,
        institutions: ['Chase', 'Amex'],
        date_range: { from: '2025-01-01T00:00:00Z', to: null },
      },
      documents: {
        total_documents: 1500,
        sources: { chatgpt: 1000, obsidian: 500 },
        date_range: { from: null, to: '2026-10-01T00:00:00Z' },
      },
      calendar: { accounts: ['a@x.com'], total_events: 0 },
      drive: { accounts: ['a@x.com', 'b@y.com'], total_files: 2048 },
    },
  });
  const lines = text.split('\n');
  assert.deepStrictEqual(lines.slice(0, 13), [
    'LOCAL DATA SOURCES:',
    '',
    'messages/                              18 threads, 12,345 messages',
    '  Channels: imessage (10000), email (2345)',
    '  Date range: 2024-01-02 → 2026-11-05',
    '  Latest message record:',
    '    timestamp: 2026-11-05T10:00:00.000Z',
    '    channel: imessage',
    '    from: "+1555 \\"Bob\\""',
    '    to: "me"',
    '    text: "héllo\\nthere \\\\ ok"',
    '  Threads by volume:',
    '    Alice Smith.thread                       1200 msgs  (last: 2 hours ago)',
  ]);
  assert.strictEqual(
    lines[13],
    '    A very long contact name that exceeds forty chars.thread   12 msgs  (last: 3 days ago)'
  );
  assert.strictEqual(lines[27], '    ... 3 more threads');
  assert.deepStrictEqual(lines.slice(28), [
    'transactions/                          3 accounts, 4,321 transactions',
    '  Institutions: Chase, Amex',
    '  Date range: 2025-01-01 → ?',
    'documents/                             1,500 docs',
    '  Sources: chatgpt (1000), obsidian (500)',
    '  Date range: ? → 2026-10-01',
    '  Search with grep source="documents".',
    'calendar/                              Google Calendar',
    '  Accounts: a@x.com',
    '  Search with grep source="calendar".',
    '',
    'drive/                                 Google Drive, 2,048 files',
    '  Accounts: a@x.com, b@y.com',
    '  Search with grep source="drive".',
  ]);
});

test('a connected Google account lists calendar/ and drive/ with nothing else stored', () => {
  const text = formatLocalDataSummary({
    sources: {
      messages: messages(),
      calendar: { accounts: ['a@example.com'], total_events: 1605 },
      drive: { accounts: ['a@example.com', 'b@example.com'], total_files: 0 },
    },
  });
  assert.notStrictEqual(text, 'No local data available.');
  const lines = text.split('\n');
  const calendar = lines.findIndex((line) => line.startsWith('calendar/'));
  assert.ok(lines[calendar].includes('1,605 events'));
  assert.strictEqual(lines[calendar + 1], '  Accounts: a@example.com');
  assert.strictEqual(lines[calendar + 2], '  Search with grep source="calendar".');
  const drive = lines.findIndex((line) => line.startsWith('drive/'));
  // Nothing stored yet is not an empty Drive: the first search fills it.
  assert.ok(!lines[drive].includes('0 files'));
  assert.strictEqual(lines[drive + 1], '  Accounts: a@example.com, b@example.com');
});

if (failures.length > 0) {
  process.stderr.write(`\nFailures:\n${failures.map((f) => `- ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\n${passed}/3 data-summary-format tests passed\n`);
