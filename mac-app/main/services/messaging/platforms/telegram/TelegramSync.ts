import { AuthService } from '../../../auth';
import { BatchUploader } from '../../../batchUploader';
import { MessageTransformer } from '../../MessageTransformer';
import { IntegrationCache } from '../../../sync/IntegrationCache';
import { TelegramClient } from './TelegramClient';
import { TelegramAuth } from './TelegramAuth';
import type { NormalizedMessage, SyncEvent, TelegramAuthCallbacks } from '../../types';

/**
 * Telegram sync coordinator.
 * Manages Telegram client lifecycle, authentication, and message sync to backend.
 */
export class TelegramSync {
  private static client: TelegramClient | null = null;
  private static messageBuffer: NormalizedMessage[] = [];
  private static flushTimer: NodeJS.Timeout | null = null;
  private static readonly FLUSH_INTERVAL_MS = 5000;
  private static readonly MAX_BUFFER_SIZE = 100;

  /**
   * Check if Telegram has stored session.
   */
  static hasSession(): boolean {
    return TelegramAuth.hasSession();
  }

  /**
   * Check if API credentials are configured.
   */
  static hasApiCredentials(): boolean {
    return TelegramClient.hasApiCredentials();
  }

  /**
   * Check if currently connected.
   */
  static isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /**
   * Get the underlying client (for auth event forwarding).
   */
  static getClient(): TelegramClient | null {
    return this.client;
  }

  /**
   * Start authentication with phone number.
   * Creates client if needed, initiates auth flow.
   * Listen for 'auth:needCode', 'auth:needPassword', 'auth:complete', 'auth:error' events on the client.
   */
  static async startAuth(phoneNumber: string): Promise<{ success: boolean; error?: string }> {
    // Create client if not exists or not connected
    if (!this.client || !this.client.isConnected()) {
      this.client = new TelegramClient();

      // Forward sync events
      this.client.on('sync', (event: SyncEvent) => {
        this.handleSyncEvent(event).catch(err => {
          console.error('[TelegramSync] Error handling sync event:', err);
        });
      });

      // Start flush timer when auth completes
      this.client.on('auth:complete', () => {
        this.startFlushTimer();
        console.log('[TelegramSync] Auth complete, listening for messages');
      });
    }

    return this.client.startAuth(phoneNumber);
  }

  /**
   * Submit verification code during auth.
   */
  static submitCode(code: string): void {
    this.client?.submitCode(code);
  }

  /**
   * Submit 2FA password during auth.
   */
  static submitPassword(password: string): void {
    this.client?.submitPassword(password);
  }

  /**
   * Cancel ongoing auth flow.
   */
  static cancelAuth(): void {
    this.client?.cancelAuth();
  }

  /**
   * Connect to Telegram with interactive authentication.
   * @param callbacks - Auth callbacks for phone, code, and password prompts
   * @deprecated Use startAuth() instead for UI-driven flows
   */
  static async connect(callbacks: TelegramAuthCallbacks): Promise<void> {
    if (this.client?.isConnected()) {
      console.log('[TelegramSync] Already connected');
      return;
    }

    this.client = new TelegramClient();

    // Handle sync events from client
    this.client.on('sync', (event: SyncEvent) => {
      this.handleSyncEvent(event).catch(err => {
        console.error('[TelegramSync] Error handling sync event:', err);
      });
    });

    await this.client.connect(callbacks);

    // Start flush timer
    this.startFlushTimer();

    console.log('[TelegramSync] Connected and listening for messages');
  }

  /**
   * Connect using existing session (no auth needed).
   */
  static async connectWithExistingSession(): Promise<boolean> {
    if (this.client?.isConnected()) {
      console.log('[TelegramSync] Already connected');
      return true;
    }

    this.client = new TelegramClient();

    // Handle sync events from client
    this.client.on('sync', (event: SyncEvent) => {
      this.handleSyncEvent(event).catch(err => {
        console.error('[TelegramSync] Error handling sync event:', err);
      });
    });

    const success = await this.client.connectWithExistingSession();

    if (success) {
      this.startFlushTimer();
      console.log('[TelegramSync] Connected with existing session');
    }

    return success;
  }

  /**
   * Disconnect from Telegram.
   */
  static async disconnect(): Promise<void> {
    this.stopFlushTimer();
    await this.flushBuffer();

    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }

    console.log('[TelegramSync] Disconnected');
  }

  /**
   * Logout and clear session.
   */
  static async logout(): Promise<void> {
    this.stopFlushTimer();

    if (this.client) {
      await this.client.logout();
      this.client = null;
    }

    this.messageBuffer = [];
    console.log('[TelegramSync] Logged out');
  }

  /**
   * Perform historical sync - fetch messages from all dialogs.
   * Uses lastFrontendAccessAt for incremental sync (only fetches new messages).
   * @param messagesPerDialog - Max messages per dialog
   */
  static async syncHistorical(messagesPerDialog: number = 100): Promise<number> {
    if (!this.client?.isConnected()) {
      console.log('[TelegramSync] Cannot sync historical - not connected');
      return 0;
    }

    // Get integration with config to check status and get lastFrontendAccessAt
    const integration = await IntegrationCache.getIntegration('telegram');
    if (!integration || integration.status === 'NOT_CONNECTED') {
      console.log('[TelegramSync] Cannot sync historical - integration not found');
      return 0;
    }

    // Get lastFrontendAccessAt for incremental sync
    const integrationConfig = integration.config as { lastFrontendAccessAt?: string } | undefined;
    const lastSyncAt = integrationConfig?.lastFrontendAccessAt
      ? new Date(integrationConfig.lastFrontendAccessAt)
      : undefined;

    const syncType = lastSyncAt ? `incremental since ${lastSyncAt.toISOString()}` : 'full';
    console.log(`[TelegramSync] Starting historical sync (${syncType}, ${messagesPerDialog} messages per dialog)`);

    const messages = await this.client.fetchAllHistoricalMessages(messagesPerDialog, lastSyncAt);

    if (messages.length === 0) {
      console.log('[TelegramSync] No new messages to sync');
      return 0;
    }

    // Upload directly (don't buffer historical)
    const success = await this.uploadMessages(messages);

    if (success) {
      console.log(`[TelegramSync] Historical sync complete: ${messages.length} messages`);
      return messages.length;
    } else {
      console.error('[TelegramSync] Historical sync failed');
      return 0;
    }
  }

  /**
   * Handle sync events from the client.
   */
  private static async handleSyncEvent(event: SyncEvent): Promise<void> {
    if (event.type === 'error') {
      console.error('[TelegramSync] Sync error:', event.error);
      return;
    }

    if (event.type === 'connection_change') {
      console.log(`[TelegramSync] Connection changed: ${event.connected ? 'connected' : 'disconnected'}`);
      return;
    }

    if (event.type === 'new_messages' && event.messages?.length) {
      console.log(`[TelegramSync] Received ${event.messages.length} messages`);

      // Add to buffer
      this.messageBuffer.push(...event.messages);

      // Flush immediately if buffer is getting large
      if (this.messageBuffer.length >= this.MAX_BUFFER_SIZE) {
        await this.flushBuffer();
      }
    }
  }

  /**
   * Upload messages to backend.
   */
  private static async uploadMessages(messages: NormalizedMessage[]): Promise<boolean> {
    const session = await AuthService.getSession();
    if (!session) {
      console.log('[TelegramSync] Skipping upload - not authenticated');
      return false;
    }

    const contacts = MessageTransformer.toContactWithMessages(messages);
    const stats = MessageTransformer.getStats(messages);

    console.log(`[TelegramSync] Uploading ${stats.total} messages from ${stats.uniqueContacts} contacts`);

    const result = await BatchUploader.uploadInBatches(
      'telegram',
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

    // Check if integration is connected
    const isConnected = await this.isIntegrationConnected();
    if (!isConnected) {
      console.log('[TelegramSync] Skipping upload - integration not connected');
      return;
    }

    // Take messages from buffer
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    console.log(`[TelegramSync] Flushing ${messages.length} messages to backend`);

    const success = await this.uploadMessages(messages);

    if (success) {
      console.log('[TelegramSync] Upload complete');
    } else {
      console.error('[TelegramSync] Upload failed');
      // Re-add messages to buffer on failure
      if (this.messageBuffer.length + messages.length <= this.MAX_BUFFER_SIZE * 2) {
        this.messageBuffer.unshift(...messages);
      }
    }
  }

  /**
   * Check if Telegram integration is connected in backend.
   */
  private static async isIntegrationConnected(): Promise<boolean> {
    return IntegrationCache.isConnected('telegram');
  }

  /**
   * Start periodic flush timer.
   */
  private static startFlushTimer(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      this.flushBuffer().catch(err => {
        console.error('[TelegramSync] Flush error:', err);
      });
    }, this.FLUSH_INTERVAL_MS);
  }

  /**
   * Stop periodic flush timer.
   */
  private static stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
