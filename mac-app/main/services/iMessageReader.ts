import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { IMessageData } from '../../shared/types/ipc';
import { ContactsReaderNative, ContactRecord } from './contactsReaderNative';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bplistParser = require('bplist-parser') as {
  parseBuffer: (buffer: Buffer) => any[];
};

const IMESSAGE_DB_PATH = path.join(
  app.getPath('home'),
  'Library/Messages/chat.db'
);

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
  const exists = info.some(col => col.name === column);
  columnPresenceCache.set(cacheKey, exists);
  return exists;
};

const stripControlCharacters = (value: string) =>
  value
    .replace(/\u0000/g, '')
    .replace(/\uFFFC/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
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
  result = value.split(startDelimiter)[1]
  result = result.substring(1);
  // Remove all leading '�' characters until a non-'�' character is seen
  let firstNonReplacementChar = 0;
  while (result[firstNonReplacementChar] === '�') {
    firstNonReplacementChar++;
  }
  if (firstNonReplacementChar > 0) {
    result = result.substring(firstNonReplacementChar);
  }
  result = result.split(endDelimiter)[0]

  result = stripControlCharacters(result);
  result = stripLeadingMarkers(result);
  return result.trim();
};

const sanitizeMessageCandidate = (
  candidate: unknown,
  messageId: number,
  source: 'text' | 'associated' | 'attributed' = 'text'
): string | null => {
  if (candidate == null) return null;
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

  return normalized
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
    const archive = parsed[0];
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
      .map(candidate => stripLeadingMarkers(stripControlCharacters(candidate)))
      .filter(Boolean);

    if (cleanedCandidates.length) {
      cleanedCandidates.sort((a, b) => b.length - a.length);
      return cleanedCandidates[0] || null;
    }

    const searchValue = (value: any, depth = 0): string | null => {
      if (!value || depth > 5) return null;
      if (typeof value === 'string' && value.trim()) {
        return stripLeadingMarkers(stripControlCharacters(value));
      }

      if (value.NS && typeof value.NS.string === 'string') {
        return stripLeadingMarkers(stripControlCharacters(value.NS.string));
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const result = searchValue(item, depth + 1);
          if (result) return result;
        }
      } else if (typeof value === 'object') {
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

export class IMessageReader {
  static checkAccess(): boolean {
    try {
      fs.accessSync(IMESSAGE_DB_PATH, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
  
  static async readMessages(): Promise<IMessageData[]> {
    if (!this.checkAccess()) {
      throw new Error('No access to iMessage database. Grant Full Disk Access in System Preferences.');
    }
    
    const db = new Database(IMESSAGE_DB_PATH, { readonly: true });
    
    try {
      const hasAssociatedTextColumn = hasColumn(db, 'message', 'associated_message_text');
      const hasAttributedBodyColumn = hasColumn(db, 'message', 'attributedBody');
      const contentWhereClause = hasAssociatedTextColumn || hasAttributedBodyColumn
        ? `(m.text IS NOT NULL OR ${hasAssociatedTextColumn ? 'm.associated_message_text IS NOT NULL' : '0'} OR ${hasAttributedBodyColumn ? 'm.attributedBody IS NOT NULL' : '0'})`
        : 'm.text IS NOT NULL';
      
      const rawMessages = db.prepare(`
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
        ORDER BY m.date DESC
      `).all() as RawMessageRow[];

      console.log(`[IMessageReader] Read ${rawMessages.length} raw messages from database`);

      let contactMap = new Map<string, ContactRecord>();
      try {
        contactMap = await ContactsReaderNative.readContacts();
        console.log(`[IMessageReader] Loaded ${contactMap.size} contact identifiers for enrichment`);
      } catch (error) {
        console.warn('[IMessageReader] Failed to load contacts for enrichment:', error);
      }

      const cleanedMessages: IMessageData[] = [];
      let skippedMissingHandle = 0;
      let skippedShortCode = 0;
      let skippedEmptyText = 0;

      for (const msg of rawMessages) {
        let contactId = normalizeHandle(msg.handle_id || msg.chat_identifier || '');
        if (!contactId || contactId === INVALID_HANDLE_SENTINEL) {
          skippedMissingHandle++;
          continue;
        }

        if (/^\d+$/.test(contactId) && contactId.length <= 8) {
          skippedShortCode++;
          continue;
        }

        let source = 'text';
        let cleanedText = sanitizeMessageCandidate(msg.text, msg.id);
        
        if ((!cleanedText || !cleanedText.trim()) && hasAssociatedTextColumn && msg.associated_message_text) {
          source = 'associated';
          cleanedText = sanitizeMessageCandidate(msg.associated_message_text, msg.id, 'associated');
        }

        if ((!cleanedText || !cleanedText.trim()) && hasAttributedBodyColumn && msg.attributedBody) {
          source = 'attributed';
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
          const fullName = [contactInfo.firstName, contactInfo.lastName].filter(Boolean).join(' ').trim();
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

      const fromUserCount = cleanedMessages.filter(m => m.is_from_me).length;
      const fromOthersCount = cleanedMessages.length - fromUserCount;

      console.log(`[IMessageReader] ✅ Cleaned ${cleanedMessages.length}/${rawMessages.length} messages`);
      console.log(`[IMessageReader] 📊 Direction: ${fromUserCount} from user, ${fromOthersCount} from others`);
      if (skippedMissingHandle) {
        console.log(`[IMessageReader] ⚠️ Skipped ${skippedMissingHandle} messages missing a handle`);
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

      const filteredMessages = cleanedMessages.filter(
        msg => repliedHandles.has(msg.contact_id) || namedHandles.has(msg.contact_id)
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
}

