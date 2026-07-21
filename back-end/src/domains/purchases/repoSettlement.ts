import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

export type SettlePurchaseClearedResult =
  | { outcome: 'cleared' }
  | {
      outcome: 'ignored';
      fundingStatus: PurchaseWalletFundingStatus | null;
    };

/**
 * Atomically consumes company funding and settles its purchase. Reclaim uses a compare-and-set
 * from FUNDED to RECLAIMING; this transaction performs the competing compare-and-set from FUNDED
 * to CONSUMED. Whichever update locks the funding row first owns the terminal transition, so a
 * late transaction.cleared webhook cannot overwrite a purchase after reclaim has started.
 */
export async function settlePurchaseAfterTransactionCleared(
  purchaseId: string
): Promise<SettlePurchaseClearedResult> {
  return prisma.$transaction(async (transaction) => {
    const funding = await transaction.purchaseWalletFunding.findUnique({
      where: { purchaseId },
      select: { status: true },
    });

    if (funding !== null) {
      const consumed = await transaction.purchaseWalletFunding.updateMany({
        where: {
          purchaseId,
          status: {
            in: [PurchaseWalletFundingStatus.FUNDED, PurchaseWalletFundingStatus.CONSUMED],
          },
        },
        data: {
          status: PurchaseWalletFundingStatus.CONSUMED,
          consumedAt: new Date(),
          errorMessage: null,
        },
      });
      if (consumed.count === 0) {
        const currentFunding = await transaction.purchaseWalletFunding.findUnique({
          where: { purchaseId },
          select: { status: true },
        });
        return {
          outcome: 'ignored',
          fundingStatus: currentFunding?.status ?? null,
        };
      }
    }

    const settled = await transaction.purchaseSpend.updateMany({
      where: {
        id: purchaseId,
        status: { notIn: [PurchaseSpendStatus.VOIDED, PurchaseSpendStatus.REFUNDED] },
      },
      data: { status: PurchaseSpendStatus.CLEARED },
    });
    if (settled.count === 0) {
      return { outcome: 'ignored', fundingStatus: funding?.status ?? null };
    }
    return { outcome: 'cleared' };
  });
}
