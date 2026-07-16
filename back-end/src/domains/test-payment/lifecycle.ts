import { callOrgTool } from '../../providers/agentcard/org-runtime';
import { stripe } from '../../providers/stripe';
import { TestPaymentError } from './errors';
import * as testPaymentRepo from './repo';
import type { TestPaymentLifecycle } from './types';

type LifecyclePurchase = Awaited<
  ReturnType<typeof testPaymentRepo.findLatestPurchaseLifecycleByAgentId>
>;
type LifecycleAttention = Awaited<
  ReturnType<typeof testPaymentRepo.findAttentionRequestsByAgentId>
>;
type LoadedPurchase = NonNullable<LifecyclePurchase>;

type StripeHold = {
  id: string;
  status: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
};
type StripeRefundList = {
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
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function mcpResultRecord(result: unknown): Record<string, unknown> {
  const envelope = asRecord(result) ?? {};
  const structured = asRecord(envelope.toolResult) ?? asRecord(envelope.structuredContent);
  if (structured !== undefined) return structured;
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const text = content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  if (text !== '') {
    let parsedText: unknown;
    try {
      parsedText = JSON.parse(text);
    } catch {
      // Malformed provider JSON is a bad-gateway condition, not a raw SyntaxError.
      throw new TestPaymentError('AgentCard transfer lifecycle response was invalid', 502);
    }
    const parsed = asRecord(parsedText);
    if (parsed !== undefined) return parsed;
  }
  throw new TestPaymentError('AgentCard transfer lifecycle response was invalid', 502);
}

function integerField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TestPaymentError(`AgentCard transfer lifecycle missing ${key}`, 502);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new TestPaymentError(`AgentCard transfer lifecycle missing ${key}`, 502);
  }
  return value;
}

function attentionKind(metadata: unknown): string | null {
  const value = asRecord(metadata)?.attentionKind;
  return typeof value === 'string' && value !== '' ? value : null;
}

async function getOrgCardSummary(cardId: string): Promise<{
  status: string;
  balanceCents: number;
}> {
  const result = await callOrgTool('get_card', { card_id: cardId });
  const record = mcpResultRecord(result);
  const card = asRecord(record.card) ?? record;
  const status = card.status;
  const balanceCents = card.balanceCents ?? card.balance_cents;
  if (typeof status !== 'string' || status === '') {
    throw new TestPaymentError('AgentCard card lifecycle missing status', 502);
  }
  if (typeof balanceCents !== 'number' || !Number.isInteger(balanceCents)) {
    throw new TestPaymentError('AgentCard card lifecycle missing balanceCents', 502);
  }
  return { status, balanceCents };
}

function buildAttention(attentionRequests: LifecycleAttention): TestPaymentLifecycle['attention'] {
  const kinds = attentionRequests
    .map((request) => ({
      kind: attentionKind(request.metadata),
      open: request.userResponse === null,
    }))
    .filter((entry): entry is { kind: string; open: boolean } => entry.kind !== null);
  return {
    openKinds: kinds.filter((entry) => entry.open).map((entry) => entry.kind),
    resolvedKinds: kinds.filter((entry) => !entry.open).map((entry) => entry.kind),
  };
}

function resolveDependencies(
  dependencies: TestPaymentLifecycleDependencies
): Required<
  Pick<
    TestPaymentLifecycleDependencies,
    'getCardSummary' | 'retrieveStripeHold' | 'listStripeRefunds' | 'listOrgTransfers'
  >
> {
  return {
    getCardSummary:
      dependencies.getCardSummary ??
      ((_userId: string, cardId: string) => getOrgCardSummary(cardId)),
    retrieveStripeHold:
      dependencies.retrieveStripeHold ??
      ((paymentIntentId: string) => stripe.paymentIntents.retrieve(paymentIntentId)),
    listStripeRefunds:
      dependencies.listStripeRefunds ??
      ((paymentIntentId: string) =>
        stripe.refunds.list({ payment_intent: paymentIntentId, limit: 10 })),
    listOrgTransfers:
      dependencies.listOrgTransfers ?? ((args) => callOrgTool('list_transfers', args)),
  };
}

function mapStripeHold(hold: StripeHold | null): TestPaymentLifecycle['stripeHold'] {
  if (hold === null) return null;
  return {
    id: hold.id,
    status: hold.status,
    amountCents: hold.amount,
    amountCapturableCents: hold.amount_capturable,
    amountReceivedCents: hold.amount_received,
  };
}

function mapStripeRefund(refunds: StripeRefundList): TestPaymentLifecycle['stripeRefund'] {
  // Prefer a succeeded refund (the happy path), but still surface a failed or
  // pending refund when that is all that exists — reporting `null` there would
  // make a broken refund indistinguishable from no refund at all.
  const refund =
    refunds.data.find((entry) => entry.status === 'succeeded') ?? refunds.data[0] ?? null;
  if (refund === null) return null;
  return {
    id: refund.id,
    status: refund.status ?? 'unknown',
    amountCents: refund.amount,
  };
}

function mapWalletFunding(purchase: LoadedPurchase): TestPaymentLifecycle['walletFunding'] {
  if (purchase.walletFunding === null) return null;
  return {
    status: purchase.walletFunding.status,
    amountCents: purchase.walletFunding.amountCents,
    providerTransferId: purchase.walletFunding.providerTransferId,
    reclaimProviderTransferId: purchase.walletFunding.reclaimProviderTransferId,
  };
}

function mapAgentCard(
  purchase: LoadedPurchase,
  cardDetails: { status: string; balanceCents: number } | null
): TestPaymentLifecycle['agentCard'] {
  if (cardDetails === null || purchase.cardId === null) return null;
  return {
    id: purchase.cardId,
    status: cardDetails.status,
    balanceCents: cardDetails.balanceCents,
  };
}

function transferReleasedCents(transfer: Record<string, unknown> | undefined): number {
  return typeof transfer?.released_cents === 'number' ? transfer.released_cents : 0;
}

/** Higher rank = a more terminal/settled transfer state, used as a stable tie-breaker. */
function transferStatusRank(transfer: Record<string, unknown> | undefined): number {
  switch (transfer?.status) {
    case 'consumed':
      return 3;
    case 'reclaimed':
      return 2;
    case 'released':
      return 1;
    default:
      return 0;
  }
}

function transferId(transfer: Record<string, unknown> | undefined): string {
  return typeof transfer?.id === 'string' ? transfer.id : '';
}

function mapOrgTransfer(
  purchase: LoadedPurchase,
  transferResults: unknown[]
): TestPaymentLifecycle['orgTransfer'] {
  const transfer = transferResults
    .flatMap((result) => {
      const transferRecord = mcpResultRecord(result);
      return Array.isArray(transferRecord.transfers) ? transferRecord.transfers : [];
    })
    .map((value) => asRecord(value))
    .filter((value) => value?.card_id === purchase.cardId)
    .sort((left, right) => {
      const releasedDifference = transferReleasedCents(right) - transferReleasedCents(left);
      if (releasedDifference !== 0) return releasedDifference;
      const rankDifference = transferStatusRank(right) - transferStatusRank(left);
      if (rankDifference !== 0) return rankDifference;
      // Stable ID tie-breaker keeps the selection independent of input ordering.
      return transferId(left).localeCompare(transferId(right));
    })[0];
  if (transfer === undefined) return null;
  return {
    id: stringField(transfer, 'id'),
    status: stringField(transfer, 'status'),
    amountCents: integerField(transfer, 'amount_cents'),
    transferredCents: integerField(transfer, 'transferred_cents'),
    releasedCents: integerField(transfer, 'released_cents'),
    cardId: typeof transfer.card_id === 'string' ? transfer.card_id : null,
    livemode: transfer.livemode === true,
  };
}

async function buildLoadedLifecycle(
  agentId: string,
  purchase: LoadedPurchase,
  attentionRequests: LifecycleAttention,
  dependencies: TestPaymentLifecycleDependencies
): Promise<TestPaymentLifecycle> {
  const { getCardSummary, retrieveStripeHold, listStripeRefunds, listOrgTransfers } =
    resolveDependencies(dependencies);
  const cardId = purchase.cardId;
  const intentId = purchase.stripePaymentIntentId;
  const emptyRefunds: StripeRefundList = { data: [] };
  const [cardDetails, stripeHold, stripeRefunds, transferResults] = await Promise.all([
    cardId !== null && cardId !== ''
      ? getCardSummary(purchase.userId, cardId)
      : Promise.resolve(null),
    intentId !== null && intentId !== '' ? retrieveStripeHold(intentId) : Promise.resolve(null),
    intentId !== null && intentId !== ''
      ? listStripeRefunds(intentId)
      : Promise.resolve(emptyRefunds),
    cardId !== null && cardId !== ''
      ? Promise.all([
          listOrgTransfers({ status: 'consumed', limit: 100 }),
          listOrgTransfers({ limit: 100 }),
        ])
      : Promise.resolve<unknown[]>([]),
  ]);
  return {
    agentId,
    purchase: {
      id: purchase.id,
      status: purchase.status,
      merchant: purchase.merchant,
      totalCents: purchase.totalCents,
      cardId: purchase.cardId,
      stripePaymentIntentId: purchase.stripePaymentIntentId,
    },
    walletFunding: mapWalletFunding(purchase),
    stripeHold: mapStripeHold(stripeHold),
    stripeRefund: mapStripeRefund(stripeRefunds),
    agentCard: mapAgentCard(purchase, cardDetails),
    orgTransfer: mapOrgTransfer(purchase, transferResults),
    attention: buildAttention(attentionRequests),
  };
}

export async function getTestPaymentLifecycle(
  agentId: string,
  dependencies: TestPaymentLifecycleDependencies = {}
): Promise<TestPaymentLifecycle> {
  if (agentId.trim() === '') throw new TestPaymentError('agentId is required');
  const findPurchase =
    dependencies.findPurchase ?? testPaymentRepo.findLatestPurchaseLifecycleByAgentId;
  const findAttention =
    dependencies.findAttentionRequests ?? testPaymentRepo.findAttentionRequestsByAgentId;
  const [purchase, attentionRequests] = await Promise.all([
    findPurchase(agentId),
    findAttention(agentId),
  ]);
  if (purchase === null) {
    return {
      agentId,
      purchase: null,
      walletFunding: null,
      stripeHold: null,
      stripeRefund: null,
      agentCard: null,
      orgTransfer: null,
      attention: buildAttention(attentionRequests),
    };
  }
  return buildLoadedLifecycle(agentId, purchase, attentionRequests, dependencies);
}
