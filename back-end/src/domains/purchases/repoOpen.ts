import { PurchaseSpendStatus, type Prisma } from '@prisma/client';
import { runTransactionWithRetry } from '../../providers/database';

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
export async function createPendingPurchaseWithLock(data: {
  userId: string;
  agentId?: string;
  fingerprint: string;
  canonicalFingerprint: string;
  merchant: string;
  lineItemsJson: unknown;
  totalCents: number;
}) {
  const agentId =
    data.agentId !== undefined && data.agentId.trim() !== '' ? data.agentId.trim() : undefined;
  return runTransactionWithRetry(async (transaction) => {
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
    const purchase = await transaction.purchaseSpend.create({
      data: {
        userId: data.userId,
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
