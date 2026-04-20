/**
 * i-message-reader — service layer
 *
 * Business logic for reading, cleaning, enriching, and filtering iMessages.
 * Orchestrates the repo layer (chat.db reads + contact lookups) and exposes
 * typed args in / typed results out. No direct better-sqlite3 or fs imports.
 */

import { APPLE_EPOCH_OFFSET_SECONDS, INVALID_HANDLE_SENTINEL } from './config';
import {
  checkDbAccess,
  openImessageDb,
  probeMessageColumns,
  queryHistoricalReplyHandles,
  queryMaxRowId,
  queryMessages,
  queryMessagesSinceRowId,
  readContacts,
} from './repo';
import { cleanRow, normalizeHandle } from './service.clean';
import type { ContactRecord, IMessageData, NormalizedMessage } from './types';

// ── timestamp helpers ─────────────────────────────────────────────────────

function isoToImessageTimestamp(isoString: string): number {
  const unixSeconds = Math.floor(new Date(isoString).getTime() / 1000);
  return (unixSeconds - APPLE_EPOCH_OFFSET_SECONDS) * 1_000_000_000;
}

function appleTimestampToDate(appleTimestamp: number): Date {
  const timestampInSeconds = appleTimestamp / 1_000_000_000;
  const unixTimestamp = timestampInSeconds + APPLE_EPOCH_OFFSET_SECONDS;
  return new Date(unixTimestamp * 1000);
}

// ── logging helpers ───────────────────────────────────────────────────────

interface SkipCounters {
  missingHandle: number;
  shortCode: number;
  emptyText: number;
}

function logCleanedSummary(cleanedCount: number, rawCount: number, fromUserCount: number): void {
  const fromOthersCount = cleanedCount - fromUserCount;
  console.log(`[IMessageReader] ✅ Cleaned ${cleanedCount}/${rawCount} messages`);
  console.log(
    `[IMessageReader] 📊 Direction: ${fromUserCount} from user, ${fromOthersCount} from others`
  );
}

function logSkipCounts(skips: SkipCounters): void {
  if (skips.missingHandle > 0) {
    console.log(`[IMessageReader] ⚠️ Skipped ${skips.missingHandle} messages missing a handle`);
  }
  if (skips.shortCode > 0) {
    console.log(`[IMessageReader] ⚠️ Skipped ${skips.shortCode} short numeric handles`);
  }
  if (skips.emptyText > 0) {
    console.log(`[IMessageReader] ⚠️ Skipped ${skips.emptyText} photo-only / empty messages`);
  }
}

// ── reply / filter helpers ────────────────────────────────────────────────

function buildReplySets(cleanedMessages: IMessageData[]): {
  repliedHandles: Set<string>;
  namedHandles: Set<string>;
} {
  const repliedHandles = new Set<string>();
  const namedHandles = new Set<string>();
  for (const msg of cleanedMessages) {
    if (msg.is_from_me) {
      repliedHandles.add(msg.contact_id);
    }
    const hasName =
      (msg.contact_firstName !== null && msg.contact_firstName !== '') ||
      (msg.contact_lastName !== null && msg.contact_lastName !== '');
    if (hasName) {
      namedHandles.add(msg.contact_id);
    }
  }
  return { repliedHandles, namedHandles };
}

// ── contact load helper ───────────────────────────────────────────────────

async function loadContactMap(logOnSuccess: boolean): Promise<Map<string, ContactRecord>> {
  try {
    const contactMap = await readContacts();
    if (logOnSuccess) {
      console.log(`[IMessageReader] Loaded ${contactMap.size} contact identifiers for enrichment`);
    }
    return contactMap;
  } catch (error) {
    console.warn('[IMessageReader] Failed to load contacts for enrichment:', error);
    return new Map<string, ContactRecord>();
  }
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Check whether the process can open chat.db. Touching the file registers
 * the app with macOS TCC so it appears under Full Disk Access.
 */
export function checkAccess(): boolean {
  return checkDbAccess();
}

/**
 * Read and clean recent iMessages.
 *
 * @param sinceTimestamp ISO-8601 timestamp; only messages newer than this are returned.
 * @param isSync         When true, messages from contacts the user ever replied to are kept
 *                       (by consulting chat.db for historical outbound messages).
 */
export async function readMessages(
  sinceTimestamp?: string,
  isSync = false
): Promise<IMessageData[]> {
  if (!checkAccess()) {
    throw new Error(
      'No access to iMessage database. Grant Full Disk Access in System Preferences.'
    );
  }

  const db = openImessageDb();

  try {
    const columns = probeMessageColumns(db);
    const sinceAppleTimestamp =
      sinceTimestamp !== undefined && sinceTimestamp !== ''
        ? isoToImessageTimestamp(sinceTimestamp)
        : null;
    const rawMessages = queryMessages(db, columns, sinceAppleTimestamp);

    console.log(`[IMessageReader] Read ${rawMessages.length} raw messages from database`);

    if (rawMessages.length === 0) {
      return [];
    }

    const contactMap = await loadContactMap(true);
    const skips: SkipCounters = { missingHandle: 0, shortCode: 0, emptyText: 0 };

    const cleanedMessages: IMessageData[] = [];
    for (const msg of rawMessages) {
      const cleaned = cleanRow(msg, {
        columns,
        contactMap,
        onSkipMissingHandle: () => skips.missingHandle++,
        onSkipShortCode: () => skips.shortCode++,
        onSkipEmptyText: () => skips.emptyText++,
      });
      if (cleaned !== null) {
        cleanedMessages.push(cleaned);
      }
    }

    const fromUserCount = cleanedMessages.filter((m) => m.is_from_me).length;
    logCleanedSummary(cleanedMessages.length, rawMessages.length, fromUserCount);
    logSkipCounts(skips);

    const { repliedHandles, namedHandles } = buildReplySets(cleanedMessages);

    if (isSync && cleanedMessages.length > 0) {
      const uniqueContactIds = [...new Set(cleanedMessages.map((m) => m.contact_id))];
      const historicalReplies = queryHistoricalReplyHandles(db, uniqueContactIds);
      for (const handleId of historicalReplies) {
        const normalized = normalizeHandle(handleId);
        if (normalized !== INVALID_HANDLE_SENTINEL) {
          repliedHandles.add(normalized);
        }
      }
      console.log(
        `[IMessageReader] Found ${historicalReplies.length} contacts with historical replies`
      );
    }

    const filteredMessages = cleanedMessages.filter(
      (msg) => repliedHandles.has(msg.contact_id) || namedHandles.has(msg.contact_id)
    );

    if (filteredMessages.length !== cleanedMessages.length) {
      const dropped = cleanedMessages.length - filteredMessages.length;
      console.log(
        `[IMessageReader] Filtered out ${dropped} message(s) from contacts the user never replied to`
      );
    }

    return filteredMessages;
  } finally {
    db.close();
  }
}

/**
 * Read iMessages with ROWID > sinceRowId, ordered by date ascending.
 * Used by the real-time watcher (no filtering — every new message is surfaced).
 */
export async function readMessagesSinceRowId(sinceRowId: number): Promise<IMessageData[]> {
  if (!checkAccess()) {
    throw new Error(
      'No access to iMessage database. Grant Full Disk Access in System Preferences.'
    );
  }

  const db = openImessageDb();

  try {
    const columns = probeMessageColumns(db);
    const rawMessages = queryMessagesSinceRowId(db, columns, sinceRowId);

    if (rawMessages.length === 0) {
      return [];
    }

    console.log(
      `[IMessageReader] Real-time: Found ${rawMessages.length} new messages since ROWID ${sinceRowId}`
    );

    const contactMap = await loadContactMap(false);

    const cleanedMessages: IMessageData[] = [];
    for (const msg of rawMessages) {
      const cleaned = cleanRow(msg, { columns, contactMap });
      if (cleaned !== null) {
        cleanedMessages.push(cleaned);
      }
    }

    return cleanedMessages;
  } finally {
    db.close();
  }
}

/**
 * Max ROWID in the message table — used to seed the real-time watcher's
 * high-water mark on first start.
 */
export function getMaxRowId(): number {
  if (!checkAccess()) {
    return 0;
  }

  const db = openImessageDb();
  try {
    return queryMaxRowId(db);
  } finally {
    db.close();
  }
}

function orUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}

/**
 * Convert a raw IMessageData row to the platform-neutral NormalizedMessage shape.
 */
export function toNormalizedMessage(msg: IMessageData): NormalizedMessage {
  return {
    id: String(msg.id),
    text: msg.text,
    timestamp: appleTimestampToDate(msg.date),
    isFromMe: msg.is_from_me,
    chatId: msg.contact_id,
    contactId: msg.contact_id,
    contactName: orUndefined(msg.contact_name),
    channel: 'IMESSAGE',
    contact: {
      firstName: orUndefined(msg.contact_firstName),
      lastName: orUndefined(msg.contact_lastName),
      company: orUndefined(msg.contact_company),
      title: orUndefined(msg.contact_title),
      email: orUndefined(msg.contact_email),
      emailAddresses: msg.contact_emailAddresses,
    },
  };
}

/**
 * Convert an array of IMessageData rows to NormalizedMessage format.
 */
export function toNormalizedMessages(messages: IMessageData[]): NormalizedMessage[] {
  return messages.map((msg) => toNormalizedMessage(msg));
}
