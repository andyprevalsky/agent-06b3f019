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
 *  8. Idle cardholder residual is RECOVERED into the pool before any treasury spend. Unspent card
 *     value otherwise sits as one user's headroom where no other user can draw on it.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { sendSms as sendSmsProvider } from '../smsQueue';
import { createCoinbaseTreasury, type CoinbaseTreasury } from '../coinbase/treasury';
import { loadCoinbaseTreasuryConfig } from '../coinbase/config';
import { callOrgTool as callOrgToolProvider, type AgentCardOrgToolCaller } from './org-runtime';
import { recoverAllCardholderResiduals } from './fund-recovery';
import { extractAgentCardOrgWallet, type AgentCardOrgWallet } from './org-wallet-monitor';

const log = createLogger('AgentCardOrgWalletTopUp');

const INFLIGHT_OPERATION_KEY = 'agentcard-org-wallet-topup:inflight';
export const TOPUP_OPERATION_TYPE = 'AGENTCARD_ORG_WALLET_TOPUP';

const DEFAULT_THRESHOLD_CENTS = 25_000; // $250
const DEFAULT_TARGET_CENTS = 50_000; // $500
const DEFAULT_MIN_TRANSFER_CENTS = 1_000; // $10 — below this, gas is not worth it
const DEFAULT_MAX_TRANSFER_CENTS = 50_000; // $500 per transfer
const DEFAULT_DAILY_CAP_CENTS = 200_000; // $2,000 per rolling 24h
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a recovery may sit un-settled before we stop deferring the top-up on it. */
const RECOVERY_SETTLE_GRACE_MS = Number(
  process.env.AGENTCARD_RECOVERY_SETTLE_GRACE_MS ?? 15 * 60 * 1000
);

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
  | { action: 'transfer'; transferCents: number };

export type TopUpSkipReason =
  'disabled' | 'sandbox_wallet' | 'above_threshold' | 'daily_cap_reached' | 'below_min_transfer';

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
}): TopUpDecision {
  const { policy, wallet, floatCents, dailySpentCents } = params;

  if (!policy.enabled) return { action: 'skip', reason: 'disabled' };
  if (!wallet.livemode) return { action: 'skip', reason: 'sandbox_wallet' };
  if (wallet.availableCents >= policy.thresholdCents) {
    return { action: 'skip', reason: 'above_threshold' };
  }

  const need = policy.targetCents - wallet.availableCents;
  const dailyRemaining = policy.dailyCapCents - dailySpentCents;
  if (dailyRemaining <= 0) return { action: 'skip', reason: 'daily_cap_reached' };

  const wanted = Math.min(need, policy.maxTransferCents, dailyRemaining);
  const affordable = Math.min(wanted, floatCents);

  if (affordable < policy.minTransferCents) {
    // Distinguish "the float is dry" (actionable — refill Coinbase) from "the gap is tiny"
    // (benign — wait for the next mint to widen it).
    return floatCents < policy.minTransferCents
      ? { action: 'insufficient_float', neededCents: wanted, floatCents }
      : { action: 'skip', reason: 'below_min_transfer' };
  }
  return { action: 'transfer', transferCents: affordable };
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
  };
}

export type TopUpResult =
  | { status: 'skipped'; reason: TopUpSkipReason }
  | { status: 'not_configured' }
  | { status: 'contended'; heldSince?: Date }
  | { status: 'recovered'; recoveredCents: number; availableCents: number }
  | { status: 'recovery_pending'; pendingCents: number }
  | { status: 'insufficient_float'; neededCents: number; floatCents: number }
  | { status: 'transferred'; transferCents: number; transactionHash: string }
  | { status: 'halted'; error: string };

interface TopUpDependencies {
  policy: OrgWalletTopUpPolicy;
  treasury: CoinbaseTreasury;
  callOrgTool: AgentCardOrgToolCaller;
  store: OrgWalletTopUpStore;
  alert: (message: string) => Promise<void>;
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

  const wallet = extractAgentCardOrgWallet(await deps.callOrgTool('get_company_wallet', {}));
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
    const emptySweep: { settledCents: number; pendingCents: number; oldestPendingAgeMs?: number } = {
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
      current = extractAgentCardOrgWallet(await deps.callOrgTool('get_company_wallet', {}));
      if (current.availableCents >= deps.policy.thresholdCents) {
        log.info('Residual recovery alone restored the org wallet; no treasury spend needed', {
          recovered_cents: recoveredCents,
          available_cents: current.availableCents,
        });
        return { status: 'recovered', recoveredCents, availableCents: current.availableCents };
      }
    }
  }

  const [floatCents, dailySpentCents] = await Promise.all([
    deps.treasury.getUsdcBalanceCents(),
    deps.store.dailySpentCents(),
  ]);
  const plan = planOrgWalletTopUp({
    policy: deps.policy,
    wallet: current,
    floatCents,
    dailySpentCents,
  });

  if (plan.action === 'skip') return { status: 'skipped', reason: plan.reason };
  if (plan.action === 'insufficient_float') {
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
    log.info('AgentCard org-wallet top-up already claimed; skipping', {
      held_since: claim.heldSince?.toISOString(),
    });
    return { status: 'contended', ...(claim.heldSince ? { heldSince: claim.heldSince } : {}) };
  }

  // Re-read UNDER the claim. If we queued behind a concurrent top-up that already landed, the
  // wallet is now healthy and this send must not happen.
  let confirmed: AgentCardOrgWallet;
  try {
    confirmed = extractAgentCardOrgWallet(await deps.callOrgTool('get_company_wallet', {}));
  } catch (error) {
    await deps.store.releaseClaim();
    throw error;
  }
  const replan = planOrgWalletTopUp({
    policy: deps.policy,
    wallet: confirmed,
    floatCents,
    dailySpentCents,
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
      idempotencyKey: claim.claimId ?? randomUUID(),
    });
    await deps.store.recordSuccess({ transactionHash, transferCents: replan.transferCents });
    log.info('AgentCard org wallet topped up', {
      transaction_hash: transactionHash,
      transfer_cents: replan.transferCents,
      available_before_cents: confirmed.availableCents,
    });
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
        recoverResidual: () => recoverAllCardholderResiduals(callOrgToolProvider),
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
