import {
  createCardProvider,
  isCardLive,
  type CardProvider,
  type CardProviderDetailsResult,
  AgentCardProviderError,
} from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import {
  cancelAuthorizedHold,
  captureAuthorizedHold,
  refundCapturedPurchase,
  stripe,
} from '../../providers/stripe';
import {
  createWalletFundingProvider,
  WalletFundingProviderError,
  type WalletFundingProvider,
} from '../../providers/wallet-funding';
import { MAX_PURCHASE_CENTS, PURCHASE_APPROVAL_CACHE_HOURS } from './config';
import { PurchaseError } from './errors';
import * as repo from './repo';
import { archivePurchaseBoundary } from './archive';
import {
  confirmPurchaseWalletCollection,
  recordPurchaseWalletFunding,
  reclaimPurchaseWalletFunding,
} from './walletFunding';
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
const STALE_CHARGING_MS = Number(process.env.PURCHASE_STALE_CHARGING_MS ?? 15 * 60 * 1000);
const COMPANY_FLOW_MAX_WAIT_MS = Number(
  process.env.AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS ?? 60 * 1000
);
const COMPANY_FLOW_RETRY_MS = Number(process.env.AGENTCARD_COMPANY_FLOW_RETRY_MS ?? 2 * 1000);
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

function isStripeMissingCustomerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    param?: unknown;
    message?: unknown;
    raw?: { code?: unknown; param?: unknown };
  };
  const code = typeof candidate.code === 'string' ? candidate.code : candidate.raw?.code;
  const param = typeof candidate.param === 'string' ? candidate.param : candidate.raw?.param;
  return (
    (code === 'resource_missing' && param === 'customer') ||
    (typeof candidate.message === 'string' && candidate.message.includes('No such customer'))
  );
}

function toPurchaseBoundaryError(error: unknown): Error {
  if (error instanceof PurchaseError) return error;
  if (isStripeMissingCustomerError(error)) {
    return new PurchaseError(
      'Stored Stripe billing customer does not exist for the current Stripe environment',
      402
    );
  }
  if (error instanceof AgentCardProviderError) {
    const statusCode =
      error.status !== undefined && error.status >= 400 && error.status < 500 ? error.status : 502;
    return new PurchaseError(error.message, statusCode, error.code, error.details);
  }
  if (error instanceof WalletFundingProviderError) {
    const statusCode = error.status >= 400 && error.status < 500 ? error.status : 502;
    return new PurchaseError(error.message, statusCode, error.code, error.details);
  }
  return error instanceof Error ? error : new Error(String(error));
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

function isStaleChargingPurchase(purchase: PurchaseSpend): boolean {
  return (
    purchase.status === PurchaseSpendStatus.CHARGING &&
    Date.now() - purchase.updatedAt.getTime() > STALE_CHARGING_MS
  );
}

function companyFundingInProgressDetails(error: unknown):
  | {
      transferId: string;
      retryAfterSeconds?: number;
      agentcardResult?: Record<string, unknown>;
    }
  | undefined {
  if (!(error instanceof AgentCardProviderError)) return undefined;
  if (error.code !== 'agentcard_company_funding_in_progress') return undefined;
  const details = error.details ?? {};
  const transferId = details.transferId;
  if (typeof transferId !== 'string' || transferId.trim() === '') return undefined;
  const retryAfterSeconds = details.retryAfterSeconds;
  const agentcardResult = details.agentcardResult;
  return {
    transferId,
    ...(typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
      ? { retryAfterSeconds }
      : {}),
    ...(typeof agentcardResult === 'object' && agentcardResult !== null
      ? { agentcardResult: agentcardResult as Record<string, unknown> }
      : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the card details only if the card is still live; `null` if it has been
 * settled/closed/deleted or can't be read. Fail-safe: an unreadable card is treated as consumed
 * so we re-prompt instead of silently re-issuing a dead, already-charged card.
 */
async function tryGetLiveCardDetails(
  userId: string,
  cardId: string,
  cardProvider?: CardProvider
): Promise<CardProviderDetailsResult | null> {
  try {
    const details = await (cardProvider ?? createCardProvider(userId)).getDetails(cardId);
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
    const liveDetails = await tryGetLiveCardDetails(userId, purchase.cardId, cardProvider);
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
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult | null> {
  if (isStaleChargingPurchase(existing)) {
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
    const liveDetails = await tryGetLiveCardDetails(existing.userId, existing.cardId, cardProvider);
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
  const receipt = {
    currency: input.currency,
    lineItems: input.lineItems,
    fees: input.fees,
    subtotalCents: input.subtotalCents,
    totalCents: input.totalCents,
  };

  if (existing && RETRYABLE_PURCHASE_STATUSES.has(existing.status)) {
    return repo.createPendingPurchase({
      userId: input.userId,
      agentId: input.agentId,
      fingerprint: input.fingerprint,
      merchant: input.merchant,
      lineItemsJson: receipt,
      totalCents: input.totalCents,
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

async function mintCompanyFlowCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  cardProvider: CardProvider,
  walletFundingProvider: WalletFundingProvider
) {
  const cardRequest = {
    amountCents: input.totalCents,
    idempotencyKey: `purchase:${purchase.id}`,
    fundsSource: 'company_flow' as const,
  };
  const deadline = Date.now() + COMPANY_FLOW_MAX_WAIT_MS;
  let confirmedTransferId: string | undefined;

  for (;;) {
    try {
      return {
        cardRequest,
        minted: await cardProvider.mintCard(cardRequest),
        providerTransferId: confirmedTransferId,
      };
    } catch (error) {
      const funding = companyFundingInProgressDetails(error);
      if (funding === undefined) throw error;

      if (confirmedTransferId !== funding.transferId) {
        const walletFunding = await confirmPurchaseWalletCollection(
          purchase,
          'usd',
          funding.transferId,
          funding.agentcardResult,
          walletFundingProvider
        );
        confirmedTransferId = funding.transferId;
        await archivePurchaseBoundary(input.agentId, purchase.id, 'agentcard-company-funding', {
          funding_id: walletFunding.id,
          provider_transfer_id: walletFunding.providerTransferId,
          status: walletFunding.status,
        });
      }

      if (Date.now() >= deadline) {
        throw new PurchaseError(
          'AgentCard company funding is still in progress; retry this purchase shortly',
          409,
          'agentcard_company_funding_in_progress',
          { transferId: funding.transferId }
        );
      }

      const retryMs =
        funding.retryAfterSeconds !== undefined
          ? Math.max(250, Math.min(funding.retryAfterSeconds * 1000, COMPANY_FLOW_RETRY_MS))
          : COMPANY_FLOW_RETRY_MS;
      await sleep(retryMs);
    }
  }
}

/**
 * Authorize the user's saved card, mint the company-funded single-use card, then capture the
 * user's charge as soon as AgentCard confirms the transfer. A returned card is therefore always
 * fully funded. If any later setup step fails, close/reclaim the card and refund the charge.
 */
async function chargeAndIssueCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  stripeCustomerId: string,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  let paymentIntentId: string | undefined;
  let paymentIntentCaptured = false;
  let paymentReversalFailed = false;
  let walletWasFunded = false;
  let walletReclaimFailed = false;
  let activeWalletFundingProvider: WalletFundingProvider | undefined;
  let activeCardProvider: CardProvider | undefined;
  let issuedCardId: string | undefined;
  const purchaseId = purchase.id;
  try {
    const paymentMethodId = await getCustomerDefaultPaymentMethodId(stripeCustomerId);
    const stripeRequest = {
      amount: input.totalCents,
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      capture_method: 'manual' as const,
      statement_descriptor_suffix: sanitizeDescriptorSuffix(input.merchant),
      metadata: {
        userId: input.userId,
        agentId: input.agentId ?? '',
        fingerprint: input.fingerprint,
        purchaseSpendId: purchaseId,
      },
    };
    const paymentIntent = await stripe.paymentIntents.create(
      stripeRequest,
      // Per-row idempotency: a retried mint of the SAME purchase never double-charges Stripe.
      { idempotencyKey: `purchase-charge:${purchaseId}` }
    );
    paymentIntentId = paymentIntent.id;
    await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.CHARGING, {
      stripePaymentIntentId: paymentIntent.id,
    });
    await archivePurchaseBoundary(input.agentId, purchaseId, 'stripe-payment-intent', {
      request: stripeRequest,
      response: paymentIntent,
    });

    activeWalletFundingProvider = walletFundingProvider ?? createWalletFundingProvider();
    activeCardProvider = cardProvider ?? createCardProvider(input.userId);
    const { cardRequest, minted, providerTransferId } = await mintCompanyFlowCard(
      purchase,
      input,
      activeCardProvider,
      activeWalletFundingProvider
    );
    const transferId = minted.providerTransferId ?? providerTransferId;
    issuedCardId = minted.cardId;
    if (transferId === undefined || transferId.trim() === '') {
      throw new PurchaseError(
        'AgentCard issued a card without a company transfer id',
        502,
        'agentcard_company_transfer_missing'
      );
    }
    walletWasFunded = true;
    await recordPurchaseWalletFunding(purchase, 'usd', transferId, minted.metadata);
    await captureAuthorizedHold(paymentIntent.id);
    paymentIntentCaptured = true;
    const details = await activeCardProvider.getDetails(minted.cardId);
    await archivePurchaseBoundary(input.agentId, purchaseId, 'agentcard-mint-and-details', {
      mint_request: cardRequest,
      mint_response: minted,
      details_response: details,
    });

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
    const boundaryError = toPurchaseBoundaryError(error);
    if (
      boundaryError instanceof PurchaseError &&
      boundaryError.code === 'agentcard_company_funding_in_progress'
    ) {
      walletReclaimFailed = true;
    }
    if (issuedCardId !== undefined && activeCardProvider !== undefined) {
      try {
        await activeCardProvider.closeCard(issuedCardId);
        await reclaimPurchaseWalletFunding(
          { ...purchase, cardId: issuedCardId },
          'mint_failed_after_card_issue',
          activeWalletFundingProvider
        );
        walletWasFunded = false;
      } catch (cleanupError) {
        walletReclaimFailed = true;
        log.error('Failed to close issued AgentCard after purchase setup failure', {
          purchase_id: purchaseId,
          card_id: issuedCardId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    if (walletWasFunded && !walletReclaimFailed) {
      walletReclaimFailed = true;
      log.error('AgentCard company funding was confirmed but card issue did not complete', {
        purchase_id: purchaseId,
        user_id: input.userId,
        error: boundaryError.message,
      });
    }
    if (paymentIntentId !== undefined && !walletReclaimFailed) {
      const reversePayment = paymentIntentCaptured
        ? refundCapturedPurchase(paymentIntentId, purchaseId)
        : cancelAuthorizedHold(paymentIntentId);
      await reversePayment.catch((reverseError) => {
        paymentReversalFailed = true;
        log.warn('Failed to reverse Stripe payment after purchase mint failure', {
          purchase_id: purchaseId,
          stripe_payment_intent_id: paymentIntentId,
          captured: paymentIntentCaptured,
          error: reverseError instanceof Error ? reverseError.message : String(reverseError),
        });
      });
    }
    log.error('Failed to mint purchase card', {
      purchase_id: purchaseId,
      user_id: input.userId,
      agent_id: input.agentId,
      error: boundaryError.message,
    });
    await repo.updatePurchaseStatus(
      purchaseId,
      walletReclaimFailed
        ? PurchaseSpendStatus.FUNDING_RECLAIM_FAILED
        : paymentIntentCaptured && paymentReversalFailed
          ? PurchaseSpendStatus.REFUND_FAILED
          : PurchaseSpendStatus.FAILED,
      {
        stripePaymentIntentId: paymentIntentId ?? null,
      }
    );
    throw boundaryError;
  }
}

export async function mintPurchaseCard(
  input: MintPurchaseInput,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
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
    const reused = await tryReuseExistingPurchase(existing, cardProvider, walletFundingProvider);
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
  return chargeAndIssueCard(purchase, input, stripeCustomerId, cardProvider, walletFundingProvider);
}
