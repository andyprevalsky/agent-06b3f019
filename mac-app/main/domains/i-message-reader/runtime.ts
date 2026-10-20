/**
 * i-message-reader — runtime layer
 *
 * Thin public entry for the iMessage reader domain. Exposes the
 * {@link IMessageReader} static class, which the app wiring
 * (main/index.ts, main/handlers/registry.ts) and the i-message-sync domain
 * call into.
 *
 * Layer rule: runtime imports own service + own types only. No raw data access,
 * no inline business logic.
 */

import {
  checkAccess,
  getMaxRowId,
  readMessages,
  readMessagesSinceRowId,
  toNormalizedMessage,
  toNormalizedMessages,
} from './service';
import {
  countMessageRows,
  loadSyncContacts,
  readMessageBatch,
  type MessageBatch,
  type MessageBatchWindow,
} from './service.batch';
import type { ContactRecord, IMessageData, NormalizedMessage } from './types';

export type { MessageBatch, MessageBatchWindow };

/**
 * Reads and cleans messages from the local macOS iMessage database
 * (~/Library/Messages/chat.db) and enriches them with macOS Contacts data.
 */
export class IMessageReader {
  /** Probe whether the process can open chat.db. */
  static checkAccess(): boolean {
    return checkAccess();
  }

  /**
   * Read and clean recent iMessages.
   *
   * @param sinceTimestamp ISO-8601 timestamp; only messages newer than this are returned.
   * @param isSync         When true, includes contacts the user ever replied to historically.
   */
  static async readMessages(sinceTimestamp?: string, isSync = false): Promise<IMessageData[]> {
    return readMessages(sinceTimestamp, isSync);
  }

  /** Convert a raw IMessageData row to the platform-neutral NormalizedMessage shape. */
  static toNormalizedMessage(msg: IMessageData): NormalizedMessage {
    return toNormalizedMessage(msg);
  }

  /** Convert an array of IMessageData rows to NormalizedMessage format. */
  static toNormalizedMessages(messages: IMessageData[]): NormalizedMessage[] {
    return toNormalizedMessages(messages);
  }

  /** Read iMessages with ROWID > sinceRowId (real-time watcher path). */
  static async readMessagesSinceRowId(sinceRowId: number): Promise<IMessageData[]> {
    return readMessagesSinceRowId(sinceRowId);
  }

  /** Max ROWID in the message table, or 0 when access is denied. */
  static getMaxRowId(): number {
    return getMaxRowId();
  }

  /** Message rows after `afterRowId` (the run total) and the current MAX(ROWID). */
  static countMessageRows(afterRowId: number): { total: number; maxRowId: number } {
    return countMessageRows(afterRowId);
  }

  /** Native contacts for enrichment, loaded once per batched sync run. */
  static async loadSyncContacts(): Promise<Map<string, ContactRecord>> {
    return loadSyncContacts();
  }

  /** One batch window of the device sync (ROWID order). */
  static readMessageBatch(
    window: MessageBatchWindow,
    contactMap: Map<string, ContactRecord>
  ): MessageBatch {
    return readMessageBatch(window, contactMap);
  }
}
