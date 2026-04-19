import { watch, type FSWatcher } from 'fs';
import { app } from 'electron';
import path from 'path';
import { EventEmitter } from 'events';
import type { NormalizedMessage, SyncEvent } from '../../types';

const CHAT_DB_PATH = path.join(app.getPath('home'), 'Library/Messages/chat.db');
const DEBOUNCE_MS = 1000;

/**
 * Real-time iMessage watcher using fs.watch on chat.db.
 * Emits 'sync' events when new messages are detected.
 */
export class IMessageWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastMessageRowId: number = 0;
  private isWatching: boolean = false;
  private queryNewMessages: () => Promise<NormalizedMessage[]>;

  constructor(queryNewMessages: () => Promise<NormalizedMessage[]>) {
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
      this.watcher = watch(CHAT_DB_PATH, (eventType) => {
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

    this.debounceTimer = setTimeout(async () => {
      try {
        const newMessages = await this.queryNewMessages();

        if (newMessages.length > 0) {
          console.log(`[IMessageWatcher] Detected ${newMessages.length} new message(s)`);

          // Update lastMessageRowId from the highest ID in new messages
          const maxId = Math.max(...newMessages.map((m) => parseInt(m.id, 10)));
          if (maxId > this.lastMessageRowId) {
            this.lastMessageRowId = maxId;
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
          error: error instanceof Error ? error : new Error(String(error)),
        } satisfies SyncEvent);
      }
    }, DEBOUNCE_MS);
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
