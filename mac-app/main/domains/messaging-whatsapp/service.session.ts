/**
 * messaging-whatsapp: one linked account's session (plan row I2)
 *
 *   WhatsAppAccountSession = auth dir + Baileys socket (WhatsAppClient)
 *     client ─sync──► buffer ─flush──► POST /whatsapp/upload {accountId}
 *     client ─history► WhatsAppHistoryProgress ─► POST .../accounts/:id/progress
 *     client ─logged_out► needs_reconnect, session ends (other accounts untouched)
 *
 * Owned and keyed by auth dir in WhatsAppSync (runtime.ts). Calls the
 * cross-cutting providers through their legacy service shims.
 *
 * Import-path note: WhatsAppClient is imported through the legacy
 * `main/services/messaging/platforms/whatsapp/WhatsAppClient` shim so that
 * blackbox tests that `vi.mock(...)` that exact path intercept the Baileys
 * boundary as designed.
 */
import { AuthService } from '../../services/auth';
import { Uploader } from '../../services/uploader';
import { MessageTransformer } from '../../services/messaging/MessageTransformer';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { IntegrationProgress } from '../../services/integrationProgress';
import { sessionForLocalMachineData } from '../../base/impersonation';
import { WhatsAppClient } from '../../services/messaging/platforms/whatsapp/WhatsAppClient';
import { jidToPhone } from './normalize';
import { legacyWhatsAppAuthStore, type WhatsAppAuthStore } from './repo';
import { toPct, toProgressPostResult, WhatsAppHistoryProgress } from './service.progress';
import {
  WHATSAPP_HISTORY_FULL,
  WHATSAPP_HISTORY_IDLE_MS,
  WHATSAPP_HISTORY_PHASES,
  WHATSAPP_INTEGRATION_NAME,
  WHATSAPP_MAX_BUFFER_SIZE,
} from './config';
import type {
  NormalizedMessage,
  SyncEvent,
  WhatsAppAuthCallbacks,
  WhatsAppHistoryBatch,
  WhatsAppProgressWrite,
} from './types';

const LOGGED_OUT_ERROR = 'WhatsApp logged this device out; link it again';

async function machineToken(): Promise<string | null> {
  return sessionForLocalMachineData(await AuthService.getSession())?.access_token ?? null;
}

/** Progress write for one account; without a machine session (impersonating) it is dropped. */
async function postProgress(accountId: string, body: WhatsAppProgressWrite) {
  const token = await machineToken();
  if (token === null) return { kind: 'stale' as const };
  const result = await IntegrationProgress.post(WHATSAPP_INTEGRATION_NAME, accountId, body, token);
  return toProgressPostResult(result.status, result.retryAfterMs);
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
      // The legacy single auth dir's phone owns the pre-multi-account history.
      const claimLegacy = this.auth.dir === legacyWhatsAppAuthStore().dir;
      const account =
        accountId === null
          ? null
          : { accountId, label: accountId, ...(claimLegacy && { claimLegacy: true }) };
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
