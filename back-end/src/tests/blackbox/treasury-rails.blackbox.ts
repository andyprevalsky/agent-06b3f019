#!/usr/bin/env tsx

/**
 * End-to-end proof of the agent-card funding rails, against REAL provider APIs.
 *
 * Covers the full flow of funds:
 *   Brex (balance read) -> Coinbase USDC float (balance read) -> AgentCard org pool
 *     -> create_card (pool debited) -> test_charge / close -> recover_funds (pool restored)
 *
 * ── Why this runs on SANDBOX ───────────────────────────────────────────────────────────────────
 * The money-moving half (mint / charge / close / recover) executes for real. AgentCard's sandbox
 * org has play money and `test_charge`, and — unlike live — recoveries settle instantly, so the
 * whole loop is observable in one run. The read-only half (Brex + Coinbase balances, config
 * resolution) is safe against live credentials and is exercised as-is.
 *
 * ── HARD SAFETY GUARD ──────────────────────────────────────────────────────────────────────────
 * This test refuses to run if `get_company_wallet` reports `livemode: true`. Local `.env` carries
 * sandbox org credentials; the live ones exist only on Render. If those ever leak into a local
 * env, this aborts rather than minting and closing real cards. That check is not optional and
 * must never be relaxed to "make the test run somewhere".
 *
 * Skips cleanly (exit 0) when AgentCard org credentials are absent, so workspaces without them
 * are not blocked.
 */

import assert from 'node:assert/strict';
import { callOrgTool } from '../../providers/agentcard/org-runtime';
import { extractAgentCardOrgWallet } from '../../providers/agentcard/org-wallet-monitor';
import { recoverAllCardholderResiduals } from '../../providers/agentcard/fund-recovery';
import { planOrgWalletTopUp } from '../../providers/agentcard/org-wallet-topup';
import { loadCoinbaseTreasuryConfig } from '../../providers/coinbase/config';
import { createCoinbaseTreasury } from '../../providers/coinbase/treasury';
import { createBrexTreasury, loadBrexConfig } from '../../providers/brex/treasury';
import { planFloatReplenish } from '../../providers/brex/replenish';

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a card's funding transfer until it reaches a terminal state.
 *
 * `consumed` is transient after a close — it flips to `reclaimed` once the release settles.
 * Asserting immediately after `close_card` reads the transient value and looks like value loss.
 */
async function waitForTransferReclaimed(
  cardId: string,
  timeoutMs = 120_000
): Promise<{ status: string; releasedCents: number }> {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 'not_found', releasedCents: 0 };
  for (;;) {
    const transfers =
      ((await callOrgTool('list_transfers', { limit: 25 })) as {
        structuredContent?: { transfers?: Array<Record<string, unknown>> };
      }).structuredContent?.transfers ?? [];
    const mine = transfers.find((t) => t.card_id === cardId);
    if (mine !== undefined) {
      last = {
        status: String(mine.status ?? 'unknown'),
        releasedCents: Number(mine.released_cents ?? 0),
      };
      if (last.status === 'reclaimed') return last;
    }
    if (Date.now() >= deadline) return last;
    await sleep(8_000);
  }
}

/**
 * Poll `recover_funds` until it yields something.
 *
 * Closing a card does NOT immediately free recoverable headroom — the release settles
 * asynchronously, so a recovery fired straight after `close_card` legitimately answers
 * `insufficient_headroom`. This is a real property of the provider, not flake: the production
 * top-up calls recovery opportunistically and simply gets nothing on that pass.
 */
async function waitForRecoverable(
  cardId: string,
  timeoutMs = 240_000
): Promise<{ settledCents: number; pendingCents: number }> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const sweep = await recoverAllCardholderResiduals(callOrgTool);
    if (sweep.settledCents > 0 || sweep.pendingCents > 0) {
      console.log(`  (recovery yielded on attempt ${attempt})`);
      return sweep;
    }
    if (Date.now() >= deadline) {
      // Surface the transfer state so a timeout is diagnosable rather than just "nothing happened".
      // `consumed` here means the release has not settled yet; `reclaimed` means it has.
      const transfers =
        ((await callOrgTool('list_transfers', { limit: 10 })) as {
          structuredContent?: { transfers?: Array<Record<string, unknown>> };
        }).structuredContent?.transfers ?? [];
      const mine = transfers.find((t) => t.card_id === cardId);
      console.error(
        `  recovery never yielded after ${attempt} attempts; transfer for ${cardId}: ` +
          (mine === undefined ? '(not found)' : JSON.stringify(mine))
      );
      return sweep;
    }
    if (attempt % 3 === 0) console.log(`  (still waiting for release to settle, attempt ${attempt})`);
    await sleep(8_000);
  }
}

function record(name: string): void {
  console.log(`  PASS ${name}`);
}

async function main(): Promise<void> {
  if (
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID === undefined &&
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN === undefined
  ) {
    console.log('SKIP treasury-rails: no AgentCard org credentials configured');
    return;
  }

  const wallet = extractAgentCardOrgWallet(await callOrgTool('get_company_wallet', {}));
  assert.equal(
    wallet.livemode,
    false,
    'REFUSING to run: these are LIVE org credentials. This test mints, charges, closes and ' +
      'recovers real cards. Point it at the sandbox org.'
  );
  record(`sandbox org wallet reachable (${usd(wallet.availableCents)} available)`);

  // ── Leg 1: Brex (read-only, safe against live) ───────────────────────────────────────────────
  const brexConfig = loadBrexConfig();
  let brexAvailableCents = 0;
  if (brexConfig !== undefined) {
    const accounts = await createBrexTreasury(brexConfig).listCashAccounts();
    assert.ok(accounts.length > 0, 'Brex returned no cash accounts');
    // Brex genuinely reports negative available when holds exceed the balance; treating that as
    // spendable is how an ACH gets returned NSF, which has happened here before.
    brexAvailableCents = accounts
      .filter((account) => account.status === 'ACTIVE')
      .reduce((total, account) => total + Math.max(0, account.availableCents), 0);
    assert.ok(brexAvailableCents >= 0, 'Brex available must never be negative after flooring');
    record(`Brex reachable, ${accounts.length} account(s), ${usd(brexAvailableCents)} available`);
  } else {
    console.log('  SKIP Brex leg: BREX_API_TOKEN not configured');
  }

  // ── Leg 2: Coinbase float (read-only, safe against live) ─────────────────────────────────────
  const coinbaseConfig = loadCoinbaseTreasuryConfig();
  let floatCents = 0;
  if (coinbaseConfig !== undefined) {
    floatCents = await createCoinbaseTreasury(coinbaseConfig).getUsdcBalanceCents();
    assert.ok(Number.isInteger(floatCents) && floatCents >= 0, 'float must be a non-negative integer');
    record(`Coinbase float readable: ${usd(floatCents)} on ${coinbaseConfig.network}`);
  } else {
    console.log('  SKIP Coinbase leg: COINBASE_TREASURY_API_KEY_ID not configured');
  }

  // ── Planners agree with the real numbers ─────────────────────────────────────────────────────
  const policy = {
    enabled: true,
    thresholdCents: 25_000,
    targetCents: 50_000,
    minTransferCents: 1_000,
    maxTransferCents: 50_000,
    dailyCapCents: 200_000,
  };
  const lowPlan = planOrgWalletTopUp({
    policy,
    wallet: { livemode: true, availableCents: 15_912 },
    floatCents: 100_000,
    dailySpentCents: 0,
  });
  assert.deepEqual(
    lowPlan,
    { action: 'transfer', transferCents: 34_088 },
    'a $159.12 pool must top up to exactly the $500 target'
  );
  assert.deepEqual(
    planFloatReplenish({
      policy: {
        enabled: true,
        floorCents: 50_000,
        targetCents: 200_000,
        minTransferCents: 10_000,
        maxTransferCents: 500_000,
      },
      floatCents: 0,
      brexAvailableCents: -41_209,
    }),
    { action: 'insufficient_brex_funds', wantedCents: 200_000, brexAvailableCents: -41_209 },
    'a negative Brex balance must never be read as spendable'
  );
  record('planners produce the expected decisions for real-world balances');

  // ── Leg 3: the AgentCard money loop (REAL, on sandbox) ───────────────────────────────────────
  const cardholders =
    ((await callOrgTool('list_cardholders', {})) as { structuredContent?: { cardholders?: Array<{ id: string }> } })
      .structuredContent?.cardholders ?? [];
  assert.ok(cardholders.length > 0, 'sandbox org has no cardholders to test with');
  const cardholderId = cardholders[0].id;

  const poolBefore = extractAgentCardOrgWallet(await callOrgTool('get_company_wallet', {}))
    .availableCents;
  const mintCents = 1_300;

  const minted = (await callOrgTool('create_card', {
    cardholder_id: cardholderId,
    amount_cents: mintCents,
    funds_source: 'company_flow',
    idempotency_key: `blackbox-treasury-${Date.now()}`,
  })) as { structuredContent?: { cardId?: string } };
  const cardId = minted.structuredContent?.cardId;
  assert.ok(cardId !== undefined, 'create_card returned no cardId');
  record(`minted ${usd(mintCents)} card ${cardId}`);

  const poolAfterMint = extractAgentCardOrgWallet(await callOrgTool('get_company_wallet', {}))
    .availableCents;
  const drawn = poolBefore - poolAfterMint;
  // Either the pool funded it, or existing cardholder headroom netted it. Both are valid; what is
  // NOT valid is the pool moving by some other amount.
  assert.ok(
    drawn === mintCents || drawn === 0,
    `pool moved ${usd(drawn)} for a ${usd(mintCents)} mint — expected a full draw or a clean net`
  );
  record(drawn === 0 ? 'mint netted against existing headroom (pool untouched)' : 'mint drew from the pool');

  // Close it unused, then prove recovery returns the value to the POOL (not the cardholder).
  const closed = (await callOrgTool('close_card', { card_id: cardId })) as {
    structuredContent?: { status?: string };
  };
  assert.equal(closed.structuredContent?.status, 'CLOSED', 'close_card did not report CLOSED');
  record('closed the card unused');

  const sweep = await waitForRecoverable(cardId);
  assert.ok(
    sweep.settledCents > 0 || sweep.pendingCents > 0,
    'recovery reported nothing within the settle window after closing a funded card — the ' +
      'unused value never became recoverable headroom'
  );
  record(`recovery: settled=${usd(sweep.settledCents)} pending=${usd(sweep.pendingCents)}`);

  // Assert on OUR transfer, not the pool balance. The sandbox org is shared with running
  // benchmarks that mint and consume cards continuously, so the absolute pool balance moves
  // underneath us — an earlier version of this test asserted `pool >= poolBefore` and failed
  // because concurrent benchmark traffic had drawn $30.96 during our settle wait. The race-free
  // invariant is that THIS card's funding transfer reached `reclaimed` and released in full.
  const settled = await waitForTransferReclaimed(cardId);
  assert.equal(
    settled.status,
    'reclaimed',
    `transfer for ${cardId} ended in "${settled.status}" — an unused card must reclaim, not consume`
  );
  assert.equal(
    settled.releasedCents,
    mintCents,
    `released ${usd(settled.releasedCents)} but the card held ${usd(mintCents)} — the full unused ` +
      `amount must return to the pool`
  );
  record(`transfer reclaimed in full: released ${usd(settled.releasedCents)} of ${usd(mintCents)}`);

  // ── Cleanup: never leave open cards behind ───────────────────────────────────────────────────
  const cards =
    ((await callOrgTool('list_cards', { cardholder_id: cardholderId, limit: 25 })) as {
      structuredContent?: { cards?: Array<{ id: string; status: string }> };
    }).structuredContent?.cards ?? [];
  const stillOpen = cards.filter((card) => card.status === 'OPEN');
  for (const card of stillOpen) await callOrgTool('close_card', { card_id: card.id });
  if (stillOpen.length > 0) record(`cleanup: closed ${stillOpen.length} lingering open card(s)`);

  console.log('\ntreasury-rails blackbox: all checks passed');
}

void main().catch((error: unknown) => {
  console.error(`treasury-rails blackbox FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
