/**
 * messaging-whatsapp: runtime layer
 *
 * Entry point for the WhatsApp messaging domain. Coordinates ONE session per
 * linked WhatsApp account (plan row I2): its own Baileys auth dir and socket
 * (service layer), message buffer, backend uploads attributed to the account,
 * and history-sync progress. Other domains (handlers/registry, SyncManager)
 * import WhatsAppSync from here.
 *
 *   WhatsAppSync (static facade)
 *     ├─ connect()      every linked account; pairs a new one when none is linked
 *     ├─ addAccount()   pair one more account in a fresh auth dir
 *     ├─ logout(id?)    one account (the others keep syncing) or all
 *     └─ sessions: authDir → WhatsAppAccountSession
 *            client ─sync──► buffer ─flush──► POST /whatsapp/upload {accountId}
 *            client ─history► WhatsAppHistoryProgress ─► POST .../accounts/:id/progress
 *
 * Rules:
 *   - No data access beyond the repo's auth stores.
 *   - No Baileys calls (delegates to service via WhatsAppClient).
 *   - Calls the cross-cutting providers: AuthService, Uploader, IntegrationCache,
 *     MessageTransformer.
 *
 * Import-path note: WhatsAppClient is imported through the legacy
 * `main/services/messaging/platforms/whatsapp/WhatsAppClient` shim so that
 * existing blackbox tests — which `vi.mock(...)` that exact path — intercept
 * the Baileys boundary as designed.
 */
import { AuthService } from '../../services/auth';
import { Uploader } from '../../services/uploader';
import { MessageTransformer } from '../../services/messaging/MessageTransformer';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { sessionForLocalMachineData } from '../../base/impersonation';
import { WhatsAppClient } from '../../services/messaging/platforms/whatsapp/WhatsAppClient';
import { jidToPhone } from './normalize';
import { createWhatsAppAuthStore, listWhatsAppAuthStores, type WhatsAppAuthStore } from './repo';
import { toPct, WhatsAppHistoryProgress } from './service.progress';
import {
  WHATSAPP_FLUSH_INTERVAL_MS,
  WHATSAPP_HISTORY_FULL,
  WHATSAPP_HISTORY_IDLE_MS,
  WHATSAPP_HISTORY_PHASES,
  WHATSAPP_INTEGRATION_NAME,
  WHATSAPP_MAX_BUFFER_SIZE,
} from './config';
import type {
  NormalizedMessage,
  SyncEvent,
  WhatsAppAccountInfo,
  WhatsAppAuthCallbacks,
  WhatsAppHistoryBatch,
  WhatsAppProgressWrite,
} from './types';

const LOGGED_OUT_ERROR = 'WhatsApp logged this device out; link it again';

async function machineToken(): Promise<string | null> {
  return sessionForLocalMachineData(await AuthService.getSession())?.access_token ?? null;
}

async function postProgress(accountId: string, body: WhatsAppProgressWrite) {
  const token = await machineToken();
  if (token === null) return { kind: 'failed' as const };
  return Uploader.reportIntegrationProgress(WHATSAPP_INTEGRATION_NAME, accountId, body, token);
}

/** One WhatsApp account: auth dir, socket, upload buffer and history progress. */
export class WhatsAppAccountSession {
  client: WhatsAppClient | null = null;
  private buffer: NormalizedMessage[] = [];
  private progress: WhatsAppHistoryProgress | null = null;
  private linkedId: string | null = null;
  private registration: Promise<void> | null = null;
  private historyIdle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly auth: WhatsAppAuthStore,
    private readonly onLinked: (session: WhatsAppAccountSession) => Promise<void>,
    private readonly onEnded: (session: WhatsAppAccountSession) => void
  ) {}

  /** The account's E.164 phone; null until the account is linked. */
  get accountId(): string | null {
    return (
      this.linkedId ?? jidToPhone(this.client?.getSelfJid()) ?? this.auth.getLinkedPhoneNumber()
    );
  }

  isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  async connect(callbacks?: WhatsAppAuthCallbacks): Promise<void> {
    if (this.client === null) {
      this.client = new WhatsAppClient(this.auth);
      this.client.on('sync', (event: SyncEvent) => {
        this.handleSyncEvent(event).catch((err) => {
          console.error('[WhatsAppSync] Error handling sync event:', err);
        });
      });
      this.client.on('history', (batch: WhatsAppHistoryBatch) => this.handleHistory(batch));
      this.client.on('logged_out', () => this.handleLoggedOut());
    }
    await this.client.connect({
      onQRCode: (qr: string) => callbacks?.onQRCode(qr),
      onConnected: async () => {
        await this.register();
        await callbacks?.onConnected?.();
      },
    });
    // Already-paired path: the socket can open before `onConnected` is wired.
    // (A 401 during connect ends the session and drops the client.)
    if (this.client?.isConnected() === true) await this.register();
  }

  /**
   * Mark this account CONNECTED in the backend, once per session; every caller
   * awaits the same registration. The uploader refuses to flush until the row
   * exists, and it is otherwise only created by an upload.
   */
  private register(): Promise<void> {
    this.registration ??= this.registerOnce();
    return this.registration;
  }

  private async registerOnce(): Promise<void> {
    const accountId = this.accountId;
    if (accountId !== null) {
      this.linkedId = accountId;
      this.progress ??= new WhatsAppHistoryProgress(accountId, postProgress);
      await this.onLinked(this);
    }
    try {
      const session = await AuthService.getSession();
      if (session === null) {
        console.log('[WhatsAppSync] Skipping backend registration - not authenticated');
        return;
      }
      const account = accountId === null ? null : { accountId, label: accountId };
      const result = await Uploader.registerWhatsAppConnected(session.access_token, account);
      if (result.success) {
        IntegrationCache.invalidate(); // the next flush's connected-check sees the row
      } else {
        console.error('[WhatsAppSync] Failed to register integration:', result.message);
      }
    } catch (err) {
      console.error('[WhatsAppSync] Error registering integration:', err);
    }
  }

  private handleHistory(batch: WhatsAppHistoryBatch): void {
    const phase =
      batch.syncType === null ? null : (WHATSAPP_HISTORY_PHASES[batch.syncType] ?? null);
    this.progress?.batch(phase, toPct(batch.progress));
    if (this.historyIdle !== null) clearTimeout(this.historyIdle);
    const finished = batch.syncType === WHATSAPP_HISTORY_FULL && (batch.progress ?? 0) >= 100;
    this.historyIdle = setTimeout(
      () => {
        this.historyIdle = null;
        void this.completeHistory();
      },
      finished ? 0 : WHATSAPP_HISTORY_IDLE_MS
    );
  }

  /** History is complete once nothing new arrived and every message is saved. */
  private async completeHistory(): Promise<void> {
    await this.flush();
    if (this.buffer.length === 0) this.progress?.finish('synced');
  }

  private handleLoggedOut(): void {
    this.progress?.finish('needs_reconnect', LOGGED_OUT_ERROR);
    this.stopTimers();
    this.buffer = [];
    this.client = null;
    this.onEnded(this);
  }

  private async handleSyncEvent(event: SyncEvent): Promise<void> {
    if (event.type === 'error') {
      console.error('[WhatsAppSync] Sync error:', event.error);
      return;
    }
    if (event.type === 'connection_change') {
      console.log(`[WhatsAppSync] Connection changed: ${event.connected === true ? 'up' : 'down'}`);
      return;
    }
    if (
      event.type === 'new_messages' &&
      event.messages !== undefined &&
      event.messages.length > 0
    ) {
      this.buffer.push(...event.messages);
      if (this.buffer.length >= WHATSAPP_MAX_BUFFER_SIZE) await this.flush();
    }
  }

  /** Upload the buffered messages, attributed to this account. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!(await IntegrationCache.isConnected(WHATSAPP_INTEGRATION_NAME))) {
      console.log('[WhatsAppSync] Skipping upload - integration not connected');
      return;
    }
    const token = await machineToken();
    if (token === null) {
      console.log('[WhatsAppSync] Skipping upload - not authenticated');
      return;
    }
    const messages = this.buffer;
    this.buffer = [];
    const contacts = MessageTransformer.toContactWithMessages(messages);
    const result = await Uploader.uploadWhatsAppContacts(contacts, token, this.accountId);
    if (result.success) {
      this.progress?.saved(messages.length);
      return;
    }
    console.error('[WhatsAppSync] Upload failed:', result.message);
    // Re-queue on failure, bounded so a dead backend cannot grow memory forever.
    if (this.buffer.length + messages.length <= WHATSAPP_MAX_BUFFER_SIZE * 2) {
      this.buffer.unshift(...messages);
    }
  }

  private stopTimers(): void {
    if (this.historyIdle !== null) clearTimeout(this.historyIdle);
    this.historyIdle = null;
    this.progress?.stop();
  }

  async disconnect(): Promise<void> {
    await this.flush();
    this.stopTimers();
    await this.client?.disconnect();
    this.client = null;
    // An abandoned pairing leaves an empty slot dir behind; drop it.
    if (!this.auth.hasCredentials()) this.auth.clearCredentials();
  }

  /** Close the socket and delete this account's credentials (other accounts are untouched). */
  async logout(): Promise<void> {
    this.stopTimers();
    this.buffer = [];
    if (this.client !== null) await this.client.logout();
    else this.auth.clearCredentials();
    this.client = null;
  }
}

/**
 * WhatsApp sync coordinator: one {@link WhatsAppAccountSession} per account.
 */
export class WhatsAppSync {
  private static sessions = new Map<string, WhatsAppAccountSession>();
  private static flushTimer: NodeJS.Timeout | null = null;

  /** True when any account has stored credentials. */
  static hasCredentials(): boolean {
    return listWhatsAppAuthStores().length > 0;
  }

  /** The first linked account's phone number, if any. */
  static getLinkedPhoneNumber(): string | null {
    return this.listAccounts()[0]?.accountId ?? null;
  }

  /** Connected at all, or (with `accountId`) that account is connected. */
  static isConnected(accountId?: string): boolean {
    return [...this.sessions.values()].some(
      (s) => s.isConnected() && (accountId === undefined || s.accountId === accountId)
    );
  }

  /** Every linked account (legacy dir first, then pairing order). */
  static listAccounts(): WhatsAppAccountInfo[] {
    const seen = new Set<string>();
    const accounts: WhatsAppAccountInfo[] = [];
    for (const store of listWhatsAppAuthStores()) {
      const accountId = store.getLinkedPhoneNumber();
      if (accountId === null || seen.has(accountId)) continue;
      seen.add(accountId);
      const connected = this.sessions.get(store.dir)?.isConnected() ?? false;
      accounts.push({ accountId, connected });
    }
    return accounts;
  }

  /** Connect every linked account; with none linked, pair a new one (QR flow). */
  static async connect(callbacks?: WhatsAppAuthCallbacks): Promise<void> {
    const stores = listWhatsAppAuthStores();
    this.startFlushTimer();
    if (stores.length === 0) {
      const pairing = [...this.sessions.values()].find((s) => !s.auth.hasCredentials());
      if (pairing !== undefined) return pairing.connect(callbacks);
      return this.addAccount(callbacks);
    }
    await Promise.all(
      stores
        .filter((store) => this.sessions.get(store.dir)?.isConnected() !== true)
        .map((store) => this.sessionFor(store).connect(callbacks))
    );
    console.log(`[WhatsAppSync] ${this.sessions.size} account(s) connected and listening`);
  }

  /** Pair one more account in its own auth dir; resolves once its socket opens. */
  static async addAccount(callbacks?: WhatsAppAuthCallbacks): Promise<void> {
    this.startFlushTimer();
    await this.sessionFor(createWhatsAppAuthStore()).connect(callbacks);
  }

  /** Disconnect every account (credentials are kept). */
  static async disconnect(): Promise<void> {
    this.stopFlushTimer();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.disconnect()));
    console.log('[WhatsAppSync] Disconnected');
  }

  /** Log out one account (others keep syncing) or, without `accountId`, all of them. */
  static async logout(accountId?: string): Promise<void> {
    const targets = [...this.sessions.values()].filter(
      (s) => accountId === undefined || s.accountId === accountId
    );
    for (const session of targets) {
      this.sessions.delete(session.auth.dir);
      await session.logout();
    }
    for (const store of listWhatsAppAuthStores()) {
      if (accountId === undefined || store.getLinkedPhoneNumber() === accountId) {
        store.clearCredentials();
      }
    }
    if (this.sessions.size === 0) this.stopFlushTimer();
    console.log(`[WhatsAppSync] Logged out ${accountId ?? 'all accounts'}`);
  }

  /**
   * Historical messages arrive through `messaging-history.set` during the
   * initial connection sync (syncFullHistory), so there is nothing to pull.
   */
  static async syncHistorical(): Promise<number> {
    if (!this.isConnected()) {
      console.log('[WhatsAppSync] Cannot sync historical - not connected');
      return 0;
    }
    console.log('[WhatsAppSync] Historical sync relies on initial connection sync');
    return 0;
  }

  private static sessionFor(store: WhatsAppAuthStore): WhatsAppAccountSession {
    const existing = this.sessions.get(store.dir);
    if (existing !== undefined) return existing;
    const session = new WhatsAppAccountSession(
      store,
      (linked) => this.dropDuplicates(linked),
      (ended) => {
        if (this.sessions.get(ended.auth.dir) === ended) this.sessions.delete(ended.auth.dir);
      }
    );
    this.sessions.set(store.dir, session);
    return session;
  }

  /** Re-pairing a phone that is already linked: the newest pairing wins. */
  private static async dropDuplicates(linked: WhatsAppAccountSession): Promise<void> {
    for (const other of [...this.sessions.values()]) {
      if (other !== linked && other.accountId === linked.accountId) {
        this.sessions.delete(other.auth.dir);
        await other.logout();
      }
    }
  }

  private static startFlushTimer(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        session.flush().catch((err) => console.error('[WhatsAppSync] Flush error:', err));
      }
    }, WHATSAPP_FLUSH_INTERVAL_MS);
  }

  private static stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
