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
  /** Running backfill of this address, when the server reports one. */
  syncProgress?: SyncProgressWire | null;
}

/**
 * Progress of ONE account's running sync, as the server reports it.
 *
 * `pct` may be omitted (derived from done/total); `eta_sec` may be omitted
 * (the client estimates it from the observed rate between refreshes).
 */
export interface SyncProgressWire {
  pct?: number | null;
  done: number;
  total: number;
  /** Plural noun for the items being synced, e.g. "messages", "transactions". */
  unit: string;
  eta_sec?: number | null;
}

/** Normalized progress for one syncing account (see hooks/useSyncProgress). */
export interface SyncProgress {
  pct: number;
  done: number;
  total: number;
  unit: string;
  etaSec: number | null;
}

/** Integrations whose accounts can report sync progress. */
export type SyncProgressProvider =
  | 'browser_cookies'
  | 'passwords'
  | 'imessage'
  | 'whatsapp'
  | 'gmail'
  | 'linkedin'
  | 'plaid';

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
  /** Running sync of this integration's single account, when the server reports one. */
  syncProgress?: SyncProgressWire | null;
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
  sync: PlaidSyncSummary & { state: PlaidSyncState; progress?: SyncProgressWire | null };
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
