import { type CardProvider } from '../../providers/card-provider';
import { type WalletFundingProvider } from '../../providers/wallet-funding';
import { isAdminUser } from '../../utils/adminAccess';
import { chargeAndIssueCard, issueAdminCompanyCard } from './charge';
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
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider
): Promise<MintPurchaseResult> {
  if (isAdminUser(input.userId)) {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING);
    return issueAdminCompanyCard(purchase, input, cardProvider, walletFundingProvider);
  }

  const subscription = await repo.findSubscriptionByUserId(input.userId);
  const stripeCustomerId = subscription?.stripeCustomerId;
  if (stripeCustomerId === undefined || stripeCustomerId === null || stripeCustomerId === '') {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FAILED);
    throw new PurchaseError('User does not have a Stripe billing customer', 402);
  }

  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CHARGING);
  return chargeAndIssueCard(purchase, input, stripeCustomerId, cardProvider, walletFundingProvider);
}
