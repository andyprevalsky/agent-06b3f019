/**
 * Unused-mint settle decisions for AgentCard company-wallet transfers.
 *
 * Closing an unused `create_card(company_flow)` card eventually returns value to the org pool.
 * Settlement can surface as THIS card's mint transfer flipping to `reclaimed`/`released`, often
 * after `recover_funds` pulls cardholder residual. The sandbox org is shared: a concurrent
 * cardholder's residual can settle `recover_funds` while THIS mint transfer stays `consumed`
 * (observed 2026-09-29: foreign $87.92 sweep at t=16s with our transfer still consumed /
 * released_cents=0; our $13 reclaim landed at t=112s only because recover kept running).
 *
 * Therefore settle waits MUST NOT treat an arbitrary recover_funds yield as success — only THIS
 * card's mint transfer reaching a terminal release state is race-free money identity.
 */

export type MintTransferObservation = {
  status: string;
  releasedCents: number;
};

export function isFullyReclaimedTransfer(
  transfer: MintTransferObservation | undefined,
  minReleasedCents: number
): transfer is MintTransferObservation {
  return (
    transfer !== undefined &&
    transfer.releasedCents >= minReleasedCents &&
    (transfer.status === 'reclaimed' || transfer.status === 'released')
  );
}

export type UnusedMintSettleOutcome =
  { done: true; via: 'transfer'; settledCents: number; status: string } | { done: false };

/**
 * Decide whether an unused-mint settle poll can stop.
 *
 * `sweepSettledCents` / `sweepPendingCents` are intentionally ignored as success criteria: a
 * foreign cardholder residual can yield while THIS card's transfer stays consumed.
 */
export function unusedMintSettleOutcome(
  transfer: MintTransferObservation | undefined,
  minReleasedCents: number
): UnusedMintSettleOutcome {
  if (isFullyReclaimedTransfer(transfer, minReleasedCents)) {
    return {
      done: true,
      via: 'transfer',
      settledCents: transfer.releasedCents,
      status: transfer.status,
    };
  }
  return { done: false };
}

/** AgentCard's documented public transfer statuses: exactly the `list_transfers` filter values. */
export const TRANSFER_PUBLIC_STATUSES = [
  'pending',
  'funded',
  'consumed',
  'reclaimed',
  'failed',
] as const;

/**
 * How long an unused card's mint may stay unreleased before it counts as lost. Most sandbox
 * reclaims land within about two minutes, but some stay `consumed` for many hours, so a miss
 * inside one run is checked again by later runs instead of failing that run.
 */
export const UNUSED_MINT_RECLAIM_DEADLINE_MS = 24 * 60 * 60 * 1000;

const STILL_RECLAIMABLE_STATUSES: ReadonlySet<string> = new Set(['pending', 'funded', 'consumed']);

export type UnusedMintClassification =
  | { kind: 'settled'; status: string; releasedCents: number }
  | { kind: 'pending'; status: string }
  | { kind: 'failed'; reason: string };

/** Classify a closed unused card's mint transfer as fully returned, still able to return, or lost. */
export function classifyUnusedMintTransfer(
  transfer: MintTransferObservation,
  minReleasedCents: number
): UnusedMintClassification {
  const { status, releasedCents } = transfer;
  if (isFullyReclaimedTransfer(transfer, minReleasedCents)) {
    return { kind: 'settled', status, releasedCents };
  }
  if (STILL_RECLAIMABLE_STATUSES.has(status)) return { kind: 'pending', status };
  if (status === 'reclaimed' || status === 'released') {
    return { kind: 'failed', reason: `${status} only ${releasedCents}c of ${minReleasedCents}c` };
  }
  return { kind: 'failed', reason: `transfer status "${status}"` };
}

export type PendingUnusedMint = {
  cardId: string;
  transferId: string;
  cardholderId: string;
  mintCents: number;
  /** Provider `created_at` of the mint transfer. */
  mintedAt: string;
};

/** One `list_transfers` page filtered to `status`: the newest `limit` rows, newest first. */
export type TransferStatusPage = {
  status: string;
  limit: number;
  rows: Array<Record<string, unknown>>;
};

export type DeferredUnusedMintVerdict =
  | { kind: 'settled'; ageMs: number; status: string; releasedCents: number }
  | { kind: 'waiting'; ageMs: number; status: string }
  | { kind: 'overdue'; ageMs: number; status: string; row?: Record<string, unknown> }
  | { kind: 'failed'; ageMs: number; reason: string; row?: Record<string, unknown> }
  | { kind: 'unobservable'; ageMs: number; reason: string };

/** A page rules a status out only when it is complete or reaches back past the mint. */
function pageCovers(page: TransferStatusPage | undefined, mintedAtMs: number): boolean {
  if (page === undefined) return false;
  if (page.rows.length < page.limit) return true;
  const oldest = Date.parse(String(page.rows.at(-1)?.created_at ?? ''));
  return Number.isFinite(oldest) && oldest < mintedAtMs;
}

/**
 * Judge an earlier run's still-unreleased mint against the current transfer pages.
 *
 * `list_transfers` has no paging or card filter, so a transfer drops out of view once 100 newer
 * rows share its status. When it is not listed, the statuses whose pages reach back past the mint
 * are ruled out; if `reclaimed` is among them, the money has not come back.
 */
export function deferredUnusedMintVerdict(
  entry: PendingUnusedMint,
  pages: readonly TransferStatusPage[],
  nowMs: number
): DeferredUnusedMintVerdict {
  const mintedAtMs = Date.parse(entry.mintedAt);
  if (!Number.isFinite(mintedAtMs)) {
    return { kind: 'failed', ageMs: 0, reason: `unparseable mint time "${entry.mintedAt}"` };
  }
  const ageMs = nowMs - mintedAtMs;
  const pastDeadline = ageMs >= UNUSED_MINT_RECLAIM_DEADLINE_MS;
  const row = pages
    .flatMap((page) => page.rows)
    .find((candidate) => candidate.id === entry.transferId || candidate.card_id === entry.cardId);
  if (row !== undefined) {
    const status = String(row.status ?? 'unknown');
    const outcome = classifyUnusedMintTransfer(
      { status, releasedCents: Number(row.released_cents ?? 0) },
      entry.mintCents
    );
    if (outcome.kind === 'settled') return { ...outcome, ageMs };
    if (outcome.kind === 'failed') return { kind: 'failed', ageMs, reason: outcome.reason, row };
    return pastDeadline
      ? { kind: 'overdue', ageMs, status, row }
      : { kind: 'waiting', ageMs, status };
  }
  const possible = TRANSFER_PUBLIC_STATUSES.filter(
    (status) =>
      !pageCovers(
        pages.find((page) => page.status === status),
        mintedAtMs
      )
  );
  if (possible.length === 0) {
    return { kind: 'failed', ageMs, reason: 'transfer is missing from every status list' };
  }
  const status = `not listed (could be ${possible.join('/')})`;
  if (!possible.includes('reclaimed')) {
    return pastDeadline ? { kind: 'overdue', ageMs, status } : { kind: 'waiting', ageMs, status };
  }
  if (!pastDeadline) return { kind: 'waiting', ageMs, status };
  return {
    kind: 'unobservable',
    ageMs,
    reason: `${status}; the reclaimed list no longer reaches back to this mint`,
  };
}
