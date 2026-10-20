/**
 * i-message-reader — service sub-layer: batched reads for the device sync.
 *
 *   countMessageRows(after) ──► { total, maxRowId }        (before a run starts)
 *   readMessageBatch(window) ─► window rows (ROWID order) ─► clean + filter
 *                               └─► { messages, scanned, lastRowId }
 *
 * `scanned` counts every message row in the window, including the rows the
 * content filter drops, so done/total track the cursor over chat.db exactly.
 */

import { INVALID_HANDLE_SENTINEL } from './config';
import {
  checkDbAccess,
  openImessageDb,
  probeMessageColumns,
  queryHistoricalReplyHandles,
  queryMaxRowId,
  queryMessageRowCount,
  queryMessagesInRowRange,
  queryRowIdWindow,
  readContacts,
} from './repo';
import { cleanRow, isLikelyOtpMessage, normalizeHandle } from './service.clean';
import type { ContactRecord, IMessageData } from './types';

export interface MessageBatchWindow {
  /** Exclusive lower ROWID bound (the cursor). */
  afterRowId: number;
  /** Inclusive upper ROWID bound (the run's snapshot of MAX(ROWID)). */
  upToRowId: number;
  /** Maximum message rows scanned in this batch. */
  limit: number;
}

export interface MessageBatch {
  messages: IMessageData[];
  /** Message rows the window spans (kept or dropped). */
  scanned: number;
  /** Last ROWID in the window; equals afterRowId when the window is empty. */
  lastRowId: number;
}

function assertAccess(): void {
  if (!checkDbAccess()) {
    throw new Error(
      'No access to iMessage database. Grant Full Disk Access in System Preferences.'
    );
  }
}

/** Message rows after `afterRowId`, counted once before a sync run starts. */
export function countMessageRows(afterRowId: number): { total: number; maxRowId: number } {
  assertAccess();
  const db = openImessageDb();
  try {
    const maxRowId = queryMaxRowId(db);
    if (maxRowId <= afterRowId) return { total: 0, maxRowId };
    return { total: queryMessageRowCount(db, afterRowId, maxRowId), maxRowId };
  } finally {
    db.close();
  }
}

/** Native contacts for enrichment, loaded once per sync run. */
export async function loadSyncContacts(): Promise<Map<string, ContactRecord>> {
  try {
    return await readContacts();
  } catch (error) {
    console.warn('[IMessageReader] Failed to load contacts for enrichment:', error);
    return new Map<string, ContactRecord>();
  }
}

/**
 * Same keep rule as a full read: contacts the user replied to (in this batch
 * or ever, from chat.db), contacts with a name, and verification texts.
 */
function keepRepliedNamedOrOtp(
  db: ReturnType<typeof openImessageDb>,
  cleaned: IMessageData[]
): IMessageData[] {
  const keep = new Set<string>();
  for (const msg of cleaned) {
    const named =
      (msg.contact_firstName !== null && msg.contact_firstName !== '') ||
      (msg.contact_lastName !== null && msg.contact_lastName !== '');
    if (msg.is_from_me || named) keep.add(msg.contact_id);
  }
  const unknown = [...new Set(cleaned.map((m) => m.contact_id))].filter((id) => !keep.has(id));
  for (const handle of queryHistoricalReplyHandles(db, unknown)) {
    const normalized = normalizeHandle(handle);
    if (normalized !== INVALID_HANDLE_SENTINEL) keep.add(normalized);
  }
  return cleaned.filter((msg) => keep.has(msg.contact_id) || isLikelyOtpMessage(msg.text));
}

/** One batch window: cleaned, enriched, filtered messages plus cursor facts. */
export function readMessageBatch(
  window: MessageBatchWindow,
  contactMap: Map<string, ContactRecord>
): MessageBatch {
  assertAccess();
  const db = openImessageDb();
  try {
    const { scanned, lastRowId } = queryRowIdWindow(
      db,
      window.afterRowId,
      window.upToRowId,
      window.limit
    );
    if (scanned === 0 || lastRowId === null) {
      return { messages: [], scanned: 0, lastRowId: window.afterRowId };
    }
    const columns = probeMessageColumns(db);
    const cleaned: IMessageData[] = [];
    for (const row of queryMessagesInRowRange(db, columns, window.afterRowId, lastRowId)) {
      const message = cleanRow(row, { columns, contactMap });
      if (message !== null) cleaned.push(message);
    }
    return { messages: keepRepliedNamedOrOtp(db, cleaned), scanned, lastRowId };
  } finally {
    db.close();
  }
}
