import {
  createCardProviderForAgent,
  isCardLive,
  type CardProvider,
  type CardProviderDetailsResult,
} from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import { PurchaseWalletFundingStatus } from './types';

const log = createLogger('Purchases');

/**
 * Funding states that mean Rose already closed this card to reclaim org-wallet float (or finished
 * doing so). A not-live / unreadable card in these states is expected reclaim noise — NOT merchant
 * settlement — so fingerprint reuse must not flip the purchase to CLEARED and clobber abandon.
 */
const RECLAIM_IN_PROGRESS_FUNDING_STATUSES = new Set<PurchaseWalletFundingStatus>([
  PurchaseWalletFundingStatus.RECLAIMING,
  PurchaseWalletFundingStatus.RECLAIMED,
  PurchaseWalletFundingStatus.RECLAIM_FAILED,
]);

/**
 * Whether a closed/unreadable held card should be recorded as merchant-spent (CLEARED). Returns
 * false while wallet funding is mid-reclaim so concurrent same-fingerprint lookup/mint cannot
 * race an in-flight abandon (smoke: agent-payment-abandonment VOIDED vs CLEARED).
 */
export async function closedCardIndicatesMerchantSpend(purchaseId: string): Promise<boolean> {
  const funding = await repo.findWalletFundingByPurchaseId(purchaseId);
  if (funding !== null && RECLAIM_IN_PROGRESS_FUNDING_STATUSES.has(funding.status)) {
    log.info('Skipping CLEARED for closed card with reclaim in progress', {
      purchase_id: purchaseId,
      funding_status: funding.status,
    });
    return false;
  }
  return true;
}

/**
 * Returns the card details only if the card is still live; `null` if it has been
 * settled/closed/deleted or can't be read. Fail-safe: an unreadable card is treated as consumed
 * so we re-prompt instead of silently re-issuing a dead, already-charged card.
 */
export async function tryGetLiveCardDetails(
  userId: string,
  agentId: string | null,
  cardId: string,
  cardProvider?: CardProvider
): Promise<CardProviderDetailsResult | null> {
  // Provider selection may perform a database lookup. Let those errors propagate so a transient
  // benchmark-classification failure cannot be mistaken for a consumed card and trigger billing.
  const activeCardProvider = cardProvider ?? (await createCardProviderForAgent(userId, agentId));
  try {
    const details = await activeCardProvider.getDetails(cardId);
    return isCardLive(details) ? details : null;
  } catch (error) {
    log.warn('Reuse liveness check failed; treating card as consumed', {
      card_id: cardId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
