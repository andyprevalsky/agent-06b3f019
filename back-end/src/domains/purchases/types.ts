import {
  PurchaseSpendStatus,
  PurchaseWalletFundingStatus,
  type PurchaseSpend,
} from '@prisma/client';

export { PurchaseSpendStatus, PurchaseWalletFundingStatus };
export type { PurchaseSpend };

export interface PurchaseLineItem {
  name: string;
  imageUrl?: string | null;
  /** Optional: the item's own product page; absent when it has none (never a cart or checkout URL). */
  productUrl?: string;
  /** Optional: shown only when the page shows a rating (any scale, as written). */
  rating?: string;
  /** Optional: shown only when the page shows a review count. */
  reviewCount?: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface PurchaseFee {
  label: string;
  amountCents: number;
}

export interface PurchaseReceipt {
  currency: string;
  lineItems: PurchaseLineItem[];
  fees: PurchaseFee[];
  subtotalCents: number;
  totalCents: number;
}

export interface MintPurchaseInput extends PurchaseReceipt {
  userId: string;
  fingerprint: string;
  merchant: string;
  agentId?: string;
  /** Reuse this approved purchase only; never admit a new financial operation. */
  reusePurchaseId?: string;
}

export interface MintPurchaseResult {
  purchaseId: string;
  cardId: string;
  pan: string;
  cvv: string;
  expiry: string;
  last4: string;
  status: PurchaseSpendStatus;
}

export interface PurchaseLookupResult {
  usageItems?: Array<Record<string, unknown>>;
  found: boolean;
  reusable: boolean;
  purchase: Pick<
    PurchaseSpend,
    | 'id'
    | 'agentId'
    | 'fingerprint'
    | 'cardId'
    | 'merchant'
    | 'totalCents'
    | 'status'
    | 'createdAt'
    | 'updatedAt'
  > | null;
}

export interface AgentCardWebhookEvent {
  type?: string;
  cardId?: string;
  card_id?: string;
  data?: {
    cardId?: string;
    card_id?: string;
    card?: { id?: string };
  };
}
