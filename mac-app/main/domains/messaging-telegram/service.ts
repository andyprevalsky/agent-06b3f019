/**
 * messaging-telegram service layer.
 *
 * TelegramClient — MTProto wrapper + auth state machine + historical/real-time
 * message fetching. Emits `sync` events consumed by the runtime coordinator.
 *
 * Imports: own types, own config, own repo, own normalizer, GramJS SDK, EventEmitter.
 */
import { EventEmitter } from 'events';
import { TelegramClient as GramClient } from 'telegram';
import type { StringSession } from 'telegram/sessions';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { Api } from 'telegram/tl';
import { getErrorMessage } from '../../../shared/utils/error';
import {
  API_HASH,
  API_ID,
  CONNECTION_RETRIES,
  DEFAULT_DIALOG_LIMIT,
  DEFAULT_MESSAGES_PER_DIALOG,
} from './config';
import { normalizeTelegramMessage } from './normalizer';
import { TelegramAuth } from './repo';
import type {
  AuthState,
  ConnectionState,
  DialogSummary,
  NormalizedMessage,
  StartAuthResult,
  SyncEvent,
} from './types';

function makeGramClient(session: StringSession): GramClient {
  return new GramClient(session, API_ID, API_HASH, { connectionRetries: CONNECTION_RETRIES });
}

function dialogDisplayName(dialog: { title?: string | null; name?: string | null }): string {
  if (typeof dialog.title === 'string' && dialog.title.length > 0) return dialog.title;
  if (typeof dialog.name === 'string' && dialog.name.length > 0) return dialog.name;
  return 'Unknown';
}

/**
 * Telegram client using GramJS for MTProto protocol.
 * Supports real-time messages and full historical sync via getMessages API.
 */
export class TelegramClient extends EventEmitter {
  private client: GramClient | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private isConnecting = false;

  // Auth flow state
  private authState: AuthState = 'idle';
  private pendingCodeResolve: ((code: string) => void) | null = null;
  private pendingPasswordResolve: ((password: string) => void) | null = null;
  // Monotonic auth attempt id — guards async callbacks from mutating state when
  // the user has cancelled or restarted auth mid-flight.
  private authAttemptId = 0;

  getAuthState(): AuthState {
    return this.authState;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  static hasApiCredentials(): boolean {
    return API_ID > 0 && API_HASH.length > 0;
  }

  /**
   * Start authentication flow with phone number.
   * Telegram will send a code; the client emits `auth:needCode` when ready.
   */
  async startAuth(phoneNumber: string): Promise<StartAuthResult> {
    if (this.isConnecting) return { success: false, error: 'Already connecting' };

    if (!TelegramClient.hasApiCredentials()) {
      return {
        success: false,
        error:
          'Telegram API credentials not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env',
      };
    }

    this.isConnecting = true;
    this.authState = 'idle';
    this.setConnectionState('connecting');
    const attemptId = ++this.authAttemptId;

    try {
      this.client = makeGramClient(TelegramAuth.loadSession());
      this.runAuthStart(this.client, attemptId, phoneNumber);
      return { success: true };
    } catch (error) {
      console.error('[TelegramClient] Failed to start auth:', error);
      this.isConnecting = false;
      this.setConnectionState('error');
      return { success: false, error: getErrorMessage(error) };
    }
  }

  /**
   * Internal helper — runs the chained GramJS auth flow in the background and
   * wires resolution/rejection to the state machine + sync events.
   */
  private runAuthStart(authClient: GramClient, attemptId: number, phoneNumber: string): void {
    console.log(`[TelegramClient] Starting auth for ${phoneNumber}`);
    authClient
      .start({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () => this.awaitCode(authClient, attemptId),
        password: async () => this.awaitPassword(authClient, attemptId),
        onError: (err) => this.onAuthError(authClient, attemptId, err),
      })
      .then(() => this.onAuthSuccess(authClient, attemptId))
      .catch((err: Error) => this.onAuthFailure(authClient, attemptId, err))
      .finally(() => {
        if (attemptId === this.authAttemptId && this.client === authClient) {
          this.isConnecting = false;
        }
      });
  }

  private onAuthSuccess(authClient: GramClient, attemptId: number): void {
    if (attemptId !== this.authAttemptId || this.client !== authClient) return;
    console.log('[TelegramClient] Auth completed successfully');
    this.authState = 'authenticated';
    TelegramAuth.saveSession(authClient.session as StringSession);
    this.setConnectionState('connected');
    this.setupMessageHandler();
    this.emit('auth:complete');
    this.emitConnectionChange(true);
  }

  private onAuthFailure(authClient: GramClient, attemptId: number, err: Error): void {
    if (attemptId !== this.authAttemptId || this.client !== authClient) return;
    console.error('[TelegramClient] Auth failed:', err);
    this.authState = 'idle';
    this.setConnectionState('error');
    this.emit('auth:error', err.message);
  }

  private onAuthError(authClient: GramClient, attemptId: number, err: Error): void {
    if (attemptId !== this.authAttemptId || this.client !== authClient) return;
    console.error('[TelegramClient] Auth error:', err);
    this.emit('auth:error', err.message);
  }

  private awaitCode(authClient: GramClient, attemptId: number): Promise<string> {
    if (attemptId !== this.authAttemptId || this.client !== authClient) {
      throw new Error('Auth attempt superseded');
    }
    this.authState = 'awaiting_code';
    this.emit('auth:needCode');
    return new Promise<string>((resolve) => {
      this.pendingCodeResolve = resolve;
    });
  }

  private awaitPassword(authClient: GramClient, attemptId: number): Promise<string> {
    if (attemptId !== this.authAttemptId || this.client !== authClient) {
      throw new Error('Auth attempt superseded');
    }
    this.authState = 'awaiting_password';
    this.emit('auth:needPassword');
    return new Promise<string>((resolve) => {
      this.pendingPasswordResolve = resolve;
    });
  }

  submitCode(code: string): void {
    if (this.authState !== 'awaiting_code' || this.pendingCodeResolve === null) {
      console.warn('[TelegramClient] submitCode called but not awaiting code');
      return;
    }
    this.pendingCodeResolve(code);
    this.pendingCodeResolve = null;
  }

  submitPassword(password: string): void {
    if (this.authState !== 'awaiting_password' || this.pendingPasswordResolve === null) {
      console.warn('[TelegramClient] submitPassword called but not awaiting password');
      return;
    }
    this.pendingPasswordResolve(password);
    this.pendingPasswordResolve = null;
  }

  cancelAuth(): void {
    this.authAttemptId++;
    this.authState = 'idle';
    this.pendingCodeResolve = null;
    this.pendingPasswordResolve = null;
    this.isConnecting = false;

    if (this.client !== null) {
      this.client.disconnect().catch(() => {});
      this.client = null;
    }
    this.setConnectionState('disconnected');
  }

  async connectWithExistingSession(): Promise<boolean> {
    if (!TelegramAuth.hasSession()) return false;
    if (!TelegramClient.hasApiCredentials()) return false;

    this.isConnecting = true;
    this.setConnectionState('connecting');

    try {
      this.client = makeGramClient(TelegramAuth.loadSession());
      await this.client.connect();
      if (!(await this.client.isUserAuthorized())) {
        this.client = null;
        this.setConnectionState('disconnected');
        return false;
      }
      this.setConnectionState('connected');
      this.setupMessageHandler();
      this.emitConnectionChange(true);
      return true;
    } catch (error) {
      console.error('[TelegramClient] Connection error:', error);
      this.setConnectionState('error');
      return false;
    } finally {
      this.isConnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client !== null) {
      try {
        await this.client.disconnect();
      } catch (error) {
        console.warn('[TelegramClient] Error disconnecting:', error);
      }
      this.client = null;
    }
    this.setConnectionState('disconnected');
    this.emitConnectionChange(false);
  }

  async logout(): Promise<void> {
    if (this.client !== null) {
      try {
        await this.client.invoke(new Api.auth.LogOut());
      } catch (error) {
        console.warn('[TelegramClient] Error logging out:', error);
      }
    }
    await this.disconnect();
    TelegramAuth.clearSession();
  }

  async fetchHistoricalMessages(
    dialogId: string | number,
    limit: number = DEFAULT_MESSAGES_PER_DIALOG,
    offsetId?: number,
    minDate?: Date
  ): Promise<NormalizedMessage[]> {
    if (this.client === null || !this.isConnected()) return [];

    try {
      const messages = await this.client.getMessages(dialogId, { limit, offsetId });
      const minTimestamp = minDate?.getTime() ?? 0;
      const normalized: NormalizedMessage[] = [];

      for (const msg of messages) {
        const n = normalizeTelegramMessage(msg);
        if (n === null) continue;
        if (minTimestamp > 0 && n.timestamp.getTime() <= minTimestamp) continue;
        normalized.push(n);
      }
      return normalized;
    } catch (error) {
      console.error('[TelegramClient] Error fetching historical messages:', error);
      return [];
    }
  }

  async getDialogs(limit: number = DEFAULT_DIALOG_LIMIT): Promise<DialogSummary[]> {
    if (this.client === null || !this.isConnected()) return [];

    try {
      const dialogs = await this.client.getDialogs({ limit });
      return dialogs.map((dialog) => ({
        id: String(dialog.id),
        name: dialogDisplayName(dialog),
        isGroup: dialog.isGroup,
        isChannel: dialog.isChannel,
      }));
    } catch (error) {
      console.error('[TelegramClient] Error fetching dialogs:', error);
      return [];
    }
  }

  async fetchAllHistoricalMessages(
    messagesPerDialog: number = DEFAULT_MESSAGES_PER_DIALOG,
    minDate?: Date
  ): Promise<NormalizedMessage[]> {
    if (this.client === null || !this.isConnected()) return [];

    const all: NormalizedMessage[] = [];
    const dialogs = await this.getDialogs();

    for (const dialog of dialogs) {
      try {
        const messages = await this.fetchHistoricalMessages(
          dialog.id,
          messagesPerDialog,
          undefined,
          minDate
        );
        all.push(...messages);
      } catch (error) {
        console.warn(`[TelegramClient] Error fetching from dialog ${dialog.id}:`, error);
      }
    }
    return all;
  }

  private setupMessageHandler(): void {
    if (this.client === null) return;
    this.client.addEventHandler((event: NewMessageEvent) => {
      this.handleNewMessage(event);
    }, new NewMessage({}));
  }

  private handleNewMessage(event: NewMessageEvent): void {
    const normalized = normalizeTelegramMessage(event.message);
    if (normalized === null) return;
    this.emit('sync', {
      type: 'new_messages',
      channel: 'TELEGRAM',
      messages: [normalized],
    } satisfies SyncEvent);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
  }

  private emitConnectionChange(connected: boolean): void {
    this.emit('sync', {
      type: 'connection_change',
      channel: 'TELEGRAM',
      connected,
    } satisfies SyncEvent);
  }
}
