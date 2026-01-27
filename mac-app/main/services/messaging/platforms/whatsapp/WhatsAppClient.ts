import { EventEmitter } from 'events';
import { WhatsAppAuth } from './WhatsAppAuth';
import type { NormalizedMessage, SyncEvent, ConnectionState as AppConnectionState, WhatsAppAuthCallbacks } from '../../types';

// Baileys types (import type is fine for ESM modules)
type WAMessage = any;
type ConnectionState = any;
type BaileysEventMap = any;
type WASocket = any;

// Lazy-loaded Baileys module
let baileys: typeof import('@whiskeysockets/baileys') | null = null;

// Use Function constructor to preserve dynamic import (TypeScript transforms import() to require() in commonjs mode)
const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (path: string) => Promise<any>;

async function loadBaileys(): Promise<typeof import('@whiskeysockets/baileys')> {
  if (!baileys) {
    baileys = await dynamicImport('@whiskeysockets/baileys');
  }
  return baileys!;
}

/**
 * WhatsApp client using Baileys for WhatsApp Web protocol.
 * Handles connection, authentication, real-time messages, and historical sync attempts.
 */
export class WhatsAppClient extends EventEmitter {
  private sock: WASocket | null = null;
  private connectionState: AppConnectionState = 'disconnected';
  private selfJid: string | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private isConnecting: boolean = false;
  private authCallbacks: WhatsAppAuthCallbacks | undefined = undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;

  constructor() {
    super();
  }

  /**
   * Get current connection state.
   */
  getConnectionState(): AppConnectionState {
    return this.connectionState;
  }

  /**
   * Check if already connected.
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Connect to WhatsApp.
   * @param callbacks - Auth callbacks for QR code display
   */
  async connect(callbacks?: WhatsAppAuthCallbacks): Promise<void> {
    if (this.isConnecting) {
      console.log('[WhatsAppClient] Already connecting');
      return;
    }

    if (this.isConnected()) {
      console.log('[WhatsAppClient] Already connected');
      return;
    }

    this.isConnecting = true;
    this.setConnectionState('connecting');
    this.authCallbacks = callbacks;

    try {
      // Load Baileys dynamically (ESM module)
      const {
        makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore,
      } = await loadBaileys();

      // Ensure auth directory exists and restore from backup if needed
      WhatsAppAuth.ensureAuthDir();
      WhatsAppAuth.maybeRestoreFromBackup();

      const authDir = WhatsAppAuth.getAuthDir();
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      this.saveCreds = saveCreds;

      const { version } = await fetchLatestBaileysVersion();

      // Create minimal pino-like logger to silence Baileys logs
      const silentLogger = {
        level: 'silent',
        child: () => silentLogger,
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
      };

      this.sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
        },
        version,
        logger: silentLogger as any,
        printQRInTerminal: false,
        // Use standard Chrome browser identifier to avoid WhatsApp blocking
        browser: ['Chrome (macOS)', 'Chrome', '126.0.6478.183'],
        syncFullHistory: true, // Attempt to sync full history
        markOnlineOnConnect: false,
      });

      this.setupEventHandlers(callbacks);

      // Wait for connection to be established
      await this.waitForConnection();
    } catch (error) {
      console.error('[WhatsAppClient] Connection error:', error);
      this.setConnectionState('error');
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Disconnect from WhatsApp.
   */
  async disconnect(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.ws?.close();
      } catch (error) {
        console.warn('[WhatsAppClient] Error closing socket:', error);
      }
      this.sock = null;
    }
    this.setConnectionState('disconnected');
    this.selfJid = null;
  }

  /**
   * Logout and clear credentials.
   */
  async logout(): Promise<void> {
    await this.disconnect();
    WhatsAppAuth.clearCredentials();
    console.log('[WhatsAppClient] Logged out and cleared credentials');
  }

  /**
   * Attempt to fetch historical messages for a chat.
   * Note: This may not work in Baileys v7.0+ due to WhatsApp API changes.
   */
  async fetchHistoricalMessages(chatId: string, limit: number = 50): Promise<NormalizedMessage[]> {
    if (!this.sock || !this.isConnected()) {
      console.warn('[WhatsAppClient] Cannot fetch history - not connected');
      return [];
    }

    try {
      console.log(`[WhatsAppClient] Attempting to fetch ${limit} historical messages for ${chatId}`);

      // Attempt 1: Try using store if available (Baileys internal message store)
      // This is the most reliable method but requires message store setup
      const messages: NormalizedMessage[] = [];

      // Attempt 2: Try fetchMessageHistory if available (may not work in v7.0+)
      // This is a best-effort attempt
      try {
        const sock = this.sock as any;
        if (typeof sock.fetchMessageHistory === 'function') {
          const history = await sock.fetchMessageHistory(chatId, limit);
          if (Array.isArray(history)) {
            for (const msg of history) {
              const normalized = this.normalizeMessage(msg);
              if (normalized) {
                messages.push(normalized);
              }
            }
          }
        }
      } catch (histErr) {
        console.log('[WhatsAppClient] fetchMessageHistory not available or failed:', histErr);
      }

      // Attempt 3: Check for messages.upsert events with type 'append' (historical)
      // These are received during initial sync when syncFullHistory is true

      console.log(`[WhatsAppClient] Historical fetch returned ${messages.length} messages`);
      return messages;
    } catch (error) {
      console.error('[WhatsAppClient] Error fetching historical messages:', error);
      return [];
    }
  }

  /**
   * Get list of chats (conversations).
   */
  async getChats(): Promise<{ id: string; name?: string; isGroup: boolean }[]> {
    if (!this.sock || !this.isConnected()) {
      return [];
    }

    // Note: Baileys doesn't have a direct "get chats" method
    // Chats are discovered through messages.upsert events
    // This is a placeholder for future implementation
    return [];
  }

  /**
   * Set up event handlers for the Baileys socket.
   */
  private setupEventHandlers(callbacks?: WhatsAppAuthCallbacks): void {
    if (!this.sock) return;

    // Handle credential updates
    this.sock.ev.on('creds.update', async () => {
      if (this.saveCreds) {
        WhatsAppAuth.backupCredentials();
        await this.saveCreds();
      }
    });

    // Handle connection updates
    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update, callbacks);
    });

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', (upsert: BaileysEventMap['messages.upsert']) => {
      this.handleMessagesUpsert(upsert);
    });

    // Handle historical message sync (fires during initial pairing)
    this.sock.ev.on('messaging-history.set', (historySet: {
      chats: any[];
      contacts: any[];
      messages: WAMessage[];
      isLatest?: boolean;
      progress?: number | null;
    }) => {
      this.handleHistorySync(historySet);
    });

    // Handle WebSocket errors
    if (this.sock.ws) {
      this.sock.ws.on('error', (error: Error) => {
        console.error('[WhatsAppClient] WebSocket error:', error);
      });
    }
  }

  /**
   * Handle connection state updates.
   */
  private handleConnectionUpdate(
    update: Partial<ConnectionState>,
    callbacks?: WhatsAppAuthCallbacks
  ): void {
    const { connection, lastDisconnect, qr } = update;

    // Handle QR code for authentication
    if (qr) {
      console.log('[WhatsAppClient] QR code received');
      callbacks?.onQRCode?.(qr);
    }

    if (connection === 'open') {
      this.selfJid = this.sock?.user?.id ?? null;
      this.setConnectionState('connected');
      this.reconnectAttempts = 0; // Reset on successful connection
      console.log('[WhatsAppClient] Connected');

      // Emit connection event
      this.emit('sync', {
        type: 'connection_change',
        channel: 'WHATSAPP',
        connected: true,
      } satisfies SyncEvent);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      // DisconnectReason.loggedOut = 401, DisconnectReason.restartRequired = 515
      const isLoggedOut = statusCode === 401;
      const isRestartRequired = statusCode === 515;

      console.log(`[WhatsAppClient] Connection closed (status: ${statusCode}, loggedOut: ${isLoggedOut}, restart: ${isRestartRequired})`);

      if (isLoggedOut) {
        WhatsAppAuth.clearCredentials();
      }

      // On status 515 (restart required), clear partial auth and reconnect
      if (isRestartRequired && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        console.log(`[WhatsAppClient] Restart required, clearing auth and reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        WhatsAppAuth.clearCredentials();
        // Reconnect after a short delay
        setTimeout(() => {
          this.sock = null;
          this.isConnecting = false;
          this.connect(this.authCallbacks).catch((err) => {
            console.error('[WhatsAppClient] Reconnect failed:', err);
          });
        }, 2000);
        return;
      }

      this.setConnectionState('disconnected');

      // Emit connection event
      this.emit('sync', {
        type: 'connection_change',
        channel: 'WHATSAPP',
        connected: false,
      } satisfies SyncEvent);
    }
  }

  /**
   * Handle incoming messages.
   */
  private handleMessagesUpsert(upsert: BaileysEventMap['messages.upsert']): void {
    const { type, messages } = upsert;

    // type can be 'notify' (new messages) or 'append' (historical/sync)
    const isHistorical = type === 'append';

    if (isHistorical) {
      console.log(`[WhatsAppClient] Received ${messages.length} historical messages`);
    }

    const normalizedMessages: NormalizedMessage[] = [];

    for (const msg of messages) {
      // Skip status broadcasts
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@status') || remoteJid.endsWith('@broadcast')) {
        continue;
      }

      const normalized = this.normalizeMessage(msg);
      if (normalized) {
        normalizedMessages.push(normalized);
      }
    }

    if (normalizedMessages.length > 0) {
      console.log(`[WhatsAppClient] Normalized ${normalizedMessages.length} messages (historical: ${isHistorical})`);

      this.emit('sync', {
        type: 'new_messages',
        channel: 'WHATSAPP',
        messages: normalizedMessages,
      } satisfies SyncEvent);
    }
  }

  /**
   * Handle historical message sync from WhatsApp.
   * This fires during initial pairing when syncFullHistory is true.
   */
  private handleHistorySync(historySet: {
    chats: any[];
    contacts: any[];
    messages: WAMessage[];
    isLatest?: boolean;
    progress?: number | null;
  }): void {
    const { chats, contacts, messages, isLatest, progress } = historySet;

    console.log(`[WhatsAppClient] 📜 History sync received: ${messages.length} messages, ${chats.length} chats, ${contacts.length} contacts`);
    if (progress !== undefined && progress !== null) {
      console.log(`[WhatsAppClient] History sync progress: ${Math.round(progress * 100)}%`);
    }
    if (isLatest) {
      console.log('[WhatsAppClient] History sync complete (isLatest=true)');
    }

    if (messages.length === 0) {
      return;
    }

    const normalizedMessages: NormalizedMessage[] = [];

    for (const msg of messages) {
      // Skip status broadcasts
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@status') || remoteJid.endsWith('@broadcast')) {
        continue;
      }

      const normalized = this.normalizeMessage(msg);
      if (normalized) {
        normalizedMessages.push(normalized);
      }
    }

    if (normalizedMessages.length > 0) {
      console.log(`[WhatsAppClient] 📜 Normalized ${normalizedMessages.length} historical messages`);

      this.emit('sync', {
        type: 'new_messages',
        channel: 'WHATSAPP',
        messages: normalizedMessages,
      } satisfies SyncEvent);
    }
  }

  /**
   * Normalize a Baileys WAMessage to our NormalizedMessage format.
   */
  private normalizeMessage(msg: WAMessage): NormalizedMessage | null {
    const key = msg.key;
    if (!key?.remoteJid || !key.id) return null;

    const text = this.extractMessageText(msg);
    if (!text) return null; // Skip media-only messages for now

    // Group JIDs end with @g.us
    const isGroup = key.remoteJid.endsWith('@g.us');
    const participantJid = key.participant;
    const senderJid = isGroup ? participantJid : key.remoteJid;

    // Extract phone number from JID
    const contactId = this.jidToPhone(senderJid || key.remoteJid);
    if (!contactId) return null;

    const timestamp = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000)
      : new Date();

    return {
      id: key.id,
      text,
      timestamp,
      isFromMe: key.fromMe ?? false,
      chatId: key.remoteJid,
      contactId,
      contactName: msg.pushName || undefined,
      channel: 'WHATSAPP',
    };
  }

  /**
   * Extract text content from a message.
   */
  private extractMessageText(msg: WAMessage): string | null {
    const message = msg.message;
    if (!message) return null;

    // Check different message types
    if (message.conversation) {
      return message.conversation;
    }
    if (message.extendedTextMessage?.text) {
      return message.extendedTextMessage.text;
    }
    if (message.imageMessage?.caption) {
      return message.imageMessage.caption;
    }
    if (message.videoMessage?.caption) {
      return message.videoMessage.caption;
    }
    if (message.documentMessage?.caption) {
      return message.documentMessage.caption;
    }

    return null;
  }

  /**
   * Convert WhatsApp JID to phone number.
   */
  private jidToPhone(jid: string | null | undefined): string | null {
    if (!jid) return null;
    // JID format: 1234567890:12@s.whatsapp.net or 1234567890@s.whatsapp.net
    const match = jid.match(/^(\d+)/);
    return match ? `+${match[1]}` : null;
  }

  /**
   * Set connection state and emit event.
   */
  private setConnectionState(state: AppConnectionState): void {
    this.connectionState = state;
  }

  /**
   * Wait for connection to be established.
   */
  private waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sock) {
        reject(new Error('Socket not initialized'));
        return;
      }

      // Check if already connected
      if (this.connectionState === 'connected') {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        // Don't reject - allow QR code flow to continue
        resolve();
      }, 60000); // 60 second timeout for initial connection

      const cleanup = () => {
        clearTimeout(timeout);
        this.sock?.ev.off('connection.update', handler);
      };

      const handler = (update: Partial<ConnectionState>) => {
        if (update.connection === 'open') {
          cleanup();
          resolve();
        } else if (update.connection === 'close') {
          cleanup();
          const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
          // DisconnectReason.loggedOut = 401
          if (statusCode === 401) {
            reject(new Error('WhatsApp session logged out'));
          }
          // For other close reasons, don't reject - allow reconnection
        }
      };

      this.sock.ev.on('connection.update', handler);
    });
  }
}
