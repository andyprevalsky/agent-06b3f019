/**
 * Data domain service — business logic for grep and summary operations.
 */

import { MAX_RESULT_CHARS } from './config';
import { boundMatchesByChars } from './grepPageBounds';
import { isPostgresRegexError } from './regexSafety';
import { formatTimeAgo } from './format.snippets';
import { sortMatches } from './grepSort';
import { InvalidPatternError } from './errors';
import { searchSource } from './sourceSearchService';
import { transactionGrepSummary } from './transactionGrepSummary';
import {
  isMessageFamilySource,
  type GrepParams,
  type GrepResult,
  type SummaryResult,
} from './types';
import { validateGrepInput } from './validate';
import * as repo from './repo';
import * as grepRepo from './grepRepo';
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
  const soleTrajectory = input.sources.length === 1 && input.sources[0] === 'agent_trajectories';
  const oldestFirst = soleTrajectory
    ? input.order === 'oldest_first'
    : input.sources.every(isMessageFamilySource);
  const merged = soleTrajectory
    ? sourceResults[0].matches
    : sortMatches(
        sourceResults.flatMap((result) => result.matches),
        oldestFirst
      );
  const page = merged.slice(input.offset, input.offset + input.headLimit);
  const { matches, charTruncated } = boundMatchesByChars(page, MAX_RESULT_CHARS);
  const keysetPage = soleTrajectory && input.offset === 0;
  const truncated = keysetPage
    ? sourceResults[0].hasMore === true
    : totalMatches > input.offset + matches.length;
  const hasMore = truncated || charTruncated;
  const summaries: GrepResult['summaries'] = {};

  if (input.sources.includes('transactions')) {
    summaries.transactions = await transactionGrepSummary(userId, input);
  }

  log.info(
    `grep: '${input.pattern}' -> ${matches.length}/${totalMatches} matches in ${input.sources.join(',')}`
  );

  return {
    matches,
    total_matches: totalMatches,
    truncated: hasMore,
    pattern: input.pattern,
    sources: input.sources,
    applied_limit: input.headLimit,
    applied_offset: input.offset,
    returned: matches.length,
    has_more: hasMore,
    next_offset:
      hasMore && input.pageAfterMessageId === undefined ? input.offset + matches.length : null,
    ...(keysetPage ? { next_page_after: hasMore ? (matches.at(-1)?.path ?? null) : null } : {}),
    applied_char_limit: MAX_RESULT_CHARS,
    ...(charTruncated ? { char_truncated: true } : {}),
    display_order: oldestFirst ? 'oldest_first' : 'newest_first',
    context_unit:
      oldestFirst && !soleTrajectory
        ? 'message_record'
        : input.sources.some(isMessageFamilySource)
          ? 'mixed'
          : 'logical_line',
    ...(Object.keys(summaries).length > 0 ? { summaries } : {}),
    ...(matches.length === 0
      ? {
          message: `No matches for '${input.pattern}' in ${input.sources.join(', ')}.`,
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
