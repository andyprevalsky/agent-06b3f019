#!/usr/bin/env tsx
/**
 * The organization-MCP poll schedule at EXACT production values.
 *
 * AgentCard throttles the organization MCP org-wide at 120 requests/minute, shared by every caller.
 * These assertions pin the trade the schedule makes: identical total wall clock to the old fixed
 * cadence, materially fewer requests. A regression that widens a deadline (rather than reducing
 * requests) fails the `sum === fixed cadence total` assertions.
 */

import assert from 'node:assert/strict';
import { orgPollWaitsMs } from '../../providers/agentcard/org-poll-schedule';

function fixedCadenceTotalMs(attempts: number, delayMs: number): number {
  return (attempts - 1) * delayMs;
}

function main(): void {
  // Wallet-funding release observer: `RELEASE_LOOKUP_ATTEMPTS`/`RELEASE_LOOKUP_DELAY_MS`.
  const releaseWaits = orgPollWaitsMs(20, 3_000);
  assert.deepEqual(releaseWaits, [3_000, 6_000, 12_000, 24_000, 12_000]);
  assert.equal(
    releaseWaits.reduce((total, wait) => total + wait, 0),
    fixedCadenceTotalMs(20, 3_000),
    'the release observation window must be exactly as long as the old fixed cadence'
  );
  assert.equal(releaseWaits.length + 1, 6, 'the release observation must cost 6 requests, was 20');

  // Card-mint transfer visibility: `TRANSFER_LOOKUP_ATTEMPTS`/`TRANSFER_LOOKUP_DELAY_MS`. Each
  // attempt issues two reads, so this is 12 requests where the fixed cadence spent 40.
  const transferWaits = orgPollWaitsMs(20, 500);
  assert.equal(
    transferWaits.reduce((total, wait) => total + wait, 0),
    fixedCadenceTotalMs(20, 500),
    'the transfer visibility window must be exactly as long as the old fixed cadence'
  );
  assert.equal(transferWaits.length + 1, 6);

  // A schedule never exceeds its budget, and never exceeds the attempt cap.
  for (const attempts of [1, 2, 3, 7, 20, 41]) {
    for (const delayMs of [1, 250, 500, 3_000]) {
      const waits = orgPollWaitsMs(attempts, delayMs);
      assert.ok(waits.length <= Math.max(0, attempts - 1), 'attempt cap must hold');
      assert.equal(
        waits.reduce((total, wait) => total + wait, 0),
        fixedCadenceTotalMs(attempts, delayMs),
        'total wait must equal the fixed cadence it replaces'
      );
      assert.ok(
        waits.every((wait) => wait > 0),
        'a zero wait would spin without spending the budget'
      );
    }
  }

  // Zero delay (tests that want no wall clock) keeps every attempt: there is no budget to trade.
  assert.deepEqual(orgPollWaitsMs(4, 0), [0, 0, 0]);
  assert.deepEqual(orgPollWaitsMs(1, 0), []);

  process.stdout.write('AgentCard organization poll schedule tests passed\n');
}

main();
