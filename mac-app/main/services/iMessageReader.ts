import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { IMessageData } from '../../shared/types/ipc';
import { ContactsReaderNative, type ContactRecord } from './contactsReaderNative';
import type { NormalizedMessage } from './messaging/types';

import * as bplistParserModule from 'bplist-parser';

const bplistParser = bplistParserModule as unknown as {
  parseBuffer: (buffer: Buffer) => unknown[];
};

const IMESSAGE_DB_PATH = path.join(app.getPath('home'), 'Library/Messages/chat.db');

const INVALID_HANDLE_SENTINEL = 'unknown';
const columnPresenceCache = new Map<string, boolean>();

interface RawMessageRow {
  id: number;
  text: string | null;
  date: number;
  is_from_me: number;
  associated_message_text: string | null;
  attributedBody: Buffer | null;
  handle_id: string | null;
  chat_identifier: string | null;
  contact_name: string | null;
}

const hasColumn = (db: Database.Database, table: string, column: string): boolean => {
  const cacheKey = `${table}.${column}`;
  if (columnPresenceCache.has(cacheKey)) {
    return columnPresenceCache.get(cacheKey)!;
  }
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = info.some((col) => col.name === column);
  columnPresenceCache.set(cacheKey, exists);
  return exists;
};

// eslint-disable-next-line no-control-regex -- intentional control-char strip for iMessage binary payloads
const CONTROL_CHAR_NULL_REGEX = /\u0000/g;
// eslint-disable-next-line no-control-regex -- intentional control-char strip for iMessage binary payloads
const CONTROL_CHAR_RANGE_REGEX = /[\x00-\x1F\x7F]/g;

const stripControlCharacters = (value: string) =>
  value
    .replace(CONTROL_CHAR_NULL_REGEX, '')
    .replace(/\uFFFC/g, '')
    .replace(CONTROL_CHAR_RANGE_REGEX, '')
    .replace(/\uFFFD/g, '')
    .trim();

const stripLeadingMarkers = (value: string): string => {
  if (value.length < 3) return value;
  const first = value[0];
  const second = value[1];
  if (/^[A-Za-z0-9'#:%!]/.test(first)) {
    if (second === second.toUpperCase() || second === ' ' || /^['"\d#:%!]/.test(first)) {
      const withoutFirst = value.substring(1);
      if (withoutFirst.length > 0 && /^[A-Z]/.test(withoutFirst[0])) {
        return withoutFirst;
      }
    }
  }
  return value;
};

const applyAttributedSplitHeuristic = (value: string): string => {
  let result = value;
  const startDelimiter = 'NSString��+';
  const endDelimiter = '��';
  if (!value.includes(startDelimiter)) return value;
  result = value.split(startDelimiter)[1];
  result = result.substring(1);
  // Remove all leading '�' characters until a non-'�' character is seen
  let firstNonReplacementChar = 0;
  while (result[firstNonReplacementChar] === '�') {
    firstNonReplacementChar++;
  }
  if (firstNonReplacementChar > 0) {
    result = result.substring(firstNonReplacementChar);
  }
  result = result.split(endDelimiter)[0];

  result = stripControlCharacters(result);
  result = stripLeadingMarkers(result);
  return result.trim();
};

const sanitizeMessageCandidate = (
  candidate: unknown,
  messageId: number,
  source: 'text' | 'associated' | 'attributed' = 'text'
): string | null => {
  if (candidate === null || candidate === undefined) return null;
  let value = candidate;

  if (typeof value === 'object') {
    try {
      value = JSON.stringify(value);
    } catch (error) {
      console.warn(`[IMessageReader] Failed to stringify message ${messageId} candidate`, error);
      return null;
    }
  }

  let normalized = stripControlCharacters(String(value || ''));
  if (!normalized) return null;

  normalized = stripLeadingMarkers(normalized);

  if (source === 'attributed') {
    normalized = applyAttributedSplitHeuristic(String(value || ''));
  }

  return normalized;
};

const extractTextFromAttributedBody = (buffer?: Buffer | null): string | null => {
  if (!buffer || !buffer.length) return null;
  const tryPlainString = () => {
    const asString = buffer.toString('utf8').replace(/\0/g, '').trim();
    return asString || null;
  };

  const header = buffer.slice(0, 6).toString('utf8');
  if (header !== 'bplist') {
    return tryPlainString();
  }

  try {
    const parsed = bplistParser.parseBuffer(buffer);
    if (!parsed?.length) return tryPlainString();
    const archive = parsed[0] as { $objects?: unknown } | undefined;
    const objects = Array.isArray(archive?.$objects) ? archive.$objects : [];
    const candidates: string[] = [];

    for (const obj of objects) {
      if (typeof obj === 'string') {
        if (
          obj.startsWith('NS') ||
          obj.startsWith('__kIM') ||
          obj.startsWith('CF$') ||
          obj.includes('NSAttributedString') ||
          obj === 'NSObject' ||
          obj === 'NSDictionary'
        ) {
          continue;
        }
        candidates.push(obj);
      } else if (obj && typeof obj === 'object') {
        if (typeof obj.NSString === 'string') {
          candidates.push(obj.NSString);
        }
        if (obj.NS && typeof obj.NS.string === 'string') {
          candidates.push(obj.NS.string);
        }
      }
    }

    const cleanedCandidates = candidates
      .map((candidate) => stripLeadingMarkers(stripControlCharacters(candidate)))
      .filter(Boolean);

    if (cleanedCandidates.length) {
      cleanedCandidates.sort((a, b) => b.length - a.length);
      return cleanedCandidates[0] || null;
    }

    const searchValue = (value: unknown, depth = 0): string | null => {
      if (!value || depth > 5) return null;
      if (typeof value === 'string' && value.trim()) {
        return stripLeadingMarkers(stripControlCharacters(value));
      }

      if (typeof value === 'object' && value !== null) {
        const rec = value as { NS?: { string?: unknown } };
        if (rec.NS && typeof rec.NS.string === 'string') {
          return stripLeadingMarkers(stripControlCharacters(rec.NS.string));
        }
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const result = searchValue(item, depth + 1);
          if (result) return result;
        }
      } else if (typeof value === 'object' && value !== null) {
        for (const val of Object.values(value)) {
          const result = searchValue(val, depth + 1);
          if (result) return result;
        }
      }

      return null;
    };

    return searchValue(archive) ?? tryPlainString();
  } catch (error) {
    console.warn('[IMessageReader] Failed to decode attributedBody:', error);
    return tryPlainString();
  }
};

const normalizeHandle = (handle: string): string => {
  if (!handle) return INVALID_HANDLE_SENTINEL;
  const trimmed = handle.trim();
  if (!trimmed) return INVALID_HANDLE_SENTINEL;
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed;
};

// Convert ISO timestamp to iMessage timestamp (nanoseconds since 2001-01-01)
const isoToImessageTimestamp = (isoString: string): number => {
  const APPLE_EPOCH_OFFSET = 978307200; // Seconds between Unix epoch (1970) and Apple epoch (2001)
  const unixSeconds = Math.floor(new Date(isoString).getTime() / 1000);
  return (unixSeconds - APPLE_EPOCH_OFFSET) * 1_000_000_000;
};

// Convert iMessage timestamp to Date
const appleTimestampToDate = (appleTimestamp: number): Date => {
  const APPLE_EPOCH_OFFSET = 978307200;
  const timestampInSeconds = appleTimestamp / 1_000_000_000;
  const unixTimestamp = timestampInSeconds + APPLE_EPOCH_OFFSET;
  return new Date(unixTimestamp * 1000);
};

export class IMessageReader {
  static checkAccess(): boolean {
    try {
      console.log(`[IMessageReader] Checking access to: ${IMESSAGE_DB_PATH}`);
      // Use openSync+closeSync instead of accessSync — actually opening the file
      // triggers macOS TCC registration so the app appears in Full Disk Access settings
      const fd = fs.openSync(IMESSAGE_DB_PATH, 'r');
      fs.closeSync(fd);
      console.log('[IMessageReader] ✅ Access granted');
      return true;
    } catch (err) {
      console.log(`[IMessageReader] ❌ Access denied: ${err}`);
      return false;
    }
  }

  static async readMessages(sinceTimestamp?: string, isSync = false): Promise<IMessageData[]> {
    if (!this.checkAccess()) {
      throw new Error(
        'No access to iMessage database. Grant Full Disk Access in System Preferences.'
      );
    }

    const db = new Database(IMESSAGE_DB_PATH, { readonly: true });

    try {
      const hasAssociatedTextColumn = hasColumn(db, 'message', 'associated_message_text');
      const hasAttributedBodyColumn = hasColumn(db, 'message', 'attributedBody');
      const contentWhereClause =
        hasAssociatedTextColumn || hasAttributedBodyColumn
          ? `(m.text IS NOT NULL OR ${hasAssociatedTextColumn ? 'm.associated_message_text IS NOT NULL' : '0'} OR ${hasAttributedBodyColumn ? 'm.attributedBody IS NOT NULL' : '0'})`
          : 'm.text IS NOT NULL';

      // Add timestamp filter if provided
      const timestampClause = sinceTimestamp
        ? `AND m.date > ${isoToImessageTimestamp(sinceTimestamp)}`
        : '';

      const rawMessages = db
        .prepare(
          `
        SELECT 
          m.ROWID as id,
          m.text,
          m.date,
          m.is_from_me,
          ${hasAssociatedTextColumn ? 'm.associated_message_text' : 'NULL as associated_message_text'},
          ${hasAttributedBodyColumn ? 'm.attributedBody' : 'NULL as attributedBody'},
          h.id as handle_id,
          c.chat_identifier,
          COALESCE(c.display_name, h.id, c.chat_identifier) as contact_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE 
          ${contentWhereClause}
          AND (
            c.chat_identifier IS NULL 
            OR c.chat_identifier NOT LIKE 'chat%'
          )
          ${timestampClause}
        ORDER BY m.date DESC
      `
        )
        .all() as RawMessageRow[];

      console.log(`[IMessageReader] Read ${rawMessages.length} raw messages from database`);

      // Early return if no messages - skip contact loading
      if (rawMessages.length === 0) {
        return [];
      }

      let contactMap = new Map<string, ContactRecord>();
      try {
        contactMap = await ContactsReaderNative.readContacts();
        console.log(
          `[IMessageReader] Loaded ${contactMap.size} contact identifiers for enrichment`
        );
      } catch (error) {
        console.warn('[IMessageReader] Failed to load contacts for enrichment:', error);
      }

      const cleanedMessages: IMessageData[] = [];
      let skippedMissingHandle = 0;
      let skippedShortCode = 0;
      let skippedEmptyText = 0;

      for (const msg of rawMessages) {
        const contactId = normalizeHandle(msg.handle_id || msg.chat_identifier || '');
        if (!contactId || contactId === INVALID_HANDLE_SENTINEL) {
          skippedMissingHandle++;
          continue;
        }

        if (/^\d+$/.test(contactId) && contactId.length <= 8) {
          skippedShortCode++;
          continue;
        }

        let cleanedText = sanitizeMessageCandidate(msg.text, msg.id);

        if (
          (!cleanedText || !cleanedText.trim()) &&
          hasAssociatedTextColumn &&
          msg.associated_message_text
        ) {
          cleanedText = sanitizeMessageCandidate(msg.associated_message_text, msg.id, 'associated');
        }

        if (
          (!cleanedText || !cleanedText.trim()) &&
          hasAttributedBodyColumn &&
          msg.attributedBody
        ) {
          const decoded = extractTextFromAttributedBody(msg.attributedBody);
          cleanedText = sanitizeMessageCandidate(decoded, msg.id, 'attributed');
        }
        if (!cleanedText) {
          skippedEmptyText++;
          continue;
        }

        let contactName = msg.contact_name || contactId;
        const contactInfo = ContactsReaderNative.lookupContact(contactId, contactMap);
        if (contactInfo) {
          const fullName = [contactInfo.firstName, contactInfo.lastName]
            .filter(Boolean)
            .join(' ')
            .trim();
          if (fullName) {
            contactName = fullName;
          }
        }

        cleanedMessages.push({
          id: msg.id,
          text: cleanedText,
          date: msg.date,
          is_from_me: msg.is_from_me === 1,
          contact_id: contactId,
          contact_name: contactName,
          contact_firstName: contactInfo?.firstName || null,
          contact_lastName: contactInfo?.lastName || null,
          contact_email: contactInfo?.emails?.[0] || null,
          contact_company: contactInfo?.company || null,
          contact_title: contactInfo?.jobTitle || null,
          contact_emailAddresses: contactInfo?.emails || [],
        });
      }

      const fromUserCount = cleanedMessages.filter((m) => m.is_from_me).length;
      const fromOthersCount = cleanedMessages.length - fromUserCount;

      console.log(
        `[IMessageReader] ✅ Cleaned ${cleanedMessages.length}/${rawMessages.length} messages`
      );
      console.log(
        `[IMessageReader] 📊 Direction: ${fromUserCount} from user, ${fromOthersCount} from others`
      );
      if (skippedMissingHandle) {
        console.log(
          `[IMessageReader] ⚠️ Skipped ${skippedMissingHandle} messages missing a handle`
        );
      }
      if (skippedShortCode) {
        console.log(`[IMessageReader] ⚠️ Skipped ${skippedShortCode} short numeric handles`);
      }
      if (skippedEmptyText) {
        console.log(`[IMessageReader] ⚠️ Skipped ${skippedEmptyText} photo-only / empty messages`);
      }

      const repliedHandles = new Set<string>();
      const namedHandles = new Set<string>();
      for (const msg of cleanedMessages) {
        if (msg.is_from_me) {
          repliedHandles.add(msg.contact_id);
        }
        if (msg.contact_firstName || msg.contact_lastName) {
          namedHandles.add(msg.contact_id);
        }
      }

      // For sync operations, check if user has EVER replied to contacts in this batch
      // This prevents filtering out messages from contacts the user replied to historically
      if (isSync && cleanedMessages.length > 0) {
        const uniqueContactIds = [...new Set(cleanedMessages.map((m) => m.contact_id))];
        const placeholders = uniqueContactIds.map(() => '?').join(',');

        const historicalReplies = db
          .prepare(
            `
          SELECT DISTINCT h.id as handle_id
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE m.is_from_me = 1
            AND h.id IN (${placeholders})
        `
          )
          .all(...uniqueContactIds) as Array<{ handle_id: string }>;

        for (const row of historicalReplies) {
          const normalized = normalizeHandle(row.handle_id);
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
   * Convert IMessageData to NormalizedMessage format for unified processing.
   */
  static toNormalizedMessage(msg: IMessageData): NormalizedMessage {
    return {
      id: String(msg.id),
      text: msg.text,
      timestamp: appleTimestampToDate(msg.date),
      isFromMe: msg.is_from_me,
      chatId: msg.contact_id,
      contactId: msg.contact_id,
      contactName: msg.contact_name || undefined,
      channel: 'IMESSAGE',
      contact: {
        firstName: msg.contact_firstName || undefined,
        lastName: msg.contact_lastName || undefined,
        company: msg.contact_company || undefined,
        title: msg.contact_title || undefined,
        email: msg.contact_email || undefined,
        emailAddresses: msg.contact_emailAddresses,
      },
    };
  }

  /**
   * Convert array of IMessageData to NormalizedMessage format.
   */
  static toNormalizedMessages(messages: IMessageData[]): NormalizedMessage[] {
    return messages.map((msg) => this.toNormalizedMessage(msg));
  }

  /**
   * Read messages since a specific ROWID (for real-time sync).
   * Returns messages with ROWID > sinceRowId, ordered by date ascending.
   */
  static async readMessagesSinceRowId(sinceRowId: number): Promise<IMessageData[]> {
    if (!this.checkAccess()) {
      throw new Error(
        'No access to iMessage database. Grant Full Disk Access in System Preferences.'
      );
    }

    const db = new Database(IMESSAGE_DB_PATH, { readonly: true });

    try {
      const hasAssociatedTextColumn = hasColumn(db, 'message', 'associated_message_text');
      const hasAttributedBodyColumn = hasColumn(db, 'message', 'attributedBody');
      const contentWhereClause =
        hasAssociatedTextColumn || hasAttributedBodyColumn
          ? `(m.text IS NOT NULL OR ${hasAssociatedTextColumn ? 'm.associated_message_text IS NOT NULL' : '0'} OR ${hasAttributedBodyColumn ? 'm.attributedBody IS NOT NULL' : '0'})`
          : 'm.text IS NOT NULL';

      const rawMessages = db
        .prepare(
          `
        SELECT
          m.ROWID as id,
          m.text,
          m.date,
          m.is_from_me,
          ${hasAssociatedTextColumn ? 'm.associated_message_text' : 'NULL as associated_message_text'},
          ${hasAttributedBodyColumn ? 'm.attributedBody' : 'NULL as attributedBody'},
          h.id as handle_id,
          c.chat_identifier,
          COALESCE(c.display_name, h.id, c.chat_identifier) as contact_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE
          m.ROWID > ?
          AND ${contentWhereClause}
          AND (
            c.chat_identifier IS NULL
            OR c.chat_identifier NOT LIKE 'chat%'
          )
        ORDER BY m.date ASC
      `
        )
        .all(sinceRowId) as RawMessageRow[];

      if (rawMessages.length === 0) {
        return [];
      }

      console.log(
        `[IMessageReader] Real-time: Found ${rawMessages.length} new messages since ROWID ${sinceRowId}`
      );

      let contactMap = new Map<string, ContactRecord>();
      try {
        contactMap = await ContactsReaderNative.readContacts();
      } catch (error) {
        console.warn('[IMessageReader] Failed to load contacts for enrichment:', error);
      }

      const cleanedMessages: IMessageData[] = [];

      for (const msg of rawMessages) {
        const contactId = normalizeHandle(msg.handle_id || msg.chat_identifier || '');
        if (!contactId || contactId === INVALID_HANDLE_SENTINEL) {
          continue;
        }

        if (/^\d+$/.test(contactId) && contactId.length <= 8) {
          continue;
        }

        let cleanedText = sanitizeMessageCandidate(msg.text, msg.id);

        if (
          (!cleanedText || !cleanedText.trim()) &&
          hasAssociatedTextColumn &&
          msg.associated_message_text
        ) {
          cleanedText = sanitizeMessageCandidate(msg.associated_message_text, msg.id, 'associated');
        }

        if (
          (!cleanedText || !cleanedText.trim()) &&
          hasAttributedBodyColumn &&
          msg.attributedBody
        ) {
          const decoded = extractTextFromAttributedBody(msg.attributedBody);
          cleanedText = sanitizeMessageCandidate(decoded, msg.id, 'attributed');
        }

        if (!cleanedText) {
          continue;
        }

        let contactName = msg.contact_name || contactId;
        const contactInfo = ContactsReaderNative.lookupContact(contactId, contactMap);
        if (contactInfo) {
          const fullName = [contactInfo.firstName, contactInfo.lastName]
            .filter(Boolean)
            .join(' ')
            .trim();
          if (fullName) {
            contactName = fullName;
          }
        }

        cleanedMessages.push({
          id: msg.id,
          text: cleanedText,
          date: msg.date,
          is_from_me: msg.is_from_me === 1,
          contact_id: contactId,
          contact_name: contactName,
          contact_firstName: contactInfo?.firstName || null,
          contact_lastName: contactInfo?.lastName || null,
          contact_email: contactInfo?.emails?.[0] || null,
          contact_company: contactInfo?.company || null,
          contact_title: contactInfo?.jobTitle || null,
          contact_emailAddresses: contactInfo?.emails || [],
        });
      }

      return cleanedMessages;
    } finally {
      db.close();
    }
  }

  /**
   * Get the maximum ROWID from the message table (for initializing real-time watcher).
   */
  static getMaxRowId(): number {
    if (!this.checkAccess()) {
      return 0;
    }

    const db = new Database(IMESSAGE_DB_PATH, { readonly: true });
    try {
      const result = db.prepare('SELECT MAX(ROWID) as maxId FROM message').get() as
        | { maxId: number }
        | undefined;
      return result?.maxId ?? 0;
    } finally {
      db.close();
    }
  }
}
