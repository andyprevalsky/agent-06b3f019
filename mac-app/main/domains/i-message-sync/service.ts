import { MessageTransformer } from '../../services/messaging/MessageTransformer';
import { STALE_SYNC_THRESHOLD_MS, UPLOAD_CHUNK_MESSAGES } from './config';
import {
  checkIMessageAccess,
  getIntegration,
  getMaxIMessageRowId,
  getSession,
  isIntegrationConnected,
  readIMessages,
  readIMessagesSinceRowId,
  startImessageProgressRun,
  toNormalizedMessages,
  uploadImessagePayload,
} from './repo';
import type { IntegrationConfig, NormalizedMessage, SyncEvent } from './types';

const INTEGRATION_NAME = 'imessage';

/** Largest ROWID in a batch. A loop, not Math.max(...ids): spreading ~125k+ ids overflows the stack. */
function maxRowId(ids: Iterable<number>, floor: number): number {
  let max = floor;
  for (const id of ids) if (id > max) max = id;
  return max;
}

/**
 * True if the iMessage integration is currently marked connected in cache.
 */
export async function isConnected(): Promise<boolean> {
  return isIntegrationConnected(INTEGRATION_NAME);
}

/**
 * Upload normalized messages to the backend. Returns true on success, false if
 * unauthenticated or the uploader reports failure. Never throws.
 */
export async function uploadNormalizedMessages(messages: NormalizedMessage[]): Promise<boolean> {
  const session = await getSession();
  if (!session) {
    console.log('[IMessageSync] Skipping upload - not authenticated');
    return false;
  }

  const contacts = MessageTransformer.toContactWithMessages(messages);
  const stats = MessageTransformer.getStats(messages);

  console.log(
    `[IMessageSync] Uploading ${stats.total} messages from ${stats.uniqueContacts} contacts`
  );

  const result = await uploadImessagePayload(contacts, session.access_token);
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

  const newMaxRowId = maxRowId(
    rawMessages.map((m) => m.id),
    lastSyncRowId
  );
  return { messages: toNormalizedMessages(rawMessages), newMaxRowId };
}

/**
 * Handle a single real-time sync event: upload new messages when the
 * integration is still connected. Errors (connection, upload) are logged.
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

  const connected = await isConnected();
  if (!connected) {
    console.log('[IMessageSync] Real-time: skipping upload - integration not connected');
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

/**
 * Can a real-time sync start right now? (access gated; caller also inspects the
 * watcher's active state before actually starting it.)
 */
export function canStartRealTimeSync(): boolean {
  if (!checkIMessageAccess()) {
    console.log('[IMessageSync] Cannot start real-time sync - no iMessage access');
    return false;
  }
  return true;
}

/**
 * Initial ROWID for real-time sync (max currently in DB — avoids re-syncing).
 */
export function initialRealTimeRowId(): number {
  const rowId = getMaxIMessageRowId();
  console.log(`[IMessageSync] Initializing real-time sync from ROWID ${rowId}`);
  return rowId;
}

interface SyncResult {
  /** True if the reader + uploader ran to completion and upload succeeded. */
  uploaded: boolean;
  /** Max ROWID observed among uploaded messages (for bumping the watcher cursor). */
  newMaxRowId: number | null;
}

/**
 * Decide whether a scheduled sync should run now. Returns null to proceed or a
 * reason string to skip.
 */
function shouldSkipScheduledSync(
  integration: { status: string; lastSyncAt?: string | null } | undefined
): string | null {
  if (!integration || integration.status === 'NOT_CONNECTED') {
    return 'integration not found';
  }
  if (integration.status !== 'SYNCING') return null;
  if (integration.lastSyncAt === null || integration.lastSyncAt === undefined) return null;

  const lastSyncAge = Date.now() - new Date(integration.lastSyncAt).getTime();
  if (lastSyncAge < STALE_SYNC_THRESHOLD_MS) {
    return `already syncing (last sync ${Math.round(lastSyncAge / 60000)}m ago)`;
  }
  console.log(
    `[IMessageSync] Re-syncing - SYNCING status stale (last sync ${Math.round(lastSyncAge / 60000)}m ago)`
  );
  return null;
}

/**
 * Full sync: gated by auth + access + integration state, reads messages
 * (incrementally when possible), uploads, and returns the outcome. Errors are
 * caught and logged — this never throws.
 */
export async function runFullSync(): Promise<SyncResult> {
  const session = await getSession();
  if (!session) {
    console.log('[IMessageSync] Skipping sync - not authenticated');
    return { uploaded: false, newMaxRowId: null };
  }

  if (!checkIMessageAccess()) {
    console.log('[IMessageSync] Skipping sync - no iMessage access');
    return { uploaded: false, newMaxRowId: null };
  }

  // Sync progress: messages uploaded of the messages read from chat.db this run.
  let progress: ReturnType<typeof startImessageProgressRun> | null = null;
  try {
    const integration = await getIntegration(INTEGRATION_NAME);
    const skipReason = shouldSkipScheduledSync(integration);
    if (skipReason !== null) {
      console.log(`[IMessageSync] Skipping sync - ${skipReason}`);
      return { uploaded: false, newMaxRowId: null };
    }

    const integrationConfig = integration?.config as IntegrationConfig | undefined;
    const lastAccessedAt = integrationConfig?.lastFrontendAccessAt;
    const isIncrementalSync = lastAccessedAt !== undefined && lastAccessedAt !== '';

    console.log(
      `[IMessageSync] Reading messages${isIncrementalSync ? ` since ${lastAccessedAt}` : ' (full sync)'}`
    );
    const syncStartedAt = new Date().toISOString();
    const messages = await readIMessages(lastAccessedAt, isIncrementalSync);

    if (messages.length === 0) {
      console.log('[IMessageSync] No new messages to sync');
      return { uploaded: false, newMaxRowId: null };
    }

    console.log(`[IMessageSync] Found ${messages.length} new messages, uploading...`);
    progress = startImessageProgressRun();
    const total = messages.length;
    const token = session.access_token;
    await progress.report({ state: 'syncing', unit: 'messages', done: 0, total }, token);
    // Bounded requests; every one carries the sync start as its cursor and only
    // the last marks the sync complete, so a failure part-way resumes from the
    // previous cursor instead of skipping the history that was never sent.
    const accessedAt = syncStartedAt;
    for (let start = 0; start < total; start += UPLOAD_CHUNK_MESSAGES) {
      const end = Math.min(start + UPLOAD_CHUNK_MESSAGES, total);
      const result = await uploadImessagePayload(messages.slice(start, end), token, {
        accessedAt,
        syncComplete: end === total,
      });
      if (!result.success) {
        console.error('[IMessageSync] Sync failed:', result.message);
        await progress.report({ state: 'failed', error: result.message ?? 'Upload failed' }, token);
        return { uploaded: false, newMaxRowId: null };
      }
      if (end < total) await progress.report({ state: 'syncing', done: end }, token);
    }

    await progress.report({ state: 'synced', done: total }, token);
    console.log('[IMessageSync] Sync complete');
    const newMaxRowId = maxRowId(
      messages.map((m) => m.id),
      0
    );
    return { uploaded: true, newMaxRowId };
  } catch (error) {
    console.error('[IMessageSync] Error during sync:', error);
    await progress?.report({ state: 'failed', error: String(error) }, session.access_token);
    return { uploaded: false, newMaxRowId: null };
  }
}
