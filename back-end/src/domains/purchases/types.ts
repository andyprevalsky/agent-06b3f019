import { PurchaseSpendStatus, type PurchaseSpend } from '@prisma/client';

export { PurchaseSpendStatus };
export type { PurchaseSpend };

export interface PurchaseLineItem {
  name: string;
  imageUrl?: string | null;
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
