import crypto from 'node:crypto';
import { createCardProvider, type CardProvider } from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import { stripe } from '../../providers/stripe';
import {
  AGENTCARD_WEBHOOK_SECRET,
  MAX_PURCHASE_CENTS,
  PURCHASE_APPROVAL_CACHE_HOURS,
} from './config';
import * as repo from './repo';
import { PurchaseSpendStatus } from './types';
import type {
  AgentCardWebhookEvent,
  MintPurchaseInput,
  MintPurchaseResult,
  PurchaseLookupResult,
} from './types';

const log = createLogger('Purchases');
const RETRYABLE_PURCHASE_STATUSES = new Set<PurchaseSpendStatus>([
  PurchaseSpendStatus.FAILED,
  PurchaseSpendStatus.REFUNDED,
  PurchaseSpendStatus.VOIDED,
]);

export class PurchaseError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

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

function isTerminalNoRepurchaseStatus(status: PurchaseSpendStatus): boolean {
  return status === PurchaseSpendStatus.CLEARED;
}

function extractWebhookCardId(event: AgentCardWebhookEvent): string | undefined {
  return (
    event.cardId ??
    event.card_id ??
    event.data?.cardId ??
    event.data?.card_id ??
    event.data?.card?.id
  );
}

export async function lookupPurchase(
  userId: string,
  fingerprint: string
): Promise<PurchaseLookupResult> {
  if (fingerprint.trim() === '') {
    throw new PurchaseError('fingerprint is required');
  }

  const since = new Date(Date.now() - PURCHASE_APPROVAL_CACHE_HOURS * 60 * 60 * 1000);
  const purchase = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
  if (!purchase) {
    return { found: false, reusable: false, purchase: null };
  }

  return {
    found: true,
    reusable: isReusableStatus(purchase.status) && purchase.cardId !== null,
    purchase: {
      id: purchase.id,
      agentId: purchase.agentId,
      fingerprint: purchase.fingerprint,
      cardId: purchase.cardId,
      merchant: purchase.merchant,
      totalCents: purchase.totalCents,
      status: purchase.status,
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
    },
  };
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

  const existing = await repo.findPurchaseByUserAndFingerprint(input.userId, input.fingerprint);
  if (existing) {
    if (isReusableStatus(existing.status) && existing.cardId !== null) {
      const details = await (cardProvider ?? createCardProvider()).getDetails(existing.cardId);
      return {
        purchaseId: existing.id,
        cardId: existing.cardId,
        pan: details.pan,
        cvv: details.cvv,
        expiry: details.expiry,
        last4: details.pan.slice(-4),
        status: existing.status,
      };
    }
    if (isTerminalNoRepurchaseStatus(existing.status)) {
      throw new PurchaseError('This purchase has already been completed', 409);
    }
    if (
      existing.status === PurchaseSpendStatus.CHARGING ||
      existing.status === PurchaseSpendStatus.PENDING_APPROVAL
    ) {
      throw new PurchaseError('This purchase is already in progress', 409);
    }
  }

  const receipt = {
    currency: input.currency,
    lineItems: input.lineItems,
    fees: input.fees,
    subtotalCents: input.subtotalCents,
    totalCents: input.totalCents,
  };

  const purchase =
    existing && RETRYABLE_PURCHASE_STATUSES.has(existing.status)
      ? await repo.updatePurchaseStatus(existing.id, PurchaseSpendStatus.PENDING_APPROVAL, {
          lineItemsJson: receipt,
          cardId: null,
          stripePaymentIntentId: null,
        })
      : await repo.createPendingPurchase({
          userId: input.userId,
          agentId: input.agentId,
          fingerprint: input.fingerprint,
          merchant: input.merchant,
          lineItemsJson: receipt,
          totalCents: input.totalCents,
        });

  const subscription = await repo.findSubscriptionByUserId(input.userId);
  if (!subscription?.stripeCustomerId) {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED);
    throw new PurchaseError('User does not have a Stripe billing customer', 402);
  }

  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING);

  let paymentIntentId: string | undefined;
  try {
    const paymentMethodId = await getCustomerDefaultPaymentMethodId(subscription.stripeCustomerId);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: input.totalCents,
      currency: 'usd',
      customer: subscription.stripeCustomerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      statement_descriptor_suffix: sanitizeDescriptorSuffix(input.merchant),
      metadata: {
        userId: input.userId,
        agentId: input.agentId ?? '',
        fingerprint: input.fingerprint,
        purchaseSpendId: purchase.id,
      },
    });
    paymentIntentId = paymentIntent.id;

    const activeCardProvider = cardProvider ?? createCardProvider();
    const minted = await activeCardProvider.mintCard({
      amountCents: input.totalCents,
      idempotencyKey: `purchase:${purchase.id}`,
    });
    const details = await activeCardProvider.getDetails(minted.cardId);

    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.HELD, {
      cardId: minted.cardId,
      stripePaymentIntentId: paymentIntent.id,
    });

    return {
      purchaseId: purchase.id,
      cardId: minted.cardId,
      pan: details.pan,
      cvv: details.cvv,
      expiry: details.expiry,
      last4: minted.last4,
      status: PurchaseSpendStatus.HELD,
    };
  } catch (error) {
    log.error('Failed to mint purchase card', {
      purchase_id: purchase.id,
      user_id: input.userId,
      agent_id: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED, {
      stripePaymentIntentId: paymentIntentId ?? null,
    });
    throw error;
  }
}

export async function closePurchaseCard(
  cardId: string,
  cardProvider: CardProvider = createCardProvider()
): Promise<{ ok: true; status: PurchaseSpendStatus }> {
  if (cardId.trim() === '') {
    throw new PurchaseError('cardId is required');
  }

  const purchase = await repo.findPurchaseByCardId(cardId);
  if (!purchase) {
    throw new PurchaseError('Purchase card not found', 404);
  }

  if (
    purchase.status === PurchaseSpendStatus.REFUNDED ||
    purchase.status === PurchaseSpendStatus.VOIDED
  ) {
    return { ok: true, status: purchase.status };
  }

  if (purchase.status !== PurchaseSpendStatus.CLEARED) {
    await cardProvider.closeCard(cardId);
    if (purchase.stripePaymentIntentId) {
      await stripe.refunds.create({
        payment_intent: purchase.stripePaymentIntentId,
        metadata: { purchaseSpendId: purchase.id },
      });
    }
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.REFUNDED);
    return { ok: true, status: PurchaseSpendStatus.REFUNDED };
  }

  await cardProvider.closeCard(cardId);
  return { ok: true, status: PurchaseSpendStatus.CLEARED };
}

export function verifyAgentCardWebhookSignature(rawBody: string, signatureHeader?: string): void {
  if (!AGENTCARD_WEBHOOK_SECRET) return;
  if (!signatureHeader) throw new PurchaseError('Missing AgentCard webhook signature', 400);

  const expected = crypto
    .createHmac('sha256', AGENTCARD_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const received = signatureHeader.replace(/^sha256=/, '');
  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  ) {
    throw new PurchaseError('Invalid AgentCard webhook signature', 403);
  }
}

export async function handleAgentCardWebhook(event: AgentCardWebhookEvent): Promise<{ ok: true }> {
  const cardId = extractWebhookCardId(event);
  if (!cardId) {
    log.warn('Ignoring AgentCard webhook without card id', { type: event.type });
    return { ok: true };
  }

  const purchase = await repo.findPurchaseByCardId(cardId);
  if (!purchase) {
    log.warn('Ignoring AgentCard webhook for unknown card', { card_id: cardId, type: event.type });
    return { ok: true };
  }

  if (event.type === 'transaction.cleared') {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CLEARED);
  } else if (event.type === 'transaction.voided') {
    if (purchase.stripePaymentIntentId) {
      await stripe.refunds.create({
        payment_intent: purchase.stripePaymentIntentId,
        metadata: { purchaseSpendId: purchase.id, agentcardEventType: event.type },
      });
    }
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.VOIDED);
  }

  return { ok: true };
}
