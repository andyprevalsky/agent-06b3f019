/**
 * Data domain formatting — render DB rows into Grep result snippets.
 * Pure presentation layer; no DB or business logic.
 */

import type * as grepRepo from './grepRepo';
import type { GrepLocation, GrepMatch, ValidSource, ValidatedGrepInput } from './types';

/** Format a date as a relative "time ago" string. */
export function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000);
  const diffHours = Math.floor((now.getTime() - date.getTime()) / 3600000);
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

function valueToLine(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return `${label}: ${JSON.stringify(value)}`;
  return `${label}: ${String(value)}`;
}

function formatSnippet(
  content: string,
  regex: RegExp,
  contextBefore: number,
  contextAfter: number,
  showLineNumbers: boolean
): string {
  const probe = new RegExp(regex.source, regex.flags.replace('g', ''));
  const match = probe.exec(content);
  const lines = content.split('\n');
  if (!match || match.index < 0) {
    return lines
      .slice(0, contextBefore + contextAfter + 1)
      .map((line, idx) => (showLineNumbers ? `${idx + 1}: ${line}` : line))
      .join('\n');
  }

  const startLine = content.slice(0, match.index).split('\n').length - 1;
  const endLine = content.slice(0, match.index + match[0].length).split('\n').length - 1;
  const from = Math.max(0, startLine - contextBefore);
  const to = Math.min(lines.length - 1, endLine + contextAfter);

  return lines
    .slice(from, to + 1)
    .map((line, idx) => (showLineNumbers ? `${from + idx + 1}: ${line}` : line))
    .join('\n');
}

function formatTransactionRowSnippet(
  content: string,
  regex: RegExp,
  showLineNumbers: boolean
): string {
  const probe = new RegExp(regex.source, regex.flags.replace('g', ''));
  const coreFields = new Set([
    'transaction_id',
    'institution',
    'account',
    'date',
    'status',
    'direction',
    'amount',
    'absolute_amount',
    'merchant',
    'name',
    'original_description',
    'category',
  ]);
  const lines = content.split('\n');
  const selectedIndexes = new Set<number>();

  lines.forEach((line, idx) => {
    const field = line.slice(0, line.indexOf(':'));
    if (coreFields.has(field) || probe.test(line)) {
      selectedIndexes.add(idx);
    }
  });

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((idx) => (showLineNumbers ? `${idx + 1}: ${lines[idx]}` : lines[idx]))
    .join('\n');
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return '';
}

function threadName(row: grepRepo.MessageGrepRow): string {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return firstNonEmpty(fullName, row.phoneNumber, row.email, row.personId);
}

function contactName(row: grepRepo.NetworkGrepRow): string {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return firstNonEmpty(fullName, row.email, row.phoneNumber, row.id);
}

function buildMatch(params: {
  source: ValidSource;
  path: string;
  pointer: string;
  timestamp: Date;
  location: GrepLocation;
  content: string;
  role?: 'SYSTEM' | 'ASSISTANT' | 'USER' | 'TOOL';
  input: ValidatedGrepInput;
}): GrepMatch {
  return {
    source: params.source,
    path: params.path,
    pointer: params.pointer,
    timestamp: params.timestamp.toISOString(),
    ...(params.role ? { role: params.role } : {}),
    location: params.location,
    content: formatSnippet(
      params.content,
      params.input.regex,
      params.input.contextBefore,
      params.input.contextAfter,
      params.input.showLineNumbers
    ),
  };
}

export function buildMessageMatch(
  row: grepRepo.MessageGrepRow,
  input: ValidatedGrepInput
): GrepMatch {
  const thread = `${threadName(row)}.thread`;
  const path = `messages/${thread}/${row.id}`;
  const content = [
    valueToLine('source', 'messages'),
    valueToLine('thread', thread),
    valueToLine('channel', row.channel),
    valueToLine('from', row.from),
    valueToLine('to', row.to),
    valueToLine('timestamp', row.timestamp.toISOString()),
    'message:',
    row.message,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return buildMatch({
    source: 'messages',
    path,
    pointer: `messages:${row.id}`,
    timestamp: row.timestamp,
    location: { source: 'messages', path, thread, field: 'message' },
    content,
    input,
  });
}

export function buildNetworkMatch(
  row: grepRepo.NetworkGrepRow,
  input: ValidatedGrepInput
): GrepMatch {
  const name = contactName(row);
  const path = `network/${name}.contact`;
  const content = [
    valueToLine('source', 'network'),
    valueToLine('contact_id', row.id),
    valueToLine('first_name', row.firstName),
    valueToLine('last_name', row.lastName),
    valueToLine('email', row.email),
    valueToLine('phone_number', row.phoneNumber),
    valueToLine('company', row.company),
    valueToLine('title', row.title),
    valueToLine('relation', row.relation),
    valueToLine('communication_frequency', row.communicationFrequency),
    valueToLine('messages_exchanged', row.messagesExchanged),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return buildMatch({
    source: 'network',
    path,
    pointer: `network:${row.id}`,
    timestamp: row.createdAt,
    location: { source: 'network', path, contact_id: row.id, field: 'contact' },
    content,
    input,
  });
}

export function buildAgentNetworkMatch(
  row: grepRepo.AgentMessageGrepRow,
  input: ValidatedGrepInput
): GrepMatch {
  const path = `agent_network/depth-${row.agentDepth}/${row.agentId}/${row.role}/${row.id}`;
  const content = [
    valueToLine('source', 'agent_network'),
    valueToLine('agent_id', row.agentId),
    valueToLine('agent_goal', row.agentGoal),
    valueToLine('agent_depth', row.agentDepth),
    valueToLine('message_id', row.id),
    valueToLine('role', row.role),
    valueToLine('timestamp', row.createdAt.toISOString()),
    'text:',
    row.text,
    valueToLine('metadata', row.metadata),
    valueToLine('file_pointer', row.filePointer),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return buildMatch({
    source: 'agent_network',
    path,
    pointer: `@ref:message:${row.id}`,
    timestamp: row.createdAt,
    role: row.role,
    location: {
      source: 'agent_network',
      path,
      agent_id: row.agentId,
      message_id: row.id,
      role: row.role,
      field: 'message',
    },
    content,
    input,
  });
}

function decimalToString(value: { toString(): string } | number | string): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : value.toString();
}

export function buildTransactionMatch(
  row: grepRepo.TransactionGrepRow,
  input: ValidatedGrepInput
): GrepMatch {
  const merchant = firstNonEmpty(row.merchantName, row.name);
  const accountSuffix =
    row.accountMask !== null && row.accountMask !== '' ? ` ****${row.accountMask}` : '';
  const path = `transactions/${row.institutionName ?? 'unknown-institution'}/${row.accountName}${accountSuffix}/${row.plaidTransactionId}`;
  const currency = row.isoCurrencyCode ?? row.unofficialCurrencyCode ?? 'UNKNOWN';
  const content = [
    valueToLine('source', 'transactions'),
    valueToLine('transaction_id', row.plaidTransactionId),
    valueToLine('institution', row.institutionName),
    valueToLine('account', `${row.accountName}${accountSuffix}`),
    valueToLine('date', row.date.toISOString().slice(0, 10)),
    valueToLine(
      'authorized_date',
      row.authorizedDate ? row.authorizedDate.toISOString().slice(0, 10) : null
    ),
    valueToLine('status', row.pending ? 'pending' : 'posted'),
    valueToLine('direction', row.direction.toLowerCase()),
    valueToLine('amount', `${decimalToString(row.amount)} ${currency}`),
    valueToLine('absolute_amount', `${decimalToString(row.absoluteAmount)} ${currency}`),
    valueToLine('merchant', merchant),
    valueToLine('name', row.name),
    valueToLine('original_description', row.originalDescription),
    valueToLine('category', row.category.join(' > ')),
    valueToLine('personal_finance_category', row.personalFinanceCategory),
    valueToLine('personal_finance_detailed', row.personalFinanceDetailed),
    valueToLine('payment_channel', row.paymentChannel),
    valueToLine('location', row.locationSummary),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  const renderedContent =
    input.contextBefore === 0 && input.contextAfter === 0
      ? formatTransactionRowSnippet(content, input.regex, input.showLineNumbers)
      : formatSnippet(
          content,
          input.regex,
          input.contextBefore,
          input.contextAfter,
          input.showLineNumbers
        );

  return {
    source: 'transactions',
    path,
    pointer: `transactions:${row.plaidTransactionId}`,
    location: {
      source: 'transactions',
      path,
      transaction_id: row.plaidTransactionId,
      account_id: row.plaidAccountExternalId,
      field: 'transaction',
    },
    timestamp: row.date.toISOString(),
    content: renderedContent,
  };
}
