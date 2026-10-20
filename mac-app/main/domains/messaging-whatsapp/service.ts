/**
 * messaging-whatsapp: service layer
 *
 * Baileys-backed WhatsApp client. Handles socket lifecycle, authentication
 * callbacks, real-time message normalization, and historical sync attempts.
 * Emits a single `'sync'` event that the runtime coordinator consumes.
 *
 * Boundary: Baileys is dynamically imported so the CommonJS build doesn't
 * eagerly pull in the WebSocket-backed SDK (and tests can stub the module
 * without spinning up a real socket).
 *
 * Normalization logic lives in `./normalize.ts` to keep this file focused on
 * connection/reconnect orchestration.
 */
import { EventEmitter } from 'events';
import { loadBaileys, silentBaileysLogger } from './client-loader';
import { fetchHistoricalMessages, listChats } from './history';
import { legacyWhatsAppAuthStore, type WhatsAppAuthStore } from './repo';
import {
  WHATSAPP_BROWSER,
  WHATSAPP_CONNECTION_TIMEOUT_MS,
  WHATSAPP_MAX_RECONNECT_ATTEMPTS,
  WHATSAPP_RECONNECT_DELAY_MS,
  WHATSAPP_STATUS_LOGGED_OUT,
} from './config';
import { decideConnectionClose } from './policy';
import { isSkippableJid, normalizeMessage, type WABaileysMessage } from './normalize';
import type {
  NormalizedMessage,
  SyncEvent,
  ConnectionState as AppConnectionState,
  WhatsAppAuthCallbacks,
  WhatsAppConnectionCloseError,
  WhatsAppHistoryBatch,
} from './types';

// Baileys types — Baileys is loaded dynamically at runtime, so we can't statically
// import its types in a CommonJS build. `any` here is the pragmatic choice; a later
// pass can harden these once the dynamic-import wrapper is replaced.
/* eslint-disable @typescript-eslint/no-explicit-any */
type WAMessage = any;
type ConnectionState = any;
type BaileysEventMap = any;
type WASocket = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface HistorySetPayload {
  chats: unknown[];
  contacts: unknown[];
  messages: WAMessage[];
  isLatest?: boolean;
  progress?: number | null;
  syncType?: number | null;
}

/**
 * WhatsApp client using Baileys for WhatsApp Web protocol: ONE account, on
 * its own auth dir and socket. Handles connection, authentication, real-time
 * messages, and history sync. Emits `sync` (messages / connection changes),
 * `history` (one {@link WhatsAppHistoryBatch} per `messaging-history.set`) and
 * `logged_out` (WhatsApp revoked this linked device; its creds are cleared).
 */
export class WhatsAppClient extends EventEmitter {
  private sock: WASocket | null = null;
  private connectionState: AppConnectionState = 'disconnected';
  private selfJid: string | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private isConnecting: boolean = false;
  private authCallbacks: WhatsAppAuthCallbacks | undefined = undefined;
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxReconnectAttempts: number = WHATSAPP_MAX_RECONNECT_ATTEMPTS;

  constructor(private readonly auth: WhatsAppAuthStore = legacyWhatsAppAuthStore()) {
    super();
  }

  /** The auth dir this client's socket runs on. */
  getAuthDir(): string {
    return this.auth.dir;
  }

  /** The account's own JID once the socket has opened (`<phone>:<device>@s.whatsapp.net`). */
  getSelfJid(): string | null {
    return this.selfJid;
  }

  /** Cancel a pending reconnect so an explicit disconnect can't be resurrected. */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Current connection state. */
  getConnectionState(): AppConnectionState {
    return this.connectionState;
  }

  /** True if currently connected. */
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
      const {
        makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore,
      } = await loadBaileys();

      this.auth.ensureAuthDir();
      this.auth.maybeRestoreFromBackup();

      const { state, saveCreds } = await useMultiFileAuthState(this.auth.dir);
      this.saveCreds = saveCreds;

      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentBaileysLogger),
        },
        version,
        logger: silentBaileysLogger,
        printQRInTerminal: false,
        browser: [...WHATSAPP_BROWSER],
        syncFullHistory: true,
        markOnlineOnConnect: false,
      });

      this.setupEventHandlers(callbacks);
      await this.waitForConnection();
    } catch (error) {
      console.error('[WhatsAppClient] Connection error:', error);
      this.setConnectionState('error');
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /** Disconnect from WhatsApp. */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    if (this.sock !== null) {
      try {
        this.sock.ws?.close();
      } catch (error) {
        console.warn('[WhatsAppClient] Error closing socket:', error);
      }
      this.sock = null;
    }
    this.setConnectionState('disconnected');
    this.selfJid = null;
    return Promise.resolve();
  }

  /** Logout and clear credentials. */
  async logout(): Promise<void> {
    await this.disconnect();
    this.auth.clearCredentials();
    console.log('[WhatsAppClient] Logged out and cleared credentials');
  }

  /**
   * Attempt to fetch historical messages for a chat.
   * Note: This may not work in Baileys v7.0+ due to WhatsApp API changes.
   */
  async fetchHistoricalMessages(chatId: string, limit: number = 50): Promise<NormalizedMessage[]> {
    return fetchHistoricalMessages(this.sock, this.isConnected(), chatId, limit);
  }

  /** Get list of chats (conversations). Currently stubbed — see `./history.ts`. */
  async getChats(): Promise<{ id: string; name?: string; isGroup: boolean }[]> {
    return listChats(this.sock, this.isConnected());
  }

  /** Collect normalized messages from a raw Baileys batch, skipping broadcasts. */
  private normalizeAndEmit(messages: WAMessage[], label: string): void {
    const normalized: NormalizedMessage[] = [];
    for (const msg of messages) {
      if (isSkippableJid(msg.key?.remoteJid)) continue;
      const n = normalizeMessage(msg as WABaileysMessage);
      if (n !== null) normalized.push(n);
    }
    if (normalized.length > 0) {
      console.log(`[WhatsAppClient] ${label} ${normalized.length} messages`);
      this.emit('sync', {
        type: 'new_messages',
        channel: 'WHATSAPP',
        messages: normalized,
      } satisfies SyncEvent);
    }
  }

  /** Set up event handlers for the Baileys socket. */
  private setupEventHandlers(callbacks?: WhatsAppAuthCallbacks): void {
    if (this.sock === null) return;

    this.sock.ev.on('creds.update', async () => {
      if (this.saveCreds !== null) {
        this.auth.backupCredentials();
        await this.saveCreds();
      }
    });

    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update, callbacks);
    });

    this.sock.ev.on('messages.upsert', (upsert: BaileysEventMap['messages.upsert']) => {
      const isHistorical = upsert.type === 'append';
      if (isHistorical) {
        console.log(`[WhatsAppClient] Received ${upsert.messages.length} historical messages`);
      }
      this.normalizeAndEmit(
        upsert.messages,
        `Normalized (historical: ${isHistorical ? 'true' : 'false'})`
      );
    });

    this.sock.ev.on('messaging-history.set', (historySet: HistorySetPayload) => {
      this.handleHistorySync(historySet);
    });

    if (this.sock.ws !== null && this.sock.ws !== undefined) {
      this.sock.ws.on('error', (error: Error) => {
        console.error('[WhatsAppClient] WebSocket error:', error);
      });
    }
  }

  /** Handle connection state updates. */
  private handleConnectionUpdate(
    update: Partial<ConnectionState>,
    callbacks?: WhatsAppAuthCallbacks
  ): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr !== undefined && qr !== null && qr !== '') {
      console.log('[WhatsAppClient] QR code received');
      callbacks?.onQRCode(qr);
    }

    if (connection === 'open') {
      this.selfJid = this.sock?.user?.id ?? null;
      this.setConnectionState('connected');
      this.reconnectAttempts = 0;
      console.log('[WhatsAppClient] Connected');
      void callbacks?.onConnected?.();
      this.emit('sync', {
        type: 'connection_change',
        channel: 'WHATSAPP',
        connected: true,
      } satisfies SyncEvent);
    }

    if (connection === 'close') {
      this.handleConnectionClose(lastDisconnect);
    }
  }

  /** Handle the `connection === 'close'` branch of Baileys' connection.update. */
  private handleConnectionClose(lastDisconnect: ConnectionState['lastDisconnect']): void {
    const statusCode = (lastDisconnect?.error as WhatsAppConnectionCloseError | undefined)?.output
      ?.statusCode;
    const { clearCredentials, reconnect } = decideConnectionClose(
      statusCode,
      this.reconnectAttempts,
      this.maxReconnectAttempts
    );

    console.log(
      `[WhatsAppClient] Connection closed (status: ${statusCode}, clearCredentials: ${clearCredentials}, reconnect: ${reconnect})`
    );

    if (clearCredentials) {
      this.auth.clearCredentials();
      this.emit('logged_out');
    }

    if (reconnect) {
      this.reconnectAttempts++;
      // 515 is Baileys' post-pairing handshake: reconnect reusing the creds we
      // just saved. Clearing them here would undo the pairing that succeeded.
      console.log(
        `[WhatsAppClient] Restart required, reconnecting with existing credentials (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );
      // The socket is gone; drop out of 'connected' or the re-dial below trips
      // connect()'s already-connected guard and the client wedges as connected
      // with a dead socket.
      this.setConnectionState('connecting');
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.sock = null;
        this.isConnecting = false;
        this.connect(this.authCallbacks).catch((err) => {
          console.error('[WhatsAppClient] Reconnect failed:', err);
        });
      }, WHATSAPP_RECONNECT_DELAY_MS);
      return;
    }

    this.setConnectionState('disconnected');
    this.emit('sync', {
      type: 'connection_change',
      channel: 'WHATSAPP',
      connected: false,
    } satisfies SyncEvent);
  }

  /**
   * Handle historical message sync from WhatsApp. Fires during initial pairing
   * when `syncFullHistory` is true.
   */
  private handleHistorySync(historySet: HistorySetPayload): void {
    const { chats, contacts, messages, isLatest, progress, syncType } = historySet;

    console.log(
      `[WhatsAppClient] 📜 History sync received: ${messages.length} messages, ${chats.length} chats, ${contacts.length} contacts (type ${syncType ?? '?'}, progress ${progress ?? '?'}%, latest ${isLatest === true ? 'yes' : 'no'})`
    );
    // HistorySync.progress is a uint32 percent (0-100), not a fraction.
    this.emit('history', {
      syncType: typeof syncType === 'number' ? syncType : null,
      progress: typeof progress === 'number' ? progress : null,
      chats: chats.length,
      messages: messages.length,
    } satisfies WhatsAppHistoryBatch);
    if (messages.length === 0) return;

    this.normalizeAndEmit(messages, '📜 Normalized historical');
  }

  /** Set connection state. */
  private setConnectionState(state: AppConnectionState): void {
    this.connectionState = state;
  }

  /** Wait for connection to be established (resolves on open, timeout, or close). */
  private waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.sock === null) {
        reject(new Error('Socket not initialized'));
        return;
      }
      if (this.connectionState === 'connected') {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        // Don't reject - allow QR code flow to continue
        resolve();
      }, WHATSAPP_CONNECTION_TIMEOUT_MS);

      const cleanup = (): void => {
        clearTimeout(timeout);
        this.sock?.ev.off('connection.update', handler);
      };

      const handler = (update: Partial<ConnectionState>): void => {
        if (update.connection === 'open') {
          cleanup();
          resolve();
        } else if (update.connection === 'close') {
          cleanup();
          const statusCode = (
            update.lastDisconnect?.error as WhatsAppConnectionCloseError | undefined
          )?.output?.statusCode;
          if (statusCode === WHATSAPP_STATUS_LOGGED_OUT) {
            reject(new Error('WhatsApp session logged out'));
          }
          // For other close reasons, don't reject - allow reconnection
        }
      };

      this.sock.ev.on('connection.update', handler);
    });
  }
}
