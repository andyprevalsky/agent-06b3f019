import type * as testPaymentRepo from './repo';

export type LifecyclePurchase = Awaited<
  ReturnType<typeof testPaymentRepo.findLatestPurchaseLifecycleByAgentId>
>;
export type LifecycleAttention = Awaited<
  ReturnType<typeof testPaymentRepo.findAttentionRequestsByAgentId>
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

export interface TestPaymentLifecycleDependencies {
  findPurchase?: (agentId: string) => Promise<LifecyclePurchase>;
  findAttentionRequests?: (agentId: string) => Promise<LifecycleAttention>;
  getCardSummary?: (
    userId: string,
    cardId: string
  ) => Promise<{ status: string; balanceCents: number }>;
  retrieveStripeHold?: (paymentIntentId: string) => Promise<StripeHold>;
  listStripeRefunds?: (paymentIntentId: string) => Promise<StripeRefundList>;
  listOrgTransfers?: (args: { status?: 'consumed'; limit: number }) => Promise<unknown>;
  listOrgCards?: (args: { cardholder_id: string; limit: number }) => Promise<unknown>;
  getOrgCardholderId?: (userId: string) => Promise<string | undefined>;
  searchStripeHolds?: (agentId: string) => Promise<{ data: Array<{ id: string }> }>;
}
