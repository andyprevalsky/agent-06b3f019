#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for the AgentCard org-wallet auto top-up rail.
 *
 * These assert the MONEY-SAFETY invariants documented in `org-wallet-topup.ts`. The rail moves
 * real USDC, so every branch that could double-send, over-send, or send from the wrong environment
 * is pinned here:
 *
 *   1. disabled by default                      → no transfer without an explicit opt-in
 *   2. sandbox org wallets are never funded      → live USDC cannot reach a test wallet
 *   3. clamping (need / max / daily cap / float) → a transfer never exceeds ANY single bound
 *   4. single-flight                             → a contended claim never sends
 *   5. re-read under claim                       → a concurrent top-up that landed cancels the send
 *   6. halt-on-ambiguous-failure                 → a possibly-broadcast send RETAINS the claim
 *   7. atomic-unit conversion                    → cents ⇄ atomic is exact, floors, honors decimals
 */

import assert from 'node:assert';
import {
  planOrgWalletTopUp,
  runOrgWalletTopUp,
  type OrgWalletTopUpPolicy,
  type OrgWalletTopUpStore,
  type TopUpResult,
} from '../../providers/agentcard/org-wallet-topup';
import { centsToDecimal, decimalToCents } from '../../providers/coinbase/treasury';

const BASE_POLICY: OrgWalletTopUpPolicy = {
  enabled: true,
  thresholdCents: 25_000,
  targetCents: 50_000,
  minTransferCents: 1_000,
  maxTransferCents: 50_000,
  dailyCapCents: 200_000,
};

const failures: string[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
}

function wallet(availableCents: number, livemode = true) {
  return { livemode, availableCents };
}

// ── 1-3. Pure planning ─────────────────────────────────────────────────────────────────────────

async function testPlanning(): Promise<void> {
  console.log('\nplanOrgWalletTopUp');

  await check('disabled policy never transfers', () => {
    const plan = planOrgWalletTopUp({
      policy: { ...BASE_POLICY, enabled: false },
      wallet: wallet(0),
      floatCents: 100_000,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'disabled' });
  });

  await check('sandbox wallet is never topped up with live funds', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: wallet(0, false),
      floatCents: 100_000,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'sandbox_wallet' });
  });

  await check('at threshold exactly is healthy (no transfer)', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: wallet(25_000),
      floatCents: 100_000,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'above_threshold' });
  });

  await check('below threshold tops up to target exactly ($240 → transfer $260)', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: wallet(24_000),
      floatCents: 100_000,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'transfer', transferCents: 26_000 });
  });

  await check('transfer is clamped by per-transfer max', () => {
    const plan = planOrgWalletTopUp({
      policy: { ...BASE_POLICY, maxTransferCents: 5_000 },
      wallet: wallet(0),
      floatCents: 100_000,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'transfer', transferCents: 5_000 });
  });

  await check('transfer is clamped by remaining daily cap', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: wallet(0),
      floatCents: 100_000,
      dailySpentCents: 197_000,
    });
    assert.deepStrictEqual(plan, { action: 'transfer', transferCents: 3_000 });
  });

  await check('exhausted daily cap skips entirely', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: wallet(0),
      floatCents: 100_000,
      dailySpentCents: 200_000,
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'daily_cap_reached' });
  });

  await check('transfer is clamped by available treasury float', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: wallet(0),
      floatCents: 12_345,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'transfer', transferCents: 12_345 });
  });

  await check('dry float reports insufficient_float (actionable), not a silent skip', () => {
    const plan = planOrgWalletTopUp({
      policy: BASE_POLICY,
      wallet: wallet(0),
      floatCents: 500,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, {
      action: 'insufficient_float',
      neededCents: 50_000,
      floatCents: 500,
    });
  });

  await check('sub-minimum gap is a benign skip when float is healthy', () => {
    const plan = planOrgWalletTopUp({
      policy: { ...BASE_POLICY, thresholdCents: 50_000, targetCents: 50_500 },
      wallet: wallet(50_000 - 1),
      floatCents: 100_000,
      dailySpentCents: 0,
    });
    assert.deepStrictEqual(plan, { action: 'skip', reason: 'below_min_transfer' });
  });

  await check('no clamp ordering can exceed any single bound', () => {
    // Exhaustive small-space sweep: the planned transfer must respect every bound simultaneously.
    for (const available of [0, 1_000, 24_999]) {
      for (const max of [2_000, 50_000]) {
        for (const spent of [0, 199_000]) {
          for (const float of [1_500, 999_999]) {
            const policy = { ...BASE_POLICY, maxTransferCents: max };
            const plan = planOrgWalletTopUp({
              policy,
              wallet: wallet(available),
              floatCents: float,
              dailySpentCents: spent,
            });
            if (plan.action !== 'transfer') continue;
            const t = plan.transferCents;
            assert.ok(t <= policy.targetCents - available, `exceeded need (${t})`);
            assert.ok(t <= max, `exceeded max (${t})`);
            assert.ok(t <= policy.dailyCapCents - spent, `exceeded daily cap (${t})`);
            assert.ok(t <= float, `exceeded float (${t})`);
            assert.ok(t >= policy.minTransferCents, `below min (${t})`);
          }
        }
      }
    }
  });
}

// ── 4-6. Orchestration ─────────────────────────────────────────────────────────────────────────

interface Recorded {
  transfers: Array<{ toAddress: string; cents: number; idempotencyKey: string }>;
  successes: Array<{ transactionHash: string; transferCents: number }>;
  releases: number;
  alerts: string[];
}

function harness(options: {
  availableCentsSequence: number[];
  floatCents?: number;
  claimed?: boolean;
  transferImpl?: () => Promise<{ transactionHash: string }>;
}): { deps: Parameters<typeof runOrgWalletTopUp>[0]; recorded: Recorded } {
  const recorded: Recorded = { transfers: [], successes: [], releases: 0, alerts: [] };
  let walletReadIndex = 0;

  const store: OrgWalletTopUpStore = {
    async dailySpentCents() {
      return 0;
    },
    async claim() {
      return options.claimed === false
        ? { claimed: false, heldSince: new Date(0), claimId: undefined }
        : { claimed: true, claimId: 'claim-row-1' };
    },
    async recordSuccess(params) {
      recorded.successes.push(params);
    },
    async releaseClaim() {
      recorded.releases += 1;
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
        async transferUsdcCents(params) {
          recorded.transfers.push(params);
          if (options.transferImpl) return options.transferImpl();
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
              livemode: true,
              balance_cents: available,
              committed_cents: 0,
              available_cents: available,
              deposit_address: '0x2222222222222222222222222222222222222222',
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

async function testOrchestration(): Promise<void> {
  console.log('\nrunOrgWalletTopUp');

  await check(
    'happy path transfers to the deposit address and records the ledger row',
    async () => {
      const { deps, recorded } = harness({ availableCentsSequence: [10_000, 10_000] });
      const result = await runOrgWalletTopUp(deps);
      assert.deepStrictEqual(result, {
        status: 'transferred',
        transferCents: 40_000,
        transactionHash: '0xdeadbeef',
      });
      assert.deepStrictEqual(recorded.transfers, [
        {
          toAddress: '0x2222222222222222222222222222222222222222',
          cents: 40_000,
          // Derived from the claim row id so a replayed send dedups provider-side.
          idempotencyKey: 'claim-row-1',
        },
      ]);
      assert.deepStrictEqual(recorded.successes, [
        { transactionHash: '0xdeadbeef', transferCents: 40_000 },
      ]);
      assert.strictEqual(recorded.releases, 0);
    }
  );

  await check('contended claim never sends (single-flight)', async () => {
    const { deps, recorded } = harness({ availableCentsSequence: [10_000], claimed: false });
    const result = await runOrgWalletTopUp(deps);
    assert.strictEqual(result.status, 'contended');
    assert.strictEqual(recorded.transfers.length, 0, 'must not transfer while contended');
  });

  await check(
    're-read under claim cancels a send that a concurrent top-up already covered',
    async () => {
      // First read sees $100 (needs top-up); by the time we hold the claim it reads $500.
      const { deps, recorded } = harness({ availableCentsSequence: [10_000, 50_000] });
      const result = await runOrgWalletTopUp(deps);
      assert.deepStrictEqual(result, { status: 'skipped', reason: 'above_threshold' });
      assert.strictEqual(recorded.transfers.length, 0, 'must not double-send');
      assert.strictEqual(recorded.releases, 1, 'claim must be released so the rail stays armed');
    }
  );

  await check(
    'ambiguous transfer failure HALTS and RETAINS the claim (no double-spend retry)',
    async () => {
      const { deps, recorded } = harness({
        availableCentsSequence: [10_000, 10_000],
        transferImpl: async () => {
          throw new Error('socket hang up');
        },
      });
      const result = await runOrgWalletTopUp(deps);
      assert.strictEqual(result.status, 'halted');
      assert.strictEqual(
        recorded.releases,
        0,
        'claim MUST be retained after a possibly-sent failure'
      );
      assert.strictEqual(recorded.successes.length, 0);
      assert.ok(
        recorded.alerts.some((a) => a.includes('halted')),
        'a halt must alert a human'
      );
    }
  );

  await check('dry treasury float alerts and does not claim', async () => {
    const { deps, recorded } = harness({ availableCentsSequence: [10_000], floatCents: 100 });
    const result = await runOrgWalletTopUp(deps);
    assert.strictEqual(result.status, 'insufficient_float');
    assert.strictEqual(recorded.transfers.length, 0);
    assert.ok(recorded.alerts.some((a) => a.includes('float is too low')));
  });

  await check('sandbox org wallet short-circuits before any treasury I/O', async () => {
    const { deps, recorded } = harness({ availableCentsSequence: [0] });
    const sandboxDeps: typeof deps = {
      ...deps,
      async callOrgTool() {
        return {
          structuredContent: {
            wallet: {
              livemode: false,
              balance_cents: 0,
              committed_cents: 0,
              available_cents: 0,
            },
          },
        };
      },
    };
    const result: TopUpResult = await runOrgWalletTopUp(sandboxDeps);
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'sandbox_wallet' });
    assert.strictEqual(recorded.transfers.length, 0);
  });
}

// ── 7. Decimal ⇄ cents conversion ──────────────────────────────────────────────────────────────

async function testSendGuards(): Promise<void> {
  console.log('\nCoinbase send guards (learned from a real failed send)');
  const { createCoinbaseTreasury } = await import('../../providers/coinbase/treasury');
  const treasury = createCoinbaseTreasury({
    apiKeyId: 'k',
    apiKeySecret: Buffer.alloc(64).toString('base64'),
    network: 'base',
  });
  const to = '0x8b5C7a040b32393acc8456476eFb5795A2C684ba';

  await check('a prefixed idem is rejected LOCALLY, not as a provider 400', async () => {
    // Live failure: idem "manual-send:1787337116132" -> 400 "Invalid input parameter. Param: Idem".
    // The rail used "rose-topup:<uuid>", so EVERY automated top-up would have died at the send.
    await assert.rejects(
      () => treasury.transferUsdcCents({ toAddress: to, cents: 100, idempotencyKey: 'rose-topup:abc' }),
      /bare UUID/
    );
  });

  await check('a bare uuid idem passes validation', async () => {
    const { randomUUID } = await import('node:crypto');
    // Reaches the network layer (fails on fake creds), proving it got past local validation.
    await assert.rejects(
      () => treasury.transferUsdcCents({ toAddress: to, cents: 100, idempotencyKey: randomUUID() }),
      (e: Error) => !/bare UUID/.test(e.message)
    );
  });

  await check('sends below Coinbase 1 USDC minimum are refused locally', async () => {
    const { randomUUID } = await import('node:crypto');
    await assert.rejects(
      () => treasury.transferUsdcCents({ toAddress: to, cents: 99, idempotencyKey: randomUUID() }),
      /minimum|1 USDC/
    );
  });
}

async function testConversion(): Promise<void> {
  console.log('\nCoinbase decimal ⇄ cents conversion');

  await check('cents → decimal string Coinbase accepts', () => {
    assert.strictEqual(centsToDecimal(1), '0.01');
    assert.strictEqual(centsToDecimal(100), '1.00');
    assert.strictEqual(centsToDecimal(26_000), '260.00');
    assert.strictEqual(centsToDecimal(50_000), '500.00');
  });

  await check('decimal → cents floors (never over-reports spendable float)', () => {
    assert.strictEqual(decimalToCents('1.00'), 100);
    assert.strictEqual(decimalToCents('0.019999'), 1);
    assert.strictEqual(decimalToCents('0.009'), 0);
    assert.strictEqual(decimalToCents('123.456789'), 12_345);
  });

  await check('string math avoids float error (0.29 * 100 = 28.999… trap)', () => {
    // parseFloat('0.29') * 100 floors to 28. This must not.
    assert.strictEqual(decimalToCents('0.29'), 29);
    assert.strictEqual(decimalToCents('1.15'), 115);
    assert.strictEqual(decimalToCents('8.87'), 887);
  });

  await check('handles integers and single-digit fractions', () => {
    assert.strictEqual(decimalToCents('500'), 50_000);
    assert.strictEqual(decimalToCents('0.5'), 50);
    assert.strictEqual(decimalToCents('0'), 0);
  });

  await check('round-trip is lossless for whole cents', () => {
    for (const cents of [1, 7, 100, 25_000, 50_000, 199_999]) {
      assert.strictEqual(decimalToCents(centsToDecimal(cents)), cents);
    }
  });

  await check('garbage amounts are rejected, not silently coerced to 0', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', 'NaN']) {
      assert.throws(() => decimalToCents(bad), /unparseable/, `should reject "${bad}"`);
    }
  });
}

async function main(): Promise<void> {
  console.log('AgentCard org-wallet auto top-up');
  await testPlanning();
  await testOrchestration();
  await testSendGuards();
  await testConversion();

  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll org-wallet top-up tests passed.');
}

void main();
