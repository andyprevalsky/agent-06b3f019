/**
 * i-message-sync — account gate and real-time uploads.
 *
 *   rows (one per Mac + legacy '') ──► decideGate ──► run(connect | sync) | skip
 *     connect trigger ............... run (sync when this Mac's row exists)
 *     this Mac's row ................ run sync (unless NOT_CONNECTED / freshly SYNCING)
 *     removed by the user ........... skip until the user connects again
 *     row seen before, now missing .. run sync: the backend's 410 decides removal
 *     legacy row / another Mac ...... run connect (claims the legacy row / joins)
 *
 * The backend, not a cached list, is the authority on removal: a `sync` upload
 * for a removed Mac answers 410 and recreates nothing.
 */

import { MessageTransformer } from '../../services/messaging/MessageTransformer';
import { STALE_SYNC_THRESHOLD_MS } from './config';
import {
  checkIMessageAccess,
  deviceAccount,
  getIMessageAccounts,
  getMaxIMessageRowId,
  getSession,
  readIMessagesSinceRowId,
  sessionUserId,
  toNormalizedMessages,
  uploadDeviceBatch,
} from './repo';
import { loadUserState, markAccountRemoved } from './service.state';
import type {
  AccountMode,
  DeviceSyncState,
  Integration,
  NormalizedMessage,
  SyncEvent,
  SyncTrigger,
} from './types';

export type Gate =
  { kind: 'run'; mode: AccountMode; accountConfirmed: boolean } | { kind: 'skip'; reason: string };

const accountOf = (row: Integration): string => row.accountId ?? '';

/** Null to proceed, or why a scheduled sync must not use this row now. */
function rowSkipReason(row: Integration): string | null {
  if (row.status === 'NOT_CONNECTED') return 'integration not connected';
  if (row.status !== 'SYNCING' || row.lastSyncAt === null || row.lastSyncAt === undefined) {
    return null;
  }
  const lastSyncAge = Date.now() - new Date(row.lastSyncAt).getTime();
  if (lastSyncAge < STALE_SYNC_THRESHOLD_MS) {
    return `already syncing (last sync ${Math.round(lastSyncAge / 60000)}m ago)`;
  }
  console.log(
    `[IMessageSync] Re-syncing - SYNCING status stale (last sync ${Math.round(lastSyncAge / 60000)}m ago)`
  );
  return null;
}

export function decideGate(
  rows: Integration[],
  accountId: string,
  state: DeviceSyncState,
  trigger: SyncTrigger
): Gate {
  const own = rows.find((row) => accountOf(row) === accountId);
  if (trigger === 'connect') {
    return { kind: 'run', mode: own ? 'sync' : 'connect', accountConfirmed: own !== undefined };
  }
  if (own !== undefined) {
    const reason = rowSkipReason(own);
    return reason === null
      ? { kind: 'run', mode: 'sync', accountConfirmed: true }
      : { kind: 'skip', reason };
  }
  if (state.removed) return { kind: 'skip', reason: "this Mac's iMessage account was removed" };
  if (state.established) return { kind: 'run', mode: 'sync', accountConfirmed: false };
  const legacy = rows.find((row) => accountOf(row) === '');
  if (legacy !== undefined) {
    const reason = rowSkipReason(legacy);
    return reason === null
      ? { kind: 'run', mode: 'connect', accountConfirmed: false }
      : { kind: 'skip', reason };
  }
  if (rows.some((row) => row.status !== 'NOT_CONNECTED')) {
    return { kind: 'run', mode: 'connect', accountConfirmed: false };
  }
  return { kind: 'skip', reason: 'integration not found' };
}

/** This Mac's own iMessage account row is present and connected. */
export async function isOwnAccountConnected(): Promise<boolean> {
  const { id } = deviceAccount();
  const rows = await getIMessageAccounts();
  return rows.some((row) => accountOf(row) === id && row.status !== 'NOT_CONNECTED');
}

/**
 * Upload real-time messages to this Mac's account (`sync` mode: never creates
 * it). Returns true on success. Never throws.
 */
export async function uploadNormalizedMessages(messages: NormalizedMessage[]): Promise<boolean> {
  const session = await getSession();
  if (!session) {
    console.log('[IMessageSync] Skipping upload - not authenticated');
    return false;
  }
  const account = deviceAccount();
  const contacts = MessageTransformer.toContactWithMessages(messages);
  const stats = MessageTransformer.getStats(messages);
  console.log(
    `[IMessageSync] Uploading ${stats.total} messages from ${stats.uniqueContacts} contacts`
  );
  const result = await uploadDeviceBatch(contacts, session.access_token, {
    ...account,
    mode: 'sync',
  });
  const userId = sessionUserId(session);
  if (result.accountRemoved && userId !== null) {
    markAccountRemoved(loadUserState(userId, account.id));
    console.log("[IMessageSync] This Mac's iMessage account was removed; real-time upload dropped");
  }
  return result.success;
}

/**
 * Query new messages since a tracked ROWID, normalize them, and return the
 * normalized batch plus the new max ROWID observed (or the input when empty).
 */
export async function fetchNewMessagesSinceRowId(
  lastSyncRowId: number
): Promise<{ messages: NormalizedMessage[]; newMaxRowId: number }> {
  const rawMessages = await readIMessagesSinceRowId(lastSyncRowId);

  let newMaxRowId = lastSyncRowId;
  if (rawMessages.length > 0) {
    const maxId = Math.max(...rawMessages.map((m) => m.id));
    if (maxId > newMaxRowId) newMaxRowId = maxId;
  }

  return { messages: toNormalizedMessages(rawMessages), newMaxRowId };
}

/**
 * Handle a single real-time sync event: upload new messages when this Mac's
 * account is connected. Errors (connection, upload) are logged.
 */
export async function handleSyncEvent(event: SyncEvent): Promise<void> {
  if (event.type === 'error') {
    console.error('[IMessageSync] Real-time watcher error:', event.error);
    return;
  }
  if (
    event.type !== 'new_messages' ||
    event.messages === undefined ||
    event.messages.length === 0
  ) {
    return;
  }
  if (!(await isOwnAccountConnected())) {
    console.log("[IMessageSync] Real-time: skipping upload - this Mac's account is not connected");
    return;
  }
  console.log(`[IMessageSync] Real-time: ${event.messages.length} new message(s) detected`);
  const success = await uploadNormalizedMessages(event.messages);
  if (success) {
    console.log('[IMessageSync] Real-time: upload complete');
  } else {
    console.error('[IMessageSync] Real-time: upload failed');
  }
}

/** Real-time sync needs chat.db access (the caller also checks watcher state). */
export function canStartRealTimeSync(): boolean {
  if (!checkIMessageAccess()) {
    console.log('[IMessageSync] Cannot start real-time sync - no iMessage access');
    return false;
  }
  return true;
}

/** Initial ROWID for real-time sync (max currently in DB — avoids re-syncing). */
export function initialRealTimeRowId(): number {
  const rowId = getMaxIMessageRowId();
  console.log(`[IMessageSync] Initializing real-time sync from ROWID ${rowId}`);
  return rowId;
}
