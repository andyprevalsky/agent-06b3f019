/**
 * i-message-reader — repo layer
 *
 * Sole data-access consumer for the iMessage reader domain. Wraps the
 * better-sqlite3 chat.db reader, the fs-based access probe (which doubles
 * as TCC-registration for Full Disk Access), and the native Contacts boundary.
 *
 * Layer rule: repo imports own types, own config, and providers/* equivalents
 * (better-sqlite3, fs, ContactsReaderNative). No business logic — queries
 * return typed raw rows and the service layer transforms them.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import { ContactsReaderNative } from '../../services/contactsReaderNative';
import { IMESSAGE_DB_PATH } from './config';
import type { ContactRecord, MessageColumnPresence, RawMessageRow } from './types';

/**
 * Module-scoped memoisation for PRAGMA table_info lookups. Keyed as
 * `<table>.<column>`; survives across reader invocations and is only reset
 * by vitest's `resetModules()` in tests.
 */
const columnPresenceCache = new Map<string, boolean>();

/**
 * Probe whether the process can open chat.db. Uses openSync+closeSync (not
 * accessSync) — actually opening the file triggers macOS TCC registration so
 * the app appears in Full Disk Access settings.
 */
export function checkDbAccess(): boolean {
  try {
    console.log(`[IMessageReader] Checking access to: ${IMESSAGE_DB_PATH}`);
    const fd = fs.openSync(IMESSAGE_DB_PATH, 'r');
    fs.closeSync(fd);
    console.log('[IMessageReader] ✅ Access granted');
    return true;
  } catch (err) {
    console.log(`[IMessageReader] ❌ Access denied: ${err}`);
    return false;
  }
}

/**
 * Open a read-only better-sqlite3 handle to chat.db.
 */
export function openImessageDb(): Database.Database {
  return new Database(IMESSAGE_DB_PATH, { readonly: true });
}

/**
 * Return whether `table.column` exists on the open DB, caching the result.
 */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cacheKey = `${table}.${column}`;
  const cached = columnPresenceCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = info.some((col) => col.name === column);
  columnPresenceCache.set(cacheKey, exists);
  return exists;
}

/**
 * Probe the optional columns we depend on for rich-message extraction.
 */
export function probeMessageColumns(db: Database.Database): MessageColumnPresence {
  return {
    hasAssociatedTextColumn: hasColumn(db, 'message', 'associated_message_text'),
    hasAttributedBodyColumn: hasColumn(db, 'message', 'attributedBody'),
  };
}

/**
 * Build the text-content WHERE fragment, respecting which optional columns exist.
 */
function buildContentWhereClause(columns: MessageColumnPresence): string {
  const { hasAssociatedTextColumn, hasAttributedBodyColumn } = columns;
  if (!hasAssociatedTextColumn && !hasAttributedBodyColumn) {
    return 'm.text IS NOT NULL';
  }
  return `(m.text IS NOT NULL OR ${
    hasAssociatedTextColumn ? 'm.associated_message_text IS NOT NULL' : '0'
  } OR ${hasAttributedBodyColumn ? 'm.attributedBody IS NOT NULL' : '0'})`;
}

/**
 * Build the SELECT-list fragment for optional columns — NULL literals stand
 * in for columns that don't exist on older macOS chat.db schemas.
 */
function buildOptionalColumnProjection(columns: MessageColumnPresence): string {
  const assoc = columns.hasAssociatedTextColumn
    ? 'm.associated_message_text'
    : 'NULL as associated_message_text';
  const attr = columns.hasAttributedBodyColumn ? 'm.attributedBody' : 'NULL as attributedBody';
  return `${assoc},\n          ${attr}`;
}

/**
 * Fetch recent messages, optionally filtered by a nanosecond Apple-epoch
 * timestamp lower bound. Ordered newest-first.
 */
export function queryMessages(
  db: Database.Database,
  columns: MessageColumnPresence,
  sinceAppleTimestamp: number | null
): RawMessageRow[] {
  const contentWhereClause = buildContentWhereClause(columns);
  const optionalProjection = buildOptionalColumnProjection(columns);
  const timestampClause = sinceAppleTimestamp !== null ? `AND m.date > ${sinceAppleTimestamp}` : '';

  return db
    .prepare(
      `
        SELECT
          m.ROWID as id,
          m.text,
          m.date,
          m.is_from_me,
          ${optionalProjection},
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
}

/**
 * Fetch messages with ROWID > sinceRowId, oldest-first — the real-time
 * watcher path.
 */
export function queryMessagesSinceRowId(
  db: Database.Database,
  columns: MessageColumnPresence,
  sinceRowId: number
): RawMessageRow[] {
  const contentWhereClause = buildContentWhereClause(columns);
  const optionalProjection = buildOptionalColumnProjection(columns);

  return db
    .prepare(
      `
        SELECT
          m.ROWID as id,
          m.text,
          m.date,
          m.is_from_me,
          ${optionalProjection},
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
}

/**
 * Number of message rows with afterRowId < ROWID <= upToRowId: the `total`
 * a batched sync reports. Counts every row (group chats, reactions and
 * attachment-only rows included) because the batch cursor scans every row.
 */
export function queryMessageRowCount(
  db: Database.Database,
  afterRowId: number,
  upToRowId: number
): number {
  const result = db
    .prepare('SELECT COUNT(*) AS total FROM message WHERE ROWID > ? AND ROWID <= ?')
    .get(afterRowId, upToRowId) as { total: number | null } | undefined;
  return result?.total ?? 0;
}

/**
 * The next batch window: up to `limit` message rows after `afterRowId` (ROWID
 * order, bounded by `upToRowId`). Returns how many rows it spans and its last
 * ROWID, so the cursor advances over rows the content filter drops too.
 */
export function queryRowIdWindow(
  db: Database.Database,
  afterRowId: number,
  upToRowId: number,
  limit: number
): { scanned: number; lastRowId: number | null } {
  const result = db
    .prepare(
      `SELECT COUNT(*) AS scanned, MAX(id) AS lastRowId FROM (
         SELECT ROWID AS id FROM message
         WHERE ROWID > ? AND ROWID <= ?
         ORDER BY ROWID ASC
         LIMIT ?
       )`
    )
    .get(afterRowId, upToRowId, limit) as
    { scanned: number | null; lastRowId: number | null } | undefined;
  return { scanned: result?.scanned ?? 0, lastRowId: result?.lastRowId ?? null };
}

/**
 * Content rows of one batch window (afterRowId < ROWID <= lastRowId), with the
 * same projection and content/group-chat filters as the other readers.
 */
export function queryMessagesInRowRange(
  db: Database.Database,
  columns: MessageColumnPresence,
  afterRowId: number,
  lastRowId: number
): RawMessageRow[] {
  const contentWhereClause = buildContentWhereClause(columns);
  const optionalProjection = buildOptionalColumnProjection(columns);

  return db
    .prepare(
      `
        SELECT
          m.ROWID as id,
          m.text,
          m.date,
          m.is_from_me,
          ${optionalProjection},
          h.id as handle_id,
          c.chat_identifier,
          COALESCE(c.display_name, h.id, c.chat_identifier) as contact_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE
          m.ROWID > ? AND m.ROWID <= ?
          AND ${contentWhereClause}
          AND (
            c.chat_identifier IS NULL
            OR c.chat_identifier NOT LIKE 'chat%'
          )
        ORDER BY m.ROWID ASC
      `
    )
    .all(afterRowId, lastRowId) as RawMessageRow[];
}

/**
 * Max ROWID currently in the message table (used by the real-time watcher
 * to seed its high-water mark).
 */
export function queryMaxRowId(db: Database.Database): number {
  const result = db.prepare('SELECT MAX(ROWID) as maxId FROM message').get() as
    { maxId: number | null } | undefined;
  return result?.maxId ?? 0;
}

/**
 * Return the set of handle_ids the user has EVER sent a message to, scoped
 * to the provided candidate list. Empty input → empty result (caller must
 * skip the round-trip).
 */
export function queryHistoricalReplyHandles(db: Database.Database, contactIds: string[]): string[] {
  if (contactIds.length === 0) return [];
  const placeholders = contactIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
          SELECT DISTINCT h.id as handle_id
          FROM message m
          JOIN handle h ON m.handle_id = h.ROWID
          WHERE m.is_from_me = 1
            AND h.id IN (${placeholders})
        `
    )
    .all(...contactIds) as Array<{ handle_id: string }>;
  return rows.map((row) => row.handle_id);
}

/**
 * Load the native macOS contact map for enrichment.
 */
export async function readContacts(): Promise<Map<string, ContactRecord>> {
  return ContactsReaderNative.readContacts();
}

/**
 * Look up a single contact by identifier against the supplied map.
 */
export function lookupContact(
  contactId: string,
  contactMap: Map<string, ContactRecord>
): ContactRecord | undefined {
  return ContactsReaderNative.lookupContact(contactId, contactMap);
}
