/**
 * Data domain service — business logic for grep and summary operations.
 */

import {
  MAX_RESULTS,
  MAX_CONTEXT_MESSAGES,
  MAX_RESULT_CHARS,
  DEFAULT_SINCE_DAYS,
  CONTEXT_WINDOW_MS,
} from './config';
import {
  VALID_SOURCES,
  type GrepParams,
  type GrepResult,
  type FormattedResult,
  type SummaryResult,
  type ValidSource,
} from './types';
import * as repo from './repo';
import { createLogger } from '../../providers/logger';

const log = createLogger('Data');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class InvalidPatternError extends Error {
  constructor() {
    super(
      "Required field 'pattern' must be a string. Use '' to return all messages, or search for keywords like 'dinner', 'meeting'."
    );
    this.name = 'InvalidPatternError';
  }
}

export class SourceNotFoundError extends Error {
  public availableSources: string[];
  constructor(source: string) {
    const available = Object.keys(VALID_SOURCES);
    super(`Unknown source: '${source}'. Available sources: ${available.join(', ')}`);
    this.name = 'SourceNotFoundError';
    this.availableSources = available;
  }
}

export class PersonNotFoundError extends Error {
  constructor(personId: string) {
    super(
      `No person found matching '${personId}' in your contacts. Try using an email address, phone number, or full name.`
    );
    this.name = 'PersonNotFoundError';
  }
}

export class InvalidSinceError extends Error {
  constructor(since: string) {
    super(
      `Invalid 'since' timestamp: '${since}'. Use ISO 8601 format, e.g. '2025-01-01T00:00:00Z'.`
    );
    this.name = 'InvalidSinceError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip email reply quotes and forwarded content from message text.
 * Removes lines starting with ">" and "On ... wrote:" attribution lines,
 * plus stray \r characters.
 */
function stripEmailQuotes(message: string): string {
  return message
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => !line.match(/^\s*>+/)) // lines starting with >
    .filter((line) => !line.match(/^On .+ wrote:\s*$/)) // "On ... wrote:" attribution
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
    .trim();
}

/**
 * Format a date as relative time ago string.
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

// ---------------------------------------------------------------------------
// Grep — input validation
// ---------------------------------------------------------------------------

interface ValidatedGrepInput {
  trimmedPattern: string;
  resolvedSource: ValidSource;
  resolvedLimit: number;
  personId: string | undefined;
  cutoffTime: Date;
}

/**
 * Validate and normalize grep input parameters.
 */
async function validateGrepInput(userId: string, params: GrepParams): Promise<ValidatedGrepInput> {
  const { pattern, source, since, limit } = params;
  let { person_id } = params;

  // Validate pattern — empty string '' is allowed (returns all messages)
  if (pattern === undefined || pattern === null || typeof pattern !== 'string') {
    throw new InvalidPatternError();
  }

  // Validate source
  const resolvedSource: ValidSource = (source as ValidSource) ?? 'messages';
  if (!(resolvedSource in VALID_SOURCES)) {
    throw new SourceNotFoundError(resolvedSource);
  }

  // Validate optional params
  const resolvedLimit = Math.min(Math.max(parseInt(String(limit)) || 20, 1), MAX_RESULTS);

  // Validate person_id if provided
  if (person_id !== undefined && person_id !== '') {
    const resolved = await repo.resolvePersonId(person_id, userId);
    if (resolved === null) {
      throw new PersonNotFoundError(person_id);
    }
    person_id = resolved;
  }

  // Calculate cutoff from 'since' (ISO timestamp) or default
  let cutoffTime: Date;
  if (since !== undefined && since !== '') {
    const parsed = new Date(since);
    if (isNaN(parsed.getTime())) {
      throw new InvalidSinceError(since);
    }
    cutoffTime = parsed;
  } else {
    cutoffTime = new Date();
    cutoffTime.setDate(cutoffTime.getDate() - DEFAULT_SINCE_DAYS);
  }

  return {
    trimmedPattern: pattern.trim(),
    resolvedSource,
    resolvedLimit,
    personId: person_id,
    cutoffTime,
  };
}

// ---------------------------------------------------------------------------
// Grep — context extraction
// ---------------------------------------------------------------------------

/**
 * For each thread with matches, fetch context messages around each match
 * and build formatted results within a token budget.
 */
async function buildFormattedResults(
  matchesByThread: Map<string, Awaited<ReturnType<typeof repo.searchMessages>>>,
  userId: string
): Promise<{ formattedResults: FormattedResult[]; truncatedCount: number }> {
  const formattedResults: FormattedResult[] = [];
  let totalChars = 0;
  let truncatedCount = 0;

  for (const [personId, threadMatches] of matchesByThread) {
    const timestamps = threadMatches.map((m) => m.timestamp);
    const earliestMatch = new Date(Math.min(...timestamps.map((t) => t.getTime())));
    const latestMatch = new Date(Math.max(...timestamps.map((t) => t.getTime())));

    const contextStart = new Date(earliestMatch.getTime() - CONTEXT_WINDOW_MS);
    const contextEnd = new Date(latestMatch.getTime() + CONTEXT_WINDOW_MS);

    const contextMessages = await repo.fetchContextMessages({
      personId,
      userId,
      contextStart,
      contextEnd,
      takeLimit: threadMatches.length * (MAX_CONTEXT_MESSAGES * 2 + 1) + 10,
    });

    const matchIds = new Set(threadMatches.map((m) => m.id));
    const contextWindow: typeof contextMessages = [];

    for (let i = 0; i < contextMessages.length; i++) {
      const msg = contextMessages[i];
      if (matchIds.has(msg.id)) {
        const start = Math.max(0, i - MAX_CONTEXT_MESSAGES);
        const end = Math.min(contextMessages.length - 1, i + MAX_CONTEXT_MESSAGES);
        for (let j = start; j <= end; j++) {
          if (!contextWindow.find((m) => m.id === contextMessages[j].id)) {
            contextWindow.push(contextMessages[j]);
          }
        }
      }
    }

    contextWindow.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const person = threadMatches[0].person;
    const threadName =
      ([person.firstName, person.lastName].filter(Boolean).join(' ') || person.phoneNumber) ??
      person.email ??
      personId;

    const threadMessages = contextWindow.map((msg) => ({
      channel: msg.channel,
      from: msg.from,
      to: msg.to,
      timestamp: msg.timestamp.toISOString(),
      message: stripEmailQuotes(msg.message),
      is_match: matchIds.has(msg.id),
    }));

    const threadText = JSON.stringify(threadMessages);
    if (totalChars + threadText.length > MAX_RESULT_CHARS) {
      truncatedCount += threadMatches.length;
      continue;
    }
    totalChars += threadText.length;

    formattedResults.push({
      thread: `${threadName}.thread`,
      person: {
        firstName: person.firstName,
        lastName: person.lastName,
        phoneNumber: person.phoneNumber,
        email: person.email,
      },
      messages: threadMessages,
    });
  }

  return { formattedResults, truncatedCount };
}

// ---------------------------------------------------------------------------
// Grep — main entry point
// ---------------------------------------------------------------------------

export async function grep(userId: string, params: GrepParams): Promise<GrepResult> {
  const { trimmedPattern, resolvedSource, resolvedLimit, personId, cutoffTime } =
    await validateGrepInput(userId, params);

  const matches = await repo.searchMessages({
    userId,
    trimmedPattern,
    cutoffTime,
    personId,
    limit: resolvedLimit,
  });

  if (matches.length === 0) {
    const totalMessages = await repo.countMessages(userId, cutoffTime);
    const threadCount = await repo.countThreads(userId, cutoffTime);

    const sinceLabel =
      params.since !== undefined && params.since !== ''
        ? `since ${params.since}`
        : `last ${DEFAULT_SINCE_DAYS} days`;
    log.info(
      `grep: no matches for '${params.pattern}' (${totalMessages} messages, ${threadCount} threads, ${sinceLabel})`
    );

    return {
      matches: [] as FormattedResult[],
      total_matches: 0 as const,
      truncated: false as const,
      message: `No matches for '${params.pattern}' in messages/ (searched ${totalMessages} messages across ${threadCount} threads, ${sinceLabel}). Try different keywords or expand the date range.`,
    };
  }

  // Group matches by thread (personId)
  const matchesByThread = new Map<string, typeof matches>();
  for (const match of matches) {
    const existing = matchesByThread.get(match.personId) ?? [];
    existing.push(match);
    matchesByThread.set(match.personId, existing);
  }

  const { formattedResults, truncatedCount } = await buildFormattedResults(matchesByThread, userId);

  log.info(
    `grep: '${params.pattern}' -> ${matches.length} matches in ${formattedResults.length} threads` +
      `${truncatedCount > 0 ? ` (${truncatedCount} truncated)` : ''}`
  );

  return {
    matches: formattedResults,
    total_matches: matches.length,
    truncated: truncatedCount > 0,
    ...(truncatedCount > 0
      ? {
          truncation_message: `& ${truncatedCount} more matches truncated to fit token budget. Narrow your search with person_id or a more recent 'since' timestamp.`,
        }
      : {}),
    pattern: params.pattern,
    source: resolvedSource,
    since: cutoffTime.toISOString(),
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
