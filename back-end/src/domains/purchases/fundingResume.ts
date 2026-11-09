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

function hasSafeProviderFailureCode(error: Error): boolean {
  if (!(error instanceof PurchaseError) || error.code === undefined) return false;
  return new Set([
    'agentcard_setup_required',
    'agentcard_kyc_required',
    'agentcard_org_wallet_funding_required',
    'agentcard_wallet_funding_required',
    'agentcard_payment_method_required',
    'agentcard_cardholder_not_found',
    'agentcard_card_creation_failed',
    'agentcard_invalid_request',
    'kyc_required',
  ]).has(error.code);
}

function hasSafeStripeFailureType(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('type' in error)) return false;
  const type = (error as { type?: unknown }).type;
  return (
    type === 'StripeCardError' ||
    type === 'StripeInvalidRequestError' ||
    type === 'StripeAuthenticationError' ||
    type === 'StripePermissionError'
  );
}

function hasAmbiguousExternalOutcome(
  error: unknown,
  boundaryError: Error,
  state: { providerCallStarted: boolean; stripeAuthorizationStarted: boolean }
): boolean {
  // Once an external mutation starts, ambiguity is a phase fact, not an error-message guess.
  // MCP 500/malformed may follow an AgentCard commit; a lost Stripe response may hide a PI.
  return state.providerCallStarted
    ? !hasSafeProviderFailureCode(boundaryError)
    : state.stripeAuthorizationStarted && !hasSafeStripeFailureType(error);
}

export async function classifyFundingResumeFailure(
  purchase: PurchaseSpend,
  error: unknown,
  state: {
    walletFundingPrepared: boolean;
    fundingRetryClaimed: boolean;
    providerCallStarted: boolean;
    stripeAuthorizationStarted: boolean;
    issuedCardId?: string;
  }
): Promise<{
  boundaryError: Error;
  walletWasFunded: boolean;
  fundingResumeRequired: boolean;
  walletFundingPrepared: boolean;
  issuedCardId?: string;
}> {
  let boundaryError = toPurchaseBoundaryError(error);
  const durablePurchase = state.providerCallStarted
    ? await repo.findPurchaseById(purchase.id).catch(() => undefined)
    : undefined;
  const issuedCardId = state.issuedCardId ?? durablePurchase?.cardId ?? undefined;
  const funding = state.walletFundingPrepared
    ? await preparePurchaseWalletCollection(purchase, 'usd').catch(() => undefined)
    : undefined;
  const walletWasFunded =
    funding?.status === PurchaseWalletFundingStatus.FUNDED ||
    funding?.status === PurchaseWalletFundingStatus.CONSUMED;
  const ambiguousExternalOutcome = hasAmbiguousExternalOutcome(error, boundaryError, state);
  const fundingResumeRequired =
    issuedCardId === undefined &&
    state.walletFundingPrepared &&
    ((boundaryError instanceof PurchaseError &&
      boundaryError.code === 'agentcard_company_funding_in_progress') ||
      // A resumed intent may have committed on an earlier attempt. A billing/preflight
      // refusal on this call says nothing about that prior keyed card or transfer.
      state.fundingRetryClaimed ||
      ambiguousExternalOutcome ||
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
    await discardPendingPurchaseWalletCollection(purchase.id).catch(() => undefined);
    return {
      boundaryError,
      walletWasFunded,
      fundingResumeRequired,
      walletFundingPrepared: false,
      issuedCardId,
    };
  }
  return {
    boundaryError,
    walletWasFunded,
    fundingResumeRequired,
    walletFundingPrepared: state.walletFundingPrepared,
    issuedCardId,
  };
}

function fundingResumeAgentMatches(purchase: PurchaseSpend, input: MintPurchaseInput): boolean {
  // Null-agent legacy rows remain claimable by any agent (same as tryReuseExistingPurchase).
  // A different non-null agent must not 409 — the caller should open its own purchase instead.
  return !(
    input.agentId !== undefined &&
    input.agentId.trim() !== '' &&
    purchase.agentId !== null &&
    purchase.agentId !== input.agentId
  );
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
  if (!fundingResumeAgentMatches(candidate, input)) return null;
  if (isStaleChargingPurchase(candidate, now)) {
    const funding = await repo.findWalletFundingByPurchaseId(candidate.id);
    if (
      candidate.cardId !== null ||
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
  if (candidate.cardId !== null) {
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
  const claimed = await repo.claimFundingPendingPurchase(candidate.id, {
    userId: input.userId,
    agentId: input.agentId,
  });
  if (claimed === null) {
    throw new PurchaseError('This purchase is already in progress', 409);
  }
  return claimed;
}
