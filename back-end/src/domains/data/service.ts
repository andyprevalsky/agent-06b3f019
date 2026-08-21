/* eslint-disable max-lines-per-function */
/**
 * Data domain service — business logic for grep and summary operations.
 */

import { isPostgresRegexError } from './regexSafety';
import { buildAgentNetworkMatch, buildDocumentMatch, buildTransactionMatch } from './format';
import { formatTimeAgo } from './format.snippets';
import {
  isMessageFamilySource,
  type GrepMatch,
  type GrepParams,
  type GrepResult,
  type SummaryResult,
  type ValidSource,
  type ValidatedGrepInput,
} from './types';
import { AgentNotFoundError, InvalidPatternError, MissingAgentIdError } from './errors';
import { validateGrepInput } from './validate';
import * as repo from './repo';
import * as grepRepo from './grepRepo';
import { searchMessageSource } from './messageSearchService';
import { searchNetworkSource } from './networkSearchService';
import { createLogger } from '../../providers/logger';

// Per-source connectivity lives in a dedicated file; re-export so routes can
// keep importing it from `./service`.
export { getSourceStatus, type SourceStatus } from './sourceStatus';

const log = createLogger('Data');

// Re-export domain errors so existing importers (routes, networkService,
// agentNetworkService) keep their `from './service'` imports.
export {
  AgentNotFoundError,
  InvalidGrepParamError,
  InvalidPatternError,
  MissingAgentIdError,
  SourceNotFoundError,
} from './errors';

async function agentTreeIdsForGrep(userId: string, agentId: string | undefined): Promise<string[]> {
  if (agentId === undefined || agentId === '') throw new MissingAgentIdError();
  const agent = await repo.findAgentByIdAndUser(agentId, userId);
  if (agent === null) throw new AgentNotFoundError(agentId);
  const rootId = await repo.findRootAgentId(agentId, userId);
  return repo.findAgentTreeIds(rootId, userId);
}

async function searchSource(
  userId: string,
  input: ValidatedGrepInput,
  source: ValidSource,
  agentId: string | undefined
): Promise<{ total: number; matches: GrepMatch[] }> {
  if (isMessageFamilySource(source)) {
    return searchMessageSource({ userId, input, source });
  }

  if (source === 'network') {
    return searchNetworkSource({ userId, input });
  }

  if (source === 'transactions') {
    const filters = input.filters.transactions;
    const [total, rows] = await Promise.all([
      grepRepo.countTransactionGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
        since: filters?.since,
        until: filters?.until,
        account: filters?.account,
        minAmount: filters?.minAmount,
        maxAmount: filters?.maxAmount,
        status: filters?.status,
        pathInstitution: filters?.pathInstitution,
        pathAccount: filters?.pathAccount,
        pathTransactionId: filters?.pathTransactionId,
      }),
      grepRepo.searchTransactionGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
        limit: input.headLimit,
        offset: input.offset,
        since: filters?.since,
        until: filters?.until,
        account: filters?.account,
        minAmount: filters?.minAmount,
        maxAmount: filters?.maxAmount,
        status: filters?.status,
        pathInstitution: filters?.pathInstitution,
        pathAccount: filters?.pathAccount,
        pathTransactionId: filters?.pathTransactionId,
      }),
    ]);
    return { total, matches: rows.map((row) => buildTransactionMatch(row, input)) };
  }

  if (source === 'documents') {
    const filters = input.filters.documents;
    const [total, rows] = await Promise.all([
      grepRepo.countDocumentGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
        documentSource: filters?.documentSource,
        since: filters?.since,
        until: filters?.until,
        path: filters?.path,
        pathDocumentSource: filters?.pathDocumentSource,
        pathRest: filters?.pathRest,
        tag: filters?.tag,
      }),
      grepRepo.searchDocumentGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
        limit: input.headLimit,
        offset: input.offset,
        documentSource: filters?.documentSource,
        since: filters?.since,
        until: filters?.until,
        path: filters?.path,
        pathDocumentSource: filters?.pathDocumentSource,
        pathRest: filters?.pathRest,
        tag: filters?.tag,
      }),
    ]);
    return { total, matches: rows.map((row) => buildDocumentMatch(row, input)) };
  }

  const agentIds = await agentTreeIdsForGrep(userId, agentId);
  const agentNetworkFilters = input.filters.agentNetwork;
  const [total, rows] = await Promise.all([
    grepRepo.countAgentNetworkGrepRows({
      agentIds,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      pathAgentId: agentNetworkFilters?.pathAgentId,
      pathRole: agentNetworkFilters?.pathRole,
      pathMessageId: agentNetworkFilters?.pathMessageId,
    }),
    grepRepo.searchAgentNetworkGrepRows({
      agentIds,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      limit: input.headLimit,
      offset: input.offset,
      pathAgentId: agentNetworkFilters?.pathAgentId,
      pathRole: agentNetworkFilters?.pathRole,
      pathMessageId: agentNetworkFilters?.pathMessageId,
    }),
  ]);
  return { total, matches: rows.map((row) => buildAgentNetworkMatch(row, input)) };
}

function sortMatches(matches: GrepMatch[], oldestFirst: boolean): GrepMatch[] {
  return [...matches].sort((a, b) => {
    const byTime = oldestFirst
      ? Date.parse(a.timestamp) - Date.parse(b.timestamp)
      : Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (byTime !== 0) return byTime;
    return a.path.localeCompare(b.path);
  });
}

// ---------------------------------------------------------------------------
// Grep — main entry point
// ---------------------------------------------------------------------------

export async function grep(userId: string, params: GrepParams): Promise<GrepResult> {
  const input = validateGrepInput(params);
  let sourceResults;
  try {
    sourceResults = await Promise.all(
      input.sources.map((source) => searchSource(userId, input, source, params.agent_id))
    );
  } catch (error) {
    // Fix 1b: a regex feature Postgres ARE rejects (e.g. lookbehind) surfaces as
    // SQLSTATE 2201B — that's a bad pattern (client error), not a 500.
    if (isPostgresRegexError(error)) {
      throw new InvalidPatternError(
        `Pattern uses a feature the search engine does not support (e.g. lookbehind). Simplify the pattern.`
      );
    }
    throw error;
  }

  const totalMatches = sourceResults.reduce((sum, result) => sum + result.total, 0);
  const oldestFirst = input.sources.every(isMessageFamilySource);
  const merged = sortMatches(
    sourceResults.flatMap((result) => result.matches),
    oldestFirst
  );
  const matches = merged.slice(input.offset, input.offset + input.headLimit);
  const truncated = totalMatches > input.offset + matches.length;
  const summaries: GrepResult['summaries'] = {};

  if (input.sources.includes('transactions')) {
    const filters = input.filters.transactions;
    const aggregateRows = await grepRepo.aggregateTransactionGrepRows({
      userId,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      since: filters?.since,
      until: filters?.until,
      account: filters?.account,
      minAmount: filters?.minAmount,
      maxAmount: filters?.maxAmount,
      status: filters?.status,
      includePendingInTotals: filters?.includePendingInTotals,
    });
    summaries.transactions = {
      totals_include_pending: filters?.includePendingInTotals === true,
      currencies: aggregateRows.map((row) => ({
        currency: row.currency,
        outflow: row.outflow?.toString() ?? '0',
        inflow: row.inflow?.toString() ?? '0',
        net: row.net?.toString() ?? '0',
        count: Number(row.count),
      })),
    };
  }

  log.info(
    `grep: '${params.pattern}' -> ${matches.length}/${totalMatches} matches in ${input.sources.join(',')}`
  );

  return {
    matches,
    total_matches: totalMatches,
    truncated,
    pattern: params.pattern,
    sources: input.sources,
    applied_limit: input.headLimit,
    applied_offset: input.offset,
    returned: matches.length,
    has_more: truncated,
    next_offset: truncated ? input.offset + matches.length : null,
    display_order: oldestFirst ? 'oldest_first' : 'newest_first',
    context_unit: oldestFirst
      ? 'message_record'
      : input.sources.some(isMessageFamilySource)
        ? 'mixed'
        : 'logical_line',
    ...(Object.keys(summaries).length > 0 ? { summaries } : {}),
    ...(matches.length === 0
      ? {
          message: `No matches for '${params.pattern}' in ${input.sources.join(', ')}.`,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function getSummary(userId: string): Promise<SummaryResult> {
  const totalMessages = await repo.countAllMessages(userId);
  const threads = await repo.getThreadsWithStats(userId);
  const channelCounts = await repo.getChannelCounts(userId);
  const oldestMessage = await repo.getOldestMessage(userId);
  const newestMessage = await repo.getNewestMessage(userId);
  const transactionSummary = await grepRepo.getTransactionSummary(userId);
  const documentSummary = await grepRepo.getDocumentSummary(userId);

  const channels = channelCounts.reduce(
    (acc, c) => {
      acc[c.channel] = c._count;
      return acc;
    },
    {} as Record<string, number>
  );

  const threadSummaries = threads.map((t) => {
    const name = ([t.firstName, t.lastName].filter(Boolean).join(' ') || t.phoneNumber) ?? t.id;
    const lastMsg = t.messageRecords[0]?.timestamp;
    const lastMsgAgo = lastMsg !== undefined ? formatTimeAgo(lastMsg) : 'unknown';

    return {
      name: `${name}.thread`,
      message_count: t._count.messageRecords,
      last_message: lastMsgAgo,
    };
  });

  log.info(`summary: ${threads.length} threads, ${totalMessages} messages`);

  const result: SummaryResult = {
    sources: {
      messages: {
        total_threads: threads.length,
        total_messages: totalMessages,
        channels,
        date_range: {
          from: oldestMessage?.timestamp?.toISOString() ?? null,
          to: newestMessage?.timestamp?.toISOString() ?? null,
        },
        latest_message: newestMessage
          ? {
              timestamp: newestMessage.timestamp.toISOString(),
              channel: newestMessage.channel,
              from: newestMessage.from,
              to: newestMessage.to,
              text: newestMessage.message,
            }
          : null,
        threads: threadSummaries,
      },
    },
  };
  if (transactionSummary.total_transactions > 0) {
    result.sources.transactions = transactionSummary;
  }
  if (documentSummary.total_documents > 0) {
    result.sources.documents = documentSummary;
  }
  return result;
}

export async function getSnapshot(userId: string) {
  const snapshot = await repo.getUserSnapshot(userId);
  return { snapshot };
}
