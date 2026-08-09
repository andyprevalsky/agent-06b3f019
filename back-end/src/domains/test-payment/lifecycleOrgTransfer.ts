import { integerField, mcpResultRows, stringField } from './lifecycleProviderRecords';
import type { TestPaymentLifecycle } from './types';

type PurchaseCardRef = { cardId: string | null };

function transferReleasedCents(transfer: Record<string, unknown> | undefined): number {
  return typeof transfer?.released_cents === 'number' ? transfer.released_cents : 0;
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
 * AgentCard sandbox (observed 2026-08-09+) leaves `transferred_cents` at 0 for
 * mint/consumed/reclaimed rows while `amount_cents` still carries the funded
 * amount. Prefer the explicit transferred counter when present; otherwise fall
 * back to amount for terminal funded statuses so lifecycle gates stay aligned
 * with the provider's funded amount.
 */
function mapTransferredCents(transfer: Record<string, unknown>): number {
  const transferred = integerField(transfer, 'transferred_cents');
  if (transferred > 0) return transferred;
  const amount = integerField(transfer, 'amount_cents');
  const status = transfer.status;
  if ((status === 'consumed' || status === 'reclaimed') && amount > 0) return amount;
  return transferred;
}

export function mapOrgTransfer(
  purchase: PurchaseCardRef,
  transferResults: unknown[]
): TestPaymentLifecycle['orgTransfer'] {
  const transfer = transferResults
    .flatMap((result) => mcpResultRows(result, 'transfers'))
    .filter((value) => value?.card_id === purchase.cardId)
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
