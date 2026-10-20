/**
 * messaging-telegram runtime layer.
 *
 * TelegramSync — coordinator for every Telegram account on this Mac.
 *
 *   accounts: Map<telegram user id, TelegramClient>     one MTProto session per account
 *   pendingAuth: TelegramClient | null                    a login in progress (adds an account)
 *   buffers: Map<telegram user id, NormalizedMessage[]>   real-time messages, flushed per account
 *
 *   connectWithExistingSession ─► every saved account (+ legacy session migration)
 *   registerConnectedAccounts  ─► POST /telegram/connect {accountId, label, claimLegacy?}
 *   syncHistorical(accountId?) ─► per account: chat list → batches → upload + progress
 *   logout(accountId?)         ─► one account (others stay connected) or all
 *
 * Imports: own service, own repo, own config, own types, cross-domain providers
 * (AuthService, BatchUploader, MessageTransformer, IntegrationCache).
 */
import { randomUUID } from 'crypto';
import { AuthService } from '../../services/auth';
import { BatchUploader } from '../../services/batchUploader';
import { MessageTransformer } from '../../services/messaging/MessageTransformer';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { sessionForLocalMachineData } from '../../base/impersonation';
import { FLUSH_INTERVAL_MS, INTEGRATION_KEY, MAX_BUFFER_SIZE } from './config';
import { TelegramAuth } from './repo';
import { postTelegramConnect, postTelegramProgress } from './repo.backend';
import { TelegramClient } from './service';
import { syncAccountHistory } from './service.history';
import { ProgressReporter } from './service.progress';
import type {
  NormalizedMessage,
  StartAuthResult,
  SyncEvent,
  TelegramAccountSummary,
  TelegramIdentity,
} from './types';

async function machineAccessToken(): Promise<string | null> {
  const session = sessionForLocalMachineData(await AuthService.getSession());
  return session?.access_token ?? null;
}

/** Incremental cursor of one account (its Integration row's lastFrontendAccessAt). */
async function accountCursor(accountId: string): Promise<Date | undefined> {
  const row = await IntegrationCache.getIntegrationAccount(INTEGRATION_KEY, accountId);
  const value = (row?.config as { lastFrontendAccessAt?: unknown } | undefined)
    ?.lastFrontendAccessAt;
  return typeof value === 'string' && value.length > 0 ? new Date(value) : undefined;
}

/**
 * Telegram sync coordinator.
 * Manages Telegram client lifecycles, authentication, and message sync to backend.
 */
export class TelegramSync {
  private static accounts = new Map<string, TelegramClient>();
  private static pendingAuth: TelegramClient | null = null;
  private static buffers = new Map<string, NormalizedMessage[]>();
  private static flushTimer: NodeJS.Timeout | null = null;

  static hasSession(): boolean {
    return TelegramAuth.hasSession();
  }

  static hasApiCredentials(): boolean {
    return TelegramClient.hasApiCredentials();
  }

  static isConnected(): boolean {
    return [...this.accounts.values()].some((client) => client.isConnected());
  }

  /** The login in progress (for auth-event forwarding), else the first account. */
  static getClient(): TelegramClient | null {
    return this.pendingAuth ?? this.accounts.values().next().value ?? null;
  }

  /** Saved accounts with their connection state. */
  static listAccounts(): TelegramAccountSummary[] {
    return TelegramAuth.listAccountIds().map((accountId) => ({
      accountId,
      label: TelegramAuth.readAccountProfile(accountId).label,
      connected: this.accounts.get(accountId)?.isConnected() ?? false,
    }));
  }

  /**
   * Start a login with a phone number; it adds an account and leaves every
   * connected account running. Listen for 'auth:needCode', 'auth:needPassword',
   * 'auth:complete' (with {accountId, label}) and 'auth:error' on getClient().
   */
  static async startAuth(phoneNumber: string): Promise<StartAuthResult> {
    this.pendingAuth?.cancelAuth();
    const client = this.makeClient(null);
    this.pendingAuth = client;
    client.on('auth:complete', (identity: TelegramIdentity) => this.adopt(client, identity));
    return client.startAuth(phoneNumber);
  }

  static submitCode(code: string): void {
    this.pendingAuth?.submitCode(code);
  }

  static submitPassword(password: string): void {
    this.pendingAuth?.submitPassword(password);
  }

  static cancelAuth(): void {
    this.pendingAuth?.cancelAuth();
    this.pendingAuth = null;
  }

  private static adopt(client: TelegramClient, identity: TelegramIdentity): void {
    if (this.pendingAuth === client) this.pendingAuth = null;
    const previous = this.accounts.get(identity.accountId);
    if (previous !== undefined && previous !== client) {
      void previous.disconnect().catch(() => undefined);
    }
    this.accounts.set(identity.accountId, client);
    this.startFlushTimer();
  }

  /**
   * Connect every saved account (and migrate a legacy single session).
   * Resolves true when at least one account is connected.
   */
  static async connectWithExistingSession(): Promise<boolean> {
    const saved = TelegramAuth.listAccountIds().filter(
      (id) => this.accounts.get(id)?.isConnected() !== true
    );
    const candidates = saved.map((id) => this.makeClient(id));
    if (TelegramAuth.hasLegacySession()) candidates.push(this.makeClient(null));
    for (const client of candidates) {
      if (!(await client.connectWithExistingSession())) continue;
      const accountId = client.getAccountId();
      if (accountId === null) continue;
      // A legacy session of an account that is already connected: keep one session.
      if (this.accounts.get(accountId)?.isConnected() === true) await client.disconnect();
      else this.accounts.set(accountId, client);
    }
    if (this.isConnected()) this.startFlushTimer();
    return this.isConnected();
  }

  /**
   * Register every connected account with the backend (idempotent upsert). A
   * migrated legacy account claims the legacy row once. Returns accounts registered.
   */
  static async registerConnectedAccounts(): Promise<number> {
    const accessToken = await machineAccessToken();
    if (accessToken === null) return 0;
    let registered = 0;
    for (const [accountId, client] of this.accounts) {
      if (!client.isConnected()) continue;
      const profile = TelegramAuth.readAccountProfile(accountId);
      const label = client.getIdentity()?.label ?? profile.label;
      const ok = await postTelegramConnect(accessToken, {
        accountId,
        ...(label !== null && { label }),
        ...(profile.claimLegacy === true && { claimLegacy: true }),
      });
      if (!ok) continue;
      registered += 1;
      if (profile.claimLegacy === true) {
        TelegramAuth.writeAccountProfile(accountId, { label: profile.label });
      }
    }
    if (registered > 0) IntegrationCache.invalidate();
    return registered;
  }

  private static makeClient(accountId: string | null): TelegramClient {
    const client = new TelegramClient(accountId);
    client.on('sync', (event: SyncEvent) => {
      this.handleSyncEvent(client, event).catch((err) => {
        console.error('[TelegramSync] Error handling sync event:', err);
      });
    });
    return client;
  }

  static async disconnect(): Promise<void> {
    this.stopFlushTimer();
    await this.flushBuffers();
    this.pendingAuth?.cancelAuth();
    this.pendingAuth = null;
    const clients = [...this.accounts.values()];
    this.accounts.clear();
    for (const client of clients) await client.disconnect();
  }

  /** Log out one account (others stay connected), or every connected account. */
  static async logout(accountId?: string): Promise<void> {
    const ids = accountId === undefined ? [...this.accounts.keys()] : [accountId];
    for (const id of ids) {
      const client = this.accounts.get(id);
      this.accounts.delete(id);
      this.buffers.delete(id);
      if (client !== undefined) await client.logout();
      else if (accountId !== undefined) TelegramAuth.clearAccountSession(id);
    }
    if (this.accounts.size === 0) this.stopFlushTimer();
  }

  /**
   * Historical sync of one account (or every connected account) with per-batch
   * progress. Returns the number of messages uploaded.
   */
  static async syncHistorical(messagesPerDialog = 100, accountId?: string): Promise<number> {
    const integration = await IntegrationCache.getIntegration(INTEGRATION_KEY);
    if (integration === undefined || integration === null) return 0;
    if (integration.status === 'NOT_CONNECTED') return 0;
    const ids = accountId === undefined ? [...this.accounts.keys()] : [accountId];
    let uploaded = 0;
    for (const id of ids) uploaded += await this.syncAccount(id, messagesPerDialog);
    return uploaded;
  }

  private static async syncAccount(accountId: string, messagesPerDialog: number): Promise<number> {
    const client = this.accounts.get(accountId);
    if (client?.isConnected() !== true) return 0;
    const accessToken = await machineAccessToken();
    if (accessToken === null) return 0;
    const progress = new ProgressReporter(`telegram-${accountId}-${randomUUID()}`, (body) =>
      postTelegramProgress(accessToken, accountId, body)
    );
    const result = await syncAccountHistory({
      source: client,
      messagesPerDialog,
      minDate: await accountCursor(accountId),
      uploadBatch: (messages) => this.uploadMessages(accountId, messages),
      progress,
    });
    return result.messages;
  }

  /**
   * Buffer real-time messages under the account that received them.
   */
  private static async handleSyncEvent(client: TelegramClient, event: SyncEvent): Promise<void> {
    if (event.type !== 'new_messages') return;
    const accountId = client.getAccountId();
    const msgs = event.messages;
    if (accountId === null || msgs === undefined || msgs.length === 0) return;

    const buffer = this.buffers.get(accountId) ?? [];
    buffer.push(...msgs);
    this.buffers.set(accountId, buffer);
    if (buffer.length >= MAX_BUFFER_SIZE) await this.flushBuffer(accountId);
  }

  /**
   * Upload one account's messages to the backend via BatchUploader.
   */
  private static async uploadMessages(
    accountId: string,
    messages: NormalizedMessage[]
  ): Promise<boolean> {
    const accessToken = await machineAccessToken();
    if (accessToken === null) return false;

    const contacts = MessageTransformer.toContactWithMessages(messages);
    const result = await BatchUploader.uploadInBatches(
      INTEGRATION_KEY,
      { accountId, contacts },
      accessToken,
      null
    );
    return result.success;
  }

  private static async flushBuffers(): Promise<void> {
    for (const accountId of [...this.buffers.keys()]) await this.flushBuffer(accountId);
  }

  /**
   * Flush one account's message buffer to the backend.
   */
  private static async flushBuffer(accountId: string): Promise<void> {
    const messages = this.buffers.get(accountId) ?? [];
    if (messages.length === 0) return;

    const isConnected = await IntegrationCache.isConnected(INTEGRATION_KEY);
    if (!isConnected) return;

    this.buffers.set(accountId, []);
    const success = await this.uploadMessages(accountId, messages);
    const current = this.buffers.get(accountId) ?? [];
    if (!success && current.length + messages.length <= MAX_BUFFER_SIZE * 2) {
      this.buffers.set(accountId, [...messages, ...current]);
    }
  }

  private static startFlushTimer(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      this.flushBuffers().catch((err) => {
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
