/**
 * messaging-whatsapp: runtime layer
 *
 * Entry point for the WhatsApp messaging domain. Thin coordinator that
 * instantiates the Baileys-backed client (from the service layer), buffers
 * normalized messages, and flushes batches to the backend via the shared
 * batch uploader. Other domains (handlers/registry, SyncManager) import
 * WhatsAppSync from here.
 *
 * Rules:
 *   - No data access (delegates to repo via WhatsAppAuth).
 *   - No Baileys calls (delegates to service via WhatsAppClient).
 *   - Calls the cross-cutting providers: AuthService, BatchUploader, IntegrationCache,
 *     MessageTransformer.
 *
 * Import-path note: WhatsAppClient is imported through the legacy
 * `main/services/messaging/platforms/whatsapp/WhatsAppClient` shim so that
 * existing blackbox tests — which `vi.mock(...)` that exact path — intercept
 * the Baileys boundary as designed.
 */
import { AuthService } from '../../services/auth';
import { BatchUploader } from '../../services/batchUploader';
import { MessageTransformer } from '../../services/messaging/MessageTransformer';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
// Imported via the legacy shim path so blackbox tests' vi.mock() on
// '../../main/services/messaging/platforms/whatsapp/WhatsAppClient'
// intercepts the constructor used here (Vitest mocks module specifiers, not
// underlying implementations).
import { WhatsAppClient } from '../../services/messaging/platforms/whatsapp/WhatsAppClient';
import { WhatsAppAuth } from './repo';
import {
  WHATSAPP_FLUSH_INTERVAL_MS,
  WHATSAPP_INTEGRATION_NAME,
  WHATSAPP_MAX_BUFFER_SIZE,
} from './config';
import type { NormalizedMessage, SyncEvent, WhatsAppAuthCallbacks } from './types';

/**
 * WhatsApp sync coordinator.
 * Manages WhatsApp client lifecycle, authentication, and message sync to backend.
 */
export class WhatsAppSync {
  private static client: WhatsAppClient | null = null;
  private static messageBuffer: NormalizedMessage[] = [];
  private static flushTimer: NodeJS.Timeout | null = null;

  /** Check if WhatsApp has stored credentials. */
  static hasCredentials(): boolean {
    return WhatsAppAuth.hasCredentials();
  }

  /** Get the linked phone number if available. */
  static getLinkedPhoneNumber(): string | null {
    return WhatsAppAuth.getLinkedPhoneNumber();
  }

  /** Check if currently connected. */
  static isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /**
   * Connect to WhatsApp.
   * @param callbacks - Auth callbacks for QR code display
   */
  static async connect(callbacks?: WhatsAppAuthCallbacks): Promise<void> {
    if (this.client?.isConnected() === true) {
      console.log('[WhatsAppSync] Already connected');
      return;
    }

    this.client = new WhatsAppClient();

    // Handle sync events from client
    this.client.on('sync', (event: SyncEvent) => {
      this.handleSyncEvent(event).catch((err) => {
        console.error('[WhatsAppSync] Error handling sync event:', err);
      });
    });

    await this.client.connect(callbacks);

    // Start flush timer
    this.startFlushTimer();

    console.log('[WhatsAppSync] Connected and listening for messages');
  }

  /** Disconnect from WhatsApp. */
  static async disconnect(): Promise<void> {
    this.stopFlushTimer();

    // Flush any remaining messages
    await this.flushBuffer();

    if (this.client !== null) {
      await this.client.disconnect();
      this.client = null;
    }

    console.log('[WhatsAppSync] Disconnected');
  }

  /** Logout and clear credentials. */
  static async logout(): Promise<void> {
    this.stopFlushTimer();

    if (this.client !== null) {
      await this.client.logout();
      this.client = null;
    }

    this.messageBuffer = [];
    console.log('[WhatsAppSync] Logged out');
  }

  /**
   * Attempt to fetch and sync historical messages.
   * Note: This may not work reliably in Baileys v7.0+.
   */
  static async syncHistorical(): Promise<number> {
    if (this.client?.isConnected() !== true) {
      console.log('[WhatsAppSync] Cannot sync historical - not connected');
      return 0;
    }

    // Historical messages are received through messages.upsert events with type 'append'
    // when syncFullHistory is true. This happens automatically during connection.
    // We just wait for them to arrive and get processed.
    console.log('[WhatsAppSync] Historical sync relies on initial connection sync');
    return 0;
  }

  /** Handle sync events from the client. */
  private static async handleSyncEvent(event: SyncEvent): Promise<void> {
    if (event.type === 'error') {
      console.error('[WhatsAppSync] Sync error:', event.error);
      return;
    }

    if (event.type === 'connection_change') {
      console.log(
        `[WhatsAppSync] Connection changed: ${event.connected === true ? 'connected' : 'disconnected'}`
      );
      return;
    }

    if (
      event.type === 'new_messages' &&
      event.messages !== undefined &&
      event.messages.length > 0
    ) {
      console.log(`[WhatsAppSync] Received ${event.messages.length} messages`);

      // Add to buffer
      this.messageBuffer.push(...event.messages);

      // Flush immediately if buffer is getting large
      if (this.messageBuffer.length >= WHATSAPP_MAX_BUFFER_SIZE) {
        await this.flushBuffer();
      }
    }
  }

  /** Flush message buffer to backend. */
  private static async flushBuffer(): Promise<void> {
    if (this.messageBuffer.length === 0) return;

    // Check if integration is connected
    const isConnected = await this.isIntegrationConnected();
    if (!isConnected) {
      console.log('[WhatsAppSync] Skipping upload - integration not connected');
      return;
    }

    const session = await AuthService.getSession();
    if (session === null) {
      console.log('[WhatsAppSync] Skipping upload - not authenticated');
      return;
    }

    // Take messages from buffer
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    console.log(`[WhatsAppSync] Flushing ${messages.length} messages to backend`);

    const contacts = MessageTransformer.toContactWithMessages(messages);
    const stats = MessageTransformer.getStats(messages);

    console.log(
      `[WhatsAppSync] Uploading ${stats.total} messages from ${stats.uniqueContacts} contacts`
    );

    const result = await BatchUploader.uploadInBatches(
      WHATSAPP_INTEGRATION_NAME,
      contacts,
      session.access_token,
      null
    );

    if (result.success) {
      console.log('[WhatsAppSync] Upload complete');
    } else {
      console.error('[WhatsAppSync] Upload failed:', result.message);
      // Re-add messages to buffer on failure (with limit to prevent infinite growth)
      if (this.messageBuffer.length + messages.length <= WHATSAPP_MAX_BUFFER_SIZE * 2) {
        this.messageBuffer.unshift(...messages);
      }
    }
  }

  /** Check if WhatsApp integration is connected in backend. */
  private static async isIntegrationConnected(): Promise<boolean> {
    return IntegrationCache.isConnected(WHATSAPP_INTEGRATION_NAME);
  }

  /** Start periodic flush timer. */
  private static startFlushTimer(): void {
    if (this.flushTimer !== null) return;

    this.flushTimer = setInterval(() => {
      this.flushBuffer().catch((err) => {
        console.error('[WhatsAppSync] Flush error:', err);
      });
    }, WHATSAPP_FLUSH_INTERVAL_MS);
  }

  /** Stop periodic flush timer. */
  private static stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
