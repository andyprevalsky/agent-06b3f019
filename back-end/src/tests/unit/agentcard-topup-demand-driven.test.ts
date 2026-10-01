#!/usr/bin/env tsx

/**
 * Unit tests for the DEMAND-DRIVEN treasury top-up.
 *
 * The rail used to have two independent triggers: a mint-time check for the USDC leg, and an
 * hourly cron that kept a standing Coinbase buffer for the fiat leg. The cron is removed; card
 * issuance drives the USDC check. The bank leg remains hard disabled after the provider incident.
 *
 * In-flight accounting is what makes that safe. These tests pin the two properties it buys:
 *   - we only ever request the DIFFERENCE between target and (held + inbound)
 *   - repeat mints during settlement converge instead of stacking duplicate deposits
 *
 * They also pin the bank leg's behavior for an injected test source, so it can be reviewed before
 * any deliberate re-enable.
 */

import assert from 'node:assert';
import {
  planOrgWalletTopUp,
  runOrgWalletTopUp,
  type OrgWalletTopUpPolicy,
  type OrgWalletTopUpStore,
} from '../../providers/agentcard/org-wallet-topup';

const report = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const reportError = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const BASE_POLICY: OrgWalletTopUpPolicy = {
  enabled: true,
  thresholdCents: 25_000, // $250 trigger
  targetCents: 50_000, // $500 target
  minTransferCents: 1_000,
  maxTransferCents: 50_000,
  dailyCapCents: 200_000,
};

const failures: string[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      report(`  \u2713 ${name}`);
    } catch (error) {
      failures.push(name);
      reportError(`  \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
}

interface Recorded {
  transfers: Array<{ toAddress: string; cents: number; idempotencyKey: string }>;
  successes: Array<{ transactionHash: string; transferCents: number }>;
  releases: number;
  alerts: string[];
}

/** Minimal dependency harness: one wallet balance, a scripted float, no real I/O. */
function harness(options: {
  availableCentsSequence: number[];
  floatCents?: number;
  unconvertedUsdCents?: number;
}): { deps: Parameters<typeof runOrgWalletTopUp>[0]; recorded: Recorded } {
  const recorded: Recorded = { transfers: [], successes: [], releases: 0, alerts: [] };
  let walletReadIndex = 0;
  const store: OrgWalletTopUpStore = {
    async dailySpentCents() {
      return 0;
    },
    async claim() {
      return { claimed: true, claimId: 'claim-row-1' };
    },
    async recordSuccess(params) {
      recorded.successes.push(params);
    },
    async releaseClaim() {
      recorded.releases += 1;
    },
    async claimFiatPull() {
      return { claimed: true, claimId: 'fiat-claim-1' };
    },
    async recordFiatSuccess() {
      /* no-op */
    },
    async releaseFiatClaim() {
      /* no-op */
    },
  };
  return {
    recorded,
    deps: {
      policy: BASE_POLICY,
      store,
      treasury: {
        async getUsdcBalanceCents() {
          return options.floatCents ?? 100_000;
        },
        async getUsdBalanceCents() {
          return options.unconvertedUsdCents ?? 0;
        },
        async transferUsdcCents(params) {
          recorded.transfers.push(params);
          return { transactionHash: '0xdeadbeef' };
        },
      },
      async callOrgTool() {
        const available =
          options.availableCentsSequence[
            Math.min(walletReadIndex, options.availableCentsSequence.length - 1)
          ];
        walletReadIndex += 1;
        return {
          structuredContent: {
            wallet: {
              object: 'org_wallet',
              livemode: true,
              balance_cents: available,
              committed_cents: 0,
              available_cents: available,
              deposit_address: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
              stablecoin: 'usdc',
            },
          },
        };
      },
      async alert(message: string) {
        recorded.alerts.push(message);
      },
    },
  };
}

/**
 * In-flight accounting is what lets the org-wallet check be the ONLY trigger in the system.
 *
 * The fiat leg used to be an hourly cron maintaining a standing Coinbase buffer. Now every deposit
 * is driven by an actual card issuance, which means the same low balance is observed by every mint
 * during a wire's multi-hour settlement window. Subtracting money already on its way is the only
 * thing preventing those mints from stacking duplicate deposits.
 */
async function testInFlightAccounting(): Promise<void> {
  report('\nplanOrgWalletTopUp — in-flight accounting');

  // The canonical worked example: target $500, trigger $250. Wallet drops to $200 with $200
  // already inbound, so we ask for exactly the $100 difference — not the full $300 gap.
  await check('wallet $200 + $200 inbound against a $500 target requests exactly $100', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 20_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
      inFlightCents: 20_000,
    });
    assert.deepStrictEqual(plan, {
      action: 'transfer',
      transferCents: 10_000,
      fiatShortfallCents: 0,
    });
  });

  // Without in-flight the same state asks for the whole gap — this is the duplicate-deposit bug.
  await check('the same state WITHOUT in-flight would request the full $300 gap', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 20_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, {
      action: 'transfer',
      transferCents: 30_000,
      fiatShortfallCents: 0,
    });
  });

  await check('in-flight that already reaches target requests nothing', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 20_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
      inFlightCents: 30_000, // 20_000 + 30_000 === target
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'covered_by_inflight' });
  });

  await check('in-flight OVERSHOOTING target still requests nothing (never over-funds)', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 20_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
      inFlightCents: 500_000,
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'covered_by_inflight' });
  });

  // The TRIGGER must stay on the held balance. If in-flight suppressed the trigger, a wallet at
  // $200 with $200 inbound would look "healthy" at $400 and never top up — yet only $200 is
  // actually spendable, so the very next mint could fail for want of funds.
  await check('in-flight does NOT suppress the trigger, only shrinks the amount', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 20_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
      inFlightCents: 5_000,
    });
    assert.deepStrictEqual(plan, {
      action: 'transfer',
      transferCents: 25_000,
      fiatShortfallCents: 0,
    });
  });

  await check('a wallet above threshold is untouched regardless of in-flight', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 30_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
      inFlightCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'above_threshold' });
  });

  await check('a negative or absent in-flight reading is treated as zero', () => {
    const negative = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 20_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
      inFlightCents: -5_000,
    });
    assert.deepStrictEqual(negative, {
      action: 'transfer',
      transferCents: 30_000,
      fiatShortfallCents: 0,
    });
  });

  // In-flight shrinks the ask, so it can land under the minimum. That is a benign skip, not a
  // dry-float alert: money is already on the way.
  await check('in-flight shrinking the ask below the minimum is a benign skip', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: { livemode: true, availableCents: 20_000 },
      floatCents: 1_000_000,
      dailySpentCents: 0,
      inFlightCents: 29_500, // leaves a $5 ask against a $10 minimum
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'below_min_transfer' });
  });

  // Repeated mints during one settlement window must converge, never stack.
  await check('successive mints during settlement converge instead of stacking', () => {
    let inFlight = 0;
    const asks: number[] = [];
    for (let mint = 0; mint < 5; mint += 1) {
      const plan = planOrgWalletTopUp({
        policy: BASE_POLICY,
        wallet: { livemode: true, availableCents: 20_000 },
        floatCents: 1_000_000,
        dailySpentCents: 0,
        inFlightCents: inFlight,
      });
      if (plan.action !== 'transfer') break;
      asks.push(plan.transferCents);
      inFlight += plan.transferCents; // the deposit we just requested is now in flight
    }
    assert.deepStrictEqual(asks, [30_000], 'only the FIRST mint should request a deposit');
    assert.strictEqual(inFlight, 30_000, 'total requested must equal the single gap to target');
  });
}

/**
 * The fiat leg is now demand-driven: a dry USDC float pulls from Brex during the same mint-time
 * check, instead of an hourly cron maintaining a standing Coinbase buffer.
 */
async function testOnDemandFiatPull(): Promise<void> {
  report('\nrunOrgWalletTopUp — on-demand fiat leg');

  await check('a dry float wires the SHORTFALL from Brex, not the whole gap', async () => {
    const wires: Array<{ cents: number; idempotencyKey: string }> = [];
    const { deps, recorded } = harness({
      availableCentsSequence: [20_000],
      floatCents: 5_000, // $50 USDC on hand against a $300 gap
    });
    const result = await runOrgWalletTopUp({
      ...deps,
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase(params) {
          wires.push(params);
          return { transferId: 'dptx_test' };
        },
      },
    });
    // The $50 we hold is sent immediately AND the missing $250 is wired: a float-limited send
    // must never silently under-fund the pool.
    assert.strictEqual(result.status, 'transferred');
    assert.strictEqual(recorded.transfers.length, 1, 'sends the liquid USDC now');
    assert.strictEqual(wires.length, 1, 'exactly one wire for the remainder');
    assert.strictEqual(wires[0].cents, 25_000, 'wires the $250 the float could not cover');
    assert.match(recorded.alerts.join(' '), /convert/i, 'operator is told about the manual step');
  });

  await check('a pending Brex wire suppresses a second wire for the same gap', async () => {
    const wires: Array<{ cents: number }> = [];
    const { deps } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    const result = await runOrgWalletTopUp({
      ...deps,
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 30_000; // the full gap is already wired and settling
        },
        async wireToCoinbase(params) {
          wires.push(params);
          return { transferId: 'dptx_should_not_happen' };
        },
      },
    });
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(wires.length, 0, 'must NOT stack a second wire while one is in flight');
  });

  await check(
    'documented wallet shape confirms sandbox through whoami before any money moves',
    async () => {
      const { deps, recorded } = harness({ availableCentsSequence: [20_000] });
      const calls: string[] = [];
      const result = await runOrgWalletTopUp({
        ...deps,
        async callOrgTool(name) {
          calls.push(name);
          if (name === 'whoami') return { structuredContent: { mode: 'sandbox' } };
          return {
            structuredContent: {
              wallet: {
                balance_cents: 20_000,
                committed_cents: 0,
                available_cents: 20_000,
                deposit_address: '0x8b5C7a040b32393acc8456476eFb5795A2C684ba',
              },
            },
          };
        },
      });
      assert.deepStrictEqual(result, { status: 'skipped', reason: 'sandbox_wallet' });
      assert.deepStrictEqual(calls, ['get_company_wallet', 'whoami']);
      assert.strictEqual(recorded.transfers.length, 0);
    }
  );

  await check('an unreadable Brex wire ledger cannot authorize another deposit', async () => {
    const { deps, recorded } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    let wires = 0;
    const result = await runOrgWalletTopUp({
      ...deps,
      fiatSource: {
        async pendingToCoinbaseCents() {
          throw new Error('Brex transfer list unavailable');
        },
        async wireToCoinbase() {
          wires += 1;
          return { transferId: 'duplicate' };
        },
      },
    });
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(wires, 0);
    assert.match(recorded.alerts.join(' '), /Brex transfer list unavailable/);
  });

  await check('an unreadable Coinbase USD balance cannot authorize a Brex wire', async () => {
    const { deps } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    let wires = 0;
    const result = await runOrgWalletTopUp({
      ...deps,
      treasury: {
        ...deps.treasury,
        async getUsdBalanceCents() {
          throw new Error('Coinbase USD balance unavailable');
        },
      },
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase() {
          wires += 1;
          return { transferId: 'duplicate' };
        },
      },
    });
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(wires, 0);
  });

  // REGRESSION: unconverted USD must NOT be treated as inbound money.
  // USD -> USDC is not automatable on this account, so that cash is stuck, not on its way.
  // Counting it as in-flight made planOrgWalletTopUp return `covered_by_inflight` on every mint
  // once the stranded balance exceeded the gap, which silently stopped the rail with no alert
  // while the float stayed dry. A $490 balance sat exactly like that for two weeks.
  await check(
    'stranded USD blocks a NEW wire but still alerts (never silently stops)',
    async () => {
      const wires: Array<{ cents: number }> = [];
      const { deps, recorded } = harness({
        availableCentsSequence: [20_000],
        floatCents: 0,
        unconvertedUsdCents: 30_000, // landed, awaiting manual conversion
      });
      const result = await runOrgWalletTopUp({
        ...deps,
        fiatSource: {
          async pendingToCoinbaseCents() {
            return 0;
          },
          async wireToCoinbase(params) {
            wires.push(params);
            return { transferId: 'dptx_should_not_happen' };
          },
        },
      });
      // Not `skipped`: the rail is genuinely blocked and the operator must hear about it.
      assert.strictEqual(result.status, 'insufficient_float');
      assert.strictEqual(wires.length, 0, 'never pile fresh fiat on top of stranded cash');
      const alerts = recorded.alerts.join(' ');
      assert.match(alerts, /UNCONVERTED/i, 'alert must name the actual blocker');
      assert.match(alerts, /coinbase\.com\/assets/, 'alert must carry the exact action');
    }
  );

  await check('without a fiat source a dry float still only alerts (unchanged)', async () => {
    const { deps, recorded } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    const result = await runOrgWalletTopUp(deps);
    assert.strictEqual(result.status, 'insufficient_float');
    assert.ok(recorded.alerts.length > 0);
  });

  await check('a failed Brex wire halts loudly instead of failing silently', async () => {
    const { deps, recorded } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    const result = await runOrgWalletTopUp({
      ...deps,
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase() {
          throw new Error('brex_rail_mismatch');
        },
      },
    });
    assert.strictEqual(result.status, 'halted');
    assert.match(recorded.alerts.join(' '), /could NOT pull fiat/i);
  });
}

/**
 * The bank leg is irreversible, so it gets its own single-flight claim rather than trusting the
 * in-flight ESTIMATE. In-flight can be stale, mis-paged, or not yet reflect a wire sent seconds
 * ago; without a claim, two concurrent card issuances each compute the same shortfall and each
 * wire it.
 */
async function testFiatIdempotency(): Promise<void> {
  report('\nfiat leg idempotency');

  await check('a contended fiat claim sends NO wire', async () => {
    const wires: Array<{ cents: number }> = [];
    const { deps } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    const result = await runOrgWalletTopUp({
      ...deps,
      store: {
        ...deps.store,
        async claimFiatPull() {
          return { claimed: false, heldSince: new Date(0) };
        },
      },
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase(params) {
          wires.push(params);
          return { transferId: 'dptx_duplicate' };
        },
      },
    });
    assert.strictEqual(result.status, 'contended');
    assert.strictEqual(wires.length, 0, 'a held claim must prevent a duplicate bank wire');
  });

  await check('the wire idempotency key is the claim id, never a fresh uuid', async () => {
    const wires: Array<{ cents: number; idempotencyKey: string }> = [];
    const { deps } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    await runOrgWalletTopUp({
      ...deps,
      store: {
        ...deps.store,
        async claimFiatPull() {
          return { claimed: true, claimId: 'fiat-claim-abc' };
        },
      },
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase(params) {
          wires.push(params);
          return { transferId: 'dptx_ok' };
        },
      },
    });
    assert.strictEqual(wires.length, 1);
    // A random key per attempt defeats Brex's own dedup, so a retry would wire twice.
    assert.strictEqual(wires[0].idempotencyKey, 'fiat-claim-abc');
  });

  await check('an AMBIGUOUS wire failure RETAINS the claim (no duplicate retry)', async () => {
    let released = 0;
    const { deps } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    const result = await runOrgWalletTopUp({
      ...deps,
      store: {
        ...deps.store,
        async releaseFiatClaim() {
          released += 1;
        },
      },
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase() {
          const error = Object.assign(new Error('gateway timeout'), { possiblySent: true });
          throw error;
        },
      },
    });
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(released, 0, 'a possibly-sent wire must NOT free the claim');
  });

  await check('a ledger failure after Brex accepted the wire RETAINS the claim', async () => {
    let released = 0;
    const { deps } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    const result = await runOrgWalletTopUp({
      ...deps,
      store: {
        ...deps.store,
        async recordFiatSuccess() {
          throw new Error('ledger unavailable');
        },
        async releaseFiatClaim() {
          released += 1;
        },
      },
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase() {
          return { transferId: 'dptx_accepted' };
        },
      },
    });
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(released, 0);
  });

  await check('a definitively-failed wire RELEASES the claim for a later retry', async () => {
    let released = 0;
    const { deps } = harness({ availableCentsSequence: [20_000], floatCents: 0 });
    const result = await runOrgWalletTopUp({
      ...deps,
      store: {
        ...deps.store,
        async releaseFiatClaim() {
          released += 1;
        },
      },
      fiatSource: {
        async pendingToCoinbaseCents() {
          return 0;
        },
        async wireToCoinbase() {
          throw Object.assign(new Error('brex_rail_mismatch'), { possiblySent: false });
        },
      },
    });
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(released, 1, 'a rejected wire must free the claim');
  });
}

async function main(): Promise<void> {
  report('Demand-driven treasury top-up (in-flight accounting + on-demand fiat leg)');
  await testInFlightAccounting();
  await testOnDemandFiatPull();
  await testFiatIdempotency();
  if (failures.length > 0) {
    reportError(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  report('\nAll demand-driven top-up tests passed.');
}

void main();
