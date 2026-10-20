/**
 * messaging-whatsapp: runtime layer
 *
 * Entry point for the WhatsApp messaging domain. Coordinates ONE session per
 * linked WhatsApp account (plan row I2), each with its own Baileys auth dir and
 * socket (see service.session.ts). Other domains (handlers/registry,
 * SyncManager) import WhatsAppSync from here.
 *
 *   WhatsAppSync (static facade)
 *     ├─ connect()      every linked account; pairs a new one when none is linked
 *     ├─ addAccount()   pair one more account in a fresh auth dir
 *     ├─ logout(id?)    one account (the others keep syncing) or all
 *     └─ sessions: authDir → WhatsAppAccountSession
 *
 * Rules:
 *   - No data access beyond the repo's auth stores.
 *   - No Baileys calls (sessions own their WhatsAppClient).
 */
import { createWhatsAppAuthStore, listWhatsAppAuthStores, type WhatsAppAuthStore } from './repo';
import { WhatsAppAccountSession } from './service.session';
import { WHATSAPP_FLUSH_INTERVAL_MS } from './config';
import type { WhatsAppAccountInfo, WhatsAppAuthCallbacks } from './types';

export { WhatsAppAccountSession };

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
