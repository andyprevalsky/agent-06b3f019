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
 * Progress of ONE account's running sync, as GET /api/integrations reports it
 * (`accounts[].progress`).
 *
 * `total` is null when the server does not know it yet: the bar is then
 * indeterminate and no percentage is ever invented. `eta_sec` is null when
 * unknown: the ETA text is hidden.
 */
export interface SyncProgressWire {
  pct?: number | null;
  done?: number | null;
  total?: number | null;
  /** Plural noun for the items being synced, e.g. "messages", "transactions". */
  unit?: string | null;
  eta_sec?: number | null;
}

/**
 * Normalized progress for one syncing account (see hooks/useSyncProgress).
 * `pct` is null exactly when the total is unknown (indeterminate bar).
 */
export interface SyncProgress {
  pct: number | null;
  done: number | null;
  total: number | null;
  unit: string;
  etaSec: number | null;
}

/**
 * One connected account of an integration, as GET /api/integrations reports it
 * per provider row. A browser-cookie account is one browser profile; connecting
 * again creates another account; removal is per account.
 */
export interface IntegrationAccountWire {
  accountId: string;
  label: string;
  /** Server health/sync state, e.g. `synced`, `syncing`, `needs_reconnect`, `error`. */
  state: string;
  progress?: SyncProgressWire | null;
  lastSyncAt?: string | null;
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
   * Connected accounts of this provider (multi-account backend). Absent on
   * backends that predate it; the UI then derives one account from the row.
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
