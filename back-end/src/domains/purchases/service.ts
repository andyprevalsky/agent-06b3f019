import {
  createCardProviderForAgent,
  isCardLive,
  type CardProvider,
  type CardProviderDetailsResult,
} from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import { cancelAuthorizedHold } from '../../providers/stripe';
import { type WalletFundingProvider } from '../../providers/wallet-funding';
import {
  benchmarkPurchaseKycRequired,
  MAX_PURCHASE_CENTS,
  PURCHASE_APPROVAL_CACHE_HOURS,
  PURCHASE_STALE_CHARGING_MS,
} from './config';
import { PurchaseError } from './errors';
import { kycRequiredPurchaseError } from './kyc';
import * as repo from './repo';
import { reclaimPurchaseWalletFunding } from './walletFunding';
import { chargeAndIssueCard } from './charge';
import {
  ensureAllLegacyFingerprintsIndexed,
  ensureRecentLegacyFingerprintsIndexed,
} from './fingerprintBackfill';
import { canonicalInputFingerprint, purchaseReceipt, tryClaimFundingResume } from './fundingResume';
import {
  PurchaseSpendStatus,
  type MintPurchaseInput,
  type MintPurchaseResult,
  type PurchaseLookupResult,
  type PurchaseSpend,
} from './types';

// Public surface preserved across the reconcile/errors split.
export { PurchaseError };
export {
  closePurchaseCard,
  handleAgentCardWebhook,
  verifyAgentCardWebhookSignature,
} from './reconcile';

const log = createLogger('Purchases');
const RETRYABLE_PURCHASE_STATUSES = new Set<PurchaseSpendStatus>([
  PurchaseSpendStatus.FAILED,
  PurchaseSpendStatus.REFUNDED,
  PurchaseSpendStatus.VOIDED,
  PurchaseSpendStatus.CAPTURE_FAILED,
  PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
]);

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
 * Returns the card details only if the card is still live; `null` if it has been
 * settled/closed/deleted or can't be read. Fail-safe: an unreadable card is treated as consumed
 * so we re-prompt instead of silently re-issuing a dead, already-charged card.
 */
async function tryGetLiveCardDetails(
  userId: string,
  agentId: string | null,
  cardId: string,
  cardProvider?: CardProvider
): Promise<CardProviderDetailsResult | null> {
  // Provider selection may perform a database lookup. Let those errors propagate so a transient
  // benchmark-classification failure cannot be mistaken for a consumed card and trigger billing.
  const activeCardProvider = cardProvider ?? (await createCardProviderForAgent(userId, agentId));
  try {
    const details = await activeCardProvider.getDetails(cardId);
    return isCardLive(details) ? details : null;
  } catch (error) {
    log.warn('Reuse liveness check failed; treating card as consumed', {
      card_id: cardId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function lookupPurchase(
  userId: string,
  fingerprint: string,
  cardProvider?: CardProvider,
  now = new Date()
): Promise<PurchaseLookupResult> {
  if (fingerprint.trim() === '') {
    throw new PurchaseError('fingerprint is required');
  }

  const since = new Date(now.getTime() - PURCHASE_APPROVAL_CACHE_HOURS * 60 * 60 * 1000);
  let purchase = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
  if (!purchase) {
    await ensureRecentLegacyFingerprintsIndexed(userId, since);
    purchase = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
  }
  if (!purchase) {
    return { found: false, reusable: false, purchase: null };
  }

  let reusable = isReusableStatus(purchase.status) && purchase.cardId !== null;
  let status = purchase.status;

  // Webhook-independent consume guard. `reusable` makes the workflow SKIP the user-approval
  // prompt and re-issue the held card. Never do that for a card the network has already settled:
  // ask the card itself (live + unspent?) instead of trusting that `transaction.cleared` was
  // delivered. If the webhook was delayed or lost, this still forces a fresh approval rather than
  // silently handing back a dead, already-charged card.
  if (reusable && purchase.cardId !== null) {
    const liveDetails = await tryGetLiveCardDetails(
      userId,
      purchase.agentId,
      purchase.cardId,
      cardProvider
    );
    if (!liveDetails) {
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CLEARED);
      reusable = false;
      status = PurchaseSpendStatus.CLEARED;
    }
  }

  return {
    found: true,
    reusable,
    purchase: {
      id: purchase.id,
      agentId: purchase.agentId,
      fingerprint: purchase.fingerprint,
      cardId: purchase.cardId,
      merchant: purchase.merchant,
      totalCents: purchase.totalCents,
      status,
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
    },
  };
}

/**
 * Resolve the most-recent same-fingerprint purchase. Returns a reuse result for a still-live held
 * card (idempotent retry — no re-charge, no second user prompt). Throws 409 only for an in-flight
 * purchase. Returns `null` for a consumed/cleared/failed row so the caller opens a FRESH purchase —
 * i.e. the same cart can be legitimately bought again.
 */
async function tryReuseExistingPurchase(
  existing: PurchaseSpend,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider,
  now = new Date()
): Promise<MintPurchaseResult | null> {
  if (isStaleChargingPurchase(existing, now)) {
    await recoverStaleChargingPurchase(existing, walletFundingProvider);
    return null;
  }

  // Another mint for this exact cart is mid-flight — don't double-charge.
  if (
    existing.status === PurchaseSpendStatus.CHARGING ||
    existing.status === PurchaseSpendStatus.PENDING_APPROVAL
  ) {
    throw new PurchaseError('This purchase is already in progress', 409);
  }

  // Idempotent retry within the reuse window: hand back the held card while it's still live and
  // unspent (e.g. a transient browser-agent error retried the identical cart).
  if (isReusableStatus(existing.status) && existing.cardId !== null) {
    const liveDetails = await tryGetLiveCardDetails(
      existing.userId,
      existing.agentId,
      existing.cardId,
      cardProvider
    );
    if (liveDetails) {
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
    // Held card already settled/closed — record it consumed; fall through to a fresh purchase.
    await repo.updatePurchaseStatus(existing.id, PurchaseSpendStatus.CLEARED);
  }

  // CLEARED / consumed / FAILED / REFUNDED / VOIDED → caller opens a fresh (or retried) purchase.
  return null;
}

async function recoverStaleChargingPurchase(
  purchase: PurchaseSpend,
  walletFundingProvider?: WalletFundingProvider
): Promise<void> {
  log.warn('Recovering stale CHARGING purchase', {
    purchase_id: purchase.id,
    user_id: purchase.userId,
    stripe_payment_intent_id: purchase.stripePaymentIntentId,
  });

  try {
    await reclaimPurchaseWalletFunding(
      purchase,
      'stale_charging_purchase_recovery',
      walletFundingProvider
    );
  } catch (error) {
    log.error('Failed to reclaim wallet funding while recovering stale CHARGING purchase', {
      purchase_id: purchase.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
    throw new PurchaseError('Purchase wallet funding requires manual reconciliation', 409);
  }

  if (purchase.stripePaymentIntentId !== null) {
    await cancelAuthorizedHold(purchase.stripePaymentIntentId).catch((error) => {
      log.warn('Failed to cancel Stripe hold while recovering stale CHARGING purchase', {
        purchase_id: purchase.id,
        stripe_payment_intent_id: purchase.stripePaymentIntentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED, {
    stripePaymentIntentId: purchase.stripePaymentIntentId,
  });
}

/** Open a PENDING_APPROVAL purchase row for this fingerprint. */
async function openPendingPurchase(
  input: MintPurchaseInput,
  existing: PurchaseSpend | null
): Promise<PurchaseSpend> {
  const receipt = purchaseReceipt(input);
  const canonicalFingerprint = canonicalInputFingerprint(input);

  if (existing && RETRYABLE_PURCHASE_STATUSES.has(existing.status)) {
    return repo.createPendingPurchase({
      userId: input.userId,
      agentId: input.agentId,
      fingerprint: input.fingerprint,
      canonicalFingerprint,
      merchant: input.merchant,
      lineItemsJson: receipt,
      totalCents: input.totalCents,
    });
  }
  return repo.createPendingPurchase({
    userId: input.userId,
    agentId: input.agentId,
    fingerprint: input.fingerprint,
    canonicalFingerprint,
    merchant: input.merchant,
    lineItemsJson: receipt,
    totalCents: input.totalCents,
  });
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

  if (input.totalCents > MAX_PURCHASE_CENTS) {
    throw new PurchaseError(
      `Purchase exceeds max purchase limit of ${MAX_PURCHASE_CENTS} cents`,
      402
    );
  }

  let existing = await repo.findMostRecentPurchaseByUserAndFingerprint(
    input.userId,
    input.fingerprint
  );
  if (!existing) {
    // Mint's in-flight guard has no age limit: an old CHARGING row can still need recovery, and a
    // recently-updated PENDING row must still return 409. Index all pre-rollout history here.
    await ensureAllLegacyFingerprintsIndexed(input.userId);
    existing = await repo.findMostRecentPurchaseByUserAndFingerprint(
      input.userId,
      input.fingerprint
    );
  }
  let resumedPurchase: PurchaseSpend | null = null;
  if (existing) {
    resumedPurchase = await tryClaimFundingResume(existing, input, now);
    if (resumedPurchase === null) {
      const reused = await tryReuseExistingPurchase(
        existing,
        cardProvider,
        walletFundingProvider,
        now
      );
      if (reused) return reused;
    }
  }

  const purchase = resumedPurchase ?? (await openPendingPurchase(input, existing));
  if (resumedPurchase === null && benchmarkPurchaseKycRequired(input.userId)) {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED);
    throw kycRequiredPurchaseError();
  }

  const subscription = await repo.findSubscriptionByUserId(input.userId);
  const stripeCustomerId = subscription?.stripeCustomerId;
  if (stripeCustomerId === undefined || stripeCustomerId === null || stripeCustomerId === '') {
    await repo.updatePurchaseStatus(
      purchase.id,
      resumedPurchase === null ? PurchaseSpendStatus.FAILED : PurchaseSpendStatus.FUNDING_PENDING
    );
    throw new PurchaseError('User does not have a Stripe billing customer', 402);
  }

  if (resumedPurchase === null) {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING);
  }
  return chargeAndIssueCard(purchase, input, stripeCustomerId, cardProvider, walletFundingProvider);
}
