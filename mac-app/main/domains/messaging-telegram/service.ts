/**
 * messaging-telegram service layer.
 *
 * TelegramClient — MTProto wrapper + auth state machine + historical/real-time
 * message fetching for ONE Telegram account. Emits `sync` events consumed by
 * the runtime coordinator.
 *
 *   new TelegramClient(null)  ── startAuth ──► login ──► identify (getMe) ──► accounts/<id>/session.txt
 *   new TelegramClient(null)  ── connectWithExistingSession ──► legacy session.txt ──► migrated to accounts/<id>/
 *   new TelegramClient(id)    ── connectWithExistingSession ──► accounts/<id>/session.txt
 *
 * `accountId` is the numeric Telegram user id; it is known after login or connect.
 *
 * Imports: own types, own config, own repo, own normalizer, GramJS SDK, EventEmitter.
 */
import { EventEmitter } from 'events';
import type { TelegramClient as GramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import { Api } from 'telegram/tl';
import { getErrorMessage } from '../../../shared/utils/error';
import { API_HASH, API_ID, DEFAULT_DIALOG_LIMIT, DEFAULT_MESSAGES_PER_DIALOG } from './config';
import { normalizeTelegramMessage } from './normalizer';
import { TelegramAuth } from './repo';
import { identifyAccount, makeGramClient, readDialogHistory, readDialogs } from './service.gram';
import type {
  AuthState,
  ConnectionState,
  DialogSummary,
  NormalizedMessage,
  StartAuthResult,
  SyncEvent,
  TelegramIdentity,
} from './types';

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
  private identity: TelegramIdentity | null = null;

  /** `accountId` = a saved account to reconnect; null = a new login or the legacy session. */
  constructor(private readonly savedAccountId: string | null = null) {
    super();
  }

  /** Telegram user id of this session, once known (after login or connect). */
  getAccountId(): string | null {
    return this.identity?.accountId ?? this.savedAccountId;
  }

  getIdentity(): TelegramIdentity | null {
    return this.identity;
  }

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
      // A login always starts from an empty session: it adds (or re-adds) an account.
      this.client = makeGramClient(new StringSession(''));
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

  private async onAuthSuccess(authClient: GramClient, attemptId: number): Promise<void> {
    if (attemptId !== this.authAttemptId || this.client !== authClient) return;
    const identity = await identifyAccount(authClient);
    if (attemptId !== this.authAttemptId || this.client !== authClient) return;
    console.log('[TelegramClient] Auth completed successfully');
    this.identity = identity;
    this.authState = 'authenticated';
    TelegramAuth.saveAccountSession(identity.accountId, authClient.session as StringSession, {
      label: identity.label,
    });
    this.setConnectionState('connected');
    this.setupMessageHandler();
    this.emit('auth:complete', identity);
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

  private savedSession(): StringSession | null {
    if (this.savedAccountId !== null) {
      const session = TelegramAuth.loadAccountSession(this.savedAccountId);
      return session.save().length > 0 ? session : null;
    }
    return TelegramAuth.hasLegacySession() ? TelegramAuth.loadSession() : null;
  }

  /** Identify the connected session; a legacy session moves into its account dir. */
  private async adoptIdentity(client: GramClient): Promise<void> {
    this.identity = await identifyAccount(client);
    if (this.savedAccountId === null) {
      TelegramAuth.adoptLegacySession(this.identity.accountId, this.identity.label);
    } else {
      const profile = TelegramAuth.readAccountProfile(this.savedAccountId);
      TelegramAuth.writeAccountProfile(this.savedAccountId, {
        ...profile,
        label: this.identity.label ?? profile.label,
      });
    }
  }

  async connectWithExistingSession(): Promise<boolean> {
    const session = this.savedSession();
    if (session === null) return false;
    if (!TelegramClient.hasApiCredentials()) return false;

    this.isConnecting = true;
    this.setConnectionState('connecting');

    try {
      this.client = makeGramClient(session);
      await this.client.connect();
      if (!(await this.client.isUserAuthorized())) {
        this.client = null;
        this.setConnectionState('disconnected');
        return false;
      }
      await this.adoptIdentity(this.client);
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
    const accountId = this.getAccountId();
    if (accountId !== null) TelegramAuth.clearAccountSession(accountId);
    else TelegramAuth.clearLegacySession();
  }

  async fetchHistoricalMessages(
    dialogId: string | number,
    limit: number = DEFAULT_MESSAGES_PER_DIALOG,
    offsetId?: number,
    minDate?: Date
  ): Promise<NormalizedMessage[]> {
    if (this.client === null || !this.isConnected()) return [];
    try {
      return await readDialogHistory(this.client, dialogId, limit, offsetId, minDate);
    } catch (error) {
      console.error('[TelegramClient] Error fetching historical messages:', error);
      return [];
    }
  }

  async getDialogs(limit: number = DEFAULT_DIALOG_LIMIT): Promise<DialogSummary[]> {
    if (this.client === null || !this.isConnected()) return [];
    try {
      return await readDialogs(this.client, limit);
    } catch (error) {
      console.error('[TelegramClient] Error fetching dialogs:', error);
      return [];
    }
  }

  /** The chat list; throws when it cannot be read (history sync source). */
  async listDialogs(): Promise<DialogSummary[]> {
    if (this.client === null || !this.isConnected()) throw new Error('Telegram is not connected');
    return readDialogs(this.client);
  }

  /** One chat's history; throws when the chat cannot be read (history sync source). */
  async fetchDialogHistory(
    dialogId: string,
    limit: number,
    minDate?: Date
  ): Promise<NormalizedMessage[]> {
    if (this.client === null || !this.isConnected()) throw new Error('Telegram is not connected');
    return readDialogHistory(this.client, dialogId, limit, undefined, minDate);
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
