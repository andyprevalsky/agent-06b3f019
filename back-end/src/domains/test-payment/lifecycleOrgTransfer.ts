import { integerField, mcpResultRows, stringField } from './lifecycleProviderRecords';
import type { TestPaymentLifecycle } from './types';

type PurchaseCardRef = { cardId: string | null };

function transferReleasedCents(transfer: Record<string, unknown> | undefined): number {
  const value = transfer?.released_cents;
  // Match integerField acceptance (integers only) but soft-fallback to 0 so a
  // malformed sort key cannot select a row that later fails mapping.
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

/** Higher rank = a more terminal/settled transfer state, used as a stable tie-breaker. */
function transferStatusRank(transfer: Record<string, unknown> | undefined): number {
  switch (transfer?.status) {
    case 'consumed':
      return 3;
    case 'reclaimed':
      return 2;
    case 'released':
      return 1;
    default:
      return 0;
  }
}

function transferId(transfer: Record<string, unknown> | undefined): string {
  return typeof transfer?.id === 'string' ? transfer.id : '';
}

/**
 * `amount_cents` is the immutable funded amount, while AgentCard mutates
 * `transferred_cents` as a card is charged (observed as 4396 → 3196 after a
 * $12 sandbox authorization). Terminal lifecycle rows must therefore derive
 * the original transfer amount from `amount_cents`, not the mutable counter.
 *
 * Live AgentCard reclaim is different: the outstanding transferred balance is
 * 0 even when the provider still echoes the original counter (observed on
 * production abandon 2026-08-09).
 */
function mapTransferredCents(transfer: Record<string, unknown>): number {
  const status = transfer.status;
  if (status === 'reclaimed' && transfer.livemode === true) return 0;
  if (status === 'consumed' || status === 'reclaimed') {
    return integerField(transfer, 'amount_cents');
  }
  return integerField(transfer, 'transferred_cents');
}

export function mapOrgTransfer(
  purchase: PurchaseCardRef,
  transferResults: unknown[]
): TestPaymentLifecycle['orgTransfer'] {
  if (purchase.cardId === null || purchase.cardId === '') return null;
  const transfer = transferResults
    .flatMap((result) => mcpResultRows(result, 'transfers'))
    .filter((value) => value.card_id === purchase.cardId)
    .sort((left, right) => {
      const releasedDifference = transferReleasedCents(right) - transferReleasedCents(left);
      if (releasedDifference !== 0) return releasedDifference;
      const rankDifference = transferStatusRank(right) - transferStatusRank(left);
      if (rankDifference !== 0) return rankDifference;
      // Stable ID tie-breaker keeps the selection independent of input ordering.
      return transferId(left).localeCompare(transferId(right));
    })[0];
  if (transfer === undefined) return null;
  return {
    id: stringField(transfer, 'id'),
    status: stringField(transfer, 'status'),
    amountCents: integerField(transfer, 'amount_cents'),
    transferredCents: mapTransferredCents(transfer),
    releasedCents: integerField(transfer, 'released_cents'),
    cardId: typeof transfer.card_id === 'string' ? transfer.card_id : null,
    livemode: transfer.livemode === true,
  };
}
