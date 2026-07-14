import { PurchaseWalletFundingStatus, type PurchaseSpend } from '@prisma/client';
import { createLogger } from './logger';
import * as repo from './purchase-wallet-funding-repo';
import {
  createWalletFundingProvider,
  isWalletFundingReleasePendingError,
  type WalletFundingProvider,
  WalletFundingProviderError,
} from './wallet-funding';

const log = createLogger('PurchaseWalletFunding');

export async function fundPurchaseWallet(
  purchase: PurchaseSpend,
  currency: string,
  walletFundingProvider?: WalletFundingProvider
) {
  const funding = await repo.createOrGetWalletFunding({
    purchaseId: purchase.id,
    userId: purchase.userId,
    agentId: purchase.agentId ?? undefined,
    amountCents: purchase.totalCents,
    currency,
    idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
  });

  if (
    funding.status === PurchaseWalletFundingStatus.FUNDED ||
    funding.status === PurchaseWalletFundingStatus.CONSUMED
  ) {
    return funding;
  }
  if (funding.status === PurchaseWalletFundingStatus.RECLAIMED) {
    throw new Error(`Wallet funding for purchase ${purchase.id} was already reclaimed`);
  }

  const activeProvider = walletFundingProvider ?? createWalletFundingProvider();
  try {
    const result = await activeProvider.fundUserWallet({
      userId: purchase.userId,
      agentId: purchase.agentId ?? undefined,
      purchaseId: purchase.id,
      amountCents: purchase.totalCents,
      currency,
      idempotencyKey: funding.idempotencyKey,
    });
    return repo.markWalletFundingFunded(funding.id, result);
  } catch (error) {
    await repo.markWalletFundingFailed(
      funding.id,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

export async function confirmPurchaseWalletCollection(
  purchase: PurchaseSpend,
  currency: string,
  providerTransferId: string,
  metadata: Record<string, unknown> | undefined,
  walletFundingProvider?: WalletFundingProvider
) {
  const funding = await repo.createOrGetWalletFunding({
    purchaseId: purchase.id,
    userId: purchase.userId,
    agentId: purchase.agentId ?? undefined,
    amountCents: purchase.totalCents,
    currency,
    idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
  });

  if (
    funding.status === PurchaseWalletFundingStatus.FUNDED ||
    funding.status === PurchaseWalletFundingStatus.CONSUMED
  ) {
    return funding;
  }
  if (funding.status === PurchaseWalletFundingStatus.RECLAIMED) {
    throw new Error(`Wallet funding for purchase ${purchase.id} was already reclaimed`);
  }

  const activeProvider = walletFundingProvider ?? createWalletFundingProvider();
  try {
    const result = await activeProvider.confirmCollection({
      userId: purchase.userId,
      agentId: purchase.agentId ?? undefined,
      purchaseId: purchase.id,
      amountCents: purchase.totalCents,
      currency,
      idempotencyKey: funding.idempotencyKey,
      providerTransferId,
      outcome: 'succeeded',
    });
    return repo.markWalletFundingFunded(funding.id, {
      providerTransferId: result.providerTransferId ?? providerTransferId,
      metadata: {
        ...(metadata ?? {}),
        ...(result.metadata ?? {}),
      },
    });
  } catch (error) {
    await repo.markWalletFundingFailed(
      funding.id,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

export async function recordPurchaseWalletFunding(
  purchase: PurchaseSpend,
  currency: string,
  providerTransferId: string,
  metadata: Record<string, unknown> | undefined
) {
  const funding = await repo.createOrGetWalletFunding({
    purchaseId: purchase.id,
    userId: purchase.userId,
    agentId: purchase.agentId ?? undefined,
    amountCents: purchase.totalCents,
    currency,
    idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
  });
  if (
    funding.status === PurchaseWalletFundingStatus.FUNDED ||
    funding.status === PurchaseWalletFundingStatus.CONSUMED
  ) {
    return funding;
  }
  return repo.markWalletFundingFunded(funding.id, {
    providerTransferId,
    metadata: {
      ...(metadata ?? {}),
      status: 'company_flow_transfer_recorded',
      transfer_id: providerTransferId,
    },
  });
}

export async function consumePurchaseWalletFunding(purchaseId: string): Promise<void> {
  await repo.markWalletFundingConsumed(purchaseId);
}

export async function reclaimPurchaseWalletFunding(
  purchase: Pick<PurchaseSpend, 'id' | 'userId' | 'agentId' | 'totalCents'> & {
    cardId?: string | null;
  },
  reason: string,
  walletFundingProvider?: WalletFundingProvider,
  opts: { allowConsumed?: boolean } = {}
): Promise<void> {
  const funding = await repo.findWalletFundingByPurchaseId(purchase.id);
  if (funding === null) return;
  if (
    funding.status === PurchaseWalletFundingStatus.PENDING ||
    funding.status === PurchaseWalletFundingStatus.FAILED ||
    funding.status === PurchaseWalletFundingStatus.RECLAIMED
  ) {
    return;
  }
  if (funding.status === PurchaseWalletFundingStatus.CONSUMED && opts.allowConsumed !== true) {
    log.warn('Skipping wallet funding reclaim for consumed purchase funding', {
      purchase_id: purchase.id,
      funding_id: funding.id,
      reason,
    });
    throw new WalletFundingProviderError(
      'AgentCard company transfer was consumed before reclaim started',
      409,
      'agentcard_company_transfer_consumed_during_reclaim'
    );
  }

  const reclaimIdempotencyKey =
    funding.reclaimIdempotencyKey ?? `purchase-wallet-reclaim:${purchase.id}`;
  const reclaiming = await repo.markWalletFundingReclaiming(funding.id, {
    reclaimIdempotencyKey,
    allowConsumed: opts.allowConsumed === true,
  });
  if (reclaiming.count === 0) {
    throw new WalletFundingProviderError(
      'AgentCard company transfer was consumed while reclaim started',
      409,
      'agentcard_company_transfer_consumed_during_reclaim'
    );
  }
  const activeProvider = walletFundingProvider ?? createWalletFundingProvider();
  try {
    const result = await activeProvider.reclaimUserWalletFunding({
      userId: purchase.userId,
      agentId: purchase.agentId ?? undefined,
      purchaseId: purchase.id,
      amountCents: purchase.totalCents,
      currency: funding.currency,
      idempotencyKey: reclaimIdempotencyKey,
      providerTransferId: funding.providerTransferId ?? undefined,
      ...(purchase.cardId !== undefined && purchase.cardId !== null
        ? { cardId: purchase.cardId }
        : {}),
      reason,
    });
    const reclaimed = await repo.markWalletFundingReclaimed(funding.id, result);
    if (reclaimed.count === 0) {
      throw new WalletFundingProviderError(
        'AgentCard company transfer was consumed while reclaim completed',
        409,
        'agentcard_company_transfer_consumed_during_reclaim'
      );
    }
  } catch (error) {
    if (isWalletFundingReleasePendingError(error)) throw error;
    await repo.markWalletFundingReclaimFailed(
      funding.id,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}
