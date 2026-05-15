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
}

export type AccordionSection =
  | 'browsers'
  | 'passwords'
  | 'messagesSync'
  | 'compute'
  | 'plaid'
  | 'socials';

export type PasswordSyncType = 'chrome' | 'apple' | 'atlas';

export type MessageSyncType = 'imessage' | 'whatsapp' | 'telegram';

// ─── Plaid types (consolidated from former features/plaid) ──────────────────

export type PlaidItemStatus = 'ACTIVE' | 'DISCONNECTED' | 'REQUIRES_REAUTH' | 'ERROR';

export interface PlaidAccount {
  id: string;
  plaidAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
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
