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

/**
 * Atomically claim a FUNDED transfer as RECLAIMING *before* its card is closed. Closing the card
 * makes it read as not-live; without this pre-claim a concurrent cleanup pass would observe the
 * not-live card while the funding is still FUNDED, misclassify it as merchant-spent, and consume
 * the transfer — permanently draining the company float. Marking RECLAIMING first makes that pass
 * defer to the in-flight reclaim instead. No-op for any non-FUNDED row (already reclaiming,
 * consumed, terminal, or not yet funded); the subsequent `reclaimPurchaseWalletFunding` handles it.
 */
export async function beginPurchaseWalletReclaim(purchaseId: string): Promise<void> {
  const funding = await repo.findWalletFundingByPurchaseId(purchaseId);
  if (funding === null || funding.status !== PurchaseWalletFundingStatus.FUNDED) return;
  const reclaimIdempotencyKey =
    funding.reclaimIdempotencyKey ?? `purchase-wallet-reclaim:${purchaseId}`;
  await repo.markWalletFundingReclaiming(funding.id, {
    reclaimIdempotencyKey,
    allowConsumed: false,
  });
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
    const current = await repo.findWalletFundingByPurchaseId(purchase.id);
    // Another cleanup can finish the same idempotent reclaim between our initial read and CAS.
    // That is success, not evidence that a merchant consumed the transfer.
    if (current?.status === PurchaseWalletFundingStatus.RECLAIMED) return;
    const consumed = current?.status === PurchaseWalletFundingStatus.CONSUMED;
    throw new WalletFundingProviderError(
      consumed
        ? 'AgentCard company transfer was consumed while reclaim started'
        : 'AgentCard company transfer changed state while reclaim started',
      409,
      consumed
        ? 'agentcard_company_transfer_consumed_during_reclaim'
        : 'agentcard_company_transfer_reclaim_conflict',
      { fundingStatus: current?.status }
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
      const current = await repo.findWalletFundingByPurchaseId(purchase.id);
      // Concurrent reconcilers may both observe the provider release. The winner has already
      // persisted the exact terminal state this call wanted, so the loser is an idempotent success.
      if (current?.status === PurchaseWalletFundingStatus.RECLAIMED) return;
      const consumed = current?.status === PurchaseWalletFundingStatus.CONSUMED;
      throw new WalletFundingProviderError(
        consumed
          ? 'AgentCard company transfer was consumed while reclaim completed'
          : 'AgentCard company transfer changed state while reclaim completed',
        409,
        consumed
          ? 'agentcard_company_transfer_consumed_during_reclaim'
          : 'agentcard_company_transfer_reclaim_conflict',
        { fundingStatus: current?.status }
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
