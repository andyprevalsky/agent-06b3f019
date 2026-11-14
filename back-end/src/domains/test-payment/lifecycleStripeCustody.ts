import { getStripeClientForLivemode } from '../../providers/stripe';
import { TestPaymentError } from './errors';
import { findStripePurchasesByAgentId } from './repo';
import type { StripeIntentCustody } from './types';

type BillingPurchase = Awaited<ReturnType<typeof findStripePurchasesByAgentId>>[number];
type Intent = {
  id: string;
  livemode: boolean;
  customer: string | { id: string } | null;
  status: string;
  amount: number;
  amount_received: number;
  amount_capturable: number;
  currency: string;
  metadata: Record<string, string>;
};
type Refund = {
  id: string;
  amount: number;
  status: string | null;
  payment_intent: string | { id: string } | null;
};
type Client = {
  paymentIntents: {
    retrieve: (id: string) => Promise<Intent>;
    list: (args: { customer: string; limit: number; starting_after?: string }) => Promise<{
      data: Array<Pick<Intent, 'id' | 'livemode' | 'customer' | 'metadata'>>;
      has_more: boolean;
    }>;
  };
  refunds: {
    list: (args: { payment_intent: string; limit: number; starting_after?: string }) => Promise<{
      data: Refund[];
      has_more: boolean;
    }>;
  };
};
export interface StripeCustodyDependencies {
  includeStripeCustody?: boolean;
  findStripePurchases?: (agentId: string) => Promise<BillingPurchase[]>;
  getCustodyStripeClient?: (livemode: boolean) => Client;
}
function refuse(message: string): never {
  throw new TestPaymentError(`Stripe custody ${message}`, 502);
}
const cents = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const linkedId = (value: string | { id: string } | null) =>
  typeof value === 'string' ? value : value?.id;

async function successfulRefunds(client: Client, intent: Intent): Promise<number> {
  let cursor: string | undefined;
  const rows = new Map<string, Refund>();
  for (let page = 0; page < 20; page++) {
    const result = await client.refunds.list({
      payment_intent: intent.id,
      limit: 100,
      ...(cursor !== undefined ? { starting_after: cursor } : {}),
    });
    if (!Array.isArray(result.data) || typeof result.has_more !== 'boolean')
      refuse('refund pagination invalid');
    for (const refund of result.data) {
      if (
        !refund.id ||
        rows.has(refund.id) ||
        linkedId(refund.payment_intent) !== intent.id ||
        !cents(refund.amount) ||
        refund.amount === 0
      )
        refuse('refund identity or amount mismatch');
      if (!['succeeded', 'failed', 'canceled'].includes(refund.status ?? ''))
        refuse('refund pending or unknown');
      rows.set(refund.id, refund);
    }
    if (!result.has_more) {
      const total = [...rows.values()]
        .filter((row) => row.status === 'succeeded')
        .reduce((sum, row) => sum + row.amount, 0);
      if (!cents(total) || total > intent.amount_received) refuse('refund total invalid');
      return total;
    }
    const next = result.data.at(-1)?.id;
    if (typeof next !== 'string' || next === '' || next === cursor)
      refuse('refund pagination did not advance');
    cursor = next;
  }
  return refuse('refund pagination exceeded limit');
}
async function inventory(
  client: Client,
  agentId: string,
  userId: string,
  customerId: string,
  mode: boolean
): Promise<Set<string>> {
  const ids = new Set<string>();
  const listed = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await client.paymentIntents.list({
      customer: customerId,
      limit: 100,
      ...(cursor !== undefined ? { starting_after: cursor } : {}),
    });
    if (!Array.isArray(result.data) || typeof result.has_more !== 'boolean')
      refuse('inventory pagination invalid');
    for (const intent of result.data) {
      if (
        typeof intent.id !== 'string' ||
        intent.id === '' ||
        listed.has(intent.id) ||
        intent.livemode !== mode ||
        linkedId(intent.customer) !== customerId ||
        typeof intent.metadata !== 'object' ||
        intent.metadata === null ||
        Array.isArray(intent.metadata)
      )
        refuse('inventory identity, mode or customer mismatch');
      listed.add(intent.id);
      if (intent.metadata.agentId !== agentId) continue;
      if (intent.metadata.userId !== userId) refuse('inventory user identity mismatch');
      ids.add(intent.id);
    }
    if (!result.has_more) return ids;
    const next = result.data.at(-1)?.id;
    if (typeof next !== 'string' || next === '' || next === cursor)
      refuse('inventory pagination did not advance');
    cursor = next;
  }
  return refuse('inventory pagination exceeded limit');
}

async function observePurchase(
  purchase: BillingPurchase,
  client: Client,
  agentId: string
): Promise<StripeIntentCustody> {
  const id = purchase.stripePaymentIntentId!;
  const intent = await client.paymentIntents.retrieve(id);
  if (
    intent.id !== id ||
    intent.livemode !== purchase.stripeLivemode ||
    linkedId(intent.customer) !== purchase.stripeCustomerId ||
    intent.amount !== purchase.totalCents ||
    intent.currency !== 'usd' ||
    intent.metadata?.purchaseSpendId !== purchase.id ||
    intent.metadata?.userId !== purchase.userId ||
    intent.metadata?.agentId !== agentId ||
    !cents(intent.amount_received) ||
    !cents(intent.amount_capturable) ||
    intent.amount_received > intent.amount ||
    intent.amount_capturable !== 0
  )
    refuse('intent identity, mode, customer or exposure mismatch');
  let outcome: StripeIntentCustody['outcome'];
  let refundedCents = 0;
  if (
    purchase.status === 'CLEARED' &&
    intent.status === 'succeeded' &&
    intent.amount_received === purchase.totalCents
  ) {
    refundedCents = await successfulRefunds(client, intent);
    if (refundedCents !== 0) refuse('cleared purchase has returned Stripe funds');
    outcome = 'paid';
  } else if (['FAILED', 'VOIDED', 'REFUNDED'].includes(purchase.status)) {
    if (
      ['canceled', 'requires_payment_method'].includes(intent.status) &&
      intent.amount_received === 0
    )
      outcome = 'unspent';
    else if (intent.status === 'succeeded' && intent.amount_received > 0) {
      refundedCents = await successfulRefunds(client, intent);
      if (refundedCents !== intent.amount_received)
        refuse('refund does not prove full returned funds');
      outcome = 'refunded';
    } else return refuse('terminal purchase has unresolved exposure');
  } else return refuse('purchase is not financially terminal');
  return {
    purchaseId: purchase.id,
    userId: purchase.userId,
    agentId,
    purchaseStatus: purchase.status,
    paymentIntentId: id,
    customerId: purchase.stripeCustomerId!,
    livemode: intent.livemode,
    status: intent.status,
    currency: intent.currency,
    amountCents: intent.amount,
    amountReceivedCents: intent.amount_received,
    amountCapturableCents: intent.amount_capturable,
    refundedCents,
    outcome,
  };
}

/** Read-only financial evidence; local terminal flags alone never prove Stripe custody. */
export async function observeStripeCustody(
  agentId: string,
  dependencies: StripeCustodyDependencies = {}
): Promise<StripeIntentCustody[]> {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) refuse('agent identity invalid');
  const purchases = await (dependencies.findStripePurchases ?? findStripePurchasesByAgentId)(
    agentId
  );
  if (purchases.length > 100) refuse('purchase coverage exceeded limit');
  const clientFor = dependencies.getCustodyStripeClient ?? getStripeClientForLivemode;
  const observations: StripeIntentCustody[] = [];
  const ids = new Set<string>();
  const purchaseIds = new Set<string>();
  const owners = new Set(purchases.map((row) => row.userId));
  if (owners.size > 1) refuse('purchase owner mismatch');
  for (const purchase of purchases) {
    const id = purchase.stripePaymentIntentId;
    if (
      typeof id !== 'string' ||
      id === '' ||
      ids.has(id) ||
      typeof purchase.id !== 'string' ||
      purchase.id === '' ||
      purchaseIds.has(purchase.id) ||
      purchase.agentId !== agentId ||
      typeof purchase.userId !== 'string' ||
      purchase.userId === '' ||
      typeof purchase.stripeCustomerId !== 'string' ||
      purchase.stripeCustomerId === '' ||
      typeof purchase.stripeLivemode !== 'boolean' ||
      !cents(purchase.totalCents) ||
      purchase.totalCents === 0
    )
      refuse('purchase identity or snapshot missing');
    ids.add(id);
    purchaseIds.add(purchase.id);
    observations.push(await observePurchase(purchase, clientFor(purchase.stripeLivemode), agentId));
  }
  const scopes = new Map(
    purchases.map((row) => [JSON.stringify([row.stripeLivemode, row.stripeCustomerId]), row])
  );
  for (const scope of scopes.values()) {
    const actual = await inventory(
      clientFor(scope.stripeLivemode),
      agentId,
      scope.userId,
      scope.stripeCustomerId!,
      scope.stripeLivemode
    );
    const expected = purchases
      .filter(
        (row) =>
          row.stripeLivemode === scope.stripeLivemode &&
          row.stripeCustomerId === scope.stripeCustomerId
      )
      .map((row) => row.stripePaymentIntentId!);
    if (actual.size !== expected.length || expected.some((id) => !actual.has(id)))
      refuse('inventory coverage differs from purchase intents');
  }

  return observations;
}
