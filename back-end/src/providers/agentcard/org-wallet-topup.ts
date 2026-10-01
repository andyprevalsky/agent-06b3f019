/**
 * Automatic AgentCard org-wallet top-up from the Coinbase CDP treasury.
 *
 * Flow of funds (the automated leg only):
 *   Coinbase CDP server wallet (USDC on Base)  ──transfer──▶  AgentCard org wallet
 *
 * Triggered after a company_flow card mint debits the org wallet (see `charge.ts`). When available
 * balance falls below `thresholdCents`, transfer enough to reach `targetCents`.
 *
 * ── Money-safety invariants ────────────────────────────────────────────────────────────────────
 *  1. NEVER blocks or fails a purchase. The trigger is fire-and-forget; every error is swallowed.
 *  2. Single-flight via a unique `ToolSideEffect` row. Concurrent mints cannot double-send.
 *  3. Balance is re-read AFTER the claim is held, then re-planned. A top-up that landed while we
 *     queued behind another claim is observed and the send is skipped.
 *  4. Defence in depth against double-spend. The send carries Coinbase's `idem` key (the claim row
 *     id), so a replay is de-duplicated provider-side. On top of that, a failure that may have been
 *     accepted leaves the claim HELD (not released), halting the rail rather than retrying. A
 *     halted rail degrades to the pre-existing manual SMS reload path; a double-send does not
 *     degrade, it just loses money.
 *  5. Sandbox org wallets are never topped up with live funds.
 *  6. Bounded by per-transfer max and a rolling 24h cap.
 *  7. Disabled by default. Requires AGENTCARD_ORG_WALLET_AUTO_TOPUP_ENABLED=1.
 *  8. Active cardholders keep residual headroom so AgentCard can net it against their next mint.
 *     Recovery is for users we will not fund again, per the current MCP contract.
 */

import { prisma } from '../database';
import { createLogger } from '../logger';
import { sendSms as sendSmsProvider } from '../smsQueue';
import { createCoinbaseTreasury, type CoinbaseTreasury } from '../coinbase/treasury';
import { loadCoinbaseTreasuryConfig } from '../coinbase/config';
import { callOrgTool as callOrgToolProvider, type AgentCardOrgToolCaller } from './org-runtime';
import { readAgentCardOrgWallet, type AgentCardOrgWallet } from './org-wallet-monitor';
import {
  resolveInFlight,
  wireFiat,
  topUpFiatShortfall,
  resolveFiatSource,
  type FiatSource,
} from './org-wallet-fiat';
export { fiatPullEnabled } from './org-wallet-fiat';

const log = createLogger('AgentCardOrgWalletTopUp');

const INFLIGHT_OPERATION_KEY = 'agentcard-org-wallet-topup:inflight';
export const TOPUP_OPERATION_TYPE = 'AGENTCARD_ORG_WALLET_TOPUP';

/** Separate single-flight key for the irreversible bank leg. */
const FIAT_INFLIGHT_OPERATION_KEY = 'agentcard-org-wallet-topup:fiat-inflight';
export const FIAT_PULL_OPERATION_TYPE = 'AGENTCARD_ORG_WALLET_FIAT_PULL';

const DEFAULT_THRESHOLD_CENTS = 25_000; // $250
const DEFAULT_TARGET_CENTS = 50_000; // $500
const DEFAULT_MIN_TRANSFER_CENTS = 1_000; // $10 — below this, gas is not worth it
const DEFAULT_MAX_TRANSFER_CENTS = 50_000; // $500 per transfer
const DEFAULT_DAILY_CAP_CENTS = 200_000; // $2,000 per rolling 24h
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECOVERY_SETTLE_GRACE_MS = 15 * 60 * 1000;

/**
 * A held claim older than this is treated as orphaned by a dead process, not as live contention.
 * Generous relative to a real top-up (a wallet read plus one transfer), so normal contention is
 * never mislabelled.
 */
const ORPHANED_CLAIM_ALERT_MS = 30 * 60 * 1000;

/**
 * How long a recovery may sit un-settled before we stop deferring the top-up on it.
 *
 * A bare `Number()` returns NaN for any non-numeric value, and EVERY comparison against NaN is
 * false — so a typo in `AGENTCARD_RECOVERY_SETTLE_GRACE_MS` would silently disable the livelock
 * guard instead of erroring. Fall back to the default (and say so) rather than shipping a guard
 * that is quietly inert. A negative or zero value is equally rejected: it would make every pending
 * recovery instantly "stuck" and defeat the deferral entirely.
 */
function resolveRecoverySettleGraceMs(
  raw: string | undefined = process.env.AGENTCARD_RECOVERY_SETTLE_GRACE_MS
): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return DEFAULT_RECOVERY_SETTLE_GRACE_MS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn('Invalid AGENTCARD_RECOVERY_SETTLE_GRACE_MS; using default', {
      provided: trimmed,
      default_ms: DEFAULT_RECOVERY_SETTLE_GRACE_MS,
    });
    return DEFAULT_RECOVERY_SETTLE_GRACE_MS;
  }
  return parsed;
}

const RECOVERY_SETTLE_GRACE_MS = resolveRecoverySettleGraceMs();

export interface OrgWalletTopUpPolicy {
  enabled: boolean;
  thresholdCents: number;
  targetCents: number;
  minTransferCents: number;
  maxTransferCents: number;
  dailyCapCents: number;
}

export type TopUpDecision =
  | { action: 'skip'; reason: TopUpSkipReason }
  | { action: 'insufficient_float'; neededCents: number; floatCents: number }
  | {
      action: 'transfer';
      transferCents: number;
      /**
       * The part of the gap the USDC float could NOT cover, so the caller can wire it from Brex.
       *
       * Without this, a float-limited transfer silently under-funds: we would send the $50 we had
       * against a $300 gap and never ask the bank for the missing $250, leaving the pool short.
       */
      fiatShortfallCents: number;
    };

export type TopUpSkipReason =
  | 'disabled'
  | 'sandbox_wallet'
  | 'above_threshold'
  | 'daily_cap_reached'
  | 'below_min_transfer'
  /** Deposits already on their way cover the gap to target; asking for more would over-fund. */
  | 'covered_by_inflight';

export interface OrgWalletTopUpClaim {
  claimed: boolean;
  /**
   * Id of the claim row. Doubles as the Coinbase `idem` key for the send, so a replay of the same
   * claim is de-duplicated provider-side instead of double-spending.
   */
  claimId?: string;
  /** A prior claim is still held — either in flight or halted awaiting manual review. */
  heldSince?: Date;
}

export interface OrgWalletTopUpStore {
  dailySpentCents(): Promise<number>;
  claim(planned: { transferCents: number; availableCents: number }): Promise<OrgWalletTopUpClaim>;
  recordSuccess(params: { transactionHash: string; transferCents: number }): Promise<void>;
  /** Release the claim so a later mint can retry. ONLY for definitively-not-sent failures. */
  releaseClaim(): Promise<void>;
  /**
   * Single-flight claim for the BANK leg, separate from the USDC claim above.
   *
   * A bank wire is irreversible, so it needs its own guard rather than trusting `inFlightCents`.
   * In-flight is an ESTIMATE read from providers: it can be stale, mis-paged, or simply not yet
   * reflect a wire we sent seconds ago. Two concurrent card issuances would each compute the same
   * shortfall and each wire it. The claim id also becomes the Brex idempotency key, so even a
   * retry of the SAME claim is de-duplicated provider-side.
   */
  claimFiatPull(planned: { wireCents: number }): Promise<OrgWalletTopUpClaim>;
  recordFiatSuccess(params: { transferId: string; wireCents: number }): Promise<void>;
  /** Release the fiat claim. ONLY for definitively-not-wired failures. */
  releaseFiatClaim(): Promise<void>;
}

/**
 * Decide whether and how much to transfer. Pure — no I/O, exhaustively unit tested.
 *
 * Clamp order matters: need → per-transfer max → remaining daily cap → available float. Each clamp
 * only ever lowers the amount, so no ordering can produce a transfer above any single bound.
 */
export function planOrgWalletTopUp(params: {
  policy: OrgWalletTopUpPolicy;
  wallet: Pick<AgentCardOrgWallet, 'livemode' | 'availableCents'>;
  floatCents: number;
  dailySpentCents: number;
  /**
   * Money that has already left Brex but has not yet landed in the org wallet: wires still
   * settling, plus USD sitting in Coinbase awaiting conversion. Counting it is what lets this be
   * the ONLY check in the system — without it, every mint during the multi-hour settlement window
   * would re-request the full gap and stack duplicate deposits.
   */
  inFlightCents?: number;
}): TopUpDecision {
  const { policy, wallet, floatCents, dailySpentCents } = params;
  const inFlightCents = Math.max(0, params.inFlightCents ?? 0);

  if (!policy.enabled) return { action: 'skip', reason: 'disabled' };
  if (!wallet.livemode) return { action: 'skip', reason: 'sandbox_wallet' };
  // The TRIGGER is the balance we actually hold. In-flight money cannot fund a mint that happens
  // before it lands, so it must not suppress the trigger — it only shrinks the amount we ask for.
  if (wallet.availableCents >= policy.thresholdCents) {
    return { action: 'skip', reason: 'above_threshold' };
  }

  // Only ever request the DIFFERENCE between target and what we will have once everything
  // already inbound arrives. Wallet $200 + $200 inbound against a $500 target asks for $100.
  const need = policy.targetCents - wallet.availableCents - inFlightCents;
  if (need <= 0) return { action: 'skip', reason: 'covered_by_inflight' };

  const dailyRemaining = policy.dailyCapCents - dailySpentCents;
  if (dailyRemaining <= 0) return { action: 'skip', reason: 'daily_cap_reached' };

  const wanted = Math.min(need, policy.maxTransferCents, dailyRemaining);
  const affordable = Math.min(wanted, floatCents);

  if (affordable < policy.minTransferCents) {
    // Distinguish "the float is dry" (actionable — pull fiat from Brex) from "the gap is tiny"
    // (benign — wait for the next mint to widen it).
    return floatCents < policy.minTransferCents
      ? { action: 'insufficient_float', neededCents: wanted, floatCents }
      : { action: 'skip', reason: 'below_min_transfer' };
  }
  return {
    action: 'transfer',
    transferCents: affordable,
    fiatShortfallCents: Math.max(0, wanted - affordable),
  };
}

export function policyFromEnvironment(): OrgWalletTopUpPolicy {
  const readCents = (name: string, fallback: number): number => {
    const raw = process.env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer number of cents`);
    }
    return value;
  };

  const policy: OrgWalletTopUpPolicy = {
    enabled: process.env.AGENTCARD_ORG_WALLET_AUTO_TOPUP_ENABLED === '1',
    thresholdCents: readCents(
      'AGENTCARD_ORG_WALLET_TOPUP_THRESHOLD_CENTS',
      DEFAULT_THRESHOLD_CENTS
    ),
    targetCents: readCents('AGENTCARD_ORG_WALLET_TOPUP_TARGET_CENTS', DEFAULT_TARGET_CENTS),
    minTransferCents: readCents('AGENTCARD_ORG_WALLET_TOPUP_MIN_CENTS', DEFAULT_MIN_TRANSFER_CENTS),
    maxTransferCents: readCents('AGENTCARD_ORG_WALLET_TOPUP_MAX_CENTS', DEFAULT_MAX_TRANSFER_CENTS),
    dailyCapCents: readCents('AGENTCARD_ORG_WALLET_TOPUP_DAILY_CAP_CENTS', DEFAULT_DAILY_CAP_CENTS),
  };
  if (policy.targetCents <= policy.thresholdCents) {
    throw new Error(
      'AGENTCARD_ORG_WALLET_TOPUP_TARGET_CENTS must exceed AGENTCARD_ORG_WALLET_TOPUP_THRESHOLD_CENTS'
    );
  }
  return policy;
}

export function createOrgWalletTopUpStore(): OrgWalletTopUpStore {
  return {
    async dailySpentCents() {
      const rows = await prisma.toolSideEffect.findMany({
        where: {
          operationType: TOPUP_OPERATION_TYPE,
          status: 'SUCCEEDED',
          createdAt: { gte: new Date(Date.now() - DAILY_WINDOW_MS) },
        },
        select: { request: true },
      });
      return rows.reduce((total, row) => {
        const request = row.request as { transferCents?: unknown } | null;
        const cents = request?.transferCents;
        return total + (typeof cents === 'number' && Number.isFinite(cents) ? cents : 0);
      }, 0);
    },

    async claim(planned) {
      try {
        const row = await prisma.toolSideEffect.create({
          data: {
            operationKey: INFLIGHT_OPERATION_KEY,
            operationType: TOPUP_OPERATION_TYPE,
            status: 'STARTED',
            request: {
              transferCents: planned.transferCents,
              availableCents: planned.availableCents,
            },
          },
          select: { id: true },
        });
        return { claimed: true, claimId: row.id };
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        // Deliberately NOT stale-cleared. A held claim may represent a broadcast-but-unconfirmed
        // send; auto-expiring it would reintroduce the double-send this lock exists to prevent.
        const existing = await prisma.toolSideEffect.findUnique({
          where: { operationKey: INFLIGHT_OPERATION_KEY },
          select: { createdAt: true },
        });
        return { claimed: false, ...(existing ? { heldSince: existing.createdAt } : {}) };
      }
    },

    async recordSuccess({ transactionHash, transferCents }) {
      // Re-key the claim row into a permanent ledger entry. This frees the inflight key for the
      // next episode AND leaves the audit trail the daily cap is computed from, atomically.
      await prisma.toolSideEffect.update({
        where: { operationKey: INFLIGHT_OPERATION_KEY },
        data: {
          operationKey: `agentcard-org-wallet-topup:tx:${transactionHash}`,
          status: 'SUCCEEDED',
          externalId: transactionHash,
          request: { transferCents },
          response: { transactionHash, transferCents },
        },
      });
    },

    async releaseClaim() {
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: INFLIGHT_OPERATION_KEY, status: 'STARTED' },
      });
    },

    async claimFiatPull(planned) {
      try {
        const row = await prisma.toolSideEffect.create({
          data: {
            operationKey: FIAT_INFLIGHT_OPERATION_KEY,
            operationType: FIAT_PULL_OPERATION_TYPE,
            status: 'STARTED',
            request: { wireCents: planned.wireCents },
          },
          select: { id: true },
        });
        return { claimed: true, claimId: row.id };
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        // Same reasoning as the USDC claim: never stale-clear. A held fiat claim may represent a
        // wire Brex already accepted, and auto-expiring it would wire the same money twice.
        const existing = await prisma.toolSideEffect.findUnique({
          where: { operationKey: FIAT_INFLIGHT_OPERATION_KEY },
          select: { createdAt: true },
        });
        return { claimed: false, ...(existing ? { heldSince: existing.createdAt } : {}) };
      }
    },

    async recordFiatSuccess({ transferId, wireCents }) {
      await prisma.toolSideEffect.update({
        where: { operationKey: FIAT_INFLIGHT_OPERATION_KEY },
        data: {
          operationKey: `${FIAT_INFLIGHT_OPERATION_KEY}:${transferId}`,
          status: 'SUCCEEDED',
          response: { transferId, wireCents },
        },
      });
    },

    async releaseFiatClaim() {
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: FIAT_INFLIGHT_OPERATION_KEY, status: 'STARTED' },
      });
    },
  };
}

export type TopUpResult =
  | { status: 'skipped'; reason: TopUpSkipReason }
  | { status: 'not_configured' }
  | { status: 'contended'; heldSince?: Date }
  | { status: 'recovered'; recoveredCents: number; availableCents: number }
  | { status: 'recovery_pending'; pendingCents: number }
  | { status: 'insufficient_float'; neededCents: number; floatCents: number }
  /** The USDC float was dry, so fiat was wired from Brex; it lands after wire settlement. */
  | { status: 'fiat_pull_started'; wiredCents: number; transferId: string }
  | { status: 'transferred'; transferCents: number; transactionHash: string }
  | { status: 'halted'; error: string };

/**
 * The fiat leg, invoked on demand rather than on a schedule when deliberately re-enabled.
 *
 * Optional so the pure-treasury tests and any caller without Brex configured behave exactly as
 * before: no Brex, no fiat pull, and the existing `insufficient_float` alert still fires.
 */
interface TopUpDependencies {
  policy: OrgWalletTopUpPolicy;
  treasury: CoinbaseTreasury;
  callOrgTool: AgentCardOrgToolCaller;
  store: OrgWalletTopUpStore;
  alert: (message: string) => Promise<void>;
  /** When present, a dry USDC float pulls fiat from Brex instead of only alerting. */
  fiatSource?: FiatSource;
  /**
   * Pull idle cardholder residual back into the pool, returning cents recovered. Attempted BEFORE
   * any treasury spend: recovering capital we already own is free. Optional so callers that only
   * want the treasury path (and every existing unit test) are unaffected.
   */
  recoverResidual?: () => Promise<{
    settledCents: number;
    pendingCents: number;
    oldestPendingAgeMs?: number;
  }>;
}

export async function runOrgWalletTopUp(deps: TopUpDependencies): Promise<TopUpResult> {
  if (!deps.policy.enabled) return { status: 'skipped', reason: 'disabled' };

  const wallet = await readAgentCardOrgWallet(deps.callOrgTool);
  if (!wallet.livemode) return { status: 'skipped', reason: 'sandbox_wallet' };
  if (wallet.availableCents >= deps.policy.thresholdCents) {
    return { status: 'skipped', reason: 'above_threshold' };
  }

  // Recover our own idle residual BEFORE buying new USDC. Unspent card value sits as a
  // cardholder's headroom where no other user can draw on it; `recover_funds` credits it back to
  // the pool. Reclaiming capital we already own is free, whereas a top-up costs a real Coinbase
  // purchase — so if recovery alone clears the floor, no money needs to move at all.
  let current = wallet;
  let recoveredCents = 0;
  if (deps.recoverResidual !== undefined) {
    const emptySweep: { settledCents: number; pendingCents: number; oldestPendingAgeMs?: number } =
      {
        settledCents: 0,
        pendingCents: 0,
      };
    const sweep = await deps.recoverResidual().catch((error: unknown) => {
      // Never let a recovery problem block the top-up; the treasury path is the backstop.
      log.warn('Residual recovery failed; falling back to treasury top-up', {
        error: error instanceof Error ? error.message : String(error),
      });
      return emptySweep;
    });
    recoveredCents = sweep.settledCents;
    // Our own money is already on the way back, so briefly defer rather than over-fund. BOUNDED:
    // a recovery that has been pending longer than the grace window is treated as stuck, and we
    // spend anyway. An unbounded defer is a livelock — recoveries have been observed sitting in
    // `requested` for over a day, and a pool that never refills fails user card mints, which is
    // far worse than temporarily holding more of our own USDC than the target.
    const pendingAgeMs = sweep.oldestPendingAgeMs;
    const stuck = pendingAgeMs !== undefined && pendingAgeMs > RECOVERY_SETTLE_GRACE_MS;
    if (sweep.pendingCents > 0 && !stuck) {
      log.info('Residual recovery is still settling; deferring treasury spend', {
        pending_cents: sweep.pendingCents,
        pending_age_ms: pendingAgeMs,
      });
      return { status: 'recovery_pending', pendingCents: sweep.pendingCents };
    }
    if (stuck) {
      log.warn('Residual recovery appears stuck; topping up anyway rather than starving the pool', {
        pending_cents: sweep.pendingCents,
        pending_age_ms: pendingAgeMs,
        grace_ms: RECOVERY_SETTLE_GRACE_MS,
      });
    }
    if (recoveredCents > 0) {
      current = await readAgentCardOrgWallet(deps.callOrgTool);
      if (current.availableCents >= deps.policy.thresholdCents) {
        log.info('Residual recovery alone restored the org wallet; no treasury spend needed', {
          recovered_cents: recoveredCents,
          available_cents: current.availableCents,
        });
        return { status: 'recovered', recoveredCents, availableCents: current.availableCents };
      }
    }
  }

  // In-flight = money that has left Brex but has not yet landed in the org wallet: wires still
  // settling, plus USD sitting in Coinbase awaiting conversion. Subtracting it is what makes this
  // check safe to run on EVERY mint — otherwise each mint inside a wire's settlement window would
  // see the same low balance and stack another deposit.
  let floatCents: number;
  let dailySpentCents: number;
  let flight: Awaited<ReturnType<typeof resolveInFlight>>;
  try {
    [floatCents, dailySpentCents, flight] = await Promise.all([
      deps.treasury.getUsdcBalanceCents(),
      deps.store.dailySpentCents(),
      resolveInFlight(deps),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Cannot establish treasury state; halting top-up to prevent duplicate funds', {
      error: message,
    });
    await deps
      .alert(`Rose AgentCard top-up halted: treasury state is unavailable (${message}).`)
      .catch(() => undefined);
    return { status: 'halted', error: message };
  }
  const { inFlightCents, strandedUsdCents } = flight;
  // Stranded USD blocks a NEW wire (piling more cash on top helps nobody) but never suppresses
  // the top-up decision or its alert, so the operator always learns the rail needs a conversion.
  if (strandedUsdCents > 0) {
    log.warn('Unconverted USD is sitting in Coinbase; it cannot fund a mint until converted', {
      stranded_usd_cents: strandedUsdCents,
      float_cents: floatCents,
    });
  }
  const plan = planOrgWalletTopUp({
    policy: deps.policy,
    wallet: current,
    floatCents,
    dailySpentCents,
    inFlightCents,
  });

  if (plan.action === 'skip') return { status: 'skipped', reason: plan.reason };
  if (plan.action === 'insufficient_float') {
    // The USDC float cannot cover the gap. The optional Brex source is hard-disabled in
    // production until the rail is repaired. If re-enabled, only mint-time demand can pull it;
    // `inFlightCents` keeps settling transfers from causing duplicate deposits.
    const shortfallCents = plan.neededCents - plan.floatCents;
    // Never wire fresh fiat on top of cash that is already stranded at Coinbase awaiting
    // conversion — that compounds the stuck balance instead of fixing it. Alert with the exact
    // action instead, so the rail's blocker is always visible rather than silent.
    if (strandedUsdCents > 0) {
      await deps.alert(
        `Rose AgentCard org wallet needs $${(shortfallCents / 100).toFixed(2)} but ` +
          `$${(strandedUsdCents / 100).toFixed(2)} USD is already sitting UNCONVERTED in Coinbase. ` +
          `Convert it to USDC at https://www.coinbase.com/assets — no new wire was sent.`
      );
      return {
        status: 'insufficient_float',
        neededCents: plan.neededCents,
        floatCents: plan.floatCents,
      };
    }
    if (deps.fiatSource !== undefined && shortfallCents > 0) {
      const wire = await wireFiat(deps, shortfallCents, 'to refill');
      if (wire.status === 'wired') {
        return {
          status: 'fiat_pull_started',
          wiredCents: shortfallCents,
          transferId: wire.transferId,
        };
      }
      if (wire.status === 'contended') {
        return { status: 'contended' };
      }
      await deps.alert(
        `Rose could NOT pull fiat from Brex to refill the AgentCard org wallet: ${wire.error}. ` +
          `Org wallet is at $${(current.availableCents / 100).toFixed(2)}.`
      );
      return { status: 'halted', error: wire.error };
    }
    await deps.alert(
      `Rose Coinbase treasury float is too low to auto-refill the AgentCard org wallet: ` +
        `$${(plan.floatCents / 100).toFixed(2)} available, needs $${(plan.neededCents / 100).toFixed(2)}. ` +
        `Fund the treasury wallet to restore automatic top-ups.`
    );
    return {
      status: 'insufficient_float',
      neededCents: plan.neededCents,
      floatCents: plan.floatCents,
    };
  }

  const claim = await deps.store.claim({
    transferCents: plan.transferCents,
    availableCents: current.availableCents,
  });
  if (!claim.claimed) {
    // A claim held far longer than any real top-up means the holder died between `claim()` and
    // `recordSuccess`/`releaseClaim`. `claim()` never stale-clears that row by design, so the rail
    // stays halted until an operator deletes it — and the transfer catch block never runs, so no
    // alert would otherwise fire. Escalate to a warning (alertable) instead of an info line that
    // repeats silently forever.
    const heldMs =
      claim.heldSince === undefined ? undefined : Date.now() - claim.heldSince.getTime();
    if (heldMs !== undefined && heldMs > ORPHANED_CLAIM_ALERT_MS) {
      log.warn('AgentCard org-wallet top-up claim appears ORPHANED; rail is halted', {
        held_since: claim.heldSince?.toISOString(),
        held_ms: heldMs,
        remediation: `delete the ${TOPUP_OPERATION_TYPE} in-flight ToolSideEffect row to resume`,
      });
    } else {
      log.info('AgentCard org-wallet top-up already claimed; skipping', {
        held_since: claim.heldSince?.toISOString(),
      });
    }
    return { status: 'contended', ...(claim.heldSince ? { heldSince: claim.heldSince } : {}) };
  }
  if (!claim.claimId) {
    await deps.store.releaseClaim();
    return { status: 'halted', error: 'USDC claim has no idempotency key' };
  }

  // Re-read UNDER the claim. If we queued behind a concurrent top-up that already landed, the
  // wallet is now healthy and this send must not happen.
  //
  // The DAILY SPEND must be re-read here too. The pre-claim value is stale in a way the balance
  // re-read does not cover: a previous holder can complete inside our wait window (its
  // recordSuccess re-keys the row and frees the in-flight key), so we would re-plan against
  // dailySpentCents=0 and exceed the rolling 24h cap. The cap is a spend total, not a balance
  // check, so a healthier balance does not restore its bound.
  let confirmed: AgentCardOrgWallet;
  let confirmedDailySpentCents: number;
  try {
    confirmed = await readAgentCardOrgWallet(deps.callOrgTool);
    confirmedDailySpentCents = await deps.store.dailySpentCents();
  } catch (error) {
    await deps.store.releaseClaim();
    throw error;
  }
  // `inFlightCents` MUST be threaded here too. Without it the re-plan sizes `fiatShortfallCents`
  // against the FULL gap and wires money that is already on its way — the exact duplicate-deposit
  // the in-flight term exists to prevent, reintroduced at the second planning site.
  const replan = planOrgWalletTopUp({
    policy: deps.policy,
    wallet: confirmed,
    floatCents,
    dailySpentCents: confirmedDailySpentCents,
    inFlightCents,
  });
  if (replan.action !== 'transfer') {
    await deps.store.releaseClaim();
    log.info('AgentCard org-wallet recovered before top-up; releasing claim', {
      available_cents: confirmed.availableCents,
    });
    return replan.action === 'skip'
      ? { status: 'skipped', reason: replan.reason }
      : {
          status: 'insufficient_float',
          neededCents: replan.neededCents,
          floatCents: replan.floatCents,
        };
  }

  const depositAddress =
    confirmed.depositAddress ?? process.env.AGENTCARD_ORG_WALLET_DEPOSIT_ADDRESS?.trim();
  if (depositAddress === undefined || depositAddress === '') {
    await deps.store.releaseClaim();
    throw new Error('AgentCard org wallet has no deposit address; cannot auto top-up');
  }

  try {
    const { transactionHash } = await deps.treasury.transferUsdcCents({
      toAddress: depositAddress,
      cents: replan.transferCents,
      // MUST be a bare UUID — Coinbase rejects prefixed keys outright. The claim row id is
      // already a uuid and is stable per top-up episode, so a replay reuses the same key.
      idempotencyKey: claim.claimId,
    });
    await deps.store.recordSuccess({ transactionHash, transferCents: replan.transferCents });
    log.info('AgentCard org wallet topped up', {
      transaction_hash: transactionHash,
      transfer_cents: replan.transferCents,
      available_before_cents: confirmed.availableCents,
    });
    // The USDC we held may not have covered the whole gap. When the bank rail is deliberately
    // re-enabled, wire the remainder in this detached purchase trigger and await its result.
    if (replan.fiatShortfallCents > 0) {
      if (strandedUsdCents > 0) {
        await deps
          .alert(
            `Rose AgentCard top-up remains $${(replan.fiatShortfallCents / 100).toFixed(2)} short; ` +
              `$${(strandedUsdCents / 100).toFixed(2)} USD is unconverted in Coinbase. No new wire was sent.`
          )
          .catch(() => undefined);
      } else {
        await topUpFiatShortfall(deps, replan.fiatShortfallCents);
      }
    }
    return { status: 'transferred', transferCents: replan.transferCents, transactionHash };
  } catch (error) {
    // Claim is intentionally retained — see invariant 4. Auto top-up stays halted until a human
    // confirms onchain whether the send landed and clears the row.
    const message = error instanceof Error ? error.message : String(error);
    log.error('AgentCard org-wallet top-up failed; rail HALTED pending manual review', {
      error: message,
      transfer_cents: replan.transferCents,
      deposit_address: depositAddress,
    });
    await deps.alert(
      `Rose auto top-up FAILED and is halted: ${message}. Verify onchain whether ` +
        `$${(replan.transferCents / 100).toFixed(2)} USDC reached ${depositAddress}, then clear ` +
        `the '${INFLIGHT_OPERATION_KEY}' ToolSideEffect row to re-arm.`
    );
    return { status: 'halted', error: message };
  }
}

function createAlerter(): (message: string) => Promise<void> {
  const phone = process.env.AGENTCARD_ORG_LOW_BALANCE_ALERT_PHONE?.trim();
  return async (message: string) => {
    if (phone === undefined || phone === '') {
      log.warn('Top-up alert suppressed (no AGENTCARD_ORG_LOW_BALANCE_ALERT_PHONE)', { message });
      return;
    }
    const sent = await sendSmsProvider(phone, message);
    if (!sent.success) log.error('Failed to send top-up alert SMS', { error: sent.error });
  };
}

/**
 * Fire-and-forget trigger for the purchase path.
 *
 * Every failure is swallowed: a treasury problem must never turn a successful card mint into a
 * failed purchase. The pre-existing low-balance SMS monitor remains the backstop.
 */
export function triggerOrgWalletTopUp(context: { purchaseId: string; debitedCents: number }): void {
  void (async () => {
    try {
      const policy = policyFromEnvironment();
      if (!policy.enabled) return;
      const config = loadCoinbaseTreasuryConfig();
      if (config === undefined) {
        log.warn('Auto top-up enabled but Coinbase treasury is not configured');
        return;
      }
      const result = await runOrgWalletTopUp({
        policy,
        treasury: createCoinbaseTreasury(config),
        callOrgTool: callOrgToolProvider,
        store: createOrgWalletTopUpStore(),
        alert: createAlerter(),
        // The bank leg is currently hard-disabled after broken Brex transfers. A dry float alerts.
        ...(resolveFiatSource() ?? {}),
      });
      log.info('AgentCard org-wallet auto top-up evaluated', {
        purchase_id: context.purchaseId,
        debited_cents: context.debitedCents,
        status: result.status,
      });
    } catch (error) {
      log.error('AgentCard org-wallet auto top-up errored', {
        purchase_id: context.purchaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
