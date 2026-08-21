/**
 * Purchase charge side-effect ledger and its compensation path.
 *
 * `ChargeState` records every irreversible step the mint flow took (Stripe hold, company transfer,
 * issued card). `rollbackChargeFailure` consumes that ledger to undo them in the one safe order:
 * close+reclaim the card BEFORE reversing Stripe, so a consumed card can never receive a free
 * user-payment reversal.
 */

import { type CardProvider } from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import { reversePurchasePaymentIntent } from '../../providers/stripe';
import { type WalletFundingProvider } from '../../providers/wallet-funding';
import { classifyFundingResumeFailure } from './fundingResume';
import { isKycRequiredError, kycRequiredPurchaseError } from './kyc';
import * as repo from './repo';
import { PurchaseSpendStatus, type MintPurchaseInput, type PurchaseSpend } from './types';
import { reclaimPurchaseWalletFunding } from './walletFunding';

const log = createLogger('Purchases');

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

function terminalStatusFor(state: ChargeState): PurchaseSpendStatus {
  if (state.fundingResumeRequired) return PurchaseSpendStatus.FUNDING_PENDING;
  if (state.walletReclaimFailed) return PurchaseSpendStatus.FUNDING_RECLAIM_FAILED;
  if (state.paymentReversalFailed) return PurchaseSpendStatus.REFUND_FAILED;
  return PurchaseSpendStatus.FAILED;
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
  await repo.updatePurchaseStatus(purchaseId, terminalStatusFor(state), {
    stripePaymentIntentId: state.paymentIntentId ?? null,
  });
  // A genuine AgentCard KYC rejection (not the MCP per-user setup flow, whose
  // error text carries no kyc_required code) surfaces as a typed kyc_required
  // PurchaseError so the agent workflow can raise a KYC gate and retry.
  if (!state.fundingResumeRequired && isKycRequiredError(error)) {
    throw kycRequiredPurchaseError();
  }
  throw boundaryError;
}
