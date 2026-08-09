import { type CardProvider } from '../../providers/card-provider';
import { stripe } from '../../providers/stripe';
import { type WalletFundingProvider } from '../../providers/wallet-funding';
import { getCustomerDefaultPaymentMethodId } from './stripeCustomer';
import * as repo from './repo';
import { archivePurchaseBoundary } from './archive';
import { sanitizeDescriptorSuffix } from './chargeHelpers';
import { PurchaseSpendStatus, type MintPurchaseInput, type PurchaseSpend } from './types';

export type StripePaymentIntent = Awaited<ReturnType<typeof stripe.paymentIntents.create>>;

/** Mutable side-effect state shared across the charge/mint/rollback steps. */
export interface ChargeState {
  paymentIntentId?: string;
  paymentIntentCaptured: boolean;
  paymentReversalFailed: boolean;
  walletWasFunded: boolean;
  walletReclaimFailed: boolean;
  walletFundingPrepared: boolean;
  fundingResumeRequired: boolean;
  fundingRetryClaimed: boolean;
  providerCallStarted: boolean;
  stripeAuthorizationStarted: boolean;
  activeWalletFundingProvider?: WalletFundingProvider;
  activeCardProvider?: CardProvider;
  issuedCardId?: string;
  /** Static Rose Agent Card: reusable, no wallet reclaim; Stripe hold still captures. */
  issuedStaticCard: boolean;
}

/** Authorize the user's saved card with a manual-capture hold. */
export async function authorizeStripeHold(
  state: ChargeState,
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  stripeCustomerId: string
): Promise<StripePaymentIntent> {
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
      purchaseSpendId: purchase.id,
    },
  };
  state.stripeAuthorizationStarted = true;
  const paymentIntent = await stripe.paymentIntents.create(
    stripeRequest,
    // Per-row idempotency: a retried mint of the SAME purchase never double-charges Stripe.
    { idempotencyKey: `purchase-charge:${purchase.id}` }
  );
  state.paymentIntentId = paymentIntent.id;
  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING, {
    stripePaymentIntentId: paymentIntent.id,
  });
  await archivePurchaseBoundary(input.agentId, purchase.id, 'stripe-payment-intent', {
    request: stripeRequest,
    response: paymentIntent,
  });
  return paymentIntent;
}
