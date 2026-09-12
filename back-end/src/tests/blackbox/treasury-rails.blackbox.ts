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
import { loadDotenvWithCallerOverrides } from '../../providers/loadDotenvWithCallerOverrides';
import { callOrgTool } from '../../providers/agentcard/org-runtime';
import { extractAgentCardOrgWallet } from '../../providers/agentcard/org-wallet-monitor';
import { recoverAllCardholderResiduals } from '../../providers/agentcard/fund-recovery';
import { planOrgWalletTopUp } from '../../providers/agentcard/org-wallet-topup';
import { loadCoinbaseTreasuryConfig } from '../../providers/coinbase/config';
import { createCoinbaseTreasury } from '../../providers/coinbase/treasury';
import { createBrexTreasury, loadBrexConfig } from '../../providers/brex/treasury';
import { planFloatReplenish } from '../../providers/brex/replenish';

loadDotenvWithCallerOverrides();

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientOrgMcpPollError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /temporarily unavailable|service unavailable|aborted due to timeout|operation was aborted|timed out/i.test(
    message
  );
}

/**
 * Poll a card's funding transfer until it reaches a terminal release state.
 *
 * `consumed` is transient after a close — it flips to `reclaimed`/`released` once the release
 * settles (same terminal set as `AgentCardCompanyWalletFundingProvider.reclaimUserWalletFunding`).
 * Asserting immediately after `close_card` reads the transient value and looks like value loss.
 */
async function waitForTransferReclaimed(
  cardId: string,
  minReleasedCents: number,
  timeoutMs = 120_000
): Promise<{ status: string; releasedCents: number }> {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 'not_found', releasedCents: 0 };
  for (;;) {
    try {
      const mine = await readCardTransfer(cardId);
      if (mine !== undefined) {
        last = mine;
        if (isFullyReclaimedTransfer(mine, minReleasedCents)) {
          return last;
        }
      }
    } catch (error) {
      if (!isTransientOrgMcpPollError(error)) throw error;
    }
    if (Date.now() >= deadline) return last;
    await sleep(8_000);
  }
}

/**
 * Drain idle cardholder headroom into the pool before minting.
 *
 * A mint against existing residual nets (`transferred_cents: 0`, pool untouched). That path never
 * produces a reclaimable company-wallet transfer for THIS card — `list_transfers` can sit at
 * `consumed` forever while `recover_funds` credits unrelated residual and false-passes a weaker
 * sweep check. Sweeping first forces the subsequent mint to draw from the pool so the close →
 * release → reclaim loop is observable on this card's transfer.
 */
async function sweepResidualHeadroom(timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let recoveredTotal = 0;
  let idleRounds = 0;
  while (Date.now() < deadline && idleRounds < 2) {
    const sweep = await recoverAllCardholderResiduals(callOrgTool);
    if (sweep.settledCents > 0) {
      recoveredTotal += sweep.settledCents;
      idleRounds = 0;
      continue;
    }
    if (sweep.pendingCents > 0) {
      idleRounds = 0;
      await sleep(5_000);
      continue;
    }
    idleRounds += 1;
    if (idleRounds < 2) await sleep(2_000);
  }
  return recoveredTotal;
}

/**
 * Read THIS card's org-wallet mint transfer (race-free money identity).
 *
 * Prefer transfer status over pool balance / residual sweeps: the sandbox org is shared, and
 * AgentCard may reclaim the mint transfer directly on close without ever exposing cardholder
 * residual for `recover_funds`.
 */
async function readCardTransfer(
  cardId: string
): Promise<{ status: string; releasedCents: number } | undefined> {
  const transfers =
    (
      (await callOrgTool('list_transfers', { limit: 100 })) as {
        structuredContent?: { transfers?: Array<Record<string, unknown>> };
      }
    ).structuredContent?.transfers ?? [];
  const mine = transfers.find((t) => t.card_id === cardId);
  if (mine === undefined) return undefined;
  return {
    status: String(mine.status ?? 'unknown'),
    releasedCents: Number(mine.released_cents ?? 0),
  };
}

function isFullyReclaimedTransfer(
  transfer: { status: string; releasedCents: number } | undefined,
  minReleasedCents: number
): transfer is { status: string; releasedCents: number } {
  return (
    transfer !== undefined &&
    transfer.releasedCents >= minReleasedCents &&
    (transfer.status === 'reclaimed' || transfer.status === 'released')
  );
}

/**
 * Wait until unused mint value is observably back (recover_funds residual OR transfer reclaim).
 *
 * Closing a card does NOT always free recoverable cardholder headroom first — the release can
 * settle by flipping the mint transfer straight to `reclaimed`/`released`. In that path
 * `recover_funds` keeps answering `insufficient_headroom` even though the pool already has the
 * money back. Requiring a recover_funds yield alone false-fails that real provider behavior
 * (observed: transfer `reclaimed` + `released_cents` full while sweep stayed at 0 for 240s).
 */
async function waitForRecoverable(
  cardId: string,
  minReleasedCents: number,
  timeoutMs = 240_000
): Promise<{ settledCents: number; pendingCents: number; via: 'recover_funds' | 'transfer' }> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const sweep = await recoverAllCardholderResiduals(callOrgTool);
      if (sweep.settledCents > 0 || sweep.pendingCents > 0) {
        console.log(`  (recovery yielded on attempt ${attempt})`);
        return { ...sweep, via: 'recover_funds' };
      }
      const transfer = await readCardTransfer(cardId);
      if (isFullyReclaimedTransfer(transfer, minReleasedCents)) {
        console.log(
          `  (transfer already ${transfer.status} with ${usd(transfer.releasedCents)} on attempt ${attempt}; ` +
            `recover_funds not needed)`
        );
        return { settledCents: transfer.releasedCents, pendingCents: 0, via: 'transfer' };
      }
      if (Date.now() >= deadline) {
        console.error(
          `  recovery never yielded after ${attempt} attempts; transfer for ${cardId}: ` +
            (transfer === undefined ? '(not found)' : JSON.stringify(transfer))
        );
        return { ...sweep, via: 'recover_funds' };
      }
    } catch (error) {
      if (!isTransientOrgMcpPollError(error)) throw error;
      if (Date.now() >= deadline) throw error;
      if (attempt % 3 === 0)
        console.log(`  (MCP poll timed out, retrying settle wait, attempt ${attempt})`);
      await sleep(8_000);
      continue;
    }
    if (attempt % 3 === 0)
      console.log(`  (still waiting for release to settle, attempt ${attempt})`);
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

  let wallet;
  try {
    wallet = extractAgentCardOrgWallet(await callOrgTool('get_company_wallet', {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Provider-side OAuth/token outages (invalid token, grant failure, timeout) are
    // credential-infra preconditions — not regressions in the rails under test.
    if (
      /invalid or expired organization token/i.test(message) ||
      /could not obtain an agentcard organization mcp access token/i.test(message) ||
      /timed out acquiring an agentcard organization mcp access token/i.test(message) ||
      /could not reach the agentcard organization mcp token endpoint/i.test(message) ||
      /aborted due to timeout|operation was aborted/i.test(message)
    ) {
      console.log(
        'SKIP treasury-rails: AgentCard org token unavailable from provider (credential-infra precondition)'
      );
      return;
    }
    if (/temporarily unavailable|service unavailable/i.test(message)) {
      console.log(
        'SKIP treasury-rails: AgentCard sandbox get_company_wallet is temporarily unavailable (provider-infra precondition)'
      );
      return;
    }
    throw error;
  }
  if (wallet.livemode !== false) {
    console.log(
      'SKIP treasury-rails: LIVE org credentials configured; refusing to mint/charge/close real cards'
    );
    return;
  }
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
    assert.ok(
      Number.isInteger(floatCents) && floatCents >= 0,
      'float must be a non-negative integer'
    );
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
    (
      (await callOrgTool('list_cardholders', {})) as {
        structuredContent?: { cardholders?: Array<{ id: string }> };
      }
    ).structuredContent?.cardholders ?? [];
  assert.ok(cardholders.length > 0, 'sandbox org has no cardholders to test with');
  const cardholderId = cardholders[0].id;

  const preSweepCents = await sweepResidualHeadroom();
  if (preSweepCents > 0) {
    record(`pre-mint residual sweep returned ${usd(preSweepCents)} to the pool`);
  } else {
    record('pre-mint residual sweep found nothing idle');
  }

  const poolBefore = extractAgentCardOrgWallet(
    await callOrgTool('get_company_wallet', {})
  ).availableCents;
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

  const poolAfterMint = extractAgentCardOrgWallet(
    await callOrgTool('get_company_wallet', {})
  ).availableCents;
  const drawn = poolBefore - poolAfterMint;
  // After the residual sweep, this mint must draw from the pool. A netted mint (drawn === 0)
  // leaves no reclaimable company-wallet transfer for THIS card — which is exactly the failure
  // mode this blackbox is here to catch on the close → release path.
  assert.equal(
    drawn,
    mintCents,
    `pool moved ${usd(drawn)} for a ${usd(mintCents)} mint after residual sweep — expected a ` +
      `full pool draw so close/reclaim is observable on this card's transfer`
  );
  record('mint drew from the pool');

  // Close it unused, then prove recovery returns the value to the POOL (not the cardholder).
  const closed = (await callOrgTool('close_card', { card_id: cardId })) as {
    structuredContent?: { status?: string };
  };
  assert.equal(closed.structuredContent?.status, 'CLOSED', 'close_card did not report CLOSED');
  record('closed the card unused');

  const sweep = await waitForRecoverable(cardId, mintCents);
  assert.ok(
    sweep.settledCents > 0 || sweep.pendingCents > 0,
    'recovery reported nothing within the settle window after closing a funded card — the ' +
      'unused value never became recoverable headroom or a reclaimed mint transfer'
  );
  record(
    sweep.via === 'transfer'
      ? `recovery: mint transfer already settled (${usd(sweep.settledCents)}) without residual headroom`
      : `recovery: settled=${usd(sweep.settledCents)} pending=${usd(sweep.pendingCents)}`
  );

  // Assert on OUR transfer, not the pool balance. The sandbox org is shared with running
  // benchmarks that mint and consume cards continuously, so the absolute pool balance moves
  // underneath us — an earlier version of this test asserted `pool >= poolBefore` and failed
  // because concurrent benchmark traffic had drawn $30.96 during our settle wait. The race-free
  // invariant is that THIS card's funding transfer reached a terminal release and released in full.
  const settled = await waitForTransferReclaimed(cardId, mintCents);
  assert.ok(
    settled.status === 'reclaimed' || settled.status === 'released',
    `transfer for ${cardId} ended in "${settled.status}" — an unused card must reclaim/release, ` +
      `not stay consumed`
  );
  assert.ok(
    settled.releasedCents >= mintCents,
    `released ${usd(settled.releasedCents)} but the card held ${usd(mintCents)} — the full unused ` +
      `amount must return to the pool`
  );
  record(
    `transfer ${settled.status} in full: released ${usd(settled.releasedCents)} of ${usd(mintCents)}`
  );

  // ── Cleanup: never leave open cards behind ───────────────────────────────────────────────────
  const cards =
    (
      (await callOrgTool('list_cards', { cardholder_id: cardholderId, limit: 25 })) as {
        structuredContent?: { cards?: Array<{ id: string; status: string }> };
      }
    ).structuredContent?.cards ?? [];
  const stillOpen = cards.filter((card) => card.status === 'OPEN');
  for (const card of stillOpen) await callOrgTool('close_card', { card_id: card.id });
  if (stillOpen.length > 0) record(`cleanup: closed ${stillOpen.length} lingering open card(s)`);

  console.log('\ntreasury-rails blackbox: all checks passed');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Mid-flight AgentCard org OAuth/token outages (after the initial wallet probe) are the same
  // credential-infra precondition as a failed first call — soft-skip rather than fail the gate.
  if (
    /temporarily unavailable|service unavailable/i.test(message) ||
    /invalid or expired organization token/i.test(message) ||
    /could not obtain an agentcard organization mcp access token/i.test(message) ||
    /timed out acquiring an agentcard organization mcp access token/i.test(message) ||
    /could not reach the agentcard organization mcp token endpoint/i.test(message) ||
    /aborted due to timeout|operation was aborted/i.test(message)
  ) {
    console.log(
      'SKIP treasury-rails: AgentCard sandbox MCP unavailable mid-run (credential-infra precondition)'
    );
    process.exit(0);
  }
  console.error(`treasury-rails blackbox FAILED: ${message}`);
  process.exit(1);
});
