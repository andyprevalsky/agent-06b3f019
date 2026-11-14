import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { agentCardV2Request } from './agentcard/api-v2';
import { getV2WalletOwnerId } from './agentcard/wallet-v2';
import { prisma, runTransactionWithRetry } from './database';
import { createLogger } from './logger';
import { isCardLive, type CardProviderDetailsResult } from './card-provider';
import {
  findWalletFundingByPurchaseId,
  lockPurchaseWalletTransition,
} from './purchase-wallet-funding-repo';

const log = createLogger('PurchaseIssuedEvidence');

type Evidence = 'legacy' | 'unspent' | 'settled' | 'pending';

/** Authoritative issued-card evidence before cleanup can close a card or reverse its backing. */
export async function reconcileIssuedPurchaseEvidence(
  purchaseId: string,
  spentStatus: 'CLEARED' | 'CAPTURE_FAILED' = PurchaseSpendStatus.CLEARED
): Promise<Evidence> {
  const purchase = await prisma.purchaseSpend.findUnique({
    where: { id: purchaseId },
    include: { walletFunding: true },
  });
  if (!purchase?.cardId || !purchase.walletFunding) return 'legacy';
  const funding = purchase.walletFunding;
  const metadata = funding.metadata as Record<string, unknown> | null;
  if (!metadata || (metadata.apiVersion !== 2 && metadata.api_version !== 'v2')) return 'legacy';
  try {
    const owner = await getV2WalletOwnerId(purchase.userId);
    if (
      !owner ||
      !funding.providerTransferId ||
      funding.userId !== purchase.userId ||
      funding.amountCents !== purchase.totalCents ||
      funding.currency.toLowerCase() !== 'usd'
    )
      return 'pending';
    const wallet = await agentCardV2Request('GET', '/api/v2/company_wallet');
    if (wallet.livemode !== purchase.stripeLivemode) return 'pending';
    const [transfer, card] = await Promise.all([
      agentCardV2Request(
        'GET',
        `/api/v2/company_wallet/transfers/${encodeURIComponent(funding.providerTransferId)}`
      ),
      agentCardV2Request('GET', `/api/v2/cards/${encodeURIComponent(purchase.cardId)}`),
    ]);
    if (
      transfer.id !== funding.providerTransferId ||
      transfer.card_id !== purchase.cardId ||
      transfer.user_id !== owner ||
      transfer.amount_cents !== purchase.totalCents ||
      transfer.livemode !== purchase.stripeLivemode ||
      card.id !== purchase.cardId ||
      card.user_id !== owner
    )
      return 'pending';
    const query = new URLSearchParams({ card_id: purchase.cardId, user_id: owner, limit: '100' });
    const ledger = await agentCardV2Request('GET', `/api/v2/transactions?${query}`);
    if (ledger.object !== 'list' || ledger.has_more !== false || !Array.isArray(ledger.data))
      return 'pending';
    if (
      ledger.data.length === 0 &&
      ((['funded', 'consumed'].includes(String(transfer.status)) &&
        card.status === 'open' &&
        card.balance_cents === purchase.totalCents) ||
        (transfer.status === 'reclaimed' &&
          typeof transfer.released_cents === 'number' &&
          transfer.released_cents >= purchase.totalCents &&
          card.status === 'closed' &&
          card.balance_cents === 0))
    )
      return 'unspent';
    if (
      ledger.data.length !== 1 ||
      transfer.status !== 'consumed' ||
      card.status !== 'closed' ||
      card.balance_cents !== 0
    )
      return 'pending';
    const charge = ledger.data[0] as Record<string, unknown> | null;
    if (
      !charge ||
      charge.object !== 'transaction' ||
      typeof charge.id !== 'string' ||
      !charge.id ||
      charge.source !== 'issued' ||
      charge.status !== 'cleared' ||
      charge.card_id !== purchase.cardId ||
      charge.user_id !== owner ||
      charge.amount !== purchase.totalCents ||
      charge.merchant !== purchase.merchant ||
      (charge.currency !== null && charge.currency !== 'usd')
    )
      return 'pending';
    return await runTransactionWithRetry(async (tx) => {
      await lockPurchaseWalletTransition(tx, purchase.id);
      const current = await tx.purchaseSpend.findUnique({
        where: { id: purchase.id },
        include: { walletFunding: true },
      });
      const currentFunding = current?.walletFunding;
      if (
        !current ||
        current.cardId !== purchase.cardId ||
        current.userId !== purchase.userId ||
        current.totalCents !== purchase.totalCents ||
        current.stripeLivemode !== purchase.stripeLivemode ||
        !currentFunding ||
        currentFunding.providerTransferId !== funding.providerTransferId ||
        ![PurchaseWalletFundingStatus.FUNDED, PurchaseWalletFundingStatus.CONSUMED].includes(
          currentFunding.status as 'FUNDED' | 'CONSUMED'
        )
      )
        return 'pending';
      if (
        current.status === spentStatus &&
        currentFunding.status === PurchaseWalletFundingStatus.CONSUMED
      )
        return 'settled';
      if (
        ![
          PurchaseSpendStatus.HELD,
          PurchaseSpendStatus.CHARGING,
          PurchaseSpendStatus.FUNDING_PENDING,
          PurchaseSpendStatus.FUNDING_ABANDONED,
        ].includes(current.status as 'HELD' | 'CHARGING' | 'FUNDING_PENDING' | 'FUNDING_ABANDONED')
      )
        return 'pending';
      const consumed = await tx.purchaseWalletFunding.updateMany({
        where: {
          id: currentFunding.id,
          status: currentFunding.status,
          providerTransferId: funding.providerTransferId,
        },
        data: {
          status: PurchaseWalletFundingStatus.CONSUMED,
          consumedAt: new Date(),
          errorMessage: null,
        },
      });
      if (consumed.count !== 1) throw new Error('Funding changed during settlement observation');
      const cleared = await tx.purchaseSpend.updateMany({
        where: { id: current.id, status: current.status, cardId: purchase.cardId },
        data: { status: spentStatus },
      });
      if (cleared.count !== 1) throw new Error('Purchase changed during settlement observation');
      return 'settled';
    });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    log.warn('Issued-card cleanup evidence is unavailable; keeping obligation pending', {
      purchase_id: purchase.id,
      card_id: purchase.cardId,
      error_class: error instanceof Error ? error.name.slice(0, 80) : 'UnknownError',
      error_code: typeof code === 'string' && /^[a-z0-9_]{1,80}$/i.test(code) ? code : undefined,
    });
    return 'pending';
  }
}

/**
 * A closed company card alone does not prove merchant spend: unused mints also close before their
 * exact transfer releases. Only canonical settlement's CONSUMED ledger can establish spending;
 * unresolved funding stays with the existing reclaim owner and its release/refund boundary.
 * Legacy cards without company funding retain their existing settlement behavior.
 */
export async function purchaseCardWasSpent(
  purchaseId: string,
  details: Pick<CardProviderDetailsResult, 'status' | 'balanceCents'>
): Promise<boolean> {
  if (isCardLive(details)) return false;
  const funding = await findWalletFundingByPurchaseId(purchaseId);
  return funding === null || funding.status === PurchaseWalletFundingStatus.CONSUMED;
}
