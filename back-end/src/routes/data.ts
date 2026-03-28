/**
 * Data routes - grep/search over user's local data (message threads, etc.)
 *
 * POST /api/data/grep   - Search message threads by keyword pattern
 * GET  /api/data/summary - Get filesystem-like summary of available data sources
 */

import express, { Response } from 'express';
import { authenticate, AuthRequest } from '../providers/auth';
import { prisma } from '../providers/database';

const router = express.Router();

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

// Valid data sources with their configuration
// TODO: Add more sources as we expand (contacts, emails, calendar, etc.)
const VALID_SOURCES = {
  messages: {
    description: 'iMessage and email conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
  },
} as const;

type ValidSource = keyof typeof VALID_SOURCES;

// Limits
const MAX_RESULTS = 50;
const MAX_CONTEXT_MESSAGES = 3; // Messages before/after each match
const MAX_RESULT_TOKENS = 8000; // Approximate token cap (~4 chars per token)
const MAX_RESULT_CHARS = MAX_RESULT_TOKENS * 4;

/**
 * POST /api/data/grep
 *
 * Search user's local data by keyword pattern.
 * Plain text search only (no regex) — uses Postgres ILIKE with trigram index.
 *
 * TODO: Full regex support skipped for now. ILIKE + trigram indexes are fast and cover
 * the majority of use cases ("dinner", "meeting notes", "project update"). Arbitrary
 * regex (~ operator) bypasses trigram indexes and causes full table scans.
 * If we add regex later, validate the pattern server-side and set a query timeout.
 */
router.post('/grep', authenticate, async (req: AuthRequest, res: Response) => {
  const startTime = Date.now();
  try {
    const userId = req.isInternal
      ? (req.headers['x-user-id'] as string) || req.body.user_id
      : req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { pattern, source, since, limit } = req.body;
    let { person_id } = req.body;

    // Validate pattern — empty string '' is allowed (returns all messages)
    if (pattern === undefined || pattern === null || typeof pattern !== 'string') {
      return res.status(400).json({
        error: 'INVALID_PATTERN',
        message:
          "Required field 'pattern' must be a string. Use '' to return all messages, or search for keywords like 'dinner', 'meeting'.",
      });
    }

    // Validate source
    const resolvedSource: ValidSource = source || 'messages';
    if (!(resolvedSource in VALID_SOURCES)) {
      return res.status(400).json({
        error: 'SOURCE_NOT_FOUND',
        message: `Unknown source: '${resolvedSource}'. Available sources: ${Object.keys(VALID_SOURCES).join(', ')}`,
        available_sources: Object.keys(VALID_SOURCES),
      });
    }

    // Validate optional params
    const resolvedLimit = Math.min(Math.max(parseInt(limit) || 20, 1), MAX_RESULTS);

    // Validate person_id if provided
    if (person_id) {
      // Resolve person_id: accept UUID, email, phone number, or name
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        person_id
      );
      let person;
      if (isUuid) {
        person = await prisma.person.findFirst({
          where: { id: person_id, userId },
          select: { id: true },
        });
      } else {
        // Try email, phone, or name match
        person = await prisma.person.findFirst({
          where: {
            userId,
            OR: [
              { email: { equals: person_id, mode: 'insensitive' } },
              { phoneNumber: person_id },
              { firstName: { equals: person_id, mode: 'insensitive' } },
              {
                AND: [
                  { firstName: { equals: person_id.split(' ')[0], mode: 'insensitive' } },
                  {
                    lastName: {
                      equals: person_id.split(' ').slice(1).join(' '),
                      mode: 'insensitive',
                    },
                  },
                ],
              },
            ],
          },
          select: { id: true },
        });
      }
      if (!person) {
        return res.status(400).json({
          error: 'PERSON_NOT_FOUND',
          message: `No person found matching '${person_id}' in your contacts. Try using an email address, phone number, or full name.`,
        });
      }
      // Replace person_id with resolved UUID for the query below
      person_id = person.id;
    }

    // Calculate cutoff from 'since' (ISO timestamp) or default to 365 days ago
    let cutoffTime: Date;
    if (since) {
      const parsed = new Date(since);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({
          error: 'INVALID_SINCE',
          message: `Invalid 'since' timestamp: '${since}'. Use ISO 8601 format, e.g. '2025-01-01T00:00:00Z'.`,
        });
      }
      cutoffTime = parsed;
    } else {
      cutoffTime = new Date();
      cutoffTime.setDate(cutoffTime.getDate() - 365);
    }

    // Search for matching messages
    // Uses ILIKE for case-insensitive text search (trigram index makes this fast)
    const trimmedPattern = pattern.trim();
    const matches = await prisma.messageRecord.findMany({
      where: {
        person: { userId },
        ...(trimmedPattern.length > 0
          ? { message: { contains: trimmedPattern, mode: 'insensitive' } }
          : {}),
        timestamp: { gte: cutoffTime },
        ...(person_id ? { personId: person_id } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: resolvedLimit,
      select: {
        id: true,
        personId: true,
        channel: true,
        from: true,
        to: true,
        timestamp: true,
        message: true,
        person: {
          select: {
            firstName: true,
            lastName: true,
            phoneNumber: true,
            email: true,
          },
        },
      },
    });

    if (matches.length === 0) {
      // Get total message count for helpful error context
      const totalMessages = await prisma.messageRecord.count({
        where: {
          person: { userId },
          timestamp: { gte: cutoffTime },
        },
      });

      const threadCount = await prisma.person.count({
        where: {
          userId,
          messageRecords: { some: { timestamp: { gte: cutoffTime } } },
        },
      });

      const elapsed = Date.now() - startTime;
      const sinceLabel = since ? `since ${since}` : 'last 365 days';
      console.log(
        `[Data] grep: no matches for '${pattern}' (${totalMessages} messages, ${threadCount} threads, ${sinceLabel}) [${elapsed}ms]`
      );

      return res.json({
        matches: [],
        total_matches: 0,
        truncated: false,
        message: `No matches for '${pattern}' in messages/ (searched ${totalMessages} messages across ${threadCount} threads, ${sinceLabel}). Try different keywords or expand the date range.`,
      });
    }

    // Fetch surrounding context for each match, grouped by thread (personId)
    const matchesByThread = new Map<string, typeof matches>();
    for (const match of matches) {
      const existing = matchesByThread.get(match.personId) || [];
      existing.push(match);
      matchesByThread.set(match.personId, existing);
    }

    // For each thread with matches, fetch context messages around each match
    const formattedResults: Array<{
      thread: string;
      person: {
        firstName: string | null;
        lastName: string | null;
        phoneNumber: string | null;
        email: string | null;
      };
      messages: Array<{
        channel: string;
        from: string;
        to: string;
        timestamp: string;
        message: string;
        is_match: boolean;
      }>;
    }> = [];

    let totalChars = 0;
    let truncatedCount = 0;

    for (const [personId, threadMatches] of matchesByThread) {
      // Build time windows around each match for context
      const contextIds = new Set<string>();
      for (const match of threadMatches) {
        contextIds.add(match.id);
      }

      // Get context messages (N before and after each match timestamp)
      const timestamps = threadMatches.map((m) => m.timestamp);
      const earliestMatch = new Date(Math.min(...timestamps.map((t) => t.getTime())));
      const latestMatch = new Date(Math.max(...timestamps.map((t) => t.getTime())));

      // Expand window by 1 hour on each side for context
      const contextStart = new Date(earliestMatch.getTime() - 3600000);
      const contextEnd = new Date(latestMatch.getTime() + 3600000);

      const contextMessages = await prisma.messageRecord.findMany({
        where: {
          personId,
          person: { userId },
          timestamp: { gte: contextStart, lte: contextEnd },
        },
        orderBy: { timestamp: 'asc' },
        take: threadMatches.length * (MAX_CONTEXT_MESSAGES * 2 + 1) + 10, // cap per thread
        select: {
          id: true,
          channel: true,
          from: true,
          to: true,
          timestamp: true,
          message: true,
        },
      });

      // Build the output: for each match, include N context messages before/after
      const matchIds = new Set(threadMatches.map((m) => m.id));
      const contextWindow: typeof contextMessages = [];

      for (let i = 0; i < contextMessages.length; i++) {
        const msg = contextMessages[i];
        if (matchIds.has(msg.id)) {
          // Include N messages before
          const start = Math.max(0, i - MAX_CONTEXT_MESSAGES);
          // Include N messages after
          const end = Math.min(contextMessages.length - 1, i + MAX_CONTEXT_MESSAGES);
          for (let j = start; j <= end; j++) {
            if (!contextWindow.find((m) => m.id === contextMessages[j].id)) {
              contextWindow.push(contextMessages[j]);
            }
          }
        }
      }

      // Sort by timestamp
      contextWindow.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      const person = threadMatches[0].person;
      const threadName =
        [person.firstName, person.lastName].filter(Boolean).join(' ') ||
        person.phoneNumber ||
        person.email ||
        personId;

      const threadMessages = contextWindow.map((msg) => ({
        channel: msg.channel,
        from: msg.from,
        to: msg.to,
        timestamp: msg.timestamp.toISOString(),
        message: stripEmailQuotes(msg.message),
        is_match: matchIds.has(msg.id),
      }));

      // Check token budget
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

    const elapsed = Date.now() - startTime;
    console.log(
      `[Data] grep: '${pattern}' → ${matches.length} matches in ${formattedResults.length} threads` +
        `${truncatedCount > 0 ? ` (${truncatedCount} truncated)` : ''} [${elapsed}ms]`
    );

    return res.json({
      matches: formattedResults,
      total_matches: matches.length,
      truncated: truncatedCount > 0,
      ...(truncatedCount > 0
        ? {
            truncation_message: `& ${truncatedCount} more matches truncated to fit token budget. Narrow your search with person_id or a more recent 'since' timestamp.`,
          }
        : {}),
      pattern,
      source: resolvedSource,
      since: cutoffTime.toISOString(),
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[Data] grep failed [${elapsed}ms]:`, error);
    return res.status(500).json({
      error: 'GREP_FAILED',
      message: 'Failed to search messages. Please try again.',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/data/summary
 *
 * Returns a filesystem-like summary of the user's available data sources.
 * Used by the explore agent to know what local data exists and how to search it.
 */
router.get('/summary', authenticate, async (req: AuthRequest, res: Response) => {
  const startTime = Date.now();
  try {
    const userId = req.isInternal ? (req.headers['x-user-id'] as string) : req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get message stats
    const totalMessages = await prisma.messageRecord.count({
      where: { person: { userId } },
    });

    // Get thread count and per-thread stats
    const threads = await prisma.person.findMany({
      where: {
        userId,
        messageRecords: { some: {} },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneNumber: true,
        _count: { select: { messageRecords: true } },
        messageRecords: {
          select: { timestamp: true, channel: true },
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
      orderBy: {
        messageRecords: { _count: 'desc' },
      },
    });

    // Get channel breakdown
    const channelCounts = await prisma.messageRecord.groupBy({
      by: ['channel'],
      where: { person: { userId } },
      _count: true,
    });

    // Get date range
    const oldestMessage = await prisma.messageRecord.findFirst({
      where: { person: { userId } },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
    });

    const newestMessage = await prisma.messageRecord.findFirst({
      where: { person: { userId } },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });

    // Format channel counts
    const channels = channelCounts.reduce(
      (acc, c) => {
        acc[c.channel] = c._count;
        return acc;
      },
      {} as Record<string, number>
    );

    // Format thread summary (top threads by volume)
    const threadSummaries = threads.map((t) => {
      const name = [t.firstName, t.lastName].filter(Boolean).join(' ') || t.phoneNumber || t.id;
      const lastMsg = t.messageRecords[0]?.timestamp;
      const lastMsgAgo = lastMsg ? formatTimeAgo(lastMsg) : 'unknown';

      return {
        name: `${name}.thread`,
        message_count: t._count.messageRecords,
        last_message: lastMsgAgo,
      };
    });

    const elapsed = Date.now() - startTime;
    console.log(
      `[Data] summary: ${threads.length} threads, ${totalMessages} messages [${elapsed}ms]`
    );

    return res.json({
      sources: {
        messages: {
          total_threads: threads.length,
          total_messages: totalMessages,
          channels,
          date_range: {
            from: oldestMessage?.timestamp?.toISOString() || null,
            to: newestMessage?.timestamp?.toISOString() || null,
          },
          threads: threadSummaries,
        },
      },
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[Data] summary failed [${elapsed}ms]:`, error);
    return res.status(500).json({
      error: 'Failed to fetch data summary',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

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

export default router;
