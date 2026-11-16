import { PurchaseSpendStatus, type Prisma } from '@prisma/client';
import { runTransactionWithRetry } from '../../providers/database';
import { lockPurchaseAgentAdmission } from './repoAgentAdmission';
import { canonicalStoredPurchaseFingerprint } from './fingerprint';
import {
  ownerLifecycleBenchmarkBilling,
  type OwnerLifecycleBilling,
} from '../../providers/ownerLifecycleBilling';

const PURCHASE_OPEN_LOCK_SEED = 4_951_887;
const ACTIVE_PURCHASE_STATUSES = [
  PurchaseSpendStatus.PENDING_APPROVAL,
  PurchaseSpendStatus.CHARGING,
  PurchaseSpendStatus.FUNDING_PENDING,
  PurchaseSpendStatus.FUNDING_ABANDONED,
  PurchaseSpendStatus.HELD,
  PurchaseSpendStatus.CAPTURE_FAILED,
  PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
  PurchaseSpendStatus.REFUND_FAILED,
];

/**
 * Serialize first-open for one canonical cart. The earlier read is only an optimization: this
 * transaction re-checks active rows while holding a per-user/cart advisory lock, so two first
 * requests cannot create different PurchaseSpend/Stripe/AgentCard idempotency keys.
 */
interface PendingPurchaseData {
  userId: string;
  agentId?: string;
  fingerprint: string;
  canonicalFingerprint: string;
  merchant: string;
  lineItemsJson: unknown;
  totalCents: number;
}

type BillingSnapshot = Pick<
  Prisma.PurchaseSpendUncheckedCreateInput,
  'stripeLivemode' | 'stripeCustomerId' | 'stripeSubscriptionId'
>;

/** The owner's production lifecycle probe bills its dedicated live customer, never its Subscription. */
function billingSnapshot(
  ownerBilling: OwnerLifecycleBilling | null,
  subscription: {
    stripeLivemode: boolean;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
  } | null
): BillingSnapshot {
  if (ownerBilling !== null) {
    return {
      stripeLivemode: true,
      stripeCustomerId: ownerBilling.stripeCustomerId,
      stripeSubscriptionId: null,
    };
  }
  return {
    stripeLivemode: subscription?.stripeLivemode ?? false,
    stripeCustomerId: subscription?.stripeCustomerId ?? null,
    stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
  };
}

export async function createPendingPurchaseWithLock(data: PendingPurchaseData) {
  const agentId =
    data.agentId !== undefined && data.agentId.trim() !== '' ? data.agentId.trim() : undefined;
  // Resolved outside the transaction (providers/ownerLifecycleBilling.ts).
  const ownerBilling = await ownerLifecycleBenchmarkBilling(data.userId, agentId);
  return runTransactionWithRetry(async (transaction) => {
    // Deletion seals this same generation. Either the purchase is visible to
    // cleanup before the seal commits, or this admission is rejected.
    await lockPurchaseAgentAdmission(transaction, { userId: data.userId, agentId });
    const lockKey = `${data.userId}:${data.canonicalFingerprint}`;
    await transaction.$queryRaw`
      WITH acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended(${lockKey}, ${PURCHASE_OPEN_LOCK_SEED})
        )
      )
      SELECT 1 AS locked FROM acquired
    `;
    // Active rows are agent-scoped, but legacy null-agent rows still count for this cart so we do
    // not mint a second live card. Another agent's HELD/PENDING row stays excluded.
    const existing = await transaction.purchaseSpend.findFirst({
      where: {
        userId: data.userId,
        status: { in: ACTIVE_PURCHASE_STATUSES },
        AND: [
          {
            OR: [
              { fingerprint: data.fingerprint },
              { canonicalFingerprint: data.canonicalFingerprint },
            ],
          },
          ...(agentId !== undefined ? [{ OR: [{ agentId }, { agentId: null }] }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (existing !== null) return { created: false as const, purchase: existing };
    // Canonicalization can improve between deployments while a card is still open. Recompute
    // active receipts under the same lock so a new spelling cannot mint a second live card.
    const candidates = await transaction.purchaseSpend.findMany({
      where: {
        userId: data.userId,
        totalCents: data.totalCents,
        status: { in: ACTIVE_PURCHASE_STATUSES },
        ...(agentId !== undefined ? { OR: [{ agentId }, { agentId: null }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const recanonicalized = candidates.find(
      (candidate) =>
        canonicalStoredPurchaseFingerprint({
          userId: candidate.userId,
          merchant: candidate.merchant,
          lineItemsJson: candidate.lineItemsJson,
          totalCents: candidate.totalCents,
        }) === data.canonicalFingerprint
    );
    if (recanonicalized !== undefined) {
      const purchase = await transaction.purchaseSpend.update({
        where: { id: recanonicalized.id },
        data: { canonicalFingerprint: data.canonicalFingerprint },
      });
      return { created: false as const, purchase };
    }
    const subscription = await transaction.subscription.findUnique({
      where: { userId: data.userId },
    });
    const purchase = await transaction.purchaseSpend.create({
      data: {
        userId: data.userId,
        ...billingSnapshot(ownerBilling, subscription),
        agentId,
        fingerprint: data.fingerprint,
        canonicalFingerprint: data.canonicalFingerprint,
        merchant: data.merchant,
        lineItemsJson: data.lineItemsJson as Prisma.InputJsonValue,
        totalCents: data.totalCents,
        status: PurchaseSpendStatus.PENDING_APPROVAL,
      },
    });
    return { created: true as const, purchase };
  });
}
