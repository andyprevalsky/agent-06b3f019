/**
 * Local data inventory text: grep `sources: ["summary"]` and the explore
 * agent's system prompt both read this one rendering (the agents layer fetches
 * it through POST /api/data/grep).
 */

import { formatSharedDataMap } from './teamContext';
import type { SummaryResult } from './types.summary';

const SUMMARY_MAX_THREADS = 15;
const COLUMN = 39;

function day(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '?' : value.slice(0, 10);
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function googleLines(sources: SummaryResult['sources']): string[] {
  const lines: string[] = [];
  const google = [
    [
      'calendar',
      'Google Calendar',
      'events',
      sources.calendar?.accounts,
      sources.calendar?.total_events,
    ],
    ['drive', 'Google Drive', 'files', sources.drive?.accounts, sources.drive?.total_files],
  ] as const;
  for (const [source, label, unit, rawAccounts, rawCount] of google) {
    const accounts = (rawAccounts ?? []).filter((a) => typeof a === 'string' && a !== '');
    if (accounts.length === 0) continue;
    const total = rawCount ?? 0;
    // Nothing stored yet reads as unknown, not "0 events": the first search fills these.
    const detail = total > 0 ? `${label}, ${count(total)} ${unit}` : label;
    lines.push(
      '',
      `${`${source}/`.padEnd(COLUMN)}${detail}`,
      `  Accounts: ${accounts.join(', ')}`,
      `  Search with grep source="${source}".`
    );
  }
  return lines;
}

function latestMessageLines(latest: SummaryResult['sources']['messages']['latest_message']) {
  if (latest === null || latest === undefined) return [];
  return [
    '  Latest message record:',
    `    timestamp: ${latest.timestamp || '?'}`,
    `    channel: ${latest.channel || '?'}`,
    `    from: ${JSON.stringify(latest.from || '')}`,
    `    to: ${JSON.stringify(latest.to || '')}`,
    `    text: ${JSON.stringify(latest.text || '')}`,
  ];
}

function threadLines(threads: SummaryResult['sources']['messages']['threads']): string[] {
  const lines = threads
    .slice(0, SUMMARY_MAX_THREADS)
    .map(
      (t) =>
        `    ${t.name.padEnd(40)} ${String(t.message_count).padStart(4)} msgs  (last: ${t.last_message})`
    );
  const remaining = threads.length - SUMMARY_MAX_THREADS;
  if (remaining > 0) lines.push(`    ... ${remaining} more threads`);
  return lines;
}

function transactionLines(transactions: SummaryResult['sources']['transactions']): string[] {
  if (transactions === undefined || transactions.total_transactions <= 0) return [];
  const institutions =
    transactions.institutions.length > 0 ? transactions.institutions.join(', ') : 'unknown';
  return [
    '',
    `${'transactions/'.padEnd(COLUMN)}${transactions.account_count} accounts, ${count(transactions.total_transactions)} transactions`,
    `  Institutions: ${institutions}`,
    `  Date range: ${day(transactions.date_range.from)} → ${day(transactions.date_range.to)}`,
  ];
}

function documentLines(documents: SummaryResult['sources']['documents']): string[] {
  if (documents === undefined || documents.total_documents <= 0) return [];
  const sources =
    Object.entries(documents.sources)
      .map(([source, n]) => `${source} (${n})`)
      .join(', ') || 'unknown';
  return [
    '',
    `${'documents/'.padEnd(COLUMN)}${count(documents.total_documents)} docs`,
    `  Sources: ${sources}`,
    `  Date range: ${day(documents.date_range.from)} → ${day(documents.date_range.to)}`,
    '  Search with grep source="documents".',
  ];
}

export function formatLocalDataSummary(summary: SummaryResult): string {
  const { messages, transactions, documents } = summary.sources;
  const google = googleLines(summary.sources);
  if (
    messages.total_messages === 0 &&
    (transactions?.total_transactions ?? 0) === 0 &&
    (documents?.total_documents ?? 0) === 0 &&
    google.length === 0
  ) {
    return (summary.teams && formatSharedDataMap(summary.teams)) || 'No local data available.';
  }
  const channels =
    Object.keys(messages.channels).length > 0
      ? Object.entries(messages.channels)
          .map(([channel, n]) => `${channel} (${n})`)
          .join(', ')
      : 'unknown';
  return [
    ...(summary.teams && formatSharedDataMap(summary.teams)
      ? [
          formatSharedDataMap(summary.teams),
          'The aggregate statistics below describe your own records only; grep email/messages for team totals.',
        ]
      : []),
    'LOCAL DATA SOURCES:',
    '',
    `${'messages/'.padEnd(COLUMN)}${messages.total_threads} threads, ${count(messages.total_messages)} messages`,
    `  Channels: ${channels}`,
    `  Date range: ${day(messages.date_range.from)} → ${day(messages.date_range.to)}`,
    latestMessageLines(messages.latest_message).join('\n'),
    '  Threads by volume:',
    threadLines(messages.threads).join('\n') +
      transactionLines(transactions).join('\n') +
      documentLines(documents).join('\n') +
      google.join('\n'),
  ].join('\n');
}
