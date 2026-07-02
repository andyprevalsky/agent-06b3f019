import crypto from 'node:crypto';
import { createCardProvider, type CardProvider } from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import { cancelAuthorizedHold, captureAuthorizedHold, stripe } from '../../providers/stripe';
import { AGENTCARD_WEBHOOK_SECRET } from './config';
import { PurchaseError } from './errors';
import * as repo from './repo';
import { PurchaseSpendStatus, type AgentCardWebhookEvent } from './types';

const log = createLogger('Purchases');

function extractWebhookCardId(event: AgentCardWebhookEvent): string | undefined {
  return (
    event.cardId ??
    event.card_id ??
    event.data?.cardId ??
    event.data?.card_id ??
    event.data?.card?.id
  );
}

function hasValue(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Close a minted card and reconcile the ledger. The purchase's Stripe charge is an authorized HOLD,
 * so an un-captured (HELD) purchase is CANCELED, not refunded — no money moved, no fee, no
 * charge/refund churn. A settled (CLEARED) purchase just has its card closed; the captured charge
 * stands. Idempotent on already-reconciled (VOIDED/REFUNDED) rows.
 */
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

  // Settled: the card was used and the hold captured — reclaim the card, but the charge stands.
  if (purchase.status === PurchaseSpendStatus.CLEARED) {
    await cardProvider.closeCard(cardId);
    return { ok: true, status: PurchaseSpendStatus.CLEARED };
  }

  // Un-captured hold (agent abandoned the purchase): release the hold. No charge, no refund.
  await cardProvider.closeCard(cardId);
  if (hasValue(purchase.stripePaymentIntentId)) {
    await cancelAuthorizedHold(purchase.stripePaymentIntentId);
  }
  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.VOIDED);
  return { ok: true, status: PurchaseSpendStatus.VOIDED };
}

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function parseSignatureHeader(header: string): { timestamp: string; v1: string } | null {
  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=');
    if (eq > 0) parts.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }
  const timestamp = parts.get('t');
  const v1 = parts.get('v1');
  if (!hasValue(timestamp) || !hasValue(v1)) return null;
  return { timestamp, v1 };
}

/**
 * Verify the AgentCard webhook signature (Svix/Stripe-style: `AgentCard-Signature: t=<ts>,v1=<hmac>`,
 * HMAC-SHA256 over `"${t}.${rawBody}"`, secret used as-is, 5-minute replay tolerance). `rawBody` must
 * be the exact received bytes — a re-stringified parse will not match. No-op without a shared secret.
 */
export function verifyAgentCardWebhookSignature(rawBody: string, signatureHeader?: string): void {
  if (!hasValue(AGENTCARD_WEBHOOK_SECRET)) return;
  if (!hasValue(signatureHeader)) {
    throw new PurchaseError('Missing AgentCard webhook signature', 400);
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    throw new PurchaseError('Malformed AgentCard webhook signature', 400);
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(parsed.timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    throw new PurchaseError('AgentCard webhook timestamp outside tolerance', 400);
  }

  const expected = crypto
    .createHmac('sha256', AGENTCARD_WEBHOOK_SECRET)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');
  const received = Buffer.from(parsed.v1, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (received.length !== expectedBuf.length || !crypto.timingSafeEqual(received, expectedBuf)) {
    throw new PurchaseError('Invalid AgentCard webhook signature', 403);
  }
}

/**
 * Reconcile a purchase from an AgentCard transaction webhook:
 *  - `transaction.cleared` → the card settled, so CAPTURE the user's hold (→ CLEARED). Capture is
 *    always attempted (even if a prior liveness check already flipped the row to CLEARED without
 *    capturing) and is idempotent, so a lost `cleared` webhook can't leave money uncollected.
 *  - `transaction.voided` → if the hold was already captured (CLEARED), REFUND it (→ REFUNDED);
 *    otherwise CANCEL the un-captured hold (→ VOIDED) — no charge, no refund churn.
 * Already-terminal (VOIDED/REFUNDED) rows are never resurrected by a late/duplicate event.
 */
export async function handleAgentCardWebhook(event: AgentCardWebhookEvent): Promise<{ ok: true }> {
  const cardId = extractWebhookCardId(event);
  if (!hasValue(cardId)) {
    log.warn('Ignoring AgentCard webhook without card id', { type: event.type });
    return { ok: true };
  }

  const purchase = await repo.findPurchaseByCardId(cardId);
  if (!purchase) {
    log.warn('Ignoring AgentCard webhook for unknown card', { card_id: cardId, type: event.type });
    return { ok: true };
  }

  if (
    purchase.status === PurchaseSpendStatus.VOIDED ||
    purchase.status === PurchaseSpendStatus.REFUNDED
  ) {
    return { ok: true };
  }

  if (event.type === 'transaction.cleared') {
    if (hasValue(purchase.stripePaymentIntentId)) {
      await captureAuthorizedHold(purchase.stripePaymentIntentId);
    }
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CLEARED);
  } else if (event.type === 'transaction.voided') {
    if (purchase.status === PurchaseSpendStatus.CLEARED) {
      // The hold was already captured, then the card transaction reversed → refund the charge.
      if (hasValue(purchase.stripePaymentIntentId)) {
        await stripe.refunds.create({
          payment_intent: purchase.stripePaymentIntentId,
          metadata: { purchaseSpendId: purchase.id, agentcardEventType: event.type },
        });
      }
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.REFUNDED);
    } else {
      // Hold never captured → release it. No money taken.
      if (hasValue(purchase.stripePaymentIntentId)) {
        await cancelAuthorizedHold(purchase.stripePaymentIntentId);
      }
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.VOIDED);
    }
  }

  return { ok: true };
}
