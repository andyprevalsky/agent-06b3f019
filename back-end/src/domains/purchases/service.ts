import {
  createCardProvider,
  isCardLive,
  type CardProvider,
  type CardProviderDetailsResult,
} from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import { stripe } from '../../providers/stripe';
import { MAX_PURCHASE_CENTS, PURCHASE_APPROVAL_CACHE_HOURS } from './config';
import { PurchaseError } from './errors';
import * as repo from './repo';
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
]);

function assertPositiveCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PurchaseError(`${field} must be a positive integer`);
  }
}

function sanitizeDescriptorSuffix(merchant: string): string {
  const cleaned = merchant
    .replace(/[^a-zA-Z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'Purchase').slice(0, 22);
}

function normalizeCurrency(currency: string): string {
  const normalized = currency.trim().toLowerCase();
  if (normalized !== 'usd') {
    throw new PurchaseError('Only USD purchases are currently supported');
  }
  return normalized;
}

async function getCustomerDefaultPaymentMethodId(customerId: string): Promise<string> {
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) {
    throw new PurchaseError('Stripe billing customer has been deleted', 402);
  }

  const defaultPaymentMethod = customer.invoice_settings?.default_payment_method;
  if (typeof defaultPaymentMethod === 'string' && defaultPaymentMethod.trim() !== '') {
    return defaultPaymentMethod;
  }
  if (
    defaultPaymentMethod !== null &&
    typeof defaultPaymentMethod === 'object' &&
    'id' in defaultPaymentMethod &&
    typeof defaultPaymentMethod.id === 'string' &&
    defaultPaymentMethod.id.trim() !== ''
  ) {
    return defaultPaymentMethod.id;
  }

  throw new PurchaseError('User does not have a default Stripe payment method', 402);
}

function isReusableStatus(status: PurchaseSpendStatus): boolean {
  return status === PurchaseSpendStatus.HELD;
}

/**
 * Returns the card details only if the card is still live; `null` if it has been
 * settled/closed/deleted or can't be read. Fail-safe: an unreadable card is treated as consumed
 * so we re-prompt instead of silently re-issuing a dead, already-charged card.
 */
async function tryGetLiveCardDetails(
  cardId: string,
  cardProvider?: CardProvider
): Promise<CardProviderDetailsResult | null> {
  try {
    const details = await (cardProvider ?? createCardProvider()).getDetails(cardId);
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
  cardProvider?: CardProvider
): Promise<PurchaseLookupResult> {
  if (fingerprint.trim() === '') {
    throw new PurchaseError('fingerprint is required');
  }

  const since = new Date(Date.now() - PURCHASE_APPROVAL_CACHE_HOURS * 60 * 60 * 1000);
  const purchase = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
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
    const liveDetails = await tryGetLiveCardDetails(purchase.cardId, cardProvider);
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
  cardProvider?: CardProvider
): Promise<MintPurchaseResult | null> {
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
    const liveDetails = await tryGetLiveCardDetails(existing.cardId, cardProvider);
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

/** Open (or re-open a retryable) PENDING_APPROVAL purchase row for this fingerprint. */
async function openPendingPurchase(
  input: MintPurchaseInput,
  existing: PurchaseSpend | null
): Promise<PurchaseSpend> {
  const receipt = {
    currency: input.currency,
    lineItems: input.lineItems,
    fees: input.fees,
    subtotalCents: input.subtotalCents,
    totalCents: input.totalCents,
  };

  if (existing && RETRYABLE_PURCHASE_STATUSES.has(existing.status)) {
    return repo.updatePurchaseStatus(existing.id, PurchaseSpendStatus.PENDING_APPROVAL, {
      lineItemsJson: receipt,
      cardId: null,
      stripePaymentIntentId: null,
    });
  }
  return repo.createPendingPurchase({
    userId: input.userId,
    agentId: input.agentId,
    fingerprint: input.fingerprint,
    merchant: input.merchant,
    lineItemsJson: receipt,
    totalCents: input.totalCents,
  });
}

/**
 * Authorize a manual-capture HOLD on the user's saved card off-session (money is NOT taken yet),
 * then mint the order-sized single-use card (→ HELD). The hold is captured only when the card
 * settles (`transaction.cleared` / liveness check), and released (canceled, no refund) if the
 * purchase is abandoned (`transaction.voided`, explicit close, or agent-session cleanup).
 */
async function chargeAndIssueCard(
  purchaseId: string,
  input: MintPurchaseInput,
  stripeCustomerId: string,
  cardProvider?: CardProvider
): Promise<MintPurchaseResult> {
  let paymentIntentId: string | undefined;
  try {
    const paymentMethodId = await getCustomerDefaultPaymentMethodId(stripeCustomerId);
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: input.totalCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        confirm: true,
        off_session: true,
        // Authorize a hold; the money is only taken on capture (card settles). Abandoned purchases
        // cancel the hold instead of charge-then-refund — no fee, no user-visible charge churn.
        capture_method: 'manual',
        statement_descriptor_suffix: sanitizeDescriptorSuffix(input.merchant),
        metadata: {
          userId: input.userId,
          agentId: input.agentId ?? '',
          fingerprint: input.fingerprint,
          purchaseSpendId: purchaseId,
        },
      },
      // Per-row idempotency: a retried mint of the SAME purchase never double-charges Stripe.
      { idempotencyKey: `purchase-charge:${purchaseId}` }
    );
    paymentIntentId = paymentIntent.id;

    const activeCardProvider = cardProvider ?? createCardProvider();
    const minted = await activeCardProvider.mintCard({
      amountCents: input.totalCents,
      idempotencyKey: `purchase:${purchaseId}`,
    });
    const details = await activeCardProvider.getDetails(minted.cardId);

    await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.HELD, {
      cardId: minted.cardId,
      stripePaymentIntentId: paymentIntent.id,
    });

    return {
      purchaseId,
      cardId: minted.cardId,
      pan: details.pan,
      cvv: details.cvv,
      expiry: details.expiry,
      last4: minted.last4,
      status: PurchaseSpendStatus.HELD,
    };
  } catch (error) {
    log.error('Failed to mint purchase card', {
      purchase_id: purchaseId,
      user_id: input.userId,
      agent_id: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.FAILED, {
      stripePaymentIntentId: paymentIntentId ?? null,
    });
    throw error;
  }
}

export async function mintPurchaseCard(
  input: MintPurchaseInput,
  cardProvider?: CardProvider
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

  const existing = await repo.findMostRecentPurchaseByUserAndFingerprint(
    input.userId,
    input.fingerprint
  );
  if (existing) {
    const reused = await tryReuseExistingPurchase(existing, cardProvider);
    if (reused) return reused;
  }

  const purchase = await openPendingPurchase(input, existing);

  const subscription = await repo.findSubscriptionByUserId(input.userId);
  const stripeCustomerId = subscription?.stripeCustomerId;
  if (stripeCustomerId === undefined || stripeCustomerId === null || stripeCustomerId === '') {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED);
    throw new PurchaseError('User does not have a Stripe billing customer', 402);
  }

  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING);
  return chargeAndIssueCard(purchase.id, input, stripeCustomerId, cardProvider);
}
