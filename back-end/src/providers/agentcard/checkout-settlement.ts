/**
 * Settlement for a Rose-minted card charged through a REAL Stripe merchant.
 *
 * The sandbox path (`sandbox-settlement.ts`) drives AgentCard's `test_charge`, which AgentCard
 * refuses on live cards: "Test charges only exist with sandbox keys (sk_test_). Live cards are
 * charged by real merchants." So a live Rose card can only be proven by an actual acquirer
 * authorization — here, Stripe Checkout against our own Stripe account.
 *
 * The two paths differ ONLY in who moves the money. Everything else — matching the card to a HELD
 * purchase, the atomic HELD -> CHARGING claim, and marking CLEARED/CONSUMED — is shared, so the
 * lifecycle assertions in the payment benchmarks hold identically for both.
 *
 * Stripe Checkout carries the exact Rose purchase id in `client_reference_id` and metadata. The
 * reported amount and card last4 are defense-in-depth checks on that correlated purchase, never a
 * search key. This prevents equal-value purchases using cards with the same suffix from crossing.
 *
 * KEY SPLIT: this file makes NO Stripe call and must never acquire one. The merchant (acquirer) key
 * belongs to the checkout domain; the only Stripe object referenced here is
 * `stripePaymentIntentId`, which is the BILLING-side hold on the user and is read/captured/refunded
 * exclusively through the `stripe` billing singleton. Reaching for the merchant client here would
 * point billing operations at the wrong Stripe account. See providers/stripe.ts.
 */

import { PurchaseSpendStatus } from '@prisma/client';
import { isAdminUser } from '../../utils/adminAccess';
import { createCardProviderForAgent } from '../card-provider';
import { prisma } from '../database';
import { agentCardV2Request } from './api-v2';
import {
  AgentCardSandboxSettlementError,
  claimHeldPurchaseForCharge,
  markPurchaseCleared,
} from './sandbox-settlement';

export interface CheckoutSettlementInput {
  /** Purchase id persisted through Stripe Checkout client_reference_id/metadata. */
  purchaseId: string;
  /** Last four digits Stripe reported for the card that actually paid. */
  last4: string;
  /** Amount Stripe actually captured, in cents. */
  amountCents: number;
}

/**
 * `stripePaymentIntentId` is the USER-side hold on the purchase, which is null for a company-funded
 * ADMIN purchase (no personal charge was ever authorized). It is not the Checkout capture.
 */
export interface CheckoutSettlementResult {
  purchaseId: string;
  cardId: string;
  stripePaymentIntentId: string | null;
}

interface CheckoutSettlementDependencies {
  findPurchaseForCheckout?: (purchaseId: string) => Promise<CheckoutHeldPurchase | null>;
  getCardLast4?: (userId: string, agentId: string | null, cardId: string) => Promise<string>;
  claimHeldPurchaseForCharge?: (purchaseId: string) => Promise<boolean>;
  markPurchaseCleared?: (purchaseId: string) => Promise<void>;
}

export interface CheckoutHeldPurchase {
  id: string;
  userId: string;
  agentId: string | null;
  cardId: string;
  stripePaymentIntentId: string | null;
  totalCents: number;
  status: PurchaseSpendStatus;
}

/**
 * Load the correlated purchase in ANY status — deliberately NOT held-only.
 *
 * A held-only lookup made this whole path unrecoverable: Stripe captures BEFORE settlement runs, so
 * once the HELD -> CHARGING claim lands the row is no longer HELD. If the CLEARED write then failed
 * (pool timeout, process restart, reclaimed funding), every retry of the very same paid Checkout
 * session 404'd and the purchase stayed CHARGING forever — money captured, purchase never cleared.
 * The same held-only filter also 404'd a shopper who simply reloaded a successful return URL.
 *
 * Loading every status lets `settleRoseCardStripeCheckout` re-validate the capture against the row
 * and then either resume the interrupted transition or replay the already-settled result.
 */
async function findPurchaseForCheckout(purchaseId: string): Promise<CheckoutHeldPurchase | null> {
  const purchase = await prisma.purchaseSpend.findFirst({
    where: { id: purchaseId, cardId: { not: null } },
    select: {
      id: true,
      userId: true,
      agentId: true,
      cardId: true,
      stripePaymentIntentId: true,
      totalCents: true,
      status: true,
    },
  });
  if (purchase === null || purchase.cardId === null) return null;
  return { ...purchase, cardId: purchase.cardId };
}

/**
 * v2 retains card identity after closure but revokes credentials. Legacy cards
 * keep the agent-scoped factory, including the production benchmark mint gate.
 * This read proves identity only; the caller must already have verified capture.
 */
async function getCardLast4(
  userId: string,
  agentId: string | null,
  cardId: string
): Promise<string> {
  if (cardId.startsWith('card_')) {
    // A captured single-use card may already be closed, with credentials revoked.
    // Read only its stable identity; closure itself is never evidence of capture.
    const card = await agentCardV2Request('GET', `/api/v2/cards/${encodeURIComponent(cardId)}`);
    if (card.id !== cardId || typeof card.last4 !== 'string' || !/^\d{4}$/.test(card.last4)) {
      throw new Error('AgentCard returned an invalid card identity');
    }
    return card.last4;
  }
  const provider = await createCardProviderForAgent(userId, agentId);
  const details = await provider.getDetails(cardId);
  return details.pan.replace(/\s+/g, '').slice(-4);
}

/**
 * Mark the purchase whose minted card Stripe just charged as CLEARED.
 *
 * Stripe has ALREADY captured by the time this runs, so this function must never itself move money
 * — it only reconciles our records to an authorization that already happened. Because the money has
 * already moved, reconciliation MUST be retryable: a failed CLEARED write can never be allowed to
 * strand a captured purchase in CHARGING.
 *
 * RECONCILIATION IDENTITY. The retry-safe key is the verified triple
 * `(purchaseId, capturedAmountCents, chargedCardLast4)`: the purchase id is carried by Stripe in
 * `client_reference_id`/metadata, and the amount + last4 are re-proved against the persisted row on
 * EVERY call, including retries. A later Checkout that differs in either dimension is rejected (409)
 * instead of replaying someone else's settlement. Only a capture that re-proves all three — i.e.
 * the same session, or a duplicate capture of the same cart on the same Rose card — is allowed to
 * finish or replay the transition, and it clears the purchase exactly once.
 *
 * State machine (status is re-read from the row on every call):
 *   HELD     -> claim HELD->CHARGING, then CLEARED. Lost claim = a concurrent settler won (409).
 *   CHARGING -> an earlier attempt captured and claimed but failed to clear: RESUME the CLEARED
 *               write. `markPurchaseCleared` only matches CHARGING rows, so this is idempotent.
 *   CLEARED  -> already reconciled (e.g. the shopper reloaded the success URL): replay the result
 *               without touching the row, so the purchase can never clear twice.
 *   anything else -> not reconcilable to a paid checkout (409).
 */
export async function settleRoseCardStripeCheckout(
  input: CheckoutSettlementInput,
  dependencies: CheckoutSettlementDependencies = {}
): Promise<CheckoutSettlementResult> {
  const findPurchase = dependencies.findPurchaseForCheckout ?? findPurchaseForCheckout;
  const readLast4 = dependencies.getCardLast4 ?? getCardLast4;
  const claimForCharge = dependencies.claimHeldPurchaseForCharge ?? claimHeldPurchaseForCharge;
  const markCleared = dependencies.markPurchaseCleared ?? markPurchaseCleared;

  const normalizedLast4 = input.last4.replace(/\D/g, '').slice(-4);
  if (normalizedLast4.length !== 4) {
    throw new AgentCardSandboxSettlementError('Stripe did not report a usable card last4', 502);
  }

  const purchaseId = input.purchaseId.trim();
  if (purchaseId === '') {
    throw new AgentCardSandboxSettlementError('Stripe did not report a purchase reference', 502);
  }
  const purchase = await findPurchase(purchaseId);
  if (purchase === null) {
    throw new AgentCardSandboxSettlementError(
      'Stripe checkout purchase does not exist or never minted a card',
      404
    );
  }
  if (purchase.totalCents !== input.amountCents) {
    throw new AgentCardSandboxSettlementError(
      'Stripe captured amount does not match the correlated Rose purchase',
      409
    );
  }

  let last4: string;
  try {
    last4 = await readLast4(purchase.userId, purchase.agentId, purchase.cardId);
  } catch {
    throw new AgentCardSandboxSettlementError(
      'The correlated Rose card could not be resolved',
      502
    );
  }
  if (last4 !== normalizedLast4) {
    throw new AgentCardSandboxSettlementError(
      'Stripe charged a different card than the correlated Rose purchase',
      409
    );
  }

  // A company-funded ADMIN purchase never authorized a personal hold, so a null payment intent is
  // expected there. For every other user the hold precedes the mint, so its absence means the row
  // is corrupt and must not be reconciled as paid.
  if (purchase.stripePaymentIntentId === null && !isAdminUser(purchase.userId)) {
    throw new AgentCardSandboxSettlementError('Cleared purchase is missing its Stripe hold', 502);
  }

  const settled: CheckoutSettlementResult = {
    purchaseId: purchase.id,
    cardId: purchase.cardId,
    stripePaymentIntentId: purchase.stripePaymentIntentId,
  };

  // Every branch below has already re-proved the reconciliation identity above, so reaching here
  // means this capture is entitled to (and only to) this purchase's single CLEARED transition.
  switch (purchase.status) {
    case PurchaseSpendStatus.CLEARED:
      // Already reconciled — a re-delivered success_url or a shopper reloading the return URL.
      // Replaying the stored result is the only safe answer: re-running `markPurchaseCleared` here
      // would fail its CHARGING guard and turn a settled purchase into a 502.
      return settled;

    case PurchaseSpendStatus.CHARGING:
      // An earlier attempt captured at Stripe, won the claim, and then failed to write CLEARED.
      // Resume that exact transition instead of stranding captured money in CHARGING forever.
      await markCleared(purchase.id);
      return settled;

    case PurchaseSpendStatus.HELD: {
      // Atomic claim keeps a double-delivered success_url (or a concurrent settle call) from
      // clearing the same purchase twice. The loser retries and lands on CHARGING/CLEARED above.
      if (!(await claimForCharge(purchase.id))) {
        throw new AgentCardSandboxSettlementError('Rose purchase was already claimed', 409);
      }
      await markCleared(purchase.id);
      return settled;
    }

    default:
      throw new AgentCardSandboxSettlementError(
        `Rose purchase is ${purchase.status} and cannot be reconciled to a paid checkout`,
        409
      );
  }
}
