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
 * Matching is by (amount, last4) rather than PAN because Stripe Checkout collects the card on
 * Stripe's page: our backend never sees the number, which is the entire point of using a hosted
 * merchant (no PCI scope, and live-mode raw-PAN tokenization is blocked anyway).
 *
 * KEY SPLIT: this file makes NO Stripe call and must never acquire one. The merchant (acquirer) key
 * belongs to the checkout domain; the only Stripe object referenced here is
 * `stripePaymentIntentId`, which is the BILLING-side hold on the user and is read/captured/refunded
 * exclusively through the `stripe` billing singleton. Reaching for the merchant client here would
 * point billing operations at the wrong Stripe account. See providers/stripe.ts.
 */

import { isAdminUser } from '../../utils/adminAccess';
import { createCardProviderForAgent } from '../card-provider';
import {
  AgentCardSandboxSettlementError,
  claimHeldPurchaseForCharge,
  findHeldPurchasesByTotal,
  markPurchaseCleared,
  type HeldPurchase,
} from './sandbox-settlement';

export interface CheckoutSettlementInput {
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
  findHeldPurchasesByTotal?: (amountCents: number) => Promise<HeldPurchase[]>;
  getCardLast4?: (userId: string, agentId: string | null, cardId: string) => Promise<string>;
  claimHeldPurchaseForCharge?: (purchaseId: string) => Promise<boolean>;
  markPurchaseCleared?: (purchaseId: string) => Promise<void>;
}

/**
 * Read the minted card's last4 through the AGENT-scoped factory. Production keeps
 * `AGENTCARD_MINT_ENABLED` off, so only the durable `Agent.isBenchmark` bit can resolve a real
 * AgentCard here; the env-only factory would hand back the static Brex provider and reject the id.
 */
async function getCardLast4(
  userId: string,
  agentId: string | null,
  cardId: string
): Promise<string> {
  const provider = await createCardProviderForAgent(userId, agentId);
  const details = await provider.getDetails(cardId);
  return details.pan.replace(/\s+/g, '').slice(-4);
}

/**
 * Mark the HELD purchase whose minted card Stripe just charged as CLEARED.
 *
 * Stripe has ALREADY captured by the time this runs, so this function must never itself move money
 * — it only reconciles our records to an authorization that already happened.
 */
export async function settleRoseCardStripeCheckout(
  input: CheckoutSettlementInput,
  dependencies: CheckoutSettlementDependencies = {}
): Promise<CheckoutSettlementResult> {
  const findPurchases = dependencies.findHeldPurchasesByTotal ?? findHeldPurchasesByTotal;
  const readLast4 = dependencies.getCardLast4 ?? getCardLast4;
  const claimForCharge = dependencies.claimHeldPurchaseForCharge ?? claimHeldPurchaseForCharge;
  const markCleared = dependencies.markPurchaseCleared ?? markPurchaseCleared;

  const normalizedLast4 = input.last4.replace(/\D/g, '').slice(-4);
  if (normalizedLast4.length !== 4) {
    throw new AgentCardSandboxSettlementError('Stripe did not report a usable card last4', 502);
  }

  for (const purchase of await findPurchases(input.amountCents)) {
    if (purchase.cardId === null) continue;

    // A candidate we cannot resolve is simply not this card — skip rather than throw, so one stale
    // HELD purchase cannot fail an otherwise-good settlement.
    let last4: string;
    try {
      last4 = await readLast4(purchase.userId, purchase.agentId, purchase.cardId);
    } catch {
      continue;
    }
    if (last4 !== normalizedLast4) continue;

    // A company-funded ADMIN purchase never authorized a personal hold, so a null payment intent is
    // expected there. For every other user the hold precedes the mint, so its absence means the row
    // is corrupt and must not be reconciled as paid.
    if (purchase.stripePaymentIntentId === null && !isAdminUser(purchase.userId)) {
      throw new AgentCardSandboxSettlementError('Cleared purchase is missing its Stripe hold', 502);
    }

    // Atomic claim keeps a double-delivered success_url (or a retried settle call) from clearing the
    // same purchase twice.
    if (!(await claimForCharge(purchase.id))) continue;

    await markCleared(purchase.id);
    return {
      purchaseId: purchase.id,
      cardId: purchase.cardId,
      stripePaymentIntentId: purchase.stripePaymentIntentId,
    };
  }

  throw new AgentCardSandboxSettlementError(
    'No held Rose-minted purchase matched the card Stripe charged',
    404
  );
}
