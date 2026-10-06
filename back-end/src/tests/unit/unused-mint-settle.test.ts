#!/usr/bin/env tsx

/**
 * Unit tests for unused-mint settle decisions.
 *
 * Cement: a foreign recover_funds yield must NEVER count as settle success while THIS card's
 * mint transfer is still consumed — that false-pass starved waitForTransferReclaimed of both
 * time and recover_funds side-effects (treasury-rails 2026-09-29).
 *
 * Cement: a reclaim that misses one run's wait is judged a day after the mint, from whatever the
 * newest-100 transfer pages still show (treasury-rails 2026-10-04).
 */

import assert from 'node:assert/strict';
import {
  UNUSED_MINT_RECLAIM_DEADLINE_MS,
  classifyUnusedMintTransfer,
  deferredUnusedMintVerdict,
  isFullyReclaimedTransfer,
  unusedMintSettleOutcome,
  type PendingUnusedMint,
  type TransferStatusPage,
} from '../../providers/agentcard/unused-mint-settle';

const failures: string[] = [];

async function check(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stderr.write(
      `  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

// The 2026-10-03 deploy card whose transfer was still consumed 20.6h after an unused close.
const STUCK_ROW = {
  id: 'owt_ef9b047212c177aaca719afe',
  status: 'consumed',
  kind: 'mint',
  amount_cents: 1300,
  transferred_cents: 1300,
  released_cents: 0,
  card_id: 'card_3fe0cde76095b38c762acbbf',
  created_at: '2026-10-03T18:02:03.922Z',
};
const STUCK: PendingUnusedMint = {
  cardId: STUCK_ROW.card_id,
  transferId: STUCK_ROW.id,
  cardholderId: 'holder-1',
  mintCents: 1300,
  mintedAt: STUCK_ROW.created_at,
};
const MINTED_AT_MS = Date.parse(STUCK.mintedAt);
const HOUR_MS = 3_600_000;

function page(status: string, rows: Array<Record<string, unknown>>): TransferStatusPage {
  return { status, limit: 100, rows };
}

/** A full page whose oldest row is `oldestOffsetMs` from the mint. */
function fullPage(status: string, oldestOffsetMs: number): TransferStatusPage {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: `owt_${status}_${index}`,
    status,
    card_id: `card_other_${status}_${index}`,
    created_at: new Date(MINTED_AT_MS + oldestOffsetMs + (99 - index) * 60_000).toISOString(),
  }));
  return page(status, rows);
}

function emptyPages(): TransferStatusPage[] {
  return ['pending', 'funded', 'failed'].map((status) => page(status, []));
}

async function main(): Promise<void> {
  process.stdout.write('Unused-mint settle decisions\n');

  await check('consumed transfer with released_cents=0 is not settled', () => {
    assert.equal(isFullyReclaimedTransfer({ status: 'consumed', releasedCents: 0 }, 1300), false);
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

  await check('a consumed transfer at the end of a run is deferred, not failed', () => {
    assert.deepEqual(classifyUnusedMintTransfer({ status: 'consumed', releasedCents: 0 }, 1300), {
      kind: 'pending',
      status: 'consumed',
    });
  });

  await check('a short or failed transfer still fails the run that sees it', () => {
    assert.deepEqual(
      classifyUnusedMintTransfer({ status: 'reclaimed', releasedCents: 500 }, 1300),
      {
        kind: 'failed',
        reason: 'reclaimed only 500c of 1300c',
      }
    );
    assert.equal(
      classifyUnusedMintTransfer({ status: 'failed', releasedCents: 0 }, 1300).kind,
      'failed'
    );
    assert.equal(
      classifyUnusedMintTransfer({ status: 'not_found', releasedCents: 0 }, 1300).kind,
      'failed'
    );
  });

  await check('a full reclaim is settled', () => {
    assert.deepEqual(
      classifyUnusedMintTransfer({ status: 'reclaimed', releasedCents: 1300 }, 1300),
      {
        kind: 'settled',
        status: 'reclaimed',
        releasedCents: 1300,
      }
    );
  });

  await check('the real stuck transfer is still waiting 20.6h after its mint', () => {
    const nowMs = Date.parse('2026-10-04T14:38:52.548Z');
    const verdict = deferredUnusedMintVerdict(
      STUCK,
      [...emptyPages(), page('consumed', [STUCK_ROW]), fullPage('reclaimed', -10 * HOUR_MS)],
      nowMs
    );
    assert.equal(verdict.kind, 'waiting');
    assert.equal(verdict.kind === 'waiting' && verdict.status, 'consumed');
  });

  await check('the same transfer still consumed at the deadline is overdue', () => {
    const verdict = deferredUnusedMintVerdict(
      STUCK,
      [...emptyPages(), page('consumed', [STUCK_ROW])],
      MINTED_AT_MS + UNUSED_MINT_RECLAIM_DEADLINE_MS
    );
    assert.equal(verdict.kind, 'overdue');
    assert.deepEqual(verdict.kind === 'overdue' && verdict.row, STUCK_ROW);
  });

  await check('a later full reclaim settles the earlier mint, even past the deadline', () => {
    const reclaimed = { ...STUCK_ROW, status: 'reclaimed', released_cents: 1300 };
    const verdict = deferredUnusedMintVerdict(
      STUCK,
      [...emptyPages(), page('reclaimed', [reclaimed])],
      MINTED_AT_MS + 2 * UNUSED_MINT_RECLAIM_DEADLINE_MS
    );
    assert.deepEqual(verdict, {
      kind: 'settled',
      ageMs: 2 * UNUSED_MINT_RECLAIM_DEADLINE_MS,
      status: 'reclaimed',
      releasedCents: 1300,
    });
  });

  await check('a later short reclaim fails', () => {
    const short = { ...STUCK_ROW, status: 'reclaimed', released_cents: 900 };
    const verdict = deferredUnusedMintVerdict(
      STUCK,
      [...emptyPages(), page('reclaimed', [short])],
      MINTED_AT_MS + HOUR_MS
    );
    assert.equal(verdict.kind, 'failed');
  });

  await check('a transfer matched by card when the ledger has another transfer id', () => {
    const verdict = deferredUnusedMintVerdict(
      { ...STUCK, transferId: 'owt_unknown' },
      [...emptyPages(), page('consumed', [STUCK_ROW])],
      MINTED_AT_MS + UNUSED_MINT_RECLAIM_DEADLINE_MS
    );
    assert.equal(verdict.kind, 'overdue');
  });

  // 2026-10-04: a card stuck 35h earlier was in neither list. The consumed page stopped 33h back,
  // but the reclaimed page reached 41h back, so it cannot have been reclaimed.
  await check(
    'aged out of consumed but ruled out of reclaimed is overdue past the deadline',
    () => {
      const pages = [
        ...emptyPages(),
        fullPage('consumed', 2 * HOUR_MS),
        fullPage('reclaimed', -6 * HOUR_MS),
      ];
      const verdict = deferredUnusedMintVerdict(STUCK, pages, MINTED_AT_MS + 35 * HOUR_MS);
      assert.deepEqual(verdict, {
        kind: 'overdue',
        ageMs: 35 * HOUR_MS,
        status: 'not listed (could be consumed)',
      });
      assert.equal(deferredUnusedMintVerdict(STUCK, pages, MINTED_AT_MS + HOUR_MS).kind, 'waiting');
    }
  );

  await check('aged out of the reclaimed list too is unverifiable, not a failure', () => {
    const pages = [
      ...emptyPages(),
      fullPage('consumed', 2 * HOUR_MS),
      fullPage('reclaimed', 2 * HOUR_MS),
    ];
    const late = deferredUnusedMintVerdict(STUCK, pages, MINTED_AT_MS + 50 * HOUR_MS);
    assert.equal(late.kind, 'unobservable');
    assert.equal(deferredUnusedMintVerdict(STUCK, pages, MINTED_AT_MS + HOUR_MS).kind, 'waiting');
  });

  await check('a transfer missing from lists that all reach back past the mint fails', () => {
    const pages = [
      ...emptyPages(),
      fullPage('consumed', -HOUR_MS),
      fullPage('reclaimed', -HOUR_MS),
    ];
    assert.equal(deferredUnusedMintVerdict(STUCK, pages, MINTED_AT_MS + HOUR_MS).kind, 'failed');
  });

  await check('an unparseable mint time fails instead of waiting forever', () => {
    const verdict = deferredUnusedMintVerdict(
      { ...STUCK, mintedAt: 'yesterday' },
      emptyPages(),
      MINTED_AT_MS
    );
    assert.equal(verdict.kind, 'failed');
  });

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} test(s) FAILED:\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
  process.stdout.write('\nAll unused-mint settle decision tests passed.\n');
}

void main();
