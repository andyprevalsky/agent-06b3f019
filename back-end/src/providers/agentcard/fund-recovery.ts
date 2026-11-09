/**
 * Recover a cardholder's unspent residual back into the org (pool) wallet.
 *
 * Background: `create_card(company_flow)` relocates pool capital into a cardholder's spending
 * power. Closing an unused card does NOT return it to the pool — instead the value stays as that
 * user's headroom and NETS against their next mint (verified: a $4 mint against existing residual
 * moved `transferred_cents: 0` and debited the pool $0.00).
 *
 * Netting is efficient for an ACTIVE user. Per AgentCard's current MCP contract, recover_funds is
 * intended for users we will not fund again. It should not be run on every card issuance.
 * `recover_funds` is AgentCard's primitive for pulling residual back — verified end to end:
 * `recover_funds({cardholder_id})` -> recovery `completed`, "the pool was credited", org wallet
 * increased by exactly the recovered amount.
 *
 * Live recovery completes asynchronously; don't treat a requested recovery as pool balance.
 */

import { createLogger } from '../logger';
import { callOrgTool as callOrgToolProvider, type AgentCardOrgToolCaller } from './org-runtime';

const log = createLogger('AgentCardFundRecovery');

export interface FundRecoveryResult {
  recoveryId?: string;
  amountCents: number;
  status: string;
  txHash?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Parse a `recover_funds` / `list_recoveries` payload.
 *
 * A recovery that reports no amount is treated as ZERO recovered, never as success of unknown
 * size — callers use the amount to decide whether they still need to buy USDC.
 */
export function extractRecovery(result: unknown): FundRecoveryResult {
  const outer = asRecord(result);
  const structured = asRecord(outer?.structuredContent) ?? outer;
  const recovery = asRecord(structured?.recovery) ?? structured;
  const rawAmount = recovery?.amount_cents ?? recovery?.amountCents;
  const amountCents =
    typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? Math.trunc(rawAmount) : 0;
  return {
    amountCents,
    status: optionalString(recovery, 'status') ?? 'unknown',
    ...(optionalString(recovery, 'id') !== undefined
      ? { recoveryId: optionalString(recovery, 'id') }
      : {}),
    ...(optionalString(recovery, 'tx_hash') !== undefined
      ? { txHash: optionalString(recovery, 'tx_hash') }
      : {}),
  };
}

export class AgentCardRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCardRecoveryError';
  }
}

/**
 * True when the provider answered "there is nothing to recover right now" rather than failing.
 *
 * `insufficient_headroom` is the common benign case and is NOT a fault: open cards and in-flight
 * claims subtract from recoverable headroom, so a recovery attempted moments after a close (or
 * against an already-swept cardholder) legitimately has nothing to take. Observed verbatim:
 *   "recover_funds failed: insufficient_headroom: Requested more than the cardholder's current
 *    recoverable headroom (open cards and in-flight claims subtract from it)."
 */
export function isNothingToRecover(result: unknown): boolean {
  const structured = asRecord(asRecord(result)?.structuredContent) ?? asRecord(result);
  const message = `${optionalString(structured, 'message') ?? ''}`.toLowerCase();
  return /insufficient_headroom|no_spending_power|no .*(residual|headroom|funds)|nothing to recover/.test(
    message
  );
}

/**
 * A recovery is only SETTLED when the provider says `completed`.
 *
 * Sandbox completes instantly, but live returns `requested` and settles asynchronously (it is an
 * onchain transfer back to the pool). Counting a pending recovery as available money would make
 * the top-up re-read an unchanged balance, buy USDC anyway, and then over-fund once the recovery
 * lands. Observed live: `rcv_fb3185a7547b6cfd2984540f` for $126.88 came back `requested`.
 */
export function isSettledRecovery(status: string): boolean {
  return status.toLowerCase() === 'completed';
}

/**
 * True for a provider error that is NOT the benign "nothing to recover" case.
 *
 * Without this, an auth failure or outage would parse as `amount_cents: 0` and be logged as a
 * successful zero recovery — the top-up would then quietly spend real money believing it had
 * already tried to reclaim its own capital.
 */
export function isRecoveryFailure(result: unknown): boolean {
  // The benign "nothing to recover" case is never a failure, whatever shape it arrives in.
  if (isNothingToRecover(result)) return false;

  const outer = asRecord(result);
  const structured = asRecord(outer?.structuredContent) ?? outer;

  // `mcpCallTool` returns the MCP result verbatim, so a provider outage can surface in several
  // shapes. Any of them previously parsed as `amount_cents: 0` and were logged as a successful
  // zero recovery — after which the top-up spends real USDC believing it had already tried to
  // reclaim its own capital.
  if (outer?.isError === true) return true;
  if (outer?.error !== undefined && outer.error !== null) return true;
  if (structured?.error !== undefined && structured.error !== null) return true;
  if (optionalString(structured, 'status')?.toLowerCase() === 'error') return true;

  // Text-only error responses carry no structured status at all.
  const content = outer?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => optionalString(asRecord(item), 'text') ?? '')
      .join(' ')
      .toLowerCase();
    if (/\b(error|failed|failure|unauthorized|forbidden|rate limit|timeout)\b/.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Pull a cardholder's full unspent residual back into the pool.
 *
 * `amountCents` is omitted deliberately — AgentCard recovers the entire residual when it is not
 * supplied, which is what we want and avoids a read-then-write race against a concurrent mint.
 */
export async function recoverCardholderFunds(
  cardholderId: string,
  callOrgTool: AgentCardOrgToolCaller = callOrgToolProvider
): Promise<FundRecoveryResult> {
  const raw = await callOrgTool('recover_funds', { cardholder_id: cardholderId });
  if (isNothingToRecover(raw)) {
    return { amountCents: 0, status: 'nothing_to_recover' };
  }
  if (isRecoveryFailure(raw)) {
    const structured = asRecord(asRecord(raw)?.structuredContent) ?? asRecord(raw);
    throw new AgentCardRecoveryError(
      optionalString(structured, 'message') ?? 'recover_funds failed'
    );
  }
  const recovery = extractRecovery(raw);
  if (recovery.amountCents > 0) {
    log.info('Recovered cardholder residual into the org wallet', {
      cardholder_id: cardholderId,
      recovery_id: recovery.recoveryId,
      amount_cents: recovery.amountCents,
      status: recovery.status,
    });
  }
  return recovery;
}

export function extractCardholderIds(result: unknown): string[] {
  const structured = asRecord(asRecord(result)?.structuredContent) ?? asRecord(result);
  const list = structured?.cardholders;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => optionalString(asRecord(entry), 'id'))
    .filter((id): id is string => id !== undefined);
}

/**
 * Recover every cardholder's residual, returning total cents credited back to the pool.
 *
 * Recovers SEQUENTIALLY. Each recovery credits the shared pool, and firing them concurrently
 * would race the provider's own balance accounting for no real gain — cardholder counts are small
 * and this runs off the purchase hot path.
 *
 * One cardholder failing must not abandon the rest: a single unrecoverable account would
 * otherwise strand every other user's residual too.
 */
export interface ResidualSweepResult {
  /** Cents the provider confirmed as `completed` — already reflected in the pool balance. */
  settledCents: number;
  /**
   * Cents accepted but still settling (live returns `requested` and lands onchain later). The
   * caller may defer a spend against these, but ONLY while they are still plausibly in flight.
   */
  pendingCents: number;
  /**
   * Age of the OLDEST still-pending recovery, or undefined when none are pending.
   *
   * Deferring on `pendingCents` alone is a livelock: observed live, recovery
   * `rcv_fb3185a7547b6cfd2984540f` ($126.88) sat in `requested` for over a day. If recoveries stop
   * settling, an unbounded deferral would never top up the pool, drain the org wallet, and fail
   * user card mints — strictly worse than briefly over-funding with our own money.
   */
  oldestPendingAgeMs?: number;
}

/**
 * Every recovery that has not reached a terminal state — regardless of which run created it.
 *
 * Counting only THIS run's pending recoveries under-reports: a recovery requested by an earlier
 * cycle still holds the cardholder's headroom, so a later cycle sees "nothing to recover" and
 * reports pending=0 while real money is still in flight. Observed live — two recoveries sat in
 * `requested` while a fresh sweep reported settled=$0.00 pending=$0.00.
 */
export async function pendingRecoveries(
  callOrgTool: AgentCardOrgToolCaller
): Promise<Array<{ amountCents: number; createdAtMs: number; cardholderId?: string }>> {
  // ONE call. Putting the `await` in the right operand of `??` fires a SECOND list_recoveries
  // whenever `structuredContent` is absent — burning the shared rate-limit budget and letting the
  // two responses describe different snapshots of the same money.
  const response = await callOrgTool('list_recoveries', { limit: 50 });
  const structured = asRecord(asRecord(response)?.structuredContent) ?? asRecord(response);
  const list = structured?.recoveries;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== undefined && !isSettledRecovery(optionalString(entry, 'status') ?? '')
    )
    .map((entry) => {
      const raw = entry.amount_cents;
      const cardholderId = optionalString(entry, 'cardholder_id');
      return {
        amountCents: typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0,
        // NaN when `created_at` is missing or unparseable. Deliberately NOT filtered out: dropping
        // the entry erases its amount from pendingCents and reports "nothing in flight" while real
        // money is still moving — exactly the failure this function exists to prevent. Callers
        // treat NaN as unknown age.
        createdAtMs: Date.parse(optionalString(entry, 'created_at') ?? ''),
        ...(cardholderId === undefined ? {} : { cardholderId }),
      };
    });
}

/** Age in ms of the oldest recovery that has not reached a terminal state. */
export async function oldestPendingRecoveryAgeMs(
  callOrgTool: AgentCardOrgToolCaller,
  now: number
): Promise<number | undefined> {
  // Single call, same reasoning as pendingRecoveries.
  const response = await callOrgTool('list_recoveries', { limit: 50 });
  const structured = asRecord(asRecord(response)?.structuredContent) ?? asRecord(response);
  const list = structured?.recoveries;
  if (!Array.isArray(list)) return undefined;
  const ages = list
    .map((entry) => asRecord(entry))
    .filter(
      (entry) => entry !== undefined && !isSettledRecovery(optionalString(entry, 'status') ?? '')
    )
    .map((entry) => Date.parse(optionalString(entry, 'created_at') ?? ''))
    // An unparseable date contributes age 0 (treated as FRESH) rather than being dropped. Dropping
    // it would let "pending exists but its date is unreadable" masquerade as `undefined`, which
    // callers read as "nothing pending" and would spend on top of in-flight money. Age 0 is the
    // conservative reading: the livelock guard defers instead of spending.
    .map((parsed) => (Number.isFinite(parsed) ? now - parsed : 0));
  return ages.length === 0 ? undefined : Math.max(...ages);
}

export async function recoverAllCardholderResiduals(
  callOrgTool: AgentCardOrgToolCaller = callOrgToolProvider
): Promise<ResidualSweepResult> {
  const cardholderIds = extractCardholderIds(await callOrgTool('list_cardholders', {}));

  // Per AgentCard: "an open recovery holds its claim so the same residual can't be pulled twice,
  // so don't retry — poll instead." Re-requesting for a cardholder that already has one in flight
  // is guaranteed to come back `insufficient_headroom`, so skip it rather than burning a call and
  // logging a benign error every cycle.
  const alreadyInFlight = new Set(
    (await pendingRecoveries(callOrgTool))
      .map((entry) => entry.cardholderId)
      .filter((id): id is string => id !== undefined)
  );
  let settledCents = 0;
  let pendingCents = 0;
  for (const cardholderId of cardholderIds) {
    if (alreadyInFlight.has(cardholderId)) {
      log.info('Skipping recovery request; one is already in flight for this cardholder', {
        cardholder_id: cardholderId,
      });
      continue;
    }
    try {
      const recovery = await recoverCardholderFunds(cardholderId, callOrgTool);
      if (isSettledRecovery(recovery.status)) settledCents += recovery.amountCents;
      else pendingCents += recovery.amountCents;
    } catch (error) {
      log.warn('Residual recovery failed for one cardholder; continuing', {
        cardholder_id: cardholderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (settledCents > 0 || pendingCents > 0) {
    log.info('Residual recovery swept cardholders into the pool', {
      cardholders: cardholderIds.length,
      settled_cents: settledCents,
      pending_cents: pendingCents,
    });
  }
  // Report ALL in-flight recoveries, not just the ones this sweep created. Anything an earlier
  // cycle requested still holds headroom and still represents money on its way back to the pool.
  const now = Date.now();
  const inFlight = await pendingRecoveries(callOrgTool);
  const totalPendingCents = inFlight.reduce((sum, entry) => sum + entry.amountCents, 0);
  // An unparseable `created_at` yields NaN, and `Math.max(x, NaN)` is NaN — which would silently
  // defeat every downstream age comparison in the livelock guard. Treat unknown age as 0 (fresh),
  // matching oldestPendingRecoveryAgeMs: the guard then defers rather than spending on top of
  // money that may still be in flight.
  const oldestPendingAgeMs =
    inFlight.length === 0
      ? undefined
      : Math.max(
          ...inFlight.map((entry) =>
            Number.isFinite(entry.createdAtMs) ? now - entry.createdAtMs : 0
          )
        );
  return {
    settledCents,
    pendingCents: Math.max(pendingCents, totalPendingCents),
    ...(oldestPendingAgeMs === undefined ? {} : { oldestPendingAgeMs }),
  };
}

/** What one settle-wait poll did for THIS cardholder's residual (an accelerator, never success). */
export type CardholderRecoveryNudge =
  | { kind: 'coalesced'; inFlightCents: number }
  | { kind: 'requested'; recovery: FundRecoveryResult }
  | { kind: 'nothing_to_recover' };

/**
 * Nudge ONE cardholder's residual back to the pool, coalescing on a recovery already in flight.
 *
 * The sandbox org is shared by every deploy and dev box. A settle wait that swept EVERY
 * cardholder (`recoverAllCardholderResiduals`: list_cardholders + list_recoveries + one
 * recover_funds per cardholder + list_recoveries) every 8 s cost 3 + N org calls per poll per
 * deploy, and pulled other runs' cardholders' residual out from under them. Only the residual of
 * the card's own cardholder can release its mint, so this reads the org's open recoveries first
 * (one call) and, when one already holds this cardholder's claim — requested by this run, another
 * deploy or production — polls on it instead of asking again (AgentCard: "an open recovery holds
 * its claim so the same residual can't be pulled twice, so don't retry — poll instead"). The
 * provider recovers the full residual when no amount is given, so a retried poll can never pull
 * money twice. A real provider failure still throws AgentCardRecoveryError.
 */
export async function nudgeCardholderRecovery(
  cardholderId: string,
  callOrgTool: AgentCardOrgToolCaller = callOrgToolProvider
): Promise<CardholderRecoveryNudge> {
  const open = (await pendingRecoveries(callOrgTool)).filter(
    (entry) => entry.cardholderId === cardholderId
  );
  if (open.length > 0) {
    return {
      kind: 'coalesced',
      inFlightCents: open.reduce((sum, entry) => sum + entry.amountCents, 0),
    };
  }
  const recovery = await recoverCardholderFunds(cardholderId, callOrgTool);
  return recovery.status === 'nothing_to_recover'
    ? { kind: 'nothing_to_recover' }
    : { kind: 'requested', recovery };
}
