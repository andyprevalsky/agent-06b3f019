import { randomUUID } from 'node:crypto';
import { PurchaseWalletFundingStatus, type PurchaseSpend } from '@prisma/client';
import { recoverCardholderFunds } from './agentcard/fund-recovery';
import { getOrgManagedCardholderId } from './agentcard/store';
import { createLogger } from './logger';
import * as repo from './purchase-wallet-funding-repo';
import {
  createWalletFundingProvider,
  isWalletFundingReleasePendingError,
  type WalletFundingProvider,
  WalletFundingProviderError,
} from './wallet-funding';

const log = createLogger('PurchaseWalletFunding');

/**
 * Persist the purchase-scoped funding attempt before calling AgentCard. A process crash or a
 * transferless `funding_in_progress` response can then be resumed with the same purchase id and
 * provider idempotency key instead of opening a second company transfer.
 */
export async function preparePurchaseWalletCollection(purchase: PurchaseSpend, currency: string) {
  return repo.createOrGetWalletFunding({
    purchaseId: purchase.id,
    userId: purchase.userId,
    agentId: purchase.agentId ?? undefined,
    amountCents: purchase.totalCents,
    currency,
    idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
  });
}

/** Static company cards have no per-purchase AgentCard transfer; remove their unused marker. */
export async function discardPendingPurchaseWalletCollection(purchaseId: string): Promise<void> {
  await repo.deletePendingWalletFunding(purchaseId);
}

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
  const funding = await preparePurchaseWalletCollection(purchase, currency);

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
  const funding = await preparePurchaseWalletCollection(purchase, currency);
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

export async function recordIssuedPurchaseCardFunding(
  purchase: PurchaseSpend,
  currency: string,
  cardId: string,
  providerTransferId: string,
  metadata: Record<string, unknown> | undefined
) {
  const funding = await preparePurchaseWalletCollection(purchase, currency);
  return repo.recordIssuedCardAndFunding({
    purchaseId: purchase.id,
    fundingId: funding.id,
    cardId,
    providerTransferId,
    metadata,
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
 * defer to the in-flight reclaim instead. The explicit claim result lets callers suppress only an
 * active owner while preserving the legacy close/reconcile behavior for missing or terminal rows.
 */
export type PurchaseWalletReclaimClaim =
  { status: 'owned'; reclaimLeaseToken: string } | { status: 'already_owned' | 'not_applicable' };

export async function beginPurchaseWalletReclaim(
  purchaseId: string
): Promise<PurchaseWalletReclaimClaim> {
  const funding = await repo.findWalletFundingByPurchaseId(purchaseId);
  if (funding === null) return { status: 'not_applicable' };
  if (funding.status === PurchaseWalletFundingStatus.RECLAIMING) {
    return { status: 'already_owned' };
  }
  if (funding.status !== PurchaseWalletFundingStatus.FUNDED) {
    return { status: 'not_applicable' };
  }
  const reclaimIdempotencyKey =
    funding.reclaimIdempotencyKey ?? `purchase-wallet-reclaim:${purchaseId}`;
  const reclaimLeaseToken = randomUUID();
  const claimed = await repo.claimWalletFundingReclaim(funding.id, purchaseId, {
    reclaimIdempotencyKey,
    reclaimLeaseToken,
  });
  if (claimed.count === 1) return { status: 'owned', reclaimLeaseToken };

  // A competing caller may have advanced the FUNDED row after our read. Suppress only an active
  // RECLAIMING owner; every other state preserves the legacy close/reconcile behavior.
  const current = await repo.findWalletFundingByPurchaseId(purchaseId);
  return current?.status === PurchaseWalletFundingStatus.RECLAIMING
    ? { status: 'already_owned' }
    : { status: 'not_applicable' };
}

const inFlightPurchaseWalletReclaims = new Map<string, Promise<void>>();

/**
 * Return a cardholder's released residual to the org pool.
 *
 * Deliberately isolated and non-throwing — see the call site. Resolves the cardholder from the
 * purchase's user because `recover_funds` is per-cardholder; a user with no org-managed cardholder
 * (the static-card path) simply has nothing to recover.
 */
async function sweepCardholderResidualToPool(userId: string): Promise<void> {
  try {
    const cardholderId = await getOrgManagedCardholderId(userId);
    if (cardholderId === undefined) return;
    const recovery = await recoverCardholderFunds(cardholderId);
    if (recovery.amountCents > 0) {
      log.info('Released card funds returned to the org pool', {
        user_id: userId,
        cardholder_id: cardholderId,
        amount_cents: recovery.amountCents,
        status: recovery.status,
      });
    }
  } catch (error) {
    log.warn('Could not return released card funds to the pool; top-up sweep will retry', {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function performPurchaseWalletFundingReclaim(
  purchase: Pick<PurchaseSpend, 'id' | 'userId' | 'agentId' | 'totalCents'> & {
    cardId?: string | null;
  },
  reason: string,
  walletFundingProvider?: WalletFundingProvider,
  opts: { allowConsumed?: boolean; reclaimLeaseToken?: string } = {}
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
  const reclaimLeaseToken = opts.reclaimLeaseToken ?? randomUUID();
  const reclaiming = await repo.markWalletFundingReclaiming(funding.id, {
    reclaimIdempotencyKey,
    reclaimLeaseToken,
    expectedReclaimLeaseToken: funding.reclaimLeaseToken,
    allowConsumed: opts.allowConsumed === true,
    // A RECLAIMING row has an active owner. Only a caller carrying that exact lease may execute
    // provider reconciliation; unclaimed callers must wait for the stale-retry CAS.
    allowReclaiming: opts.reclaimLeaseToken !== undefined,
  });
  if (reclaiming.count === 0) {
    const current = await repo.findWalletFundingByPurchaseId(purchase.id);
    // Another cleanup can finish the same idempotent reclaim between our initial read and CAS.
    // That is success, not evidence that a merchant consumed the transfer.
    if (current?.status === PurchaseWalletFundingStatus.RECLAIMED) return;
    const consumed = current?.status === PurchaseWalletFundingStatus.CONSUMED;
    const activeOwner = current?.status === PurchaseWalletFundingStatus.RECLAIMING;
    throw new WalletFundingProviderError(
      consumed
        ? 'AgentCard company transfer was consumed while reclaim started'
        : activeOwner
          ? 'AgentCard company transfer reclaim is already owned'
          : 'AgentCard company transfer changed state while reclaim started',
      409,
      consumed
        ? 'agentcard_company_transfer_consumed_during_reclaim'
        : activeOwner
          ? 'agentcard_company_transfer_release_pending'
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
    const reclaimed = await repo.markWalletFundingReclaimed(funding.id, reclaimLeaseToken, result);
    if (reclaimed.count === 1 && result.metadata?.api_version !== 'v2') {
      // The card is closed and AgentCard has released the hold — but that release lands in the
      // CARDHOLDER's float, not the org pool, where no other user can draw on it. Pull it back
      // now rather than waiting for the next top-up cycle to sweep it.
      //
      // Fire-and-forget and never throwing: the reclaim itself is the money-critical step and is
      // already durably recorded. A recovery failure here must not undo or fail it, and the
      // top-up's recover-before-spend remains the backstop.
      void sweepCardholderResidualToPool(purchase.userId);
    }
    if (reclaimed.count === 0) {
      const current = await repo.findWalletFundingByPurchaseId(purchase.id);
      // Concurrent reconcilers may both observe the provider release. The winner has already
      // persisted the exact terminal state this call wanted, so the loser is an idempotent success.
      if (current?.status === PurchaseWalletFundingStatus.RECLAIMED) return;
      const consumed = current?.status === PurchaseWalletFundingStatus.CONSUMED;
      const activeOwner = current?.status === PurchaseWalletFundingStatus.RECLAIMING;
      throw new WalletFundingProviderError(
        consumed
          ? 'AgentCard company transfer was consumed while reclaim completed'
          : activeOwner
            ? 'AgentCard company transfer reclaim ownership changed before completion'
            : 'AgentCard company transfer changed state while reclaim completed',
        409,
        consumed
          ? 'agentcard_company_transfer_consumed_during_reclaim'
          : activeOwner
            ? 'agentcard_company_transfer_release_pending'
            : 'agentcard_company_transfer_reclaim_conflict',
        { fundingStatus: current?.status }
      );
    }
  } catch (error) {
    if (isWalletFundingReleasePendingError(error)) throw error;
    await repo.markWalletFundingReclaimFailed(
      funding.id,
      reclaimLeaseToken,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

/**
 * Coalesce same-process retries for one provider transfer. The database state machine keeps the
 * result idempotent, and one owner must observe the transfer release before a later retry starts.
 * `close_card` belongs exclusively to the card-provider owner; this funding operation is read-only
 * provider reconciliation and must never replay that mutation.
 */
export async function reclaimPurchaseWalletFunding(
  purchase: Pick<PurchaseSpend, 'id' | 'userId' | 'agentId' | 'totalCents'> & {
    cardId?: string | null;
  },
  reason: string,
  walletFundingProvider?: WalletFundingProvider,
  opts: { allowConsumed?: boolean; reclaimLeaseToken?: string } = {}
): Promise<void> {
  const existing = inFlightPurchaseWalletReclaims.get(purchase.id);
  if (existing !== undefined) return existing;

  const reclaim = performPurchaseWalletFundingReclaim(
    purchase,
    reason,
    walletFundingProvider,
    opts
  );
  inFlightPurchaseWalletReclaims.set(purchase.id, reclaim);
  try {
    await reclaim;
  } finally {
    if (inFlightPurchaseWalletReclaims.get(purchase.id) === reclaim) {
      inFlightPurchaseWalletReclaims.delete(purchase.id);
    }
  }
}
