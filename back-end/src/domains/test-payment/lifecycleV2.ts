import { agentCardV2Request, type AgentCardV2Request } from '../../providers/agentcard/api-v2';
import { getV2WalletOwnerId } from '../../providers/agentcard/wallet-v2';
import { TestPaymentError } from './errors';
import { asRecord, integerField, stringField } from './lifecycleProviderRecords';
import type { LifecyclePurchase } from './lifecycleDependencies';
import type { TestPaymentLifecycle } from './types';

type Purchase = NonNullable<LifecyclePurchase>;
const CARD_STATUSES = new Set([
  'creating',
  'pending_approval',
  'open',
  'in_use',
  'paused',
  'pausing',
  'closing',
  'closed',
]);
const TRANSFER_STATUSES = new Set(['pending', 'funded', 'consumed', 'reclaimed', 'failed']);

export function isV2LifecycleFunding(metadata: unknown): boolean {
  const record = asRecord(metadata);
  return record?.apiVersion === 2 || record?.api_version === 'v2';
}

function assertIntent(record: Record<string, unknown>, key: string, id: string): void {
  if (record[key] !== id)
    throw new TestPaymentError('AgentCard v2 lifecycle identity mismatch', 502);
}

/** Cursor pagination is user scoped and stops once the purchase window is covered. */
async function listWindow(
  api: AgentCardV2Request,
  path: string,
  userId: string,
  createdAt: Date
): Promise<Record<string, unknown>[]> {
  const rows = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({
      user_id: userId,
      limit: '100',
      ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
    });
    const result = await api('GET', `${path}?${query}`);
    if (!Array.isArray(result.data) || typeof result.has_more !== 'boolean') {
      throw new TestPaymentError('AgentCard v2 lifecycle list response was invalid', 502);
    }
    let covered = false;
    for (const value of result.data) {
      const row = asRecord(value);
      if (
        !row ||
        typeof row.id !== 'string' ||
        !row.id ||
        row.user_id !== userId ||
        typeof row.created_at !== 'string' ||
        !Number.isFinite(Date.parse(row.created_at))
      ) {
        throw new TestPaymentError(
          'AgentCard v2 lifecycle list identity or timestamp was invalid',
          502
        );
      }
      rows.set(row.id, row);
      if (Date.parse(row.created_at) < createdAt.getTime() - 5_000) covered = true;
    }
    if (!result.has_more || covered) return [...rows.values()];
    if (typeof result.cursor !== 'string' || !result.cursor || seen.has(result.cursor)) {
      throw new TestPaymentError('AgentCard v2 lifecycle pagination did not advance', 502);
    }
    seen.add(result.cursor);
    cursor = result.cursor;
  }
  throw new TestPaymentError('AgentCard v2 history exceeded lifecycle pagination limit', 502);
}

function cardSummary(
  card: Record<string, unknown> | null,
  cardId: string | null,
  userId: string
): { status: string; balanceCents: number } | null {
  if (card === null || cardId === null || cardId === '') return null;
  assertIntent(card, 'id', cardId);
  assertIntent(card, 'user_id', userId);
  if (!CARD_STATUSES.has(String(card.status)) || integerField(card, 'balance_cents') < 0) {
    throw new TestPaymentError('AgentCard v2 lifecycle card state was invalid', 502);
  }
  return { status: stringField(card, 'status'), balanceCents: integerField(card, 'balance_cents') };
}

function validateTransfer(
  transfer: Record<string, unknown>,
  purchase: Purchase,
  transferId: string,
  userId: string
): asserts transfer is Record<string, unknown> & { livemode: boolean } {
  assertIntent(transfer, 'id', transferId);
  assertIntent(transfer, 'user_id', userId);
  if (
    transfer.card_id !== purchase.cardId ||
    transfer.amount_cents !== purchase.totalCents ||
    typeof transfer.livemode !== 'boolean' ||
    transfer.livemode !== purchase.stripeLivemode ||
    !TRANSFER_STATUSES.has(String(transfer.status))
  ) {
    throw new TestPaymentError(
      'AgentCard v2 lifecycle transfer does not match purchase intent and mode',
      502
    );
  }
  for (const field of ['amount_cents', 'transferred_cents', 'released_cents']) {
    if (integerField(transfer, field) < 0)
      throw new TestPaymentError('AgentCard v2 lifecycle transfer amount was invalid', 502);
  }
}

/**
 * Same contract as the org mapper (lifecycleOrgTransfer.mapTransferredCents): a live reclaim leaves
 * 0 outstanding even though AgentCard still echoes the original transferred counter (observed on
 * production abandon 2026-08-09, and again on the v2 owner probe 2026-11-15), and a consumed
 * transfer moved its whole amount even though v2 reports `transferred_cents: 0` on it (owner
 * production purchase probe 2026-11-16).
 */
export function v2TransferredCents(transfer: Record<string, unknown>): number {
  if (transfer.status === 'reclaimed' && transfer.livemode === true) return 0;
  if (transfer.status === 'consumed') return integerField(transfer, 'amount_cents');
  return integerField(transfer, 'transferred_cents');
}

export async function observeV2Lifecycle(
  purchase: Purchase,
  api: AgentCardV2Request = agentCardV2Request,
  resolveOwner: (userId: string) => Promise<string | undefined> = getV2WalletOwnerId
): Promise<{
  card: { status: string; balanceCents: number } | null;
  transfer: TestPaymentLifecycle['orgTransfer'];
  integrity: Pick<
    TestPaymentLifecycle['integrity'],
    | 'agentCardProviderCardCount'
    | 'agentCardProviderTransferCount'
    | 'agentCardProviderUnlinkedTransferCount'
  >;
}> {
  const userId = await resolveOwner(purchase.userId);
  const transferId = purchase.walletFunding?.providerTransferId;
  if (
    userId === undefined ||
    userId === '' ||
    typeof transferId !== 'string' ||
    transferId === '' ||
    typeof purchase.stripeLivemode !== 'boolean'
  ) {
    throw new TestPaymentError(
      'AgentCard v2 lifecycle is missing scoped ownership, mode or transfer identity',
      502
    );
  }
  const [transfer, card, cards, transfers] = await Promise.all([
    api('GET', `/api/v2/company_wallet/transfers/${encodeURIComponent(transferId)}`),
    purchase.cardId !== null && purchase.cardId !== ''
      ? api('GET', `/api/v2/cards/${encodeURIComponent(purchase.cardId)}`)
      : Promise.resolve(null),
    listWindow(api, '/api/v2/cards', userId, purchase.createdAt),
    listWindow(api, '/api/v2/company_wallet/transfers', userId, purchase.createdAt),
  ]);
  validateTransfer(transfer, purchase, transferId, userId);
  const inWindow = (row: Record<string, unknown>) =>
    typeof row.created_at === 'string' &&
    Date.parse(row.created_at) >= purchase.createdAt.getTime() - 5_000;
  const matchingCards = cards.filter(
    (row) => row.spend_limit_cents === purchase.totalCents && inWindow(row)
  );
  const matchingTransfers = transfers.filter(
    (row) => row.amount_cents === purchase.totalCents && inWindow(row)
  );
  return {
    card: cardSummary(card, purchase.cardId, userId),
    transfer: {
      id: transferId,
      status: stringField(transfer, 'status'),
      amountCents: integerField(transfer, 'amount_cents'),
      transferredCents: v2TransferredCents(transfer),
      releasedCents: integerField(transfer, 'released_cents'),
      cardId: purchase.cardId,
      livemode: transfer.livemode,
    },
    integrity: {
      agentCardProviderCardCount: matchingCards.length,
      agentCardProviderTransferCount: matchingTransfers.length,
      agentCardProviderUnlinkedTransferCount: matchingTransfers.filter(
        (row) => typeof row.card_id !== 'string' || !row.card_id
      ).length,
    },
  };
}
