/** TS types mirroring `back-end/src/domains/integrations/service.plaid.ts`. */

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
