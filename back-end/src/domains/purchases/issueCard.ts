import { type CardProvider } from '../../providers/card-provider';
import { type WalletFundingProvider } from '../../providers/wallet-funding';
import { BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID } from '../../providers/benchmarkPaymentIdentity';
import { isAdminUser } from '../../utils/adminAccess';
import { benchmarkForceCustomerPurchasePath } from './config';
import {
  chargeAndIssueCard,
  mintCaptureAndIssue,
  rollbackChargeFailure,
  type ChargeState,
} from './charge';
import { PurchaseError } from './errors';
import * as repo from './repo';
import {
  PurchaseSpendStatus,
  type MintPurchaseInput,
  type MintPurchaseResult,
  type PurchaseSpend,
} from './types';

/**
 * Choose the funding path for a purchase and issue the card. Admins (ADMIN_USER_IDS) bypass the
 * subscription / card-on-file requirement via a company-funded no-charge card; everyone else must
 * have a Stripe billing customer and is charged normally. KYC is enforced upstream in the caller.
 */
export async function resolveAndIssuePurchaseCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  resumedPurchase: PurchaseSpend | null,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  // Admission can precede this immutable snapshot by minutes. A production probe
  // must never fund a live card from a test-mode purchase, including a resume.
  if (
    purchase.userId === BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID &&
    purchase.stripeLivemode !== true
  ) {
    if (resumedPurchase === null && purchase.status === PurchaseSpendStatus.PENDING_APPROVAL) {
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED);
    }
    throw new PurchaseError(
      'Production payment requires a live Stripe billing snapshot',
      402,
      'production_payment_billing_mode'
    );
  }
  // A resumed purchase already holds a wallet-funding claim; only a fresh purchase transitions to
  // CHARGING here (a resume re-enters mid-flight). Mirrors the non-admin path below.
  // Benchmark-only: BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH keeps isAdminUser() true for
  // credits/unlimited, but routes minting through the charged Stripe-hold path.
  if (isAdminUser(input.userId) && !benchmarkForceCustomerPurchasePath()) {
    if (resumedPurchase === null) {
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING);
    }
    return issueAdminCompanyCard(purchase, input, cardProvider, walletFundingProvider);
  }

  const subscription = await repo.findSubscriptionByUserId(input.userId);
  if (
    purchase.stripeCustomerId === null &&
    subscription !== null &&
    subscription.stripeLivemode !== purchase.stripeLivemode
  ) {
    throw new PurchaseError(
      'Billing account changed; this legacy purchase cannot charge the new account',
      409
    );
  }
  const stripeCustomerId = purchase.stripeCustomerId ?? subscription?.stripeCustomerId;
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
  return chargeAndIssueCard(
    purchase,
    input,
    stripeCustomerId,
    cardProvider,
    walletFundingProvider,
    purchase.stripeSubscriptionId ?? subscription?.stripeSubscriptionId ?? undefined
  );
}

/**
 * Admin no-charge card: mint the company-funded card with NO Stripe hold. There is never a payment
 * intent to capture or a stale-charging retry to resume — the card is fully company-funded.
 */
export async function issueAdminCompanyCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  const state: ChargeState = {
    paymentIntentCaptured: false,
    paymentReversalFailed: false,
    walletWasFunded: false,
    walletReclaimFailed: false,
    walletFundingPrepared: false,
    fundingResumeRequired: false,
    fundingRetryClaimed: false,
    providerCallStarted: false,
    stripeAuthorizationStarted: false,
    issuedStaticCard: false,
  };
  try {
    return await mintCaptureAndIssue(
      state,
      purchase,
      input,
      undefined,
      cardProvider,
      walletFundingProvider
    );
  } catch (error) {
    return await rollbackChargeFailure(state, purchase, input, error);
  }
}
