import {
  PurchaseSpendStatus,
  PurchaseWalletFundingStatus,
  type MintPurchaseInput,
  type PurchaseSpend,
} from './types';
import { PurchaseError, toPurchaseBoundaryError } from './errors';
import { canonicalStoredPurchaseFingerprint } from './fingerprint';
import { PURCHASE_STALE_CHARGING_MS } from './config';
import {
  discardPendingPurchaseWalletCollection,
  preparePurchaseWalletCollection,
} from './walletFunding';
import * as repo from './repo';

export function purchaseReceipt(input: MintPurchaseInput) {
  return {
    currency: input.currency,
    lineItems: input.lineItems,
    fees: input.fees,
    subtotalCents: input.subtotalCents,
    totalCents: input.totalCents,
  };
}

export function canonicalInputFingerprint(input: MintPurchaseInput): string {
  const canonicalFingerprint = canonicalStoredPurchaseFingerprint({
    userId: input.userId,
    merchant: input.merchant,
    lineItemsJson: purchaseReceipt(input),
    totalCents: input.totalCents,
  });
  if (canonicalFingerprint === null) {
    throw new PurchaseError('purchase receipt cannot be fingerprinted');
  }
  return canonicalFingerprint;
}

export async function classifyFundingResumeFailure(
  purchase: PurchaseSpend,
  error: unknown,
  state: {
    walletFundingPrepared: boolean;
    fundingRetryClaimed: boolean;
    issuedCardId?: string;
  }
): Promise<{
  boundaryError: Error;
  walletWasFunded: boolean;
  fundingResumeRequired: boolean;
  walletFundingPrepared: boolean;
}> {
  let boundaryError = toPurchaseBoundaryError(error);
  const funding = state.walletFundingPrepared
    ? await preparePurchaseWalletCollection(purchase, 'usd').catch(() => undefined)
    : undefined;
  const walletWasFunded =
    funding?.status === PurchaseWalletFundingStatus.FUNDED ||
    funding?.status === PurchaseWalletFundingStatus.CONSUMED;
  const ambiguousProviderOutcome =
    /\btimeout|timed out|network|fetch|socket|connection|econn|aborted?\b/i.test(
      boundaryError.message
    );
  const fundingResumeRequired =
    state.issuedCardId === undefined &&
    state.walletFundingPrepared &&
    ((boundaryError instanceof PurchaseError &&
      boundaryError.code === 'agentcard_company_funding_in_progress') ||
      state.fundingRetryClaimed ||
      ambiguousProviderOutcome ||
      funding?.status === PurchaseWalletFundingStatus.FAILED ||
      walletWasFunded);
  if (
    fundingResumeRequired &&
    (!(boundaryError instanceof PurchaseError) ||
      boundaryError.code !== 'agentcard_company_funding_in_progress')
  ) {
    boundaryError = new PurchaseError(
      'AgentCard company funding outcome is not confirmed; retry this purchase shortly',
      409,
      'agentcard_company_funding_in_progress',
      { retryAfterSeconds: 5 }
    );
  }
  if (
    !fundingResumeRequired &&
    state.walletFundingPrepared &&
    funding?.status === PurchaseWalletFundingStatus.PENDING
  ) {
    await discardPendingPurchaseWalletCollection(purchase.id);
    return { boundaryError, walletWasFunded, fundingResumeRequired, walletFundingPrepared: false };
  }
  return {
    boundaryError,
    walletWasFunded,
    fundingResumeRequired,
    walletFundingPrepared: state.walletFundingPrepared,
  };
}

function assertFundingResumeMatchesInput(purchase: PurchaseSpend, input: MintPurchaseInput): void {
  const storedCanonicalFingerprint =
    purchase.canonicalFingerprint ??
    canonicalStoredPurchaseFingerprint({
      userId: purchase.userId,
      merchant: purchase.merchant,
      lineItemsJson: purchase.lineItemsJson,
      totalCents: purchase.totalCents,
    });
  if (
    storedCanonicalFingerprint === null ||
    storedCanonicalFingerprint !== canonicalInputFingerprint(input)
  ) {
    throw new PurchaseError(
      'The retry payload does not match the purchase whose funding is in progress',
      409,
      'purchase_funding_resume_mismatch'
    );
  }
}

function isResumableWalletFundingStatus(status: PurchaseWalletFundingStatus): boolean {
  return (
    status === PurchaseWalletFundingStatus.PENDING ||
    status === PurchaseWalletFundingStatus.FUNDED ||
    status === PurchaseWalletFundingStatus.FAILED
  );
}

function isStaleChargingPurchase(purchase: PurchaseSpend, now: Date): boolean {
  return (
    purchase.status === PurchaseSpendStatus.CHARGING &&
    now.getTime() - purchase.updatedAt.getTime() > PURCHASE_STALE_CHARGING_MS
  );
}

/**
 * Claim a durable company-funding retry. A stale CHARGING row is resumable only when the
 * pre-provider funding marker proves an idempotent AgentCard call may already be in flight.
 */
export async function tryClaimFundingResume(
  existing: PurchaseSpend,
  input: MintPurchaseInput,
  now: Date
): Promise<PurchaseSpend | null> {
  let candidate = existing;
  if (isStaleChargingPurchase(candidate, now)) {
    const funding = await repo.findWalletFundingByPurchaseId(candidate.id);
    if (
      candidate.cardId !== null ||
      candidate.stripePaymentIntentId === null ||
      funding === null ||
      !isResumableWalletFundingStatus(funding.status)
    ) {
      return null;
    }
    assertFundingResumeMatchesInput(candidate, input);
    const marked = await repo.markStalePurchaseFundingPending(candidate.id, candidate.updatedAt);
    if (marked.count !== 1) {
      throw new PurchaseError('This purchase is already in progress', 409);
    }
    candidate = { ...candidate, status: PurchaseSpendStatus.FUNDING_PENDING };
  }

  if (candidate.status !== PurchaseSpendStatus.FUNDING_PENDING) return null;
  assertFundingResumeMatchesInput(candidate, input);
  if (candidate.cardId !== null || candidate.stripePaymentIntentId === null) {
    throw new PurchaseError(
      'Purchase funding state requires manual reconciliation',
      409,
      'purchase_funding_resume_invalid'
    );
  }
  const funding = await repo.findWalletFundingByPurchaseId(candidate.id);
  if (funding === null || !isResumableWalletFundingStatus(funding.status)) {
    throw new PurchaseError(
      'Purchase funding state requires manual reconciliation',
      409,
      'purchase_funding_resume_invalid'
    );
  }
  const claimed = await repo.claimFundingPendingPurchase(candidate.id);
  if (claimed === null) {
    throw new PurchaseError('This purchase is already in progress', 409);
  }
  return claimed;
}
