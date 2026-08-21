/**
 * Replenish the Coinbase USDC float from Brex (the slow fiat leg).
 *
 * Runs on cron, NOT on the purchase path: an ACH transfer settles in 1-3 business days, so this
 * loop keeps the float stocked over time while `org-wallet-topup.ts` does the second-scale refill
 * of the org wallet from that float.
 *
 * ── Safety invariants ──────────────────────────────────────────────────────────────────────────
 *  1. AT MOST ONE transfer in flight per settlement window. Keyed on a day bucket, because an ACH
 *     in flight is invisible in the Coinbase balance for days — without this, every cron tick
 *     would see a still-low float and stack duplicate transfers.
 *  2. Brex `Idempotency-Key` on every POST, so a retried request is de-duplicated provider-side.
 *  3. Bounded by a per-transfer max and by Brex's own available balance.
 *  4. Disabled by default, and inert until BREX_COINBASE_COUNTERPARTY_ID is configured.
 */

import { prisma } from '../database';
import { createLogger } from '../logger';
import { sendSms as sendSmsProvider } from '../smsQueue';
import { createCoinbaseTreasury, type CoinbaseTreasury } from '../coinbase/treasury';
import { loadCoinbaseTreasuryConfig } from '../coinbase/config';
import { createBrexTreasury, loadBrexConfig, type BrexTreasury } from './treasury';

const log = createLogger('CoinbaseFloatReplenish');

export const REPLENISH_OPERATION_TYPE = 'COINBASE_FLOAT_REPLENISH';

const DEFAULT_FLOOR_CENTS = 50_000; // $500 — below this, pull more fiat
const DEFAULT_TARGET_CENTS = 200_000; // $2,000 float
const DEFAULT_MIN_TRANSFER_CENTS = 10_000; // $100 — ACH fees make dust pointless
const DEFAULT_MAX_TRANSFER_CENTS = 500_000; // $5,000 per transfer

export interface FloatReplenishPolicy {
  enabled: boolean;
  floorCents: number;
  targetCents: number;
  minTransferCents: number;
  maxTransferCents: number;
}

export type FloatReplenishDecision =
  | { action: 'skip'; reason: 'disabled' | 'float_healthy' | 'below_min_transfer' }
  | { action: 'insufficient_brex_funds'; wantedCents: number; brexAvailableCents: number }
  | { action: 'transfer'; cents: number };

/** Pure planner — no I/O. */
export function planFloatReplenish(params: {
  policy: FloatReplenishPolicy;
  floatCents: number;
  brexAvailableCents: number;
}): FloatReplenishDecision {
  const { policy, floatCents, brexAvailableCents } = params;
  if (!policy.enabled) return { action: 'skip', reason: 'disabled' };
  if (floatCents >= policy.floorCents) return { action: 'skip', reason: 'float_healthy' };

  const wanted = Math.min(policy.targetCents - floatCents, policy.maxTransferCents);
  const affordable = Math.min(wanted, Math.max(0, brexAvailableCents));
  if (affordable < policy.minTransferCents) {
    return brexAvailableCents < policy.minTransferCents
      ? { action: 'insufficient_brex_funds', wantedCents: wanted, brexAvailableCents }
      : { action: 'skip', reason: 'below_min_transfer' };
  }
  return { action: 'transfer', cents: affordable };
}

export function floatReplenishPolicyFromEnvironment(): FloatReplenishPolicy {
  const read = (name: string, fallback: number): number => {
    const raw = process.env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer number of cents`);
    }
    return value;
  };
  const policy: FloatReplenishPolicy = {
    enabled: process.env.COINBASE_FLOAT_REPLENISH_ENABLED === '1',
    floorCents: read('COINBASE_FLOAT_FLOOR_CENTS', DEFAULT_FLOOR_CENTS),
    targetCents: read('COINBASE_FLOAT_TARGET_CENTS', DEFAULT_TARGET_CENTS),
    minTransferCents: read('COINBASE_FLOAT_MIN_TRANSFER_CENTS', DEFAULT_MIN_TRANSFER_CENTS),
    maxTransferCents: read('COINBASE_FLOAT_MAX_TRANSFER_CENTS', DEFAULT_MAX_TRANSFER_CENTS),
  };
  if (policy.targetCents <= policy.floorCents) {
    throw new Error('COINBASE_FLOAT_TARGET_CENTS must exceed COINBASE_FLOAT_FLOOR_CENTS');
  }
  return policy;
}

export interface FloatReplenishStore {
  /** Claim the settlement window. Returns false when a transfer is already in flight. */
  claimWindow(windowKey: string, cents: number): Promise<boolean>;
  recordSuccess(windowKey: string, transferId: string): Promise<void>;
  releaseWindow(windowKey: string): Promise<void>;
}

/** Day bucket. ACH settles in 1-3 days, so one transfer per day is the safe ceiling. */
/**
 * The one manual step in the whole rail, delivered as an actionable SMS.
 *
 * USD -> USDC cannot be automated on this Coinbase account (v3 `convert/quote` rejects the pair,
 * `buys`/`trades` 404, `USDC-USD` is not a tradeable product), so the money physically cannot move
 * without a human. An alert that just says "something is wrong" wastes that human's time — this
 * says exactly what to tap, so the step takes seconds rather than a re-investigation.
 */
export function unconvertedUsdSms(unconvertedUsdCents: number, floatCents: number): string {
  const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
  const url = process.env.COINBASE_CONVERT_URL?.trim() || 'https://www.coinbase.com/assets';
  return (
    `Rose treasury: ACTION NEEDED.\n` +
    `${usd(unconvertedUsdCents)} landed in Coinbase as USD but the USDC float is ${usd(floatCents)}. ` +
    `Agent card purchases stop when the org wallet drains.\n\n` +
    `Fix (~30s): ${url}\n` +
    `Assets > Cash (USD) > Convert > USDC > ${usd(unconvertedUsdCents)} > Confirm.\n\n` +
    `Coinbase cannot convert via API, so this step is manual. Nothing else is needed — ` +
    `the rail tops up the org wallet automatically once the balance is USDC.`
  );
}

export function settlementWindowKey(now: Date): string {
  return `coinbase-float-replenish:${now.toISOString().slice(0, 10)}`;
}

export function createFloatReplenishStore(): FloatReplenishStore {
  return {
    async claimWindow(windowKey, cents) {
      try {
        await prisma.toolSideEffect.create({
          data: {
            operationKey: windowKey,
            operationType: REPLENISH_OPERATION_TYPE,
            status: 'STARTED',
            request: { cents },
          },
        });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') return false;
        throw error;
      }
    },
    async recordSuccess(windowKey, transferId) {
      await prisma.toolSideEffect.updateMany({
        where: { operationKey: windowKey, status: 'STARTED' },
        data: { status: 'SUCCEEDED', externalId: transferId, response: { transferId } },
      });
    },
    async releaseWindow(windowKey) {
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: windowKey, status: 'STARTED' },
      });
    },
  };
}

export type FloatReplenishResult =
  | { status: 'skipped'; reason: string }
  | { status: 'not_configured'; missing: string }
  | { status: 'window_claimed' }
  | { status: 'insufficient_brex_funds'; wantedCents: number; brexAvailableCents: number }
  | { status: 'transferred'; cents: number; transferId: string }
  | { status: 'unconverted_usd'; unconvertedUsdCents: number; floatCents: number }
  | { status: 'halted'; error: string };

interface ReplenishDependencies {
  policy: FloatReplenishPolicy;
  coinbase: CoinbaseTreasury;
  brex: BrexTreasury;
  store: FloatReplenishStore;
  alert: (message: string) => Promise<void>;
  now: Date;
}

export async function runCoinbaseFloatReplenish(
  deps: ReplenishDependencies
): Promise<FloatReplenishResult> {
  if (!deps.policy.enabled) return { status: 'skipped', reason: 'disabled' };

  const [floatCents, brexAvailableCents, unconvertedUsdCents] = await Promise.all([
    deps.coinbase.getUsdcBalanceCents(),
    deps.brex.getAvailableCents(),
    deps.coinbase.getUsdBalanceCents(),
  ]);

  // Fiat that landed but was never converted is invisible to the rail: the float reads low while
  // the money is already at Coinbase, so this loop would wire MORE fiat on top of it. Surface it
  // and stop, rather than stacking another transfer against cash that just needs converting.
  if (unconvertedUsdCents >= deps.policy.minTransferCents && floatCents < deps.policy.floorCents) {
    await deps.alert(unconvertedUsdSms(unconvertedUsdCents, floatCents));
    log.warn('Unconverted USD detected; skipping fiat transfer', {
      unconverted_usd_cents: unconvertedUsdCents,
      float_cents: floatCents,
    });
    return { status: 'unconverted_usd', unconvertedUsdCents, floatCents };
  }
  const plan = planFloatReplenish({ policy: deps.policy, floatCents, brexAvailableCents });

  if (plan.action === 'skip') return { status: 'skipped', reason: plan.reason };
  if (plan.action === 'insufficient_brex_funds') {
    await deps.alert(
      `Rose Coinbase USDC float is $${(floatCents / 100).toFixed(2)} (floor ` +
        `$${(deps.policy.floorCents / 100).toFixed(2)}) and Brex only has ` +
        `$${(brexAvailableCents / 100).toFixed(2)} available. Card purchases will fail once the ` +
        `org wallet drains.`
    );
    return {
      status: 'insufficient_brex_funds',
      wantedCents: plan.wantedCents,
      brexAvailableCents,
    };
  }

  const windowKey = settlementWindowKey(deps.now);
  if (!(await deps.store.claimWindow(windowKey, plan.cents))) {
    log.info('Coinbase float replenish already in flight for this window', {
      window_key: windowKey,
    });
    return { status: 'window_claimed' };
  }

  try {
    const { transferId } = await deps.brex.transferToCoinbase({
      cents: plan.cents,
      idempotencyKey: windowKey,
      description: 'Rose agent card treasury funding',
    });
    await deps.store.recordSuccess(windowKey, transferId);
    log.info('Brex -> Coinbase replenishment initiated', {
      transfer_id: transferId,
      cents: plan.cents,
      float_before_cents: floatCents,
    });
    return { status: 'transferred', cents: plan.cents, transferId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const possiblySent = (error as { possiblySent?: boolean }).possiblySent === true;
    // A definitively-rejected transfer frees the window so the next tick can retry. An ambiguous
    // one keeps it, so we never stack a second ACH on top of one that may already be moving.
    if (!possiblySent) await deps.store.releaseWindow(windowKey);
    log.error('Brex -> Coinbase replenishment failed', {
      error: message,
      possibly_sent: possiblySent,
    });
    await deps.alert(`Rose Brex->Coinbase treasury transfer failed: ${message}`);
    return { status: 'halted', error: message };
  }
}

function createAlerter(): (message: string) => Promise<void> {
  const phone =
    process.env.COINBASE_TREASURY_ALERT_PHONE?.trim() ||
    process.env.AGENTCARD_ORG_LOW_BALANCE_ALERT_PHONE?.trim();
  return async (message: string) => {
    if (phone === undefined || phone === '') {
      log.warn('Float replenish alert suppressed (no alert phone configured)', { message });
      return;
    }
    const sent = await sendSmsProvider(phone, message);
    if (!sent.success) log.error('Failed to send float replenish alert', { error: sent.error });
  };
}

/** Cron entrypoint. Never throws — a treasury problem must not take down the cron loop. */
export async function runCoinbaseFloatReplenishJob(): Promise<FloatReplenishResult> {
  const policy = floatReplenishPolicyFromEnvironment();
  if (!policy.enabled) return { status: 'skipped', reason: 'disabled' };

  const coinbaseConfig = loadCoinbaseTreasuryConfig();
  if (coinbaseConfig === undefined) return { status: 'not_configured', missing: 'coinbase' };
  const brexConfig = loadBrexConfig();
  if (brexConfig === undefined) return { status: 'not_configured', missing: 'brex' };
  if (brexConfig.coinbaseCounterpartyId === undefined) {
    return { status: 'not_configured', missing: 'BREX_COINBASE_COUNTERPARTY_ID' };
  }

  return runCoinbaseFloatReplenish({
    policy,
    coinbase: createCoinbaseTreasury(coinbaseConfig),
    brex: createBrexTreasury(brexConfig),
    store: createFloatReplenishStore(),
    alert: createAlerter(),
    now: new Date(),
  });
}
