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

import {
  AgentCardRecoveryError,
  nudgeCardholderRecovery,
  type CardholderRecoveryNudge,
} from './fund-recovery';
import { AgentCardOrgRuntimeError, type AgentCardOrgToolCaller } from './org-runtime';

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

export const UNUSED_MINT_SETTLE_POLL_MS = 8_000;
export const UNUSED_MINT_SETTLE_WAIT_MS = 240_000;
/**
 * The org MCP throttle is one fixed 60 s window shared by every caller of the org (concurrent
 * deploys, smoke payment tasks, production). A poll that still gets 429 after the runtime's own
 * bounded retry waits out a whole window before polling again instead of adding to the backlog.
 */
export const UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS = 60_000;

/** The runtime's typed outcome for org-wide throttling that its bounded retry did not outlast. */
function isOrgThrottle(error: unknown): boolean {
  return (
    error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_rate_limited'
  );
}

/** Paced throttle waits one caller may still spend; shared by every read it paces. */
export interface OrgThrottleBudget {
  remainingMs: number;
}

export interface OrgThrottlePacing {
  budget: OrgThrottleBudget;
  report?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Jitter in [0, 1) (PR #2129's runtime clock design); omitted means none, for exact tests. */
  random?: () => number;
}

/**
 * Re-issue one org read that the runtime's own bounded retry could not carry through an
 * org-wide throttle (typed `agentcard_org_mcp_rate_limited`), waiting for the advertised reset
 * (`"retryAfter": <epoch ms>` in the provider text) plus up to 1 s of jitter, or else one throttle
 * window grown by up to half. Concurrent deploys share one org window, so the jitter keeps their
 * retries from re-colliding at the refill. Every wait is charged to the caller's shared budget:
 * a reset that does not fit it, or an exhausted budget, rethrows the throttle untouched. Any
 * other error propagates on first sight.
 */
export async function paceOrgThrottle<T>(
  read: () => Promise<T>,
  pacing: OrgThrottlePacing
): Promise<T> {
  const now = pacing.now ?? Date.now;
  const sleep =
    pacing.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (!isOrgThrottle(error)) throw error;
      const remainingMs = pacing.budget.remainingMs;
      const jitter = Math.min(Math.max(pacing.random?.() ?? 0, 0), 1);
      const match = /"retryAfter"\s*:\s*(\d+)/.exec(
        error instanceof Error ? error.message : String(error)
      );
      const resetWaitMs = match === null ? Number.NaN : Number(match[1]) - now() + 250;
      const hinted = Number.isFinite(resetWaitMs) && resetWaitMs > 0;
      if (remainingMs <= 0 || (hinted && resetWaitMs > remainingMs)) throw error;
      const waitMs = hinted
        ? Math.min(resetWaitMs + jitter * 1_000, remainingMs)
        : Math.min(UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS * (1 + jitter / 2), remainingMs);
      pacing.budget.remainingMs = remainingMs - waitMs;
      pacing.report?.(
        `  (org MCP throttled; waiting ${Math.round(waitMs)} ms before one more read, ` +
          `${Math.round(pacing.budget.remainingMs)} ms of throttle budget left)`
      );
      await sleep(waitMs);
    }
  }
}

export interface UnusedMintSettleWait<T extends MintTransferObservation> {
  /** The closed card's own cardholder: the only residual that can release its mint. */
  cardholderId: string;
  minReleasedCents: number;
  callOrgTool: AgentCardOrgToolCaller;
  /** THIS card's org-wallet mint transfer; the only success signal. */
  readTransfer: () => Promise<T | undefined>;
  isTransientError: (error: unknown) => boolean;
  report: (line: string) => void;
  /** Provider row for the timeout diagnostic. */
  describe?: (transfer: T | undefined) => string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function nudgeNote(attempt: number, nudge: CardholderRecoveryNudge): string | undefined {
  if (nudge.kind === 'coalesced')
    return `#${attempt} coalesced on in-flight ${nudge.inFlightCents}c`;
  if (nudge.kind === 'requested' && nudge.recovery.amountCents > 0) {
    return `#${attempt} ${nudge.recovery.status} ${nudge.recovery.amountCents}c`;
  }
  return undefined;
}

/**
 * Wait until THIS card's unused mint transfer reaches a terminal release state.
 *
 * Each poll nudges only the card's own cardholder (nudgeCardholderRecovery: read open recoveries
 * first, coalesce on one in flight), then reads THIS card's transfer. A recovery yield is never
 * success. When the in-run wait runs out this returns the latest observation instead of failing:
 * a reclaim can legitimately take up to a day (UNUSED_MINT_RECLAIM_DEADLINE_MS). An org throttle
 * the runtime could not outlast is paced (UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS) within the same
 * window and fails only if it is still in force at the deadline.
 */
export async function waitForUnusedMintSettled<T extends MintTransferObservation>(
  wait: UnusedMintSettleWait<T>
): Promise<T | undefined> {
  const now = wait.now ?? Date.now;
  const sleep =
    wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (wait.timeoutMs ?? UNUSED_MINT_SETTLE_WAIT_MS);
  let attempt = 0;
  let last: T | undefined;
  // Keep every attempt's recovery note so a timeout shows which side stalled.
  const notes: string[] = [];
  for (;;) {
    attempt += 1;
    try {
      try {
        const note = nudgeNote(
          attempt,
          await nudgeCardholderRecovery(wait.cardholderId, wait.callOrgTool)
        );
        if (note !== undefined) notes.push(note);
      } catch (error) {
        // The nudge only accelerates; a refused recovery is evidence, not a settle failure.
        if (!(error instanceof AgentCardRecoveryError)) throw error;
        notes.push(`#${attempt} recover_funds refused: ${error.message}`);
      }
      const transfer = await wait.readTransfer();
      if (transfer !== undefined) last = transfer;
      const outcome = unusedMintSettleOutcome(transfer, wait.minReleasedCents);
      if (outcome.done) {
        wait.report(
          `  (transfer ${outcome.status} with ${outcome.settledCents}c on attempt ${attempt}; ` +
            `own-cardholder recovery: ${notes.join(', ') || 'not needed'})`
        );
        return transfer;
      }
      if (now() >= deadline) {
        wait.report(
          `  unused mint not reclaimed within the in-run wait (${attempt} attempts); provider row: ` +
            `${wait.describe?.(last) ?? JSON.stringify(last ?? null)}; own-cardholder recovery: ` +
            `${notes.join(', ') || 'none'}`
        );
        return last;
      }
    } catch (error) {
      // Org-wide backpressure says nothing about THIS transfer: keep polling inside the same
      // settle window, one poll per throttle window. A throttle that outlasts it still fails.
      if (isOrgThrottle(error)) {
        if (now() >= deadline) throw error;
        wait.report(
          `  (org MCP throttled on attempt ${attempt}; waiting one throttle window before polling again)`
        );
        await sleep(Math.min(UNUSED_MINT_SETTLE_THROTTLE_BACKOFF_MS, deadline - now()));
        continue;
      }
      if (!wait.isTransientError(error)) throw error;
      if (now() >= deadline) throw error;
      if (attempt % 3 === 0) {
        wait.report(`  (MCP poll timed out, retrying settle wait, attempt ${attempt})`);
      }
      await sleep(UNUSED_MINT_SETTLE_POLL_MS);
      continue;
    }
    if (attempt % 3 === 0)
      wait.report(`  (still waiting for release to settle, attempt ${attempt})`);
    await sleep(UNUSED_MINT_SETTLE_POLL_MS);
  }
}
