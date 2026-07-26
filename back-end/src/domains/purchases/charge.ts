import { createCardProviderForAgent, type CardProvider } from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import {
  captureAuthorizedHold,
  reversePurchasePaymentIntent,
  stripe,
} from '../../providers/stripe';
import {
  createWalletFundingProvider,
  type WalletFundingProvider,
} from '../../providers/wallet-funding';
import { PurchaseError } from './errors';
import { isKycRequiredError, kycRequiredPurchaseError } from './kyc';
import { getCustomerDefaultPaymentMethodId } from './stripeCustomer';
import * as repo from './repo';
import { archivePurchaseBoundary } from './archive';
import { assertIssuedCardIsSpendable, sanitizeDescriptorSuffix } from './chargeHelpers';
import { mintCompanyFlowCard } from './companyFlowCard';
import { classifyFundingResumeFailure } from './fundingResume';
import {
  discardPendingPurchaseWalletCollection,
  preparePurchaseWalletCollection,
  recordIssuedPurchaseCardFunding,
  reclaimPurchaseWalletFunding,
} from './walletFunding';
import {
  PurchaseSpendStatus,
  PurchaseWalletFundingStatus,
  type MintPurchaseInput,
  type MintPurchaseResult,
  type PurchaseSpend,
} from './types';

const log = createLogger('Purchases');

type StripePaymentIntent = Awaited<ReturnType<typeof stripe.paymentIntents.create>>;

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
  /**
   * True when the issued card is the static, company-funded Rose Agent Card (mint cutoff active).
   * It has no AgentCard company transfer and is reusable, so there is nothing to wallet-fund or
   * reclaim — but the user's Stripe hold is still captured normally.
   */
  issuedStaticCard: boolean;
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
  const transferId = minted.providerTransferId ?? providerTransferId;
  const isStaticCard = minted.metadata?.staticCard === true;
  if (isStaticCard) {
    await discardPendingPurchaseWalletCollection(purchaseId);
    state.walletFundingPrepared = false;
    state.issuedCardId = minted.cardId;
    state.issuedStaticCard = true;
    await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.CHARGING, {
      cardId: minted.cardId,
    });
  } else {
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
  }
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

/** Close a card that was issued before a later setup step failed, reclaiming its funding. */
async function closeIssuedCardOnFailure(
  state: ChargeState,
  purchase: PurchaseSpend
): Promise<void> {
  if (state.issuedCardId === undefined || state.activeCardProvider === undefined) return;
  // The static Rose Agent Card is reusable and company-funded: never close it and there is no
  // wallet funding to reclaim. Return early so reverseStripePaymentOnFailure still refunds the
  // user's captured hold (a reclaim error would otherwise set walletReclaimFailed and block it).
  if (state.issuedStaticCard) return;
  try {
    await state.activeCardProvider.closeCard(state.issuedCardId);
    await reclaimPurchaseWalletFunding(
      { ...purchase, cardId: state.issuedCardId },
      'mint_failed_after_card_issue',
      state.activeWalletFundingProvider
    );
    state.walletWasFunded = false;
  } catch (cleanupError) {
    state.walletReclaimFailed = true;
    log.error('Failed to close issued AgentCard after purchase setup failure', {
      purchase_id: purchase.id,
      card_id: state.issuedCardId,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

/** Reverse Stripe after a mint failure by re-reading the durable PaymentIntent state. */
async function reverseStripePaymentOnFailure(
  state: ChargeState,
  purchaseId: string
): Promise<void> {
  const paymentIntentId = state.paymentIntentId;
  if (paymentIntentId === undefined || state.walletReclaimFailed) return;
  await reversePurchasePaymentIntent(paymentIntentId, purchaseId).catch((reverseError) => {
    state.paymentReversalFailed = true;
    log.warn('Failed to reverse Stripe payment after purchase mint failure', {
      purchase_id: purchaseId,
      stripe_payment_intent_id: paymentIntentId,
      captured: state.paymentIntentCaptured,
      error: reverseError instanceof Error ? reverseError.message : String(reverseError),
    });
  });
}

/** Undo every side effect after a failed mint, then throw a typed purchase error. */
export async function rollbackChargeFailure(
  state: ChargeState,
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  error: unknown
): Promise<never> {
  const purchaseId = purchase.id;
  const fundingFailure = await classifyFundingResumeFailure(purchase, error, state);
  const boundaryError = fundingFailure.boundaryError;
  state.walletWasFunded = fundingFailure.walletWasFunded;
  state.fundingResumeRequired = fundingFailure.fundingResumeRequired;
  state.walletFundingPrepared = fundingFailure.walletFundingPrepared;
  state.issuedCardId ??= fundingFailure.issuedCardId;
  if (state.fundingResumeRequired) {
    state.walletReclaimFailed = true;
  }
  await closeIssuedCardOnFailure(state, purchase);
  if (state.walletWasFunded && !state.walletReclaimFailed) {
    state.walletReclaimFailed = true;
    log.error('AgentCard company funding was confirmed but card issue did not complete', {
      purchase_id: purchaseId,
      user_id: input.userId,
      error: boundaryError.message,
    });
  }
  await reverseStripePaymentOnFailure(state, purchaseId);
  log.error('Failed to mint purchase card', {
    purchase_id: purchaseId,
    user_id: input.userId,
    agent_id: input.agentId,
    error: boundaryError.message,
  });
  await repo.updatePurchaseStatus(
    purchaseId,
    state.fundingResumeRequired
      ? PurchaseSpendStatus.FUNDING_PENDING
      : state.walletReclaimFailed
        ? PurchaseSpendStatus.FUNDING_RECLAIM_FAILED
        : state.paymentReversalFailed
          ? PurchaseSpendStatus.REFUND_FAILED
          : PurchaseSpendStatus.FAILED,
    {
      stripePaymentIntentId: state.paymentIntentId ?? null,
    }
  );
  // A genuine AgentCard KYC rejection (not the MCP per-user setup flow, whose
  // error text carries no kyc_required code) surfaces as a typed kyc_required
  // PurchaseError so the agent workflow can raise a KYC gate and retry.
  if (!state.fundingResumeRequired && isKycRequiredError(error)) {
    throw kycRequiredPurchaseError();
  }
  throw boundaryError;
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
