/**
 * Health of ONE connected email address.
 *
 * `needs_reconnect` is terminal — only re-consent fixes it. `sync_failed` is
 * transient, so it warns without pushing the user through an OAuth flow that
 * would not have helped.
 */
export type EmailCredentialState = 'connected' | 'needs_reconnect' | 'sync_failed';

export interface EmailCredentialHealth {
  id: string;
  email: string | null;
  state: EmailCredentialState;
  lastErrorReason: string | null;
  lastFailedSyncAt: string | null;
}

/**
 * Progress of an integration's running sync, as GET /api/integrations reports
 * it (`accounts[0].progress`, lane L-CULL-INTEG).
 *
 * `total` is null when the server does not know it yet: the bar is then
 * indeterminate and no percentage is ever invented. `eta_sec` is null when
 * unknown: the ETA text is hidden.
 */
export interface SyncProgressWire {
  pct?: number | null;
  done?: number | null;
  total?: number | null;
  /** messages | chats | contacts | cookies | passwords | transactions | files | bytes | records */
  unit?: string | null;
  eta_sec?: number | null;
  /** What the sync is doing right now, e.g. "Decrypting cookies" or Gmail's `scanning`. */
  phase?: string | null;
}

/**
 * Normalized progress of one integration's sync (see hooks/useSyncProgress).
 * `pct` is null exactly when the total is unknown (indeterminate bar).
 */
export interface SyncProgress {
  pct: number | null;
  done: number | null;
  total: number | null;
  unit: string;
  etaSec: number | null;
  phase: string | null;
}

/**
 * The ONE account of an integration row (backend contract, lane L-CULL-INTEG):
 * `integrations[].accounts` holds exactly one entry and `accountsByProvider`
 * maps each provider to that same one-entry list.
 *
 * `state`: syncing | synced | idle | needs_reconnect | sync_failed | EXPIRED
 * (other strings are tolerated as legacy states).
 */
export interface IntegrationAccountWire {
  provider?: string;
  accountId: string;
  label: string | null;
  state: string;
  progress?: SyncProgressWire | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

/** `accountsByProvider` (also lists providers that have only reported progress). */
export type AccountsByProvider = Record<string, IntegrationAccountWire[]>;

/** GET /api/integrations/progress?since=<cursor> */
export interface IntegrationsProgressDelta {
  cursor: string;
  changed: boolean;
  /** Present only when something changed after `since`. */
  accountsByProvider?: AccountsByProvider;
}

/** Chip tone for one account (ConnectedAccountChip). */
export type AccountTone = 'synced' | 'syncing' | 'warning' | 'error';

/** Parsed account (hooks/integrationAccounts). */
export interface IntegrationAccount {
  accountId: string;
  label: string;
  tone: AccountTone;
  /** Raw server state, kept for titles and repair decisions. */
  state: string;
  progress: SyncProgress | null;
  lastSyncAt: string | null;
  /** Why the last sync failed / needs reconnect (null otherwise). */
  lastError: string | null;
  /** True when the server sent no label (callers show their own row label). */
  unlabeled: boolean;
}

export interface ConnectedIntegration {
  id: string;
  name: string;
  status: 'NOT_CONNECTED' | 'CONNECTED' | 'SYNCING' | 'SYNC_FAILED' | 'EXPIRED';
  isActive: boolean;
  config?: {
    connectedEmail?: string;
    connectedEmails?: string[];
    provider?: string;
    contacts?: number;
    messages?: number;
    cookieCount?: number;
    [key: string]: unknown;
  };
  lastSuccessfulSyncAt?: string;
  /**
   * The row's one account with its sync state and progress (exactly one
   * entry). Absent on backends that predate it; the UI then derives the
   * account from the row status.
   */
  accounts?: IntegrationAccountWire[] | null;
  /**
   * Per-account health. A `gmail` row fans out to N addresses, so a single
   * integration status cannot say which address broke.
   */
  emailCredentials?: EmailCredentialHealth[];
}

export interface GmailResyncResult {
  email: string;
  /** Retry cannot fix this; the client must run the OAuth connect flow. */
  needsReauth: boolean;
  state: EmailCredentialState;
  reason: string | null;
}

export type AccordionSection = 'browsers' | 'passwords' | 'messagesSync' | 'compute' | 'socials';

export type PasswordSyncType = 'chrome' | 'apple' | 'passkeys' | 'atlas';

export type MessageSyncType = 'imessage' | 'whatsapp' | 'telegram';

// ─── Plaid types (consolidated from former features/plaid) ──────────────────

export type PlaidItemStatus = 'ACTIVE' | 'DISCONNECTED' | 'REQUIRES_REAUTH' | 'ERROR';

export interface PlaidSyncSummary {
  transactionCount: number;
  postedTransactionCount: number;
  pendingTransactionCount: number;
  removedTransactionCount: number;
  dateRange: {
    from: string | null;
    to: string | null;
  };
}

export type PlaidSyncState = 'syncing' | 'synced' | 'needs_repair' | 'error';

export interface PlaidAccount {
  id: string;
  plaidAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  sync: PlaidSyncSummary;
}

export interface PlaidItem {
  id: string;
  plaidItemId: string;
  institutionId: string | null;
  institutionName: string | null;
  status: PlaidItemStatus;
  products: string[];
  createdAt: string;
  lastSyncAt: string | null;
  disconnectedAt: string | null;
  sync: PlaidSyncSummary & { state: PlaidSyncState };
  accounts: PlaidAccount[];
}

export interface PlaidLinkSuccessMetadata {
  institution: {
    institution_id: string;
    name: string;
  } | null;
  accounts: Array<{
    id: string;
    name: string;
    mask: string | null;
    type: string;
    subtype: string | null;
  }>;
  link_session_id: string;
}

export interface PlaidLinkTokenResponse {
  link_token: string;
  expiration: string;
  request_id: string;
}

/** What the Index app's webhook screen needs, from POST /api/index01/credentials. */
export interface Index01Credentials {
  webhook_url: string;
  header_name: string;
  header_value: string;
}

/** One provider quota window; `usedPct` is 0-100 as of `ComputeAccountUsage.observedAt`. */
export interface ComputeUsageWindow {
  usedPct: number;
  resetsAt: string | null;
}

/** Where the usage snapshot was read; absent on backends that predate it. */
export type ComputeUsageSource = 'response' | 'rate_limit' | 'usage_endpoint' | 'code_session';

/** Provider verdict on the request that produced the snapshot. */
export type ComputeUsageStatus = 'allowed' | 'allowed_warning' | 'rejected';

export interface ComputeAccountUsage {
  fiveHour: ComputeUsageWindow | null;
  sevenDay: ComputeUsageWindow | null;
  observedAt: string;
  source?: ComputeUsageSource | null;
  status?: ComputeUsageStatus | null;
}

export type ComputeCooldownReason =
  'usage_window_5h' | 'usage_window_7d' | 'usage_window' | 'rate_limit' | 'stall' | 'auth';

/**
 * Why the account serves nothing until `until`. `authoritative` = the time is a
 * provider-reported window reset; otherwise it is a Rose backoff (stall,
 * default cooldown) and says nothing about the quota.
 */
export interface ComputeCooldown {
  until: string;
  reason: ComputeCooldownReason;
  authoritative: boolean;
}

export interface ComputeAccount {
  provider: string;
  accountId: string;
  accountEmail: string | null;
  /** "connected" | "needs_reconnect" -- the only user-actionable state. */
  state: string;
  lastErrorReason: string | null;
  connectedAt: string;
  /** Last subscription usage an agent observed on this account; null until one is used. */
  usage: ComputeAccountUsage | null;
  /**
   * Provider cooldown: the account serves nothing until this passes. Kept for
   * older backends; `cooldown` says whether the time is authoritative.
   */
  rateLimitedUntil: string | null;
  /** Active cooldown (only while `until` > now at read time); absent on older backends. */
  cooldown?: ComputeCooldown | null;
  /** Earliest future reset among binding windows, else an authoritative cooldown's end. */
  nextResetAt?: string | null;
}

/** Meeting note taker provider and connection contracts. */
export type MeetingNotesProvider = 'granola' | 'fireflies';
export interface MeetingNotesStatus {
  connected: boolean;
  status: 'NOT_CONNECTED' | 'PENDING' | 'CONNECTED' | 'SYNCING' | 'SYNC_FAILED' | 'EXPIRED';
  accountEmail: string | null;
  backfillDone: boolean;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  documents: Partial<Record<string, number>>;
}

export interface MeetingNotesConnection {
  status: MeetingNotesStatus | null;
  busy: 'connect' | 'sync' | 'disconnect' | null;
  error: string | null;
  connect: () => Promise<void>;
  sync: () => Promise<void>;
  disconnect: () => Promise<void>;
}
export type MeetingNotesConnections = Record<MeetingNotesProvider, MeetingNotesConnection>;
export type IntegrationCatalogKey =
  | 'iphone'
  | 'browsers'
  | 'passwords'
  | 'messages'
  | 'compute'
  | 'banks'
  | 'socials'
  | 'files'
  | 'githubRepos'
  | 'meetingNotes'
  | 'pebble'
  | 'clis';
