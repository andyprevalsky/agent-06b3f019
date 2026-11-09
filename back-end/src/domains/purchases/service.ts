import { type CardProvider } from '../../providers/card-provider';
import { ROSE_AGENT_CARD_ID } from '../../providers/card-provider/static-card';
import { createLogger } from '../../providers/logger';
import { cancelAuthorizedHold } from '../../providers/stripe';
import { type WalletFundingProvider } from '../../providers/wallet-funding';
import { findSameAgentHeldCart } from './agentCartReuse';
import { tryGetLiveCardDetails } from './cardLiveness';
import {
  benchmarkPurchaseKycRequired,
  MAX_PURCHASE_CENTS,
  PURCHASE_ABOVE_MAX_LIMIT_CODE,
  PURCHASE_APPROVAL_CACHE_HOURS,
  PURCHASE_STALE_CHARGING_MS,
} from './config';
import { PurchaseError, toPurchaseBoundaryError } from './errors';
import { kycRequiredPurchaseError } from './kyc';
import * as repo from './repo';
import { resolveAndIssuePurchaseCard } from './issueCard';
import { ensureAllLegacyFingerprintsIndexed } from './fingerprintBackfill';
import { canonicalInputFingerprint, purchaseReceipt, tryClaimFundingResume } from './fundingResume';
import {
  PurchaseSpendStatus,
  type MintPurchaseInput,
  type MintPurchaseResult,
  type PurchaseSpend,
} from './types';

// Public surface preserved across the reconcile/errors split.
export { PurchaseError };
export { lookupPurchase } from './lookup';
export {
  closePurchaseCard,
  handleAgentCardWebhook,
  verifyAgentCardWebhookSignature,
} from './reconcile';

const log = createLogger('Purchases');

function assertPositiveCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PurchaseError(`${field} must be a positive integer`);
  }
}

function normalizeCurrency(currency: string): string {
  const normalized = currency.trim().toLowerCase();
  if (normalized !== 'usd') {
    throw new PurchaseError('Only USD purchases are currently supported');
  }
  return normalized;
}

function isReusableStatus(status: PurchaseSpendStatus): boolean {
  return status === PurchaseSpendStatus.HELD;
}

function isStaleChargingPurchase(purchase: PurchaseSpend, now: Date): boolean {
  return (
    purchase.status === PurchaseSpendStatus.CHARGING &&
    now.getTime() - purchase.updatedAt.getTime() > PURCHASE_STALE_CHARGING_MS
  );
}

/**
 * Resolve the most-recent same-fingerprint purchase. Returns a reuse result for a available held
 * card (idempotent retry — no re-charge, no second user prompt). Throws 409 only for an in-flight
 * purchase. Returns `null` for a consumed/cleared/failed row so the caller opens a FRESH purchase —
 * i.e. the same cart can be legitimately bought again.
 */
async function tryReuseExistingPurchase(
  existing: PurchaseSpend,
  cardProvider?: CardProvider,
  now = new Date(),
  requestingAgentId?: string,
  reuseOnly = false
): Promise<MintPurchaseResult | null> {
  // Cross-agent fingerprint hits must never reuse a live card. Lifecycle/abandon keys off the
  // requesting agentId; handing back another agent's HELD purchase leaves the new agent with no
  // PurchaseSpend row (prod AgentCard gate: purchaseCount expected 1, got 0).
  if (
    requestingAgentId !== undefined &&
    requestingAgentId.trim() !== '' &&
    existing.agentId !== null &&
    existing.agentId !== requestingAgentId
  ) {
    return null;
  }

  if (isStaleChargingPurchase(existing, now)) {
    await recoverStaleChargingPurchase(existing);
    return null;
  }

  // Another mint for this exact cart is mid-flight — don't double-charge.
  if (
    existing.status === PurchaseSpendStatus.CHARGING ||
    existing.status === PurchaseSpendStatus.PENDING_APPROVAL ||
    existing.status === PurchaseSpendStatus.FUNDING_ABANDONED
  ) {
    throw new PurchaseError(
      existing.status === PurchaseSpendStatus.FUNDING_ABANDONED
        ? 'This purchase is being reconciled after company funding was abandoned'
        : 'This purchase is already in progress',
      409,
      existing.status === PurchaseSpendStatus.FUNDING_ABANDONED
        ? 'purchase_funding_abandoned_reconciliation'
        : undefined
    );
  }

  // Idempotent retry within the reuse window: hand back the held card while the provider reports availability
  // and the purchase remains HELD (e.g. a transient browser-agent error retried the identical cart).
  if (isReusableStatus(existing.status) && existing.cardId !== null) {
    // An unreadable card preserves the purchase, but the mint caller must still see the provider's
    // typed status/code: a raw AgentCard runtime error reaches the route as an untyped 500.
    const liveDetails = await tryGetLiveCardDetails(
      existing.userId,
      existing.agentId,
      existing.cardId,
      cardProvider
    ).catch((error: unknown) => {
      throw toPurchaseBoundaryError(error);
    });
    if (
      liveDetails &&
      (!reuseOnly ||
        existing.cardId === ROSE_AGENT_CARD_ID ||
        liveDetails.balanceCents >= existing.totalCents)
    ) {
      return {
        purchaseId: existing.id,
        cardId: existing.cardId,
        pan: liveDetails.pan,
        cvv: liveDetails.cvv,
        expiry: liveDetails.expiry,
        last4: liveDetails.pan.slice(-4),
        status: existing.status,
      };
    }
    // Held card already settled/closed — record consumed unless Rose closed it for reclaim.
    await repo.markHeldPurchaseClearedIfNoReclaim(existing.id);
  }

  // CLEARED / consumed / FAILED / REFUNDED / VOIDED → caller opens a fresh (or retried) purchase.
  return null;
}

async function recoverStaleChargingPurchase(purchase: PurchaseSpend): Promise<void> {
  log.warn('Recovering stale CHARGING purchase', {
    purchase_id: purchase.id,
    user_id: purchase.userId,
    stripe_payment_intent_id: purchase.stripePaymentIntentId,
  });

  const funding = await repo.findWalletFundingByPurchaseId(purchase.id);
  if (purchase.cardId !== null || funding !== null) {
    // A card or pre-provider marker means an external AgentCard result may exist. Only the cron
    // compensator may close/release it; never mark the row retryable from an HTTP request.
    throw new PurchaseError(
      'This purchase is being reconciled after an interrupted funding attempt',
      409,
      'purchase_funding_reconciliation_in_progress'
    );
  }

  if (purchase.stripePaymentIntentId !== null) {
    try {
      await cancelAuthorizedHold(purchase.stripePaymentIntentId, purchase.stripeLivemode);
    } catch (error) {
      log.warn('Failed to cancel Stripe hold while recovering stale CHARGING purchase', {
        purchase_id: purchase.id,
        stripe_payment_intent_id: purchase.stripePaymentIntentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Preserve CHARGING so another request cannot open a second row while the first hold may live.
      throw new PurchaseError(
        'Stripe authorization cleanup is still in progress',
        409,
        'purchase_stripe_reconciliation_in_progress'
      );
    }
  }

  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED, {
    stripePaymentIntentId: purchase.stripePaymentIntentId,
  });
}

async function reuseSameAgentHeldCart(
  input: MintPurchaseInput,
  cardProvider: CardProvider | undefined,
  now: Date
): Promise<MintPurchaseResult | null> {
  const since = new Date(now.getTime() - PURCHASE_APPROVAL_CACHE_HOURS * 60 * 60 * 1000);
  const held = await findSameAgentHeldCart(input, since);
  return held === null ? null : tryReuseExistingPurchase(held, cardProvider, now, input.agentId);
}

/** Open a PENDING_APPROVAL purchase row for this fingerprint. */
async function openPendingPurchase(input: MintPurchaseInput) {
  const receipt = purchaseReceipt(input);
  const canonicalFingerprint = canonicalInputFingerprint(input);
  return repo.createPendingPurchaseWithLock({
    userId: input.userId,
    agentId: input.agentId,
    fingerprint: input.fingerprint,
    canonicalFingerprint,
    merchant: input.merchant,
    lineItemsJson: receipt,
    totalCents: input.totalCents,
  });
}

async function reuseApprovedPurchaseOnly(
  input: MintPurchaseInput,
  cardProvider: CardProvider | undefined,
  now: Date
): Promise<MintPurchaseResult> {
  const approved = await repo.findPurchaseById(input.reusePurchaseId!);
  if (
    approved !== null &&
    approved.userId === input.userId &&
    approved.agentId === input.agentId &&
    approved.fingerprint === input.fingerprint &&
    approved.status === PurchaseSpendStatus.HELD &&
    approved.totalCents === input.totalCents &&
    approved.merchant.toLowerCase() === input.merchant.toLowerCase() &&
    approved.createdAt.getTime() >= now.getTime() - PURCHASE_APPROVAL_CACHE_HOURS * 3600000
  ) {
    const reused = await tryReuseExistingPurchase(approved, cardProvider, now, input.agentId, true);
    if (reused !== null) return reused;
  }
  throw new PurchaseError(
    'The approved card is no longer reusable; fresh approval is required',
    409,
    'purchase_approval_required'
  );
}

export async function mintPurchaseCard(
  input: MintPurchaseInput,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider,
  now = new Date()
): Promise<MintPurchaseResult> {
  if (input.userId.trim() === '') throw new PurchaseError('userId is required', 401);
  if (input.fingerprint.trim() === '') throw new PurchaseError('fingerprint is required');
  if (input.merchant.trim() === '') throw new PurchaseError('merchant is required');
  assertPositiveCents(input.totalCents, 'totalCents');
  normalizeCurrency(input.currency);

  await repo.assertPurchaseAgentAdmitted(input);

  if (input.reusePurchaseId !== undefined)
    return reuseApprovedPurchaseOnly(input, cardProvider, now);

  if (input.totalCents > MAX_PURCHASE_CENTS) {
    // Distinct from subscription 402s: the browser tool surfaces this as a hard
    // error ("purchase is above max limit of X"), not a subscribe gate.
    throw new PurchaseError(
      `Purchase is above max limit of ${MAX_PURCHASE_CENTS}`,
      400,
      PURCHASE_ABOVE_MAX_LIMIT_CODE,
      { maxPurchaseCents: MAX_PURCHASE_CENTS }
    );
  }

  let existing = await repo.findMostRecentPurchaseByUserAndFingerprint(
    input.userId,
    input.fingerprint,
    input.agentId
  );
  if (!existing) {
    // Mint's in-flight guard has no age limit: an old CHARGING row can still need recovery, and a
    // recently-updated PENDING row must still return 409. Index all pre-rollout history here.
    await ensureAllLegacyFingerprintsIndexed(input.userId);
    existing = await repo.findMostRecentPurchaseByUserAndFingerprint(
      input.userId,
      input.fingerprint,
      input.agentId
    );
  }
  if (!existing) {
    const sameCart = await reuseSameAgentHeldCart(input, cardProvider, now);
    if (sameCart) return sameCart;
  }
  let resumedPurchase: PurchaseSpend | null = null;
  if (existing) {
    resumedPurchase = await tryClaimFundingResume(existing, input, now);
    if (resumedPurchase === null) {
      const reused = await tryReuseExistingPurchase(existing, cardProvider, now, input.agentId);
      if (reused) return reused;
    }
  }

  let purchase = resumedPurchase;
  if (purchase === null) {
    const opened = await openPendingPurchase(input);
    if (!opened.created) {
      const reused = await tryReuseExistingPurchase(
        opened.purchase,
        cardProvider,
        now,
        input.agentId
      );
      if (reused !== null) return reused;
      throw new PurchaseError('This purchase is already in progress', 409);
    }
    purchase = opened.purchase;
  }
  if (resumedPurchase === null && benchmarkPurchaseKycRequired(input.userId)) {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED);
    throw kycRequiredPurchaseError();
  }

  // Admins bypass the subscription / card-on-file gate (company-funded no-charge card); everyone
  // else goes through the standard Stripe-customer check. Funding-resume state is threaded through.
  return resolveAndIssuePurchaseCard(
    purchase,
    input,
    resumedPurchase,
    cardProvider,
    walletFundingProvider
  );
}
