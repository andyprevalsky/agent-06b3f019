/**
 * messaging-telegram runtime layer.
 *
 * TelegramSync — thin coordinator on top of the service-layer TelegramClient.
 * Responsibilities:
 *   1. Own the singleton client lifecycle (create, forward sync events, shut down).
 *   2. Buffer real-time messages, flush on cadence via BatchUploader.
 *   3. Expose static entry-points for the IPC handler registry (main/handlers/registry.ts).
 *
 * Imports: own service, own repo, own config, own types, cross-domain providers
 * (AuthService, BatchUploader, MessageTransformer, IntegrationCache).
 */
import { AuthService } from '../../services/auth';
import { BatchUploader } from '../../services/batchUploader';
import { MessageTransformer } from '../../services/messaging/MessageTransformer';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { IntegrationProgress, type ProgressRunWrite } from '../../services/integrationProgress';
import { sessionForLocalMachineData } from '../../base/impersonation';
import { FLUSH_INTERVAL_MS, INTEGRATION_KEY, MAX_BUFFER_SIZE } from './config';
import { TelegramAuth } from './repo';
import { TelegramClient } from './service';
import type { NormalizedMessage, StartAuthResult, SyncEvent } from './types';

/**
 * Telegram sync coordinator.
 * Manages Telegram client lifecycle, authentication, and message sync to backend.
 */
export class TelegramSync {
  private static client: TelegramClient | null = null;
  private static messageBuffer: NormalizedMessage[] = [];
  private static flushTimer: NodeJS.Timeout | null = null;

  static hasSession(): boolean {
    return TelegramAuth.hasSession();
  }

  static hasApiCredentials(): boolean {
    return TelegramClient.hasApiCredentials();
  }

  static isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /** Underlying client — exposed for auth-event forwarding in the IPC handlers. */
  static getClient(): TelegramClient | null {
    return this.client;
  }

  /**
   * Start authentication with phone number.
   * Listen for 'auth:needCode', 'auth:needPassword', 'auth:complete', 'auth:error' events
   * on the client (available via getClient()).
   */
  static async startAuth(phoneNumber: string): Promise<StartAuthResult> {
    if (this.client === null || !this.client.isConnected()) {
      this.client = this.makeClient();
      this.client.on('auth:complete', () => {
        this.startFlushTimer();
      });
    }
    return this.client.startAuth(phoneNumber);
  }

  static submitCode(code: string): void {
    this.client?.submitCode(code);
  }

  static submitPassword(password: string): void {
    this.client?.submitPassword(password);
  }

  static cancelAuth(): void {
    this.client?.cancelAuth();
  }

  /**
   * Connect using existing session (no auth needed).
   */
  static async connectWithExistingSession(): Promise<boolean> {
    if (this.client?.isConnected() === true) return true;

    this.client = this.makeClient();
    const success = await this.client.connectWithExistingSession();
    if (success) this.startFlushTimer();
    return success;
  }

  private static makeClient(): TelegramClient {
    const client = new TelegramClient();
    client.on('sync', (event: SyncEvent) => {
      this.handleSyncEvent(event).catch((err) => {
        console.error('[TelegramSync] Error handling sync event:', err);
      });
    });
    return client;
  }

  static async disconnect(): Promise<void> {
    this.stopFlushTimer();
    await this.flushBuffer();
    if (this.client !== null) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  static async logout(): Promise<void> {
    this.stopFlushTimer();
    if (this.client !== null) {
      await this.client.logout();
      this.client = null;
    }
    this.messageBuffer = [];
  }

  /**
   * Perform historical sync — fetch messages from all dialogs.
   * Uses lastFrontendAccessAt for incremental sync (only fetches new messages).
   */
  static async syncHistorical(messagesPerDialog = 100): Promise<number> {
    if (this.client === null || !this.client.isConnected()) return 0;

    const integration = await IntegrationCache.getIntegration(INTEGRATION_KEY);
    if (
      integration === undefined ||
      integration === null ||
      integration.status === 'NOT_CONNECTED'
    ) {
      return 0;
    }

    const integrationConfig = integration.config as { lastFrontendAccessAt?: string } | undefined;
    const lastAccessStr = integrationConfig?.lastFrontendAccessAt;
    const lastSyncAt =
      typeof lastAccessStr === 'string' && lastAccessStr.length > 0
        ? new Date(lastAccessStr)
        : undefined;

    // Sync progress: chats fetched of the chat list, then the upload's outcome (best-effort).
    const session = sessionForLocalMachineData(await AuthService.getSession());
    const progress = IntegrationProgress.startRun(INTEGRATION_KEY);
    const report = async (write: ProgressRunWrite): Promise<void> => {
      if (session !== null)
        await progress.report({ unit: 'chats', ...write }, session.access_token);
    };
    const messages = await this.client.fetchAllHistoricalMessages(
      messagesPerDialog,
      lastSyncAt,
      (done, total) => report({ state: 'syncing', done, total })
    );
    if (messages.length === 0) {
      await report({ state: 'synced' });
      return 0;
    }

    const success = await this.uploadMessages(messages);
    await report(success ? { state: 'synced' } : { state: 'failed', error: 'Upload failed' });
    return success ? messages.length : 0;
  }

  /**
   * Handle sync events from the client — buffer new messages, ignore control events.
   */
  private static async handleSyncEvent(event: SyncEvent): Promise<void> {
    if (event.type !== 'new_messages') return;
    const msgs = event.messages;
    if (msgs === undefined || msgs.length === 0) return;

    this.messageBuffer.push(...msgs);
    if (this.messageBuffer.length >= MAX_BUFFER_SIZE) {
      await this.flushBuffer();
    }
  }

  /**
   * Upload messages to backend via BatchUploader.
   */
  private static async uploadMessages(messages: NormalizedMessage[]): Promise<boolean> {
    const session = sessionForLocalMachineData(await AuthService.getSession());
    if (session === null || session === undefined) return false;

    const contacts = MessageTransformer.toContactWithMessages(messages);
    const result = await BatchUploader.uploadInBatches(
      INTEGRATION_KEY,
      contacts,
      session.access_token,
      null
    );
    return result.success;
  }

  /**
   * Flush message buffer to backend.
   */
  private static async flushBuffer(): Promise<void> {
    if (this.messageBuffer.length === 0) return;

    const isConnected = await IntegrationCache.isConnected(INTEGRATION_KEY);
    if (!isConnected) return;

    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    const success = await this.uploadMessages(messages);
    if (!success && this.messageBuffer.length + messages.length <= MAX_BUFFER_SIZE * 2) {
      this.messageBuffer.unshift(...messages);
    }
  }

  private static startFlushTimer(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      this.flushBuffer().catch((err) => {
        console.error('[TelegramSync] Flush error:', err);
      });
    }, FLUSH_INTERVAL_MS);
  }

  private static stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
