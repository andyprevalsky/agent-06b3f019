#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNUSED_MINT_RECLAIM_DEADLINE_MS } from '../../providers/agentcard/unused-mint-settle';
import {
  checkPendingUnusedMints,
  overdueReclaimSkipped,
  pendingMintLedgerPath,
  readOpenPendingMints,
  recordPendingMint,
  observePendingUnusedMint,
} from './treasury-rails-pending-mints';

type Row = Record<string, unknown>;

const HOUR_MS = 3_600_000;
const MINTED_AT = '2026-10-03T18:02:03.922Z';
const MINTED_AT_MS = Date.parse(MINTED_AT);

function fakeProvider(transfers: () => Row[]): {
  callOrgTool: (name: string, args: Record<string, unknown>, deadline?: number) => Promise<unknown>;
  calls: Array<{ status: unknown; limit: unknown; deadline: number | undefined }>;
} {
  const calls: Array<{ status: unknown; limit: unknown; deadline: number | undefined }> = [];
  return {
    calls,
    callOrgTool: async (name, args, deadline) => {
      assert.equal(name, 'list_transfers', 'the deferred check must only read transfers');
      calls.push({ status: args.status, limit: args.limit, deadline });
      const rows = transfers().filter((row) => row.status === args.status);
      return { structuredContent: { transfers: rows } };
    },
  };
}

function transferRow(cardId: string, status: string, releasedCents: number): Row {
  return {
    id: `owt_${cardId}`,
    status,
    kind: 'mint',
    amount_cents: 1300,
    transferred_cents: 1300,
    released_cents: releasedCents,
    card_id: cardId,
    created_at: MINTED_AT,
  };
}

async function main(): Promise<void> {
  // Overdue reclaims are skippable only through the exact opt-in flag.
  assert.equal(overdueReclaimSkipped({ TREASURY_RAILS_SKIP_OVERDUE_RECLAIM: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    assert.equal(overdueReclaimSkipped({ TREASURY_RAILS_SKIP_OVERDUE_RECLAIM: value }), false);
  }
  const dir = mkdtempSync(join(tmpdir(), 'treasury-pending-'));
  const ledgerPath = join(dir, 'nested', 'pending.jsonl');
  const ours = new Set(['holder-ours']);
  try {
    const interruptedLedger = join(dir, 'interrupted.jsonl');
    const interruptedMint = {
      cardId: 'closed-owned-card',
      transferId: 'exact-owned-transfer',
      cardholderId: 'holder-ours',
      mintCents: 1300,
      mintedAt: MINTED_AT,
    };
    const primary = new Error('Invalid or expired organization token');
    await assert.rejects(
      () =>
        observePendingUnusedMint(interruptedLedger, interruptedMint, async () => {
          throw primary;
        }),
      (error: unknown) => error === primary
    );
    assert.deepEqual(
      readOpenPendingMints(interruptedLedger),
      [interruptedMint],
      'an interrupted settlement must retain the exact known closed-card transfer'
    );
    await observePendingUnusedMint(interruptedLedger, interruptedMint, async () => ({
      status: 'reclaimed',
      releasedCents: 1299,
      transferredCents: 1300,
    }));
    assert.deepEqual(
      readOpenPendingMints(interruptedLedger),
      [interruptedMint],
      'a partial reclaim must remain pending'
    );
    await observePendingUnusedMint(interruptedLedger, interruptedMint, async () => ({
      status: 'failed',
      releasedCents: 1300,
      transferredCents: 1300,
    }));
    assert.deepEqual(
      readOpenPendingMints(interruptedLedger),
      [interruptedMint],
      'a failed transfer must not be mistaken for an observed full reclaim'
    );
    await assert.rejects(
      () =>
        observePendingUnusedMint(interruptedLedger, interruptedMint, async () => ({
          status: 'reclaimed',
          releasedCents: 1300,
          transferredCents: 1301,
        })),
      /invalid pool debit/
    );
    assert.deepEqual(
      readOpenPendingMints(interruptedLedger),
      [interruptedMint],
      'an invalid pool debit must fail before clearing pending custody'
    );
    await observePendingUnusedMint(interruptedLedger, interruptedMint, async () => ({
      status: 'reclaimed',
      releasedCents: 1300,
      transferredCents: 1300,
    }));
    assert.deepEqual(
      readOpenPendingMints(interruptedLedger),
      [],
      'only an observed full reclaim clears the pending transfer'
    );
    assert.equal(
      pendingMintLedgerPath({ TREASURY_RAILS_PENDING_MINT_LEDGER: ledgerPath }),
      ledgerPath
    );
    assert.equal(
      pendingMintLedgerPath({}),
      join(homedir(), '.cache', 'rose-labs', 'treasury-rails-pending-mints.jsonl'),
      'the default ledger must outlive the worktree'
    );

    const idle = fakeProvider(() => []);
    assert.deepEqual(
      await checkPendingUnusedMints({
        callOrgTool: idle.callOrgTool,
        ledgerPath,
        cardholderIds: ours,
      }),
      []
    );
    assert.equal(idle.calls.length, 0, 'no open entries must cost no provider calls');

    const statuses = new Map<string, Row>();
    const provider = fakeProvider(() => [...statuses.values()]);
    for (const cardId of ['card_slow', 'card_lost']) {
      recordPendingMint(ledgerPath, {
        cardId,
        transferId: `owt_${cardId}`,
        cardholderId: 'holder-ours',
        mintCents: 1300,
        mintedAt: MINTED_AT,
      });
      statuses.set(cardId, transferRow(cardId, 'consumed', 0));
    }
    recordPendingMint(ledgerPath, {
      cardId: 'card_other_org',
      transferId: 'owt_card_other_org',
      cardholderId: 'holder-other-org',
      mintCents: 1300,
      mintedAt: MINTED_AT,
    });

    const early = await checkPendingUnusedMints({
      callOrgTool: provider.callOrgTool,
      ledgerPath,
      cardholderIds: ours,
      nowMs: MINTED_AT_MS + 2 * HOUR_MS,
    });
    assert.deepEqual(
      early.map(({ entry, verdict }) => [entry.cardId, verdict.kind]),
      [
        ['card_slow', 'waiting'],
        ['card_lost', 'waiting'],
      ],
      'consumed transfers inside the deadline wait, and another org’s entry is not checked'
    );
    assert.deepEqual(
      provider.calls.map((call) => [call.status, call.limit]),
      ['pending', 'funded', 'consumed', 'reclaimed', 'failed'].map((status) => [status, 100])
    );
    assert.equal(
      new Set(provider.calls.map((call) => call.deadline)).size,
      1,
      'one rate-limit budget must cover every page read'
    );
    assert.equal(readOpenPendingMints(ledgerPath).length, 3, 'waiting entries stay open');

    statuses.set('card_slow', transferRow('card_slow', 'reclaimed', 1300));
    const late = await checkPendingUnusedMints({
      callOrgTool: provider.callOrgTool,
      ledgerPath,
      cardholderIds: ours,
      nowMs: MINTED_AT_MS + UNUSED_MINT_RECLAIM_DEADLINE_MS,
    });
    assert.deepEqual(
      late.map(({ entry, verdict }) => [entry.cardId, verdict.kind]),
      [
        ['card_slow', 'settled'],
        ['card_lost', 'overdue'],
      ]
    );

    provider.calls.length = 0;
    const after = await checkPendingUnusedMints({
      callOrgTool: provider.callOrgTool,
      ledgerPath,
      cardholderIds: ours,
      nowMs: MINTED_AT_MS + 2 * UNUSED_MINT_RECLAIM_DEADLINE_MS,
    });
    assert.deepEqual(
      after.map(({ entry, verdict }) => [entry.cardId, verdict.kind]),
      [['card_lost', 'overdue']],
      'an unreclaimed mint must keep failing subsequent runs until settlement is proved'
    );
    assert.equal(provider.calls.length, 5);
    assert.deepEqual(
      readOpenPendingMints(ledgerPath).map((entry) => entry.cardId),
      ['card_lost', 'card_other_org'],
      'unreclaimed entries and entries for other credentials must stay open'
    );
    const resolutions = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Row)
      .filter((line) => line.event === 'resolved')
      .map((line) => [line.cardId, line.verdict, line.detail]);
    assert.deepEqual(resolutions, [['card_slow', 'settled', 'reclaimed 1300c']]);

    // Historical non-settlement receipts cannot make an unpaid obligation disappear.
    for (const verdict of ['overdue', 'failed', 'unobservable']) {
      appendFileSync(
        ledgerPath,
        `${JSON.stringify({
          event: 'resolved',
          cardId: 'card_lost',
          verdict,
          detail: 'no reclaim proof',
          resolvedAt: new Date().toISOString(),
        })}\n`
      );
      assert.ok(readOpenPendingMints(ledgerPath).some((entry) => entry.cardId === 'card_lost'));
    }
    statuses.set('card_lost', transferRow('card_lost', 'reclaimed', 1300));
    const reconciled = await checkPendingUnusedMints({
      callOrgTool: provider.callOrgTool,
      ledgerPath,
      cardholderIds: ours,
      nowMs: MINTED_AT_MS + 3 * UNUSED_MINT_RECLAIM_DEADLINE_MS,
    });
    assert.equal(reconciled[0]?.verdict.kind, 'settled');
    assert.deepEqual(
      readOpenPendingMints(ledgerPath).map((entry) => entry.cardId),
      ['card_other_org']
    );

    appendFileSync(ledgerPath, '{"event":"pending","cardId":\n');
    assert.throws(
      () => readOpenPendingMints(ledgerPath),
      new RegExp(`${ledgerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+ is not valid JSON`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('Treasury rails pending-mint ledger blackbox passed');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
