import { triggerOrgWalletTopUp } from '../../providers/agentcard/org-wallet-topup';
import { createCardProviderForAgent, type CardProvider } from '../../providers/card-provider';
import { captureAuthorizedHold, stripe } from '../../providers/stripe';
import {
  createWalletFundingProvider,
  type WalletFundingProvider,
} from '../../providers/wallet-funding';
import { PurchaseError } from './errors';
import { getCustomerDefaultPaymentMethodId } from './stripeCustomer';
import * as repo from './repo';
import { archivePurchaseBoundary } from './archive';
import { assertIssuedCardIsSpendable, sanitizeDescriptorSuffix } from './chargeHelpers';
import { rollbackChargeFailure, type ChargeState } from './chargeRollback';
import { mintCompanyFlowCard } from './companyFlowCard';
import {
  discardPendingPurchaseWalletCollection,
  preparePurchaseWalletCollection,
  recordIssuedPurchaseCardFunding,
} from './walletFunding';
import {
  PurchaseSpendStatus,
  PurchaseWalletFundingStatus,
  type MintPurchaseInput,
  type MintPurchaseResult,
  type PurchaseSpend,
} from './types';

type StripePaymentIntent = Awaited<ReturnType<typeof stripe.paymentIntents.create>>;

type MintedCard = Awaited<ReturnType<typeof mintCompanyFlowCard>>['minted'];

/**
 * Persist the mint outcome and record it on `state` for rollback. Returns whether the issued card
 * is the static Rose Agent Card, which has no company transfer to record or reclaim.
 */
async function persistMintedCard(
  state: ChargeState,
  purchase: PurchaseSpend,
  minted: MintedCard,
  transferId: string | undefined
): Promise<boolean> {
  if (minted.metadata?.staticCard === true) {
    await discardPendingPurchaseWalletCollection(purchase.id);
    state.walletFundingPrepared = false;
    state.issuedCardId = minted.cardId;
    state.issuedStaticCard = true;
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING, {
      cardId: minted.cardId,
    });
    return true;
  }
  if (transferId === undefined || transferId.trim() === '') {
    throw new PurchaseError(
      'AgentCard issued a card without a company transfer id',
      502,
      'agentcard_company_transfer_missing'
    );
  }
  // Card + transfer are one durable fact. If the process dies before this transaction, replaying
  // create_card with the same purchase idempotency key recovers them; after it commits, cleanup
  // always has both identifiers required to close and release the card.
  await recordIssuedPurchaseCardFunding(
    purchase,
    'usd',
    minted.cardId,
    transferId,
    minted.metadata
  );
  state.issuedCardId = minted.cardId;
  state.issuedStaticCard = false;
  state.walletWasFunded = true;
  return false;
}

/** Authorize the user's saved card with a manual-capture hold. */
async function authorizeStripeHold(
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

/**
 * Mint the company-funded card, capture the user's charge (when there is one), and mark the
 * purchase HELD. `paymentIntent` is `undefined` for the admin no-charge flow: the card is funded
 * entirely by the AgentCard company transfer (Rose fronts the cost) and there is no Stripe hold to
 * capture.
 */
export async function mintCaptureAndIssue(
  state: ChargeState,
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  paymentIntent: StripePaymentIntent | undefined,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  const purchaseId = purchase.id;
  state.activeWalletFundingProvider = walletFundingProvider ?? createWalletFundingProvider();
  state.activeCardProvider =
    cardProvider ?? (await createCardProviderForAgent(input.userId, input.agentId));
  const preparedFunding = await preparePurchaseWalletCollection(purchase, 'usd');
  state.providerCallStarted = true;
  const { cardRequest, minted, providerTransferId } = await mintCompanyFlowCard(
    purchase,
    input,
    state.activeCardProvider,
    state.activeWalletFundingProvider,
    preparedFunding.providerTransferId ?? undefined
  );
  const isStaticCard = await persistMintedCard(
    state,
    purchase,
    minted,
    minted.providerTransferId ?? providerTransferId
  );
  const details = await state.activeCardProvider.getDetails(minted.cardId);
  if (!isStaticCard) {
    // An exact-key replay can return a card created by an earlier attempt. Re-read the provider
    // state after card+transfer persistence and before charging the user; a closed/consumed or
    // underfunded replay is reclaimed by rollback and must never reach Stripe capture.
    assertIssuedCardIsSpendable(details, purchase.totalCents);
  }
  await archivePurchaseBoundary(input.agentId, purchaseId, 'agentcard-mint-and-details', {
    mint_request: cardRequest,
    mint_response: minted,
    // Never archive the PAN/CVV that `getDetails` returns; persist only non-sensitive evidence.
    details_response: {
      cardId: minted.cardId,
      last4: minted.last4,
    },
  });

  // Admin no-charge flow has no Stripe hold to capture; the card is already fully company-funded.
  if (paymentIntent !== undefined) {
    await captureAuthorizedHold(paymentIntent.id);
    state.paymentIntentCaptured = true;
  }
  await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.HELD, {
    cardId: minted.cardId,
    ...(paymentIntent !== undefined ? { stripePaymentIntentId: paymentIntent.id } : {}),
  });

  // A company_flow mint just debited the org wallet. Re-check its balance and refill from the
  // Coinbase treasury if it dropped below the floor. Fire-and-forget by contract: the purchase is
  // already durable and must never fail because the treasury is unreachable. Static-card mints
  // (the Brex cutoff path) never touch the org wallet, so they never trigger a top-up.
  if (!isStaticCard) {
    triggerOrgWalletTopUp({ purchaseId, debitedCents: purchase.totalCents });
  }

  return {
    purchaseId,
    cardId: minted.cardId,
    pan: details.pan,
    cvv: details.cvv,
    expiry: details.expiry,
    last4: minted.last4,
    status: PurchaseSpendStatus.HELD,
  };
}

/**
 * Authorize the user's saved card, mint the company-funded single-use card, verify that the
 * returned card is live and fully funded, then capture the charge. Failures before capture close
 * and reclaim the card before canceling the hold; failures after capture refund the charge.
 */
export async function chargeAndIssueCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  stripeCustomerId: string,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  const fundingRetryClaimed = purchase.cardId === null && purchase.stripePaymentIntentId !== null;
  const state: ChargeState = {
    paymentIntentId: purchase.stripePaymentIntentId ?? undefined,
    paymentIntentCaptured: false,
    paymentReversalFailed: false,
    walletWasFunded: false,
    walletReclaimFailed: false,
    walletFundingPrepared: fundingRetryClaimed,
    fundingResumeRequired: false,
    fundingRetryClaimed,
    providerCallStarted: false,
    stripeAuthorizationStarted: false,
    issuedStaticCard: false,
  };
  try {
    const preparedFunding = await preparePurchaseWalletCollection(purchase, 'usd');
    state.walletFundingPrepared = true;
    state.walletWasFunded =
      preparedFunding.status === PurchaseWalletFundingStatus.FUNDED ||
      preparedFunding.status === PurchaseWalletFundingStatus.CONSUMED;
    const paymentIntent = await authorizeStripeHold(state, purchase, input, stripeCustomerId);
    return await mintCaptureAndIssue(
      state,
      purchase,
      input,
      paymentIntent,
      cardProvider,
      walletFundingProvider
    );
  } catch (error) {
    return await rollbackChargeFailure(state, purchase, input, error);
  }
}

/**
 * Admin-only: issue a company-funded card WITHOUT any personal Stripe charge. Reserved for
 * `ADMIN_USER_IDS` (Andy + Tamy) purchases that bypass the subscription / card-on-file requirement
 * — Rose fronts the cost via the AgentCard company transfer and there is no Stripe hold to
 * capture or reverse. On failure the issued card is closed and its funding reclaimed, exactly like
 * the charged flow, but no payment reversal is attempted (nothing was charged).
 */
