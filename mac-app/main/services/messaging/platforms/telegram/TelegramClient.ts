import { EventEmitter } from 'events';
import { TelegramClient as GramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { Api } from 'telegram/tl';
import { TelegramAuth } from './TelegramAuth';
import type {
  NormalizedMessage,
  SyncEvent,
  ConnectionState,
  TelegramAuthCallbacks,
} from '../../types';

// Telegram API credentials - these should be obtained from https://my.telegram.org
// For now using placeholder values that need to be configured
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';

/**
 * Auth state for tracking the authentication flow.
 */
type AuthState = 'idle' | 'awaiting_code' | 'awaiting_password' | 'authenticated';

/**
 * Telegram client using GramJS for MTProto protocol.
 * Supports real-time messages and full historical sync via getMessages API.
 */
export class TelegramClient extends EventEmitter {
  private client: GramClient | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private isConnecting: boolean = false;

  // Auth flow state
  private authState: AuthState = 'idle';
  private pendingCodeResolve: ((code: string) => void) | null = null;
  private pendingPasswordResolve: ((password: string) => void) | null = null;
  private authError: Error | null = null;
  // Monotonic auth attempt id — used to guard async callbacks from
  // mutating state when the user has since cancelled or restarted auth.
  private authAttemptId = 0;

  constructor() {
    super();
  }

  /**
   * Get current auth state.
   */
  getAuthState(): AuthState {
    return this.authState;
  }

  /**
   * Get current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Check if API credentials are configured.
   */
  static hasApiCredentials(): boolean {
    return API_ID > 0 && API_HASH.length > 0;
  }

  /**
   * Start authentication flow with phone number.
   * This initiates the auth process - Telegram will send a code to the phone.
   * The client will emit 'auth:needCode' when ready for code input.
   * @param phoneNumber - Phone number with country code (e.g., +1234567890)
   */
  async startAuth(phoneNumber: string): Promise<{ success: boolean; error?: string }> {
    if (this.isConnecting) {
      return { success: false, error: 'Already connecting' };
    }

    if (!TelegramClient.hasApiCredentials()) {
      return {
        success: false,
        error:
          'Telegram API credentials not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env',
      };
    }

    this.isConnecting = true;
    this.authState = 'idle';
    this.authError = null;
    this.setConnectionState('connecting');

    const attemptId = ++this.authAttemptId;

    try {
      const session = TelegramAuth.loadSession();

      this.client = new GramClient(session, API_ID, API_HASH, {
        connectionRetries: 5,
      });
      const authClient = this.client;

      console.log(`[TelegramClient] Starting auth for ${phoneNumber}`);

      // Start auth in background - don't await, it will wait for code/password
      authClient
        .start({
          phoneNumber: async () => {
            console.log('[TelegramClient] Phone number callback called');
            return phoneNumber;
          },
          phoneCode: async () => {
            if (attemptId !== this.authAttemptId || this.client !== authClient) {
              throw new Error('Auth attempt superseded');
            }
            console.log('[TelegramClient] Code callback called - waiting for user input');
            this.authState = 'awaiting_code';
            this.emit('auth:needCode');

            // Wait for code to be submitted via submitCode()
            return new Promise<string>((resolve) => {
              this.pendingCodeResolve = resolve;
            });
          },
          password: async () => {
            if (attemptId !== this.authAttemptId || this.client !== authClient) {
              throw new Error('Auth attempt superseded');
            }
            console.log('[TelegramClient] Password callback called - waiting for user input');
            this.authState = 'awaiting_password';
            this.emit('auth:needPassword');

            // Wait for password to be submitted via submitPassword()
            return new Promise<string>((resolve) => {
              this.pendingPasswordResolve = resolve;
            });
          },
          onError: (err) => {
            if (attemptId !== this.authAttemptId || this.client !== authClient) return;
            console.error('[TelegramClient] Auth error:', err);
            this.authError = err;
            this.emit('auth:error', err.message);
          },
        })
        .then(() => {
          if (attemptId !== this.authAttemptId || this.client !== authClient) return;
          // Auth completed successfully
          console.log('[TelegramClient] Auth completed successfully');
          this.authState = 'authenticated';
          TelegramAuth.saveSession(authClient.session as StringSession);
          this.setConnectionState('connected');
          this.setupMessageHandler();

          this.emit('auth:complete');
          this.emit('sync', {
            type: 'connection_change',
            channel: 'TELEGRAM',
            connected: true,
          } satisfies SyncEvent);
        })
        .catch((err) => {
          if (attemptId !== this.authAttemptId || this.client !== authClient) return;
          console.error('[TelegramClient] Auth failed:', err);
          this.authState = 'idle';
          this.authError = err;
          this.setConnectionState('error');
          this.emit('auth:error', err.message);
        })
        .finally(() => {
          if (attemptId !== this.authAttemptId || this.client !== authClient) return;
          this.isConnecting = false;
        });

      // Return success - the auth process has started
      // Caller should listen for auth:needCode event
      return { success: true };
    } catch (error) {
      console.error('[TelegramClient] Failed to start auth:', error);
      this.isConnecting = false;
      this.setConnectionState('error');
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Submit verification code during auth flow.
   * Call this when user enters the code received via Telegram.
   */
  submitCode(code: string): void {
    if (this.authState !== 'awaiting_code' || !this.pendingCodeResolve) {
      console.warn('[TelegramClient] submitCode called but not awaiting code');
      return;
    }

    console.log('[TelegramClient] Code submitted');
    this.pendingCodeResolve(code);
    this.pendingCodeResolve = null;
  }

  /**
   * Submit 2FA password during auth flow.
   * Call this when user enters their Telegram 2FA password.
   */
  submitPassword(password: string): void {
    if (this.authState !== 'awaiting_password' || !this.pendingPasswordResolve) {
      console.warn('[TelegramClient] submitPassword called but not awaiting password');
      return;
    }

    console.log('[TelegramClient] Password submitted');
    this.pendingPasswordResolve(password);
    this.pendingPasswordResolve = null;
  }

  /**
   * Cancel ongoing auth flow.
   */
  cancelAuth(): void {
    this.authAttemptId++;
    this.authState = 'idle';
    this.pendingCodeResolve = null;
    this.pendingPasswordResolve = null;
    this.isConnecting = false;

    if (this.client) {
      this.client.disconnect().catch(() => {});
      this.client = null;
    }

    this.setConnectionState('disconnected');
    console.log('[TelegramClient] Auth cancelled');
  }

  /**
   * Connect to Telegram.
   * @param callbacks - Auth callbacks for phone, code, and password prompts
   * @deprecated Use startAuth() instead for UI-driven flows
   */
  async connect(callbacks: TelegramAuthCallbacks): Promise<void> {
    if (this.isConnecting) {
      console.log('[TelegramClient] Already connecting');
      return;
    }

    if (this.isConnected()) {
      console.log('[TelegramClient] Already connected');
      return;
    }

    if (!TelegramClient.hasApiCredentials()) {
      throw new Error(
        'Telegram API credentials not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables.'
      );
    }

    this.isConnecting = true;
    this.setConnectionState('connecting');

    try {
      const session = TelegramAuth.loadSession();

      this.client = new GramClient(session, API_ID, API_HASH, {
        connectionRetries: 5,
      });

      // Start the client with interactive auth
      await this.client.start({
        phoneNumber: callbacks.onPhoneRequest,
        phoneCode: callbacks.onCodeRequest,
        password: callbacks.onPasswordRequest,
        onError: (err) => {
          console.error('[TelegramClient] Auth error:', err);
        },
      });

      // Save the session
      TelegramAuth.saveSession(this.client.session as StringSession);

      this.setConnectionState('connected');
      console.log('[TelegramClient] Connected');

      // Set up message handler
      this.setupMessageHandler();

      // Emit connection event
      this.emit('sync', {
        type: 'connection_change',
        channel: 'TELEGRAM',
        connected: true,
      } satisfies SyncEvent);
    } catch (error) {
      console.error('[TelegramClient] Connection error:', error);
      this.setConnectionState('error');
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Connect using existing session (no auth callbacks needed).
   */
  async connectWithExistingSession(): Promise<boolean> {
    if (!TelegramAuth.hasSession()) {
      console.log('[TelegramClient] No existing session');
      return false;
    }

    if (!TelegramClient.hasApiCredentials()) {
      console.log('[TelegramClient] API credentials not configured');
      return false;
    }

    this.isConnecting = true;
    this.setConnectionState('connecting');

    try {
      const session = TelegramAuth.loadSession();

      this.client = new GramClient(session, API_ID, API_HASH, {
        connectionRetries: 5,
      });

      await this.client.connect();

      // Check if authorized
      if (!(await this.client.isUserAuthorized())) {
        console.log('[TelegramClient] Session invalid, need re-auth');
        this.client = null;
        this.setConnectionState('disconnected');
        return false;
      }

      this.setConnectionState('connected');
      console.log('[TelegramClient] Connected with existing session');

      // Set up message handler
      this.setupMessageHandler();

      // Emit connection event
      this.emit('sync', {
        type: 'connection_change',
        channel: 'TELEGRAM',
        connected: true,
      } satisfies SyncEvent);

      return true;
    } catch (error) {
      console.error('[TelegramClient] Connection error:', error);
      this.setConnectionState('error');
      return false;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Disconnect from Telegram.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (error) {
        console.warn('[TelegramClient] Error disconnecting:', error);
      }
      this.client = null;
    }
    this.setConnectionState('disconnected');

    // Emit connection event
    this.emit('sync', {
      type: 'connection_change',
      channel: 'TELEGRAM',
      connected: false,
    } satisfies SyncEvent);
  }

  /**
   * Logout and clear session.
   */
  async logout(): Promise<void> {
    if (this.client) {
      try {
        await this.client.invoke(new Api.auth.LogOut());
      } catch (error) {
        console.warn('[TelegramClient] Error logging out:', error);
      }
    }
    await this.disconnect();
    TelegramAuth.clearSession();
    console.log('[TelegramClient] Logged out and cleared session');
  }

  /**
   * Fetch historical messages from a dialog.
   * @param dialogId - Peer ID or username
   * @param limit - Maximum messages to fetch
   * @param offsetId - Message ID to start from (for pagination)
   * @param minDate - Only fetch messages after this date (for incremental sync)
   */
  async fetchHistoricalMessages(
    dialogId: string | number,
    limit: number = 100,
    offsetId?: number,
    minDate?: Date
  ): Promise<NormalizedMessage[]> {
    if (!this.client || !this.isConnected()) {
      console.warn('[TelegramClient] Cannot fetch history - not connected');
      return [];
    }

    try {
      const minDateStr = minDate ? ` (since ${minDate.toISOString()})` : '';
      console.log(
        `[TelegramClient] Fetching ${limit} historical messages for dialog ${dialogId}${minDateStr}`
      );

      const messages = await this.client.getMessages(dialogId, {
        limit,
        offsetId,
        // GramJS offsetDate: messages older than this date (Unix timestamp in seconds)
        // We want messages NEWER than minDate, so we don't use offsetDate directly
        // Instead, we filter after fetching
      });

      const normalizedMessages: NormalizedMessage[] = [];
      const minTimestamp = minDate?.getTime() ?? 0;

      for (const msg of messages) {
        const normalized = this.normalizeMessage(msg);
        if (normalized) {
          // Filter by minDate if provided
          if (minTimestamp > 0 && normalized.timestamp.getTime() <= minTimestamp) {
            continue;
          }
          normalizedMessages.push(normalized);
        }
      }

      console.log(`[TelegramClient] Fetched ${normalizedMessages.length} historical messages`);
      return normalizedMessages;
    } catch (error) {
      console.error('[TelegramClient] Error fetching historical messages:', error);
      return [];
    }
  }

  /**
   * Get list of dialogs (chats/conversations).
   */
  async getDialogs(
    limit: number = 100
  ): Promise<{ id: string; name: string; isGroup: boolean; isChannel: boolean }[]> {
    if (!this.client || !this.isConnected()) {
      return [];
    }

    try {
      const dialogs = await this.client.getDialogs({ limit });
      return dialogs.map((dialog) => ({
        id: String(dialog.id),
        name: dialog.title || dialog.name || 'Unknown',
        isGroup: dialog.isGroup,
        isChannel: dialog.isChannel,
      }));
    } catch (error) {
      console.error('[TelegramClient] Error fetching dialogs:', error);
      return [];
    }
  }

  /**
   * Fetch all historical messages from all dialogs.
   * @param messagesPerDialog - Max messages to fetch per dialog
   * @param minDate - Only fetch messages after this date (for incremental sync)
   */
  async fetchAllHistoricalMessages(
    messagesPerDialog: number = 100,
    minDate?: Date
  ): Promise<NormalizedMessage[]> {
    if (!this.client || !this.isConnected()) {
      return [];
    }

    const allMessages: NormalizedMessage[] = [];
    const dialogs = await this.getDialogs();

    const minDateStr = minDate ? ` (since ${minDate.toISOString()})` : ' (full sync)';
    console.log(`[TelegramClient] Fetching history from ${dialogs.length} dialogs${minDateStr}`);

    for (const dialog of dialogs) {
      try {
        const messages = await this.fetchHistoricalMessages(
          dialog.id,
          messagesPerDialog,
          undefined,
          minDate
        );
        allMessages.push(...messages);
      } catch (error) {
        console.warn(`[TelegramClient] Error fetching from dialog ${dialog.id}:`, error);
      }
    }

    console.log(`[TelegramClient] Total historical messages: ${allMessages.length}`);
    return allMessages;
  }

  /**
   * Set up real-time message handler.
   */
  private setupMessageHandler(): void {
    if (!this.client) return;

    this.client.addEventHandler((event: NewMessageEvent) => {
      this.handleNewMessage(event);
    }, new NewMessage({}));

    console.log('[TelegramClient] Message handler set up');
  }

  /**
   * Handle incoming messages.
   */
  private handleNewMessage(event: NewMessageEvent): void {
    const message = event.message;
    const normalized = this.normalizeMessage(message);

    if (normalized) {
      console.log(`[TelegramClient] New message from ${normalized.contactId}`);

      this.emit('sync', {
        type: 'new_messages',
        channel: 'TELEGRAM',
        messages: [normalized],
      } satisfies SyncEvent);
    }
  }

  /**
   * Normalize a GramJS message to our NormalizedMessage format.
   */
  private normalizeMessage(msg: Api.Message): NormalizedMessage | null {
    if (!msg.id || !msg.text) return null;

    // Get peer info
    const peerId = msg.peerId;
    let contactId: string;
    let chatId: string;

    if (peerId instanceof Api.PeerUser) {
      contactId = String(peerId.userId);
      chatId = contactId;
    } else if (peerId instanceof Api.PeerChat) {
      chatId = String(peerId.chatId);
      // For group chats, sender is fromId
      const fromId = msg.fromId;
      if (fromId instanceof Api.PeerUser) {
        contactId = String(fromId.userId);
      } else {
        contactId = chatId;
      }
    } else if (peerId instanceof Api.PeerChannel) {
      chatId = String(peerId.channelId);
      const fromId = msg.fromId;
      if (fromId instanceof Api.PeerUser) {
        contactId = String(fromId.userId);
      } else {
        contactId = chatId;
      }
    } else {
      return null;
    }

    const timestamp = msg.date ? new Date(msg.date * 1000) : new Date();

    return {
      id: String(msg.id),
      text: msg.text,
      timestamp,
      isFromMe: msg.out ?? false,
      chatId,
      contactId,
      contactName: undefined, // Would need to resolve from contacts
      channel: 'TELEGRAM',
    };
  }

  /**
   * Set connection state.
   */
  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
  }
}
