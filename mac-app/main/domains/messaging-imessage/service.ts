/**
 * messaging-imessage: service layer
 *
 * `IMessageWatcher` — debounces `fs.watch` change events on `~/Library/Messages/chat.db`,
 * drives an injected `queryNewMessages` callback on each burst, and emits `sync`
 * events consumed by the runtime coordinator (i-message-sync).
 *
 * The raw `fs.watch` call lives in the repo layer so this file owns only the
 * business rules: debouncing, ROWID bookkeeping, and sync-event shaping.
 *
 * Imports: own repo, own config, own types, EventEmitter.
 */
import { EventEmitter } from 'events';
import { toError } from '../../../shared/utils/error';
import { DEBOUNCE_MS } from './config';
import { watchChatDb, type FSWatcher } from './repo';
import type { NormalizedMessage, QueryNewMessages, SyncEvent } from './types';

/**
 * Real-time iMessage watcher using fs.watch on chat.db.
 * Emits 'sync' events when new messages are detected.
 */
export class IMessageWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastMessageRowId: number = 0;
  private isWatching: boolean = false;
  private queryNewMessages: QueryNewMessages;

  constructor(queryNewMessages: QueryNewMessages) {
    super();
    this.queryNewMessages = queryNewMessages;
  }

  /**
   * Initialize the last known message ROWID to avoid re-processing existing messages.
   */
  async initialize(lastRowId?: number): Promise<void> {
    if (lastRowId !== undefined) {
      this.lastMessageRowId = lastRowId;
      console.log(`[IMessageWatcher] Initialized with lastRowId: ${lastRowId}`);
    }
  }

  /**
   * Start watching chat.db for changes.
   */
  start(): void {
    if (this.isWatching) {
      console.log('[IMessageWatcher] Already watching');
      return;
    }

    try {
      this.watcher = watchChatDb((eventType) => {
        if (eventType !== 'change') return;
        this.handleChange();
      });

      this.isWatching = true;
      console.log('[IMessageWatcher] Started watching chat.db for real-time messages');

      this.watcher.on('error', (error) => {
        console.error('[IMessageWatcher] Watch error:', error);
        this.emit('sync', {
          type: 'error',
          channel: 'IMESSAGE',
          error,
        } satisfies SyncEvent);
      });
    } catch (error) {
      console.error('[IMessageWatcher] Failed to start watching:', error);
      throw error;
    }
  }

  /**
   * Stop watching for changes.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.isWatching = false;
    console.log('[IMessageWatcher] Stopped watching');
  }

  /**
   * Handle file change event with debouncing.
   */
  private handleChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.processDebouncedChange();
    }, DEBOUNCE_MS);
  }

  /**
   * Invoke the injected query and emit the resulting sync event. Split out
   * from `handleChange` so the debounce timer can accept a sync callback
   * (lint: `no-misused-promises` forbids returning a Promise to setTimeout).
   */
  private async processDebouncedChange(): Promise<void> {
    try {
      const newMessages = await this.queryNewMessages();

      if (newMessages.length > 0) {
        console.log(`[IMessageWatcher] Detected ${newMessages.length} new message(s)`);

        // Update lastMessageRowId from the highest ID in new messages
        // A loop, not Math.max(...ids): spreading a large batch overflows the stack.
        for (const m of newMessages as NormalizedMessage[]) {
          const id = parseInt(m.id, 10);
          if (id > this.lastMessageRowId) this.lastMessageRowId = id;
        }

        this.emit('sync', {
          type: 'new_messages',
          channel: 'IMESSAGE',
          messages: newMessages,
        } satisfies SyncEvent);
      }
    } catch (error) {
      console.error('[IMessageWatcher] Error querying new messages:', error);
      this.emit('sync', {
        type: 'error',
        channel: 'IMESSAGE',
        error: toError(error),
      } satisfies SyncEvent);
    }
  }

  /**
   * Get the last processed message ROWID.
   */
  getLastMessageRowId(): number {
    return this.lastMessageRowId;
  }

  /**
   * Update the last processed message ROWID.
   */
  setLastMessageRowId(rowId: number): void {
    this.lastMessageRowId = rowId;
  }

  /**
   * Check if currently watching.
   */
  isActive(): boolean {
    return this.isWatching;
  }
}
