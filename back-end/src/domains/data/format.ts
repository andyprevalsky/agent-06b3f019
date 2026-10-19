/**
 * Data domain formatting — render DB rows into Grep result snippets.
 * Pure presentation layer; no DB or business logic.
 */

import type * as grepRepo from './grepRepo';
import type { GrepLocation, GrepMatch, ValidSource, ValidatedGrepInput } from './types';
import {
  decimalToString,
  firstNonEmpty,
  formatSnippet,
  formatTransactionRowSnippet,
  metadataString,
  valueToLine,
} from './format.snippets';
import {
  buildAccountLabel,
  buildAgentNetworkPath,
  buildDocumentPath,
  buildMessagePath,
  buildNetworkPath,
  buildTransactionPath,
  THREAD_SUFFIX,
} from './path';

export { buildAgentTrajectoryMatch } from './format.agent';

function threadName(row: grepRepo.MessageGrepRow): string {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return firstNonEmpty(fullName, row.phoneNumber, row.email, row.personId);
}

function contactName(row: grepRepo.NetworkGrepRow): string {
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return firstNonEmpty(fullName, row.email, row.phoneNumber, row.id);
}

export function buildMatch(params: {
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
  const thread = `${threadName(row)}${THREAD_SUFFIX}`;
  const path = buildMessagePath(threadName(row), row.id);
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
  const path = buildNetworkPath(name);
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
  const path = buildAgentNetworkPath(row.agentDepth, row.agentId, row.role, row.id);
  const agentPath = row.agentPath;
  const content = [
    valueToLine('source', 'agent_network'),
    valueToLine('agent_path', agentPath),
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
      ...(agentPath !== null ? { agent_path: agentPath } : {}),
      message_id: row.id,
      role: row.role,
      field: 'message',
    },
    content,
    input,
  });
}
export function buildTransactionMatch(
  row: grepRepo.TransactionGrepRow,
  input: ValidatedGrepInput
): GrepMatch {
  const merchant = firstNonEmpty(row.merchantName, row.name);
  const accountLabel = buildAccountLabel(row.accountName, row.accountMask);
  const path = buildTransactionPath(
    row.institutionName,
    row.accountName,
    row.accountMask,
    row.plaidTransactionId
  );
  const currency = row.isoCurrencyCode ?? row.unofficialCurrencyCode ?? 'UNKNOWN';
  const content = [
    valueToLine('source', 'transactions'),
    valueToLine('transaction_id', row.plaidTransactionId),
    valueToLine('institution', row.institutionName),
    valueToLine('account', accountLabel),
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

export function buildDocumentMatch(
  row: grepRepo.DocumentGrepRow,
  input: ValidatedGrepInput
): GrepMatch {
  const vault = metadataString(row.metadata, 'vault');
  const relativePath =
    metadataString(row.metadata, 'path') ?? metadataString(row.metadata, 'relativePath');
  const path =
    row.source === 'obsidian' && vault !== undefined && relativePath !== undefined
      ? buildDocumentPath(row.source, vault, relativePath)
      : buildDocumentPath(row.source, row.title, row.externalId);
  const timestamp = row.sourceUpdatedAt ?? row.updatedAt;
  const content = [
    valueToLine('source', 'documents'),
    valueToLine('document_source', row.source),
    valueToLine('document_id', row.id),
    valueToLine('external_id', row.externalId),
    valueToLine('title', row.title),
    valueToLine('url', row.url),
    valueToLine('timestamp', timestamp.toISOString()),
    valueToLine('metadata', row.metadata),
    'content:',
    row.content,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return buildMatch({
    source: 'documents',
    path,
    pointer: `documents:${row.id}`,
    timestamp,
    location: {
      source: 'documents',
      path,
      document_id: row.id,
      source_name: row.source,
      field: 'content',
    },
    content,
    input,
  });
}
