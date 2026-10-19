/**
 * Data domain service — business logic for grep and summary operations.
 */

import { isPostgresRegexError } from './regexSafety';
import { formatTimeAgo } from './format.snippets';
import { sortMatches } from './grepSort';
import {
  isCalendarOnly,
  isGoogleGrepSource,
  isMessageFamilySource,
  type GrepMatch,
  type GrepParams,
  type GrepResult,
  type SummaryResult,
  type ValidSource,
  type ValidatedGrepInput,
} from './types';
import { InvalidPatternError } from './errors';
import { validateGrepInput } from './validate';
import * as repo from './repo';
import * as grepRepo from './grepRepo';
import { searchTrajectorySource } from './trajectorySearchService';
import { resolveTaskPathScope } from './taskPathScope';
import { searchMessageSource } from './messageSearchService';
import { searchNetworkSource } from './networkSearchService';
import { googleSourceSummary, searchGoogleSource } from './googleSourceSearchService';
import {
  searchAgentNetworkSource,
  searchDocumentSource,
  searchTransactionSource,
  transactionSummaries,
} from './tableSearchService';
import { createLogger } from '../../providers/logger';

// Per-source connectivity lives in a dedicated file; re-export so routes can
// keep importing it from `./service`.
export { getSourceStatus, type SourceStatus } from './sourceStatus';

const log = createLogger('Data');

// Re-export domain errors so existing importers (routes, networkService,
// agentNetworkService) keep their `from './service'` imports.
export {
  AgentNotFoundError,
  AgentPathNotFoundError,
  InvalidGrepParamError,
  InvalidPatternError,
  MissingAgentIdError,
  SourceNotFoundError,
} from './errors';

interface SourceSearchResult {
  total: number;
  matches: GrepMatch[];
  hasMore?: boolean;
  nextPageAfter?: string | null;
  /** Something the caller must know about these results, e.g. a source still syncing. */
  notice?: string;
}

async function searchSource(
  userId: string,
  input: ValidatedGrepInput,
  source: ValidSource,
  agentId: string | undefined
): Promise<SourceSearchResult> {
  if (isMessageFamilySource(source)) return searchMessageSource({ userId, input, source });
  if (isGoogleGrepSource(source)) return searchGoogleSource({ userId, input, source });
  if (source === 'network') return searchNetworkSource({ userId, input });
  if (source === 'transactions') return searchTransactionSource(userId, input);
  if (source === 'documents') return searchDocumentSource(userId, input);
  if (source === 'agent_trajectories') return searchTrajectorySource(userId, input, agentId);
  return searchAgentNetworkSource(userId, input, agentId);
}

async function searchAllSources(
  userId: string,
  input: ValidatedGrepInput,
  agentId: string | undefined
): Promise<SourceSearchResult[]> {
  try {
    return await Promise.all(
      input.sources.map((source) => searchSource(userId, input, source, agentId))
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
}

/** How one grep's merged matches are ordered and described. */
function displayOrder(input: ValidatedGrepInput): {
  soleTrajectory: boolean;
  oldestFirst: boolean;
  contextUnit: GrepResult['context_unit'];
} {
  const soleTrajectory = input.sources.length === 1 && input.sources[0] === 'agent_trajectories';
  const allMessages = input.sources.every(isMessageFamilySource);
  // Conversations and calendars read forward in time; everything else is newest first.
  const allCalendar = isCalendarOnly(input.sources);
  const oldestFirst = soleTrajectory ? input.order === 'oldest_first' : allMessages || allCalendar;
  const contextUnit = allMessages
    ? 'message_record'
    : input.sources.some(isMessageFamilySource)
      ? 'mixed'
      : 'logical_line';
  return { soleTrajectory, oldestFirst, contextUnit };
}

/** Source notices first, then the plain "no matches" line when nothing matched. */
function resultMessage(
  input: ValidatedGrepInput,
  sourceResults: SourceSearchResult[],
  returned: number
): { message?: string } {
  const parts = sourceResults
    .map((result) => result.notice)
    .filter((notice): notice is string => notice !== undefined);
  if (returned === 0) {
    const where = input.sources.join(', ');
    parts.push(
      input.pattern === ''
        ? `Nothing to list in ${where} for these filters.`
        : `No matches for '${input.pattern}' in ${where}.`
    );
  }
  return parts.length === 0 ? {} : { message: parts.join(' ') };
}

// ---------------------------------------------------------------------------
// Grep — main entry point
// ---------------------------------------------------------------------------

export async function grep(userId: string, params: GrepParams): Promise<GrepResult> {
  const input = await resolveTaskPathScope(userId, validateGrepInput(params), params.agent_id);
  const sourceResults = await searchAllSources(userId, input, params.agent_id);
  const { soleTrajectory, oldestFirst, contextUnit } = displayOrder(input);

  const totalMatches = sourceResults.reduce((sum, result) => sum + result.total, 0);
  const merged = soleTrajectory
    ? sourceResults[0].matches
    : sortMatches(
        sourceResults.flatMap((result) => result.matches),
        oldestFirst
      );
  const matches = merged.slice(input.offset, input.offset + input.headLimit);
  const keysetPage = soleTrajectory && input.offset === 0;
  const truncated = keysetPage
    ? sourceResults[0].hasMore === true
    : totalMatches > input.offset + matches.length;
  const summaries: GrepResult['summaries'] = {};
  if (input.sources.includes('transactions')) {
    summaries.transactions = await transactionSummaries(userId, input);
  }

  log.info(
    `grep: '${input.pattern}' -> ${matches.length}/${totalMatches} matches in ${input.sources.join(',')}`
  );

  return {
    matches,
    total_matches: totalMatches,
    truncated,
    pattern: input.pattern,
    sources: input.sources,
    applied_limit: input.headLimit,
    applied_offset: input.offset,
    returned: matches.length,
    has_more: truncated,
    next_offset:
      truncated && input.pageAfterMessageId === undefined ? input.offset + matches.length : null,
    ...(keysetPage ? { next_page_after: sourceResults[0].nextPageAfter ?? null } : {}),
    display_order: oldestFirst ? 'oldest_first' : 'newest_first',
    context_unit: contextUnit,
    ...(Object.keys(summaries).length > 0 ? { summaries } : {}),
    ...resultMessage(input, sourceResults, matches.length),
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
  const google = await googleSourceSummary(userId);
  if (google !== undefined) {
    result.sources.calendar = google.calendar;
    result.sources.drive = google.drive;
  }
  return result;
}

export async function getSnapshot(userId: string) {
  const snapshot = await repo.getUserSnapshot(userId);
  return { snapshot };
}
