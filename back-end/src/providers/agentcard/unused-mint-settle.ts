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
  | { done: true; via: 'transfer'; settledCents: number; status: string }
  | { done: false };

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
