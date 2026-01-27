import { AuthService } from '../../../auth';
import { BatchUploader } from '../../../batchUploader';
import { MessageTransformer } from '../../MessageTransformer';
import { IntegrationCache } from '../../../sync/IntegrationCache';
import { WhatsAppClient } from './WhatsAppClient';
import { WhatsAppAuth } from './WhatsAppAuth';
import type { NormalizedMessage, SyncEvent, WhatsAppAuthCallbacks } from '../../types';

/**
 * WhatsApp sync coordinator.
 * Manages WhatsApp client lifecycle, authentication, and message sync to backend.
 */
export class WhatsAppSync {
  private static client: WhatsAppClient | null = null;
  private static messageBuffer: NormalizedMessage[] = [];
  private static flushTimer: NodeJS.Timeout | null = null;
  private static readonly FLUSH_INTERVAL_MS = 5000; // Flush buffer every 5 seconds
  private static readonly MAX_BUFFER_SIZE = 100;

  /**
   * Check if WhatsApp has stored credentials.
   */
  static hasCredentials(): boolean {
    return WhatsAppAuth.hasCredentials();
  }

  /**
   * Get the linked phone number if available.
   */
  static getLinkedPhoneNumber(): string | null {
    return WhatsAppAuth.getLinkedPhoneNumber();
  }

  /**
   * Check if currently connected.
   */
  static isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /**
   * Connect to WhatsApp.
   * @param callbacks - Auth callbacks for QR code display
   */
  static async connect(callbacks?: WhatsAppAuthCallbacks): Promise<void> {
    if (this.client?.isConnected()) {
      console.log('[WhatsAppSync] Already connected');
      return;
    }

    this.client = new WhatsAppClient();

    // Handle sync events from client
    this.client.on('sync', (event: SyncEvent) => {
      this.handleSyncEvent(event).catch(err => {
        console.error('[WhatsAppSync] Error handling sync event:', err);
      });
    });

    await this.client.connect(callbacks);

    // Start flush timer
    this.startFlushTimer();

    console.log('[WhatsAppSync] Connected and listening for messages');
  }

  /**
   * Disconnect from WhatsApp.
   */
  static async disconnect(): Promise<void> {
    this.stopFlushTimer();

    // Flush any remaining messages
    await this.flushBuffer();

    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }

    console.log('[WhatsAppSync] Disconnected');
  }

  /**
   * Logout and clear credentials.
   */
  static async logout(): Promise<void> {
    this.stopFlushTimer();

    if (this.client) {
      await this.client.logout();
      this.client = null;
    }

    this.messageBuffer = [];
    console.log('[WhatsAppSync] Logged out');
  }

  /**
   * Attempt to fetch and sync historical messages.
   * Note: This may not work reliably in Baileys v7.0+
   */
  static async syncHistorical(): Promise<number> {
    if (!this.client?.isConnected()) {
      console.log('[WhatsAppSync] Cannot sync historical - not connected');
      return 0;
    }

    // Historical messages are received through messages.upsert events with type 'append'
    // when syncFullHistory is true. This happens automatically during connection.
    // We just wait for them to arrive and get processed.

    console.log('[WhatsAppSync] Historical sync relies on initial connection sync');
    return 0;
  }

  /**
   * Handle sync events from the client.
   */
  private static async handleSyncEvent(event: SyncEvent): Promise<void> {
    if (event.type === 'error') {
      console.error('[WhatsAppSync] Sync error:', event.error);
      return;
    }

    if (event.type === 'connection_change') {
      console.log(`[WhatsAppSync] Connection changed: ${event.connected ? 'connected' : 'disconnected'}`);
      return;
    }

    if (event.type === 'new_messages' && event.messages?.length) {
      console.log(`[WhatsAppSync] Received ${event.messages.length} messages`);

      // Add to buffer
      this.messageBuffer.push(...event.messages);

      // Flush immediately if buffer is getting large
      if (this.messageBuffer.length >= this.MAX_BUFFER_SIZE) {
        await this.flushBuffer();
      }
    }
  }

  /**
   * Flush message buffer to backend.
   */
  private static async flushBuffer(): Promise<void> {
    if (this.messageBuffer.length === 0) return;

    // Check if integration is connected
    const isConnected = await this.isIntegrationConnected();
    if (!isConnected) {
      console.log('[WhatsAppSync] Skipping upload - integration not connected');
      return;
    }

    const session = await AuthService.getSession();
    if (!session) {
      console.log('[WhatsAppSync] Skipping upload - not authenticated');
      return;
    }

    // Take messages from buffer
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    console.log(`[WhatsAppSync] Flushing ${messages.length} messages to backend`);

    const contacts = MessageTransformer.toContactWithMessages(messages);
    const stats = MessageTransformer.getStats(messages);

    console.log(`[WhatsAppSync] Uploading ${stats.total} messages from ${stats.uniqueContacts} contacts`);

    const result = await BatchUploader.uploadInBatches(
      'whatsapp',
      contacts,
      session.access_token,
      null
    );

    if (result.success) {
      console.log('[WhatsAppSync] Upload complete');
    } else {
      console.error('[WhatsAppSync] Upload failed:', result.message);
      // Re-add messages to buffer on failure (with limit to prevent infinite growth)
      if (this.messageBuffer.length + messages.length <= this.MAX_BUFFER_SIZE * 2) {
        this.messageBuffer.unshift(...messages);
      }
    }
  }

  /**
   * Check if WhatsApp integration is connected in backend.
   */
  private static async isIntegrationConnected(): Promise<boolean> {
    return IntegrationCache.isConnected('whatsapp');
  }

  /**
   * Start periodic flush timer.
   */
  private static startFlushTimer(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      this.flushBuffer().catch(err => {
        console.error('[WhatsAppSync] Flush error:', err);
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
