/**
 * Data domain service — business logic for grep and summary operations.
 */

import { isPostgresRegexError } from './regexSafety';
import {
  buildAgentNetworkMatch,
  buildMessageMatch,
  buildNetworkMatch,
  formatTimeAgo,
} from './format';
import {
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
import { createLogger } from '../../providers/logger';

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
  if (source === 'messages') {
    // person/since narrow the messages source only.
    let personId: string | undefined;
    if (input.person !== undefined) {
      const resolved = await grepRepo.resolvePersonId(userId, input.person);
      if (resolved === null) return { total: 0, matches: [] }; // requested person not found
      personId = resolved;
    }
    const [total, rows] = await Promise.all([
      grepRepo.countMessageGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
        personId,
        since: input.since,
      }),
      grepRepo.searchMessageGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
        limit: input.headLimit,
        offset: input.offset,
        personId,
        since: input.since,
      }),
    ]);
    return { total, matches: rows.map((row) => buildMessageMatch(row, input)) };
  }

  if (source === 'network') {
    const [total, rows] = await Promise.all([
      grepRepo.countNetworkGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
      }),
      grepRepo.searchNetworkGrepRows({
        userId,
        pattern: input.dbPattern,
        caseInsensitive: input.caseInsensitive,
        limit: input.headLimit,
        offset: input.offset,
      }),
    ]);
    return { total, matches: rows.map((row) => buildNetworkMatch(row, input)) };
  }

  const agentIds = await agentTreeIdsForGrep(userId, agentId);
  const [total, rows] = await Promise.all([
    grepRepo.countAgentNetworkGrepRows({
      agentIds,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
    }),
    grepRepo.searchAgentNetworkGrepRows({
      agentIds,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      limit: input.headLimit,
      offset: input.offset,
    }),
  ]);
  return { total, matches: rows.map((row) => buildAgentNetworkMatch(row, input)) };
}

function sortMatches(matches: GrepMatch[]): GrepMatch[] {
  return [...matches].sort((a, b) => {
    const byTime = Date.parse(b.timestamp) - Date.parse(a.timestamp);
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
  const merged = sortMatches(sourceResults.flatMap((result) => result.matches));
  const matches = merged.slice(input.offset, input.offset + input.headLimit);
  const truncated = totalMatches > input.offset + matches.length;

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

  return {
    sources: {
      messages: {
        total_threads: threads.length,
        total_messages: totalMessages,
        channels,
        date_range: {
          from: oldestMessage?.timestamp?.toISOString() ?? null,
          to: newestMessage?.timestamp?.toISOString() ?? null,
        },
        threads: threadSummaries,
      },
    },
  };
}
