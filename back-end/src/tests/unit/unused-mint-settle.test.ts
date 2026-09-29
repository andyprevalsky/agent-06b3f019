#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for unused-mint settle decisions.
 *
 * Cement: a foreign recover_funds yield must NEVER count as settle success while THIS card's
 * mint transfer is still consumed — that false-pass starved waitForTransferReclaimed of both
 * time and recover_funds side-effects (treasury-rails 2026-09-29).
 */

import assert from 'node:assert/strict';
import {
  isFullyReclaimedTransfer,
  unusedMintSettleOutcome,
} from '../../providers/agentcard/unused-mint-settle';

const failures: string[] = [];

async function check(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  console.log('Unused-mint settle decisions');

  await check('consumed transfer with released_cents=0 is not settled', () => {
    assert.equal(
      isFullyReclaimedTransfer({ status: 'consumed', releasedCents: 0 }, 1300),
      false
    );
    assert.deepEqual(unusedMintSettleOutcome({ status: 'consumed', releasedCents: 0 }, 1300), {
      done: false,
    });
  });

  await check('foreign recover_funds yield does not make consumed transfer done', () => {
    // Simulate the 2026-09-29 observation: sweep settled $87.92 from another cardholder while
    // our mint transfer stayed consumed. Outcome ignores sweep and stays not-done.
    const transfer = { status: 'consumed', releasedCents: 0 };
    assert.deepEqual(unusedMintSettleOutcome(transfer, 1300), { done: false });
  });

  await check('consumed transfer with stale released_cents echo is not settled', () => {
    // Sandbox sometimes echoes authorization-release counters on consumed rows; status still
    // must be reclaimed/released for the unused-mint invariant.
    assert.equal(
      isFullyReclaimedTransfer({ status: 'consumed', releasedCents: 1300 }, 1300),
      false
    );
    assert.deepEqual(unusedMintSettleOutcome({ status: 'consumed', releasedCents: 1300 }, 1300), {
      done: false,
    });
  });

  await check('reclaimed transfer with full released_cents is settled', () => {
    assert.deepEqual(unusedMintSettleOutcome({ status: 'reclaimed', releasedCents: 1300 }, 1300), {
      done: true,
      via: 'transfer',
      settledCents: 1300,
      status: 'reclaimed',
    });
  });

  await check('released transfer with full released_cents is settled', () => {
    assert.deepEqual(unusedMintSettleOutcome({ status: 'released', releasedCents: 1300 }, 1300), {
      done: true,
      via: 'transfer',
      settledCents: 1300,
      status: 'released',
    });
  });

  await check('reclaimed transfer below mint amount is not settled', () => {
    assert.deepEqual(unusedMintSettleOutcome({ status: 'reclaimed', releasedCents: 500 }, 1300), {
      done: false,
    });
  });

  await check('missing transfer is not settled', () => {
    assert.deepEqual(unusedMintSettleOutcome(undefined, 1300), { done: false });
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nAll unused-mint settle decision tests passed.');
}

void main();
