import type * as testPaymentRepo from './repo';

export type LifecyclePurchase = Awaited<
  ReturnType<typeof testPaymentRepo.findLatestPurchaseLifecycleByAgentId>
>;
export type LifecycleAttention = Awaited<
  ReturnType<typeof testPaymentRepo.findAttentionRequestsByAgentId>
>;
export type LifecycleIntegrity = Awaited<
  ReturnType<typeof testPaymentRepo.findPurchaseLifecycleIntegrityByAgentId>
>;
export type StripeHold = {
  id: string;
  status: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
};
export type StripeRefundList = {
  data: Array<{ id: string; status: string | null; amount: number }>;
};
export type StripeHoldSearch = {
  data: Array<{ id: string }>;
  has_more?: boolean;
  next_page?: string | null;
};
export type OrgTransferStatus = 'pending' | 'funded' | 'consumed' | 'reclaimed' | 'failed';

export interface TestPaymentLifecycleDependencies {
  findPurchase?: (agentId: string) => Promise<LifecyclePurchase>;
  findAttentionRequests?: (agentId: string) => Promise<LifecycleAttention>;
  findPurchaseLifecycleIntegrity?: (agentId: string) => Promise<LifecycleIntegrity>;
  getCardSummary?: (
    userId: string,
    cardId: string
  ) => Promise<{ status: string; balanceCents: number }>;
  retrieveStripeHold?: (paymentIntentId: string) => Promise<StripeHold>;
  listStripeRefunds?: (paymentIntentId: string) => Promise<StripeRefundList>;
  listOrgTransfers?: (args: { status?: OrgTransferStatus; limit: number }) => Promise<unknown>;
  listOrgCards?: (args: {
    cardholder_id: string;
    limit: number;
    offset?: number;
  }) => Promise<unknown>;
  getOrgCardholderId?: (userId: string) => Promise<string | undefined>;
  searchStripeHolds?: (agentId: string, page?: string) => Promise<StripeHoldSearch>;
}
