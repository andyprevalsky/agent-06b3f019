import { createCardProvider, type CardProvider } from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import {
  cancelAuthorizedHold,
  captureAuthorizedHold,
  refundCapturedPurchase,
  stripe,
} from '../../providers/stripe';
import {
  createWalletFundingProvider,
  type WalletFundingProvider,
} from '../../providers/wallet-funding';
import { PurchaseError, toPurchaseBoundaryError } from './errors';
import { isKycRequiredError, kycRequiredPurchaseError } from './kyc';
import { getCustomerDefaultPaymentMethodId } from './stripeCustomer';
import * as repo from './repo';
import { archivePurchaseBoundary } from './archive';
import { mintCompanyFlowCard } from './companyFlowCard';
import { recordPurchaseWalletFunding, reclaimPurchaseWalletFunding } from './walletFunding';
import {
  PurchaseSpendStatus,
  type MintPurchaseInput,
  type MintPurchaseResult,
  type PurchaseSpend,
} from './types';

const log = createLogger('Purchases');

type StripePaymentIntent = Awaited<ReturnType<typeof stripe.paymentIntents.create>>;

/** Mutable side-effect state shared across the charge/mint/rollback steps. */
interface ChargeState {
  paymentIntentId?: string;
  paymentIntentCaptured: boolean;
  paymentReversalFailed: boolean;
  walletWasFunded: boolean;
  walletReclaimFailed: boolean;
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

function sanitizeDescriptorSuffix(merchant: string): string {
  const cleaned = merchant
    .replace(/[^a-zA-Z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'Purchase').slice(0, 22);
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

/** Mint the company-funded card, capture the user's charge, and mark the purchase HELD. */
async function mintCaptureAndIssue(
  state: ChargeState,
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  paymentIntent: StripePaymentIntent,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  const purchaseId = purchase.id;
  state.activeWalletFundingProvider = walletFundingProvider ?? createWalletFundingProvider();
  state.activeCardProvider = cardProvider ?? createCardProvider(input.userId);
  const { cardRequest, minted, providerTransferId } = await mintCompanyFlowCard(
    purchase,
    input,
    state.activeCardProvider,
    state.activeWalletFundingProvider
  );
  const transferId = minted.providerTransferId ?? providerTransferId;
  const isStaticCard = minted.metadata?.staticCard === true;
  state.issuedCardId = minted.cardId;
  state.issuedStaticCard = isStaticCard;
  // Persist the issued card id immediately, before capture or any later failure point. A crash
  // between minting and the HELD write would otherwise orphan the funded card with no durable
  // pointer for reconcilers to close it and reclaim its funding.
  await repo.updatePurchaseStatus(purchaseId, PurchaseSpendStatus.CHARGING, {
    cardId: minted.cardId,
  });
  // The static Rose Agent Card (mint cutoff) is company-funded out-of-band: no AgentCard company
  // transfer exists, so there is nothing to require or wallet-fund. Real AgentCard cards MUST carry
  // a company transfer id. Either way the user's Stripe hold is captured below.
  if (!isStaticCard) {
    if (transferId === undefined || transferId.trim() === '') {
      throw new PurchaseError(
        'AgentCard issued a card without a company transfer id',
        502,
        'agentcard_company_transfer_missing'
      );
    }
    state.walletWasFunded = true;
    await recordPurchaseWalletFunding(purchase, 'usd', transferId, minted.metadata);
  }
  await captureAuthorizedHold(paymentIntent.id);
  state.paymentIntentCaptured = true;
  const details = await state.activeCardProvider.getDetails(minted.cardId);
  await archivePurchaseBoundary(input.agentId, purchaseId, 'agentcard-mint-and-details', {
    mint_request: cardRequest,
    mint_response: minted,
    // Never archive the PAN/CVV that `getDetails` returns; persist only non-sensitive evidence.
    details_response: {
      cardId: minted.cardId,
      last4: minted.last4,
    },
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

/** Reverse the Stripe charge (refund if captured, else cancel the hold) after a mint failure. */
async function reverseStripePaymentOnFailure(
  state: ChargeState,
  purchaseId: string
): Promise<void> {
  const paymentIntentId = state.paymentIntentId;
  if (paymentIntentId === undefined || state.walletReclaimFailed) return;
  const reversePayment = state.paymentIntentCaptured
    ? refundCapturedPurchase(paymentIntentId, purchaseId)
    : cancelAuthorizedHold(paymentIntentId);
  await reversePayment.catch((reverseError) => {
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
async function rollbackChargeFailure(
  state: ChargeState,
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  error: unknown
): Promise<never> {
  const purchaseId = purchase.id;
  const boundaryError = toPurchaseBoundaryError(error);
  if (
    boundaryError instanceof PurchaseError &&
    boundaryError.code === 'agentcard_company_funding_in_progress'
  ) {
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
    state.walletReclaimFailed
      ? PurchaseSpendStatus.FUNDING_RECLAIM_FAILED
      : state.paymentIntentCaptured && state.paymentReversalFailed
        ? PurchaseSpendStatus.REFUND_FAILED
        : PurchaseSpendStatus.FAILED,
    {
      stripePaymentIntentId: state.paymentIntentId ?? null,
    }
  );
  // A genuine AgentCard KYC rejection (not the MCP per-user setup flow, whose
  // error text carries no kyc_required code) surfaces as a typed kyc_required
  // PurchaseError so the agent workflow can raise a KYC gate and retry.
  if (isKycRequiredError(error)) throw kycRequiredPurchaseError();
  throw boundaryError;
}

/**
 * Authorize the user's saved card, mint the company-funded single-use card, then capture the
 * user's charge as soon as AgentCard confirms the transfer. A returned card is therefore always
 * fully funded. If any later setup step fails, close/reclaim the card and refund the charge.
 */
export async function chargeAndIssueCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  stripeCustomerId: string,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  const state: ChargeState = {
    paymentIntentCaptured: false,
    paymentReversalFailed: false,
    walletWasFunded: false,
    walletReclaimFailed: false,
    issuedStaticCard: false,
  };
  try {
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
