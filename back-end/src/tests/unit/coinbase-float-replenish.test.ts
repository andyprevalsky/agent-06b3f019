#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for the Brex → Coinbase fiat replenishment leg.
 *
 * The dangerous property here is DUPLICATE ACH STACKING: an in-flight ACH is invisible in the
 * Coinbase balance for 1-3 days, so a naive "float is low → send money" loop would fire a fresh
 * transfer on every tick until settlement. The settlement-window lock is what prevents that, and
 * it is the primary thing these tests pin.
 */

import assert from 'node:assert';
import {
  planFloatReplenish,
  runCoinbaseFloatReplenish,
  settlementWindowKey,
  unconvertedUsdSms,
  type FloatReplenishPolicy,
  type FloatReplenishStore,
} from '../../providers/brex/replenish';
import { railsAreCompatible } from '../../providers/brex/treasury';

const BASE_POLICY: FloatReplenishPolicy = {
  enabled: true,
  floorCents: 50_000, // $500
  targetCents: 200_000, // $2,000
  minTransferCents: 10_000, // $100
  maxTransferCents: 500_000, // $5,000
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

async function testPlanning(): Promise<void> {
  console.log('\nplanFloatReplenish');

  await check('disabled never transfers', () => {
    assert.deepStrictEqual(
      planFloatReplenish({
        policy: { ...BASE_POLICY, enabled: false },
        floatCents: 0,
        brexAvailableCents: 10_000_000,
      }),
      { action: 'skip', reason: 'disabled' }
    );
  });

  await check('healthy float is left alone', () => {
    assert.deepStrictEqual(
      planFloatReplenish({
        policy: BASE_POLICY,
        floatCents: 50_000,
        brexAvailableCents: 10_000_000,
      }),
      { action: 'skip', reason: 'float_healthy' }
    );
  });

  await check('low float pulls up to target', () => {
    assert.deepStrictEqual(
      planFloatReplenish({
        policy: BASE_POLICY,
        floatCents: 10_000,
        brexAvailableCents: 10_000_000,
      }),
      { action: 'transfer', cents: 190_000 }
    );
  });

  await check('clamped by per-transfer max', () => {
    assert.deepStrictEqual(
      planFloatReplenish({
        policy: { ...BASE_POLICY, maxTransferCents: 25_000 },
        floatCents: 0,
        brexAvailableCents: 10_000_000,
      }),
      { action: 'transfer', cents: 25_000 }
    );
  });

  await check('clamped by Brex available balance', () => {
    assert.deepStrictEqual(
      planFloatReplenish({ policy: BASE_POLICY, floatCents: 0, brexAvailableCents: 60_000 }),
      { action: 'transfer', cents: 60_000 }
    );
  });

  await check('dry Brex account is an actionable alert, not a silent skip', () => {
    assert.deepStrictEqual(
      planFloatReplenish({ policy: BASE_POLICY, floatCents: 0, brexAvailableCents: 500 }),
      { action: 'insufficient_brex_funds', wantedCents: 200_000, brexAvailableCents: 500 }
    );
  });

  await check('negative Brex available balance is treated as zero, never as a credit', () => {
    // Brex "Primary checking" really does report a negative available balance when holds exceed
    // the current balance. That must never be read as spendable.
    const plan = planFloatReplenish({
      policy: BASE_POLICY,
      floatCents: 0,
      brexAvailableCents: -41_209,
    });
    assert.strictEqual(plan.action, 'insufficient_brex_funds');
  });

  await check('settlement window key is a stable day bucket', () => {
    assert.strictEqual(
      settlementWindowKey(new Date('2026-08-05T01:23:45Z')),
      'coinbase-float-replenish:2026-08-05'
    );
    assert.strictEqual(
      settlementWindowKey(new Date('2026-08-05T23:59:59Z')),
      settlementWindowKey(new Date('2026-08-05T00:00:00Z'))
    );
  });
}

interface Recorded {
  transfers: Array<{ cents: number; idempotencyKey: string }>;
  successes: string[];
  releases: number;
  alerts: string[];
}

function harness(options: {
  floatCents: number;
  brexAvailableCents: number;
  unconvertedUsdCents?: number;
  claimed?: boolean;
  transferImpl?: () => Promise<{ transferId: string }>;
}): { deps: Parameters<typeof runCoinbaseFloatReplenish>[0]; recorded: Recorded } {
  const recorded: Recorded = { transfers: [], successes: [], releases: 0, alerts: [] };
  const store: FloatReplenishStore = {
    async claimWindow() {
      return options.claimed !== false;
    },
    async recordSuccess(_windowKey, transferId) {
      recorded.successes.push(transferId);
    },
    async releaseWindow() {
      recorded.releases += 1;
    },
  };
  return {
    recorded,
    deps: {
      policy: BASE_POLICY,
      store,
      now: new Date('2026-08-05T12:00:00Z'),
      coinbase: {
        async getUsdcBalanceCents() {
          return options.floatCents;
        },
        async getUsdBalanceCents() {
          return options.unconvertedUsdCents ?? 0;
        },
        async transferUsdcCents() {
          throw new Error('coinbase send must not be used by the fiat leg');
        },
      },
      brex: {
        async listCashAccounts() {
          return [];
        },
        async getCounterpartyRail() {
          return 'ACH';
        },
        async getAvailableCents() {
          return options.brexAvailableCents;
        },
        async transferToCoinbase(params) {
          recorded.transfers.push({ cents: params.cents, idempotencyKey: params.idempotencyKey });
          if (options.transferImpl) return options.transferImpl();
          return { transferId: 'dptx_test' };
        },
      },
      async alert(message: string) {
        recorded.alerts.push(message);
      },
    },
  };
}

async function testAlertContent(): Promise<void> {
  console.log('\nunconvertedUsdSms (the one manual step)');
  await check('SMS carries amount, link, and exact taps', () => {
    const m = unconvertedUsdSms(49_000, 3);
    assert.ok(m.includes('$490.00'), 'exact amount to convert');
    assert.ok(m.includes('$0.03'), 'current float so severity is obvious');
    assert.ok(m.includes('https://'), 'a link to act on');
    assert.ok(/Convert/.test(m), 'the action');
    assert.ok(m.length <= 600, `keep it SMS-sized (was ${m.length})`);
  });
}

async function testRails(): Promise<void> {
  console.log('\nrailsAreCompatible');

  await check('a DOMESTIC_WIRE instrument is compatible with a WIRE transfer', () => {
    // Brex names these differently: instruments are DOMESTIC_WIRE, transfer rails are WIRE.
    // Comparing raw strings rejected the real Coinbase Inc wire instrument.
    assert.ok(railsAreCompatible('DOMESTIC_WIRE', 'WIRE'));
    assert.ok(railsAreCompatible('INTERNATIONAL_WIRE', 'WIRE'));
    assert.ok(railsAreCompatible('WIRE', 'WIRE'));
  });

  await check('ACH family matches SAME_DAY_ACH but never WIRE', () => {
    assert.ok(railsAreCompatible('ACH', 'ACH'));
    assert.ok(railsAreCompatible('ACH', 'SAME_DAY_ACH'));
    assert.ok(!railsAreCompatible('ACH', 'WIRE'), 'ACH instrument must not send on a wire rail');
    assert.ok(!railsAreCompatible('DOMESTIC_WIRE', 'ACH'), 'wire instrument must not send ACH');
  });
}

async function testOrchestration(): Promise<void> {
  console.log('\nrunCoinbaseFloatReplenish');

  await check('happy path transfers and keys idempotency to the settlement window', async () => {
    const { deps, recorded } = harness({ floatCents: 10_000, brexAvailableCents: 10_000_000 });
    const result = await runCoinbaseFloatReplenish(deps);
    assert.deepStrictEqual(result, {
      status: 'transferred',
      cents: 190_000,
      transferId: 'dptx_test',
    });
    assert.deepStrictEqual(recorded.transfers, [
      { cents: 190_000, idempotencyKey: 'coinbase-float-replenish:2026-08-05' },
    ]);
    assert.deepStrictEqual(recorded.successes, ['dptx_test']);
  });

  await check('unconverted USD blocks a fiat transfer and alerts instead', async () => {
    // The failure this prevents: $490 landed at Coinbase as CASH, the USDC float still read $0,
    // and the rail would have wired MORE fiat on top of money that only needed converting.
    // USD -> USDC is not automatable on this account, so detect-and-alert is the only defence.
    const { deps, recorded } = harness({
      floatCents: 3,
      brexAvailableCents: 10_000_000,
      unconvertedUsdCents: 49_000,
    });
    const result = await runCoinbaseFloatReplenish(deps);
    assert.strictEqual(result.status, 'unconverted_usd');
    assert.strictEqual(recorded.transfers.length, 0, 'must NOT wire more fiat on top of cash');
    // Assert the alert is ACTIONABLE, not just that it fired. This is the one manual step in the
    // rail, so the SMS must carry the amount, a link, and the exact taps — otherwise it costs a
    // re-investigation every time instead of 30 seconds.
    const alert = recorded.alerts.find((a) => a.includes('ACTION NEEDED'));
    assert.ok(alert, 'must send an ACTION NEEDED alert');
    assert.ok(alert.includes('$490.00'), 'names the exact amount to convert');
    assert.ok(alert.includes('https://'), 'includes a link to act on');
    assert.ok(/convert/i.test(alert), 'says what to do');
  });

  await check('an already-claimed window NEVER stacks a second ACH', async () => {
    const { deps, recorded } = harness({
      floatCents: 0,
      brexAvailableCents: 10_000_000,
      claimed: false,
    });
    const result = await runCoinbaseFloatReplenish(deps);
    assert.deepStrictEqual(result, { status: 'window_claimed' });
    assert.strictEqual(recorded.transfers.length, 0, 'must not send while a transfer is in flight');
  });

  await check('definitively-rejected transfer releases the window for retry', async () => {
    const { deps, recorded } = harness({
      floatCents: 0,
      brexAvailableCents: 10_000_000,
      transferImpl: async () => {
        throw Object.assign(new Error('invalid counterparty'), { possiblySent: false });
      },
    });
    const result = await runCoinbaseFloatReplenish(deps);
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(recorded.releases, 1, 'a rejected transfer should re-arm the window');
  });

  await check('ambiguous transfer failure RETAINS the window (no stacked ACH)', async () => {
    const { deps, recorded } = harness({
      floatCents: 0,
      brexAvailableCents: 10_000_000,
      transferImpl: async () => {
        throw Object.assign(new Error('gateway timeout'), { possiblySent: true });
      },
    });
    const result = await runCoinbaseFloatReplenish(deps);
    assert.strictEqual(result.status, 'halted');
    assert.strictEqual(recorded.releases, 0, 'a possibly-sent transfer must NOT re-arm the window');
    assert.ok(recorded.alerts.length > 0, 'a halt must alert a human');
  });

  await check('dry Brex balance alerts and sends nothing', async () => {
    const { deps, recorded } = harness({ floatCents: 0, brexAvailableCents: 100 });
    const result = await runCoinbaseFloatReplenish(deps);
    assert.strictEqual(result.status, 'insufficient_brex_funds');
    assert.strictEqual(recorded.transfers.length, 0);
    assert.ok(recorded.alerts.some((a) => a.includes('Brex only has')));
  });

  await check('healthy float does no I/O against Brex transfers', async () => {
    const { deps, recorded } = harness({ floatCents: 500_000, brexAvailableCents: 10_000_000 });
    const result = await runCoinbaseFloatReplenish(deps);
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'float_healthy' });
    assert.strictEqual(recorded.transfers.length, 0);
  });
}

async function testRailGuard(): Promise<void> {
  console.log('\nrail compatibility (wire-vs-ACH misroute guard)');

  await check('matching rails are compatible', () => {
    assert.strictEqual(railsAreCompatible('ACH', 'ACH'), true);
    assert.strictEqual(railsAreCompatible('WIRE', 'WIRE'), true);
  });

  await check('ACH instrument must NOT be used for a WIRE (Coinbase is wire-only here)', () => {
    // Coinbase's deposit page states "Wire transfers only — please do not send funds via ACH",
    // while the Brex instrument was created as ACH. This mismatch must be refused, not sent.
    assert.strictEqual(railsAreCompatible('ACH', 'WIRE'), false);
    assert.strictEqual(railsAreCompatible('WIRE', 'ACH'), false);
  });

  await check('SAME_DAY_ACH is ACH-family and works with an ACH instrument', () => {
    assert.strictEqual(railsAreCompatible('ACH', 'SAME_DAY_ACH'), true);
    assert.strictEqual(railsAreCompatible('WIRE', 'SAME_DAY_ACH'), false);
  });

  await check('comparison is case-insensitive on the instrument side', () => {
    assert.strictEqual(railsAreCompatible('ach', 'ACH'), true);
  });
}

async function main(): Promise<void> {
  console.log('Brex -> Coinbase float replenishment');
  await testPlanning();
  await testAlertContent();
  await testRails();
  await testOrchestration();
  await testRailGuard();
  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll float replenishment tests passed.');
}

void main();
