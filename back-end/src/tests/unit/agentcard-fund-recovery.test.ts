#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for cardholder residual recovery — the "unused card money goes back to the pool"
 * invariant.
 *
 * Why this exists: `create_card(company_flow)` relocates pool capital into a cardholder's spending
 * power, and closing an unused card does NOT return it to the pool — the value stays as that
 * user's headroom and nets against their next mint. Netting is efficient for an active user, but
 * idle residual is capital no other user can draw on. `recover_funds` credits it back.
 *
 * Verified against the live sandbox 2026-08-05:
 *   recover_funds({cardholder_id}) -> "Recovery rcv_5286… for $6832.80 is completed — the pool was
 *   credited", and the org wallet moved $999,537.96 -> $1,006,370.76 (exactly +$6,832.80).
 *
 * The invariant these tests pin: **the top-up must recover our own idle residual BEFORE spending
 * real money on USDC**, and must never spend at all if recovery alone clears the floor.
 */

import assert from 'node:assert';
import {
  extractCardholderIds,
  extractRecovery,
  isNothingToRecover,
  isRecoveryFailure,
  isSettledRecovery,
  recoverAllCardholderResiduals,
  recoverCardholderFunds,
} from '../../providers/agentcard/fund-recovery';
import {
  runOrgWalletTopUp,
  type OrgWalletTopUpPolicy,
  type OrgWalletTopUpStore,
} from '../../providers/agentcard/org-wallet-topup';

const POLICY: OrgWalletTopUpPolicy = {
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

// Shape captured verbatim from the live sandbox response.
const REAL_RECOVERY = {
  structuredContent: {
    message:
      'Recovery rcv_52860701fdd2d890791a7e49 for $6832.80 is completed — the pool was credited.',
    recovery: {
      id: 'rcv_52860701fdd2d890791a7e49',
      object: 'headroom_recovery',
      status: 'completed',
      cardholder_id: 'cmrfpz6d1000bl804w1gggfto',
      amount_cents: 683_280,
      failure_reason: null,
      tx_hash: '0xabc',
    },
  },
};

async function testParsing(): Promise<void> {
  console.log('\nrecovery payload parsing');

  await check('parses the real sandbox recover_funds response', () => {
    const r = extractRecovery(REAL_RECOVERY);
    assert.strictEqual(r.amountCents, 683_280);
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.recoveryId, 'rcv_52860701fdd2d890791a7e49');
    assert.strictEqual(r.txHash, '0xabc');
  });

  await check('a recovery with no amount reports ZERO, never unknown success', () => {
    // The caller decides whether to spend real money based on this number, so an unparseable
    // amount must read as "recovered nothing", not "recovered something".
    assert.strictEqual(extractRecovery({ structuredContent: { recovery: {} } }).amountCents, 0);
    assert.strictEqual(extractRecovery({}).amountCents, 0);
    assert.strictEqual(extractRecovery(null).amountCents, 0);
  });

  await check('"nothing to recover" is recognised, not treated as an error', () => {
    assert.ok(
      isNothingToRecover({
        structuredContent: { status: 'error', message: 'No residual funds to recover' },
      })
    );
    assert.ok(isNothingToRecover({ message: 'nothing to recover' }));
    assert.ok(
      !isNothingToRecover({ structuredContent: { status: 'error', message: 'rate limited' } })
    );
  });

  await check('the REAL insufficient_headroom response is benign, not a failure', () => {
    // Verbatim from the live sandbox. Open cards and in-flight claims subtract from recoverable
    // headroom, so this fires legitimately right after a close — it must not look like an outage.
    const real = {
      structuredContent: {
        message:
          "recover_funds failed: insufficient_headroom: Requested more than the cardholder's " +
          'current recoverable headroom (open cards and in-flight claims subtract from it).',
        status: 'error',
      },
    };
    assert.ok(isNothingToRecover(real), 'insufficient_headroom must read as nothing-to-recover');
    assert.ok(!isRecoveryFailure(real), 'and must NOT be classified as a failure');
  });

  await check('a genuine provider error is a FAILURE, never a silent zero recovery', async () => {
    // Regression: an auth failure once parsed as amount_cents=0 and was logged as a successful
    // recovery, so the top-up would spend real money believing it had already reclaimed capital.
    const outage = {
      structuredContent: { status: 'error', message: 'recover_funds failed: unauthorized' },
    };
    assert.ok(isRecoveryFailure(outage));
    await assert.rejects(
      () => recoverCardholderFunds('ch_1', async () => outage),
      /unauthorized/,
      'a real error must throw, not report $0 recovered'
    );
  });

  await check('no_spending_power is benign (observed live), not a failure', () => {
    // Live: the benchmark cardholder had nothing to give and answered no_spending_power. Treating
    // it as a fault would spam warnings and mask real outages.
    const real = {
      structuredContent: {
        message: 'recover_funds failed: no_spending_power: no_spending_power',
        status: 'error',
      },
    };
    assert.ok(isNothingToRecover(real));
    assert.ok(!isRecoveryFailure(real));
  });

  await check('only "completed" counts as settled — live returns "requested"', () => {
    assert.ok(isSettledRecovery('completed'));
    assert.ok(!isSettledRecovery('requested'), 'live recoveries settle asynchronously');
    assert.ok(!isSettledRecovery('pending'));
  });

  await check('a pending live recovery is reported as pending, not settled', async () => {
    const sweep = await recoverAllCardholderResiduals(async (tool) =>
      tool === 'list_cardholders'
        ? { structuredContent: { cardholders: [{ id: 'a' }] } }
        : {
            structuredContent: {
              recovery: { id: 'rcv_1', status: 'requested', amount_cents: 12_688 },
            },
          }
    );
    assert.strictEqual(sweep.settledCents, 0, 'requested money is not in the pool yet');
    assert.strictEqual(sweep.pendingCents, 12_688);
  });

  await check('counts recoveries pending from EARLIER runs, not just this sweep', async () => {
    // Observed live: two recoveries sat in "requested" holding the cardholder's entire headroom,
    // so a fresh sweep recovered nothing and would have reported pending=0 while $127.88 was
    // genuinely still in flight. In-flight money must be visible regardless of who requested it.
    const sweep = await recoverAllCardholderResiduals(async (tool) => {
      if (tool === 'list_cardholders') return { structuredContent: { cardholders: [{ id: 'a' }] } };
      if (tool === 'recover_funds')
        return { structuredContent: { status: 'error', message: 'insufficient_headroom' } };
      return {
        structuredContent: {
          recoveries: [
            { id: 'rcv_old', status: 'requested', amount_cents: 12_688, created_at: new Date(Date.now() - 140 * 3600_000).toISOString() },
            { id: 'rcv_new', status: 'requested', amount_cents: 100, created_at: new Date(Date.now() - 60_000).toISOString() },
            { id: 'rcv_done', status: 'completed', amount_cents: 500, created_at: new Date().toISOString() },
          ],
        },
      };
    });
    assert.strictEqual(sweep.settledCents, 0, 'this sweep recovered nothing');
    assert.strictEqual(sweep.pendingCents, 12_788, 'but $127.88 is still in flight from before');
    assert.ok((sweep.oldestPendingAgeMs ?? 0) > 100 * 3600_000, 'oldest age drives the stuck guard');
  });

  await check('never re-requests for a cardholder with one already in flight', async () => {
    // AgentCard: "an open recovery holds its claim so the same residual can't be pulled twice,
    // so don't retry — poll instead." Re-requesting is guaranteed insufficient_headroom.
    const calls: string[] = [];
    const sweep = await recoverAllCardholderResiduals(async (tool, args) => {
      calls.push(tool);
      if (tool === 'list_cardholders')
        return { structuredContent: { cardholders: [{ id: 'busy' }, { id: 'free' }] } };
      if (tool === 'list_recoveries')
        return {
          structuredContent: {
            recoveries: [
              { id: 'rcv_x', status: 'requested', amount_cents: 500, cardholder_id: 'busy', created_at: new Date().toISOString() },
            ],
          },
        };
      assert.strictEqual((args as { cardholder_id?: string }).cardholder_id, 'free',
        'must never call recover_funds for the busy cardholder');
      return { structuredContent: { recovery: { status: 'completed', amount_cents: 700 } } };
    });
    assert.strictEqual(calls.filter((c) => c === 'recover_funds').length, 1, 'only the free one');
    assert.strictEqual(sweep.settledCents, 700);
  });

  await check('extracts cardholder ids from list_cardholders', () => {
    assert.deepStrictEqual(
      extractCardholderIds({ structuredContent: { cardholders: [{ id: 'a' }, { id: 'b' }, {}] } }),
      ['a', 'b']
    );
    assert.deepStrictEqual(extractCardholderIds({}), []);
  });

  await check('one failing cardholder never strands the others', async () => {
    const calls: string[] = [];
    const total = await recoverAllCardholderResiduals(async (tool, args) => {
      calls.push(tool);
      if (tool === 'list_cardholders') {
        return { structuredContent: { cardholders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } };
      }
      if ((args as { cardholder_id?: string }).cardholder_id === 'b') throw new Error('boom');
      return { structuredContent: { recovery: { status: 'completed', amount_cents: 500 } } };
    });
    assert.strictEqual(
      total.settledCents,
      1_000,
      'a and c should still be recovered when b throws'
    );
    assert.strictEqual(calls.filter((c) => c === 'recover_funds').length, 3);
  });
}

function harness(options: {
  availableSequence: number[];
  recoveredCents?: number;
  pendingCents?: number;
  oldestPendingAgeMs?: number;
  recoverThrows?: boolean;
  floatCents?: number;
}) {
  const recorded = { transfers: 0, recoverCalls: 0 };
  let read = 0;
  const store: OrgWalletTopUpStore = {
    async dailySpentCents() {
      return 0;
    },
    async claim() {
      return { claimed: true, claimId: 'c1' };
    },
    async recordSuccess() {},
    async releaseClaim() {},
  };
  const deps: Parameters<typeof runOrgWalletTopUp>[0] = {
    policy: POLICY,
    store,
    treasury: {
      async getUsdcBalanceCents() {
        return options.floatCents ?? 100_000;
      },
      async transferUsdcCents() {
        recorded.transfers += 1;
        return { transactionHash: '0xdead' };
      },
    },
    async callOrgTool() {
      const available =
        options.availableSequence[Math.min(read, options.availableSequence.length - 1)];
      read += 1;
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
    async alert() {},
    async recoverResidual() {
      recorded.recoverCalls += 1;
      if (options.recoverThrows) throw new Error('recovery unavailable');
      return {
        settledCents: options.recoveredCents ?? 0,
        pendingCents: options.pendingCents ?? 0,
        ...(options.oldestPendingAgeMs === undefined
          ? {}
          : { oldestPendingAgeMs: options.oldestPendingAgeMs }),
      };
    },
  };
  return { deps, recorded };
}

async function testOrdering(): Promise<void> {
  console.log('\ntop-up recovers before spending');

  await check('recovery alone clearing the floor means NO money is spent', async () => {
    // $100 available -> recover $400 -> $500 available, above the $250 floor.
    const { deps, recorded } = harness({
      availableSequence: [10_000, 50_000],
      recoveredCents: 40_000,
    });
    const result = await runOrgWalletTopUp(deps);
    assert.strictEqual(result.status, 'recovered');
    assert.strictEqual(recorded.recoverCalls, 1);
    assert.strictEqual(recorded.transfers, 0, 'must NOT buy USDC when our own residual sufficed');
  });

  await check('recovery is attempted BEFORE any treasury transfer', async () => {
    const { deps, recorded } = harness({ availableSequence: [10_000, 10_000], recoveredCents: 0 });
    await runOrgWalletTopUp(deps);
    assert.strictEqual(recorded.recoverCalls, 1, 'recovery must always be tried first');
    assert.strictEqual(
      recorded.transfers,
      1,
      'and the transfer still happens when it is not enough'
    );
  });

  await check('partial recovery still tops up the remainder', async () => {
    // Recover $50 -> still only $150, below the $250 floor, so a transfer must follow.
    const { deps, recorded } = harness({
      availableSequence: [10_000, 15_000],
      recoveredCents: 5_000,
    });
    const result = await runOrgWalletTopUp(deps);
    assert.strictEqual(result.status, 'transferred');
    assert.strictEqual(recorded.transfers, 1);
  });

  await check('a failing recovery degrades to the treasury path, never blocks it', async () => {
    const { deps, recorded } = harness({
      availableSequence: [10_000, 10_000],
      recoverThrows: true,
    });
    const result = await runOrgWalletTopUp(deps);
    assert.strictEqual(result.status, 'transferred', 'recovery failure must not block the top-up');
    assert.strictEqual(recorded.transfers, 1);
  });

  await check('a PENDING recovery defers the spend (never double-funds the pool)', async () => {
    // Regression from the live run: recovery returned "requested" for $126.88 and the balance had
    // not moved yet. Buying USDC on top of that would over-fund the pool once it lands.
    const { deps, recorded } = harness({
      availableSequence: [10_000, 10_000],
      pendingCents: 12_688,
    });
    const result = await runOrgWalletTopUp(deps);
    assert.deepStrictEqual(result, { status: 'recovery_pending', pendingCents: 12_688 });
    assert.strictEqual(recorded.transfers, 0, 'must not buy USDC while our own money is in flight');
  });

  await check('a STUCK pending recovery must NOT starve the pool (livelock guard)', async () => {
    // Live reality: rcv_fb3185a7547b6cfd2984540f sat in "requested" for over a day. Deferring on
    // pendingCents alone would mean the pool NEVER refills — org wallet drains and user card mints
    // fail. Over-funding with our own USDC is bounded and self-correcting; an empty pool is not.
    const { deps, recorded } = harness({
      availableSequence: [10_000, 10_000],
      pendingCents: 12_688,
      oldestPendingAgeMs: 26 * 60 * 60 * 1000, // ~26h, far past the grace window
    });
    const result = await runOrgWalletTopUp(deps);
    assert.strictEqual(result.status, 'transferred', 'a stuck recovery must not block the top-up');
    assert.strictEqual(recorded.transfers, 1);
  });

  await check('a FRESH pending recovery still defers (no over-funding)', async () => {
    const { deps, recorded } = harness({
      availableSequence: [10_000, 10_000],
      pendingCents: 12_688,
      oldestPendingAgeMs: 30_000, // 30s — plausibly still in flight
    });
    const result = await runOrgWalletTopUp(deps);
    assert.deepStrictEqual(result, { status: 'recovery_pending', pendingCents: 12_688 });
    assert.strictEqual(recorded.transfers, 0);
  });

  await check('a healthy wallet never recovers or spends', async () => {
    const { deps, recorded } = harness({ availableSequence: [50_000] });
    const result = await runOrgWalletTopUp(deps);
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'above_threshold' });
    assert.strictEqual(recorded.recoverCalls, 0);
    assert.strictEqual(recorded.transfers, 0);
  });
}

async function main(): Promise<void> {
  console.log('AgentCard cardholder residual recovery');
  await testParsing();
  await testOrdering();
  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll fund-recovery tests passed.');
}

void main();
