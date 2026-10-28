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
 * org has play money and `test_charge`, and most unused-card reclaims land within minutes, so the
 * loop is usually observable in one run. A reclaim that has not landed by the end of the run is
 * recorded outside the worktree, and later runs fail it if it is still missing a day after the
 * mint (`treasury-rails-pending-mints.ts`). The read-only half (Brex + Coinbase balances, config
 * resolution) is safe against live credentials and is exercised as-is.
 *
 * ── HARD SAFETY GUARD ──────────────────────────────────────────────────────────────────────────
 * This test refuses to run if `whoami` reports production mode. Local `.env` carries
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
import { readAgentCardOrgWallet } from '../../providers/agentcard/org-wallet-monitor';
import { resolveBenchmarkCardholderId } from '../../providers/agentcard/benchmark-float';
import { recoverAllCardholderResiduals } from '../../providers/agentcard/fund-recovery';
import { planOrgWalletTopUp } from '../../providers/agentcard/org-wallet-topup';
import { fiatPullEnabled, resolveFiatSource } from '../../providers/agentcard/org-wallet-fiat';
import {
  UNUSED_MINT_RECLAIM_DEADLINE_MS,
  classifyUnusedMintTransfer,
  unusedMintSettleOutcome,
  type MintTransferObservation,
} from '../../providers/agentcard/unused-mint-settle';
import { loadCoinbaseTreasuryConfig } from '../../providers/coinbase/config';
import { createCoinbaseTreasury } from '../../providers/coinbase/treasury';
import { createBrexTreasury, loadBrexConfig } from '../../providers/brex/treasury';
import { cleanupTreasuryRailCards } from './treasury-rails-card-cleanup';
import { waitForIdleTreasuryRailCardholder } from './treasury-rails-cardholder';
import {
  checkPendingUnusedMints,
  overdueReclaimSkipped,
  pendingMintLedgerPath,
  recordPendingMint,
} from './treasury-rails-pending-mints';

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
 * Drain idle cardholder headroom into the pool before minting.
 *
 * A mint against existing residual can net (`transferred_cents: 0`, pool untouched).
 * Sweeping cannot reserve a globally shared cardholder's headroom, and unrelated residual
 * recovery cannot prove this mint's funding. Sweep first, then retry once if the provider
 * still nets headroom: at least one settled mint must prove a full pool debit on its own transfer.
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
type CardTransfer = MintTransferObservation & {
  amountCents: number;
  transferredCents: number;
  raw: Record<string, unknown>;
};

async function readCardTransfer(cardId: string): Promise<CardTransfer | undefined> {
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
    amountCents: Number(mine.amount_cents ?? 0),
    releasedCents: Number(mine.released_cents ?? 0),
    transferredCents: Number(mine.transferred_cents ?? 0),
    raw: mine,
  };
}

/**
 * Wait until THIS card's unused mint transfer reaches a terminal release state.
 *
 * `recover_funds` is called each poll as an accelerator (AgentCard often flips the mint transfer
 * to `reclaimed` only after residual is pulled). A foreign cardholder's recover_funds yield is
 * NEVER treated as success — that false-passed the old wait while THIS transfer stayed
 * `consumed`, then the follow-up poll stopped calling recover_funds and timed out.
 *
 * Auto-reclaim without residual (transfer flips while recover answers insufficient_headroom) is
 * still accepted via the transfer observation alone. When the in-run wait runs out this returns
 * the latest observation instead of failing: a reclaim can legitimately take up to a day.
 */
async function waitForUnusedMintSettled(
  cardId: string,
  minReleasedCents: number,
  timeoutMs = 240_000
): Promise<CardTransfer | undefined> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let last: CardTransfer | undefined;
  // A residual can be recovered while THIS transfer never flips. Keep every attempt's sweep yield
  // and the provider's own transfer row so a timeout shows which side stalled.
  const sweepYields: string[] = [];
  for (;;) {
    attempt += 1;
    try {
      const sweep = await recoverAllCardholderResiduals(callOrgTool);
      if (sweep.settledCents > 0 || sweep.pendingCents > 0) {
        sweepYields.push(
          `#${attempt} settled=${usd(sweep.settledCents)} pending=${usd(sweep.pendingCents)}`
        );
      }
      const transfer = await readCardTransfer(cardId);
      if (transfer !== undefined) last = transfer;
      const outcome = unusedMintSettleOutcome(transfer, minReleasedCents);
      if (outcome.done) {
        assert.ok(transfer !== undefined, `no org-wallet transfer found for ${cardId}`);
        if (sweep.settledCents > 0 || sweep.pendingCents > 0) {
          console.log(
            `  (transfer ${outcome.status} with ${usd(outcome.settledCents)} on attempt ${attempt}; ` +
              `recover_funds also yielded settled=${usd(sweep.settledCents)} pending=${usd(sweep.pendingCents)})`
          );
        } else {
          console.log(
            `  (transfer already ${outcome.status} with ${usd(outcome.settledCents)} on attempt ${attempt}; ` +
              `recover_funds not needed)`
          );
        }
        return transfer;
      }
      if (Date.now() >= deadline) {
        console.warn(
          `  unused mint not reclaimed within the in-run wait (${attempt} attempts); provider row ` +
            `for ${cardId}: ${JSON.stringify(last?.raw ?? null)}` +
            `; recover_funds yields: ${sweepYields.join(', ') || 'none'}`
        );
        return last;
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

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;
const RECLAIM_DEADLINE = hours(UNUSED_MINT_RECLAIM_DEADLINE_MS);

/** Earlier runs' unused mints that had not come back yet; any lost past the deadline fails here. */
async function checkEarlierUnusedMints(
  cardholderIds: ReadonlySet<string>,
  ledgerPath: string
): Promise<void> {
  const checks = await checkPendingUnusedMints({ callOrgTool, ledgerPath, cardholderIds });
  if (checks.length === 0) {
    record('no earlier unused mints awaiting reclaim');
    return;
  }
  const lost: string[] = [];
  for (const { entry, verdict } of checks) {
    const label = `earlier mint ${entry.cardId} (${hours(verdict.ageMs)} old)`;
    switch (verdict.kind) {
      case 'settled':
        record(`${label} ${verdict.status} in full: released ${usd(verdict.releasedCents)}`);
        break;
      case 'waiting':
        console.log(`  PENDING ${label} still ${verdict.status}; deadline ${RECLAIM_DEADLINE}`);
        break;
      case 'unobservable':
        lost.push(`${label}: reclaim remains unverified: ${verdict.reason}`);
        break;
      case 'overdue': {
        const overdue =
          `${label} still ${verdict.status} past the ${RECLAIM_DEADLINE} reclaim deadline; ` +
          `provider row: ${JSON.stringify(verdict.row ?? null)}`;
        if (overdueReclaimSkipped()) {
          console.warn(`  SKIP ${overdue} (TREASURY_RAILS_SKIP_OVERDUE_RECLAIM=1)`);
          break;
        }
        lost.push(overdue);
        break;
      }
      case 'failed':
        lost.push(
          `${label}: ${verdict.reason}; provider row: ${JSON.stringify(verdict.row ?? null)}`
        );
        break;
    }
  }
  if (lost.length > 0) {
    assert.fail(
      `unused mint(s) never returned to the pool (recorded in ${ledgerPath}):\n  ${lost.join('\n  ')}`
    );
  }
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
    wallet = await readAgentCardOrgWallet(callOrgTool);
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
    { action: 'transfer', transferCents: 34_088, fiatShortfallCents: 0 },
    'a $159.12 pool must top up to exactly the $500 target'
  );
  assert.equal(fiatPullEnabled(), false, 'broken Brex→Coinbase rail must remain hard-disabled');
  assert.equal(resolveFiatSource(), undefined, 'production binder must not expose a bank source');
  record('USDC planner and Brex hard kill have the expected decisions');

  // ── Leg 3: the AgentCard money loop (REAL, on sandbox) ───────────────────────────────────────
  const cardholders =
    (
      (await callOrgTool('list_cardholders', {})) as {
        structuredContent?: { cardholders?: Array<{ id: string }> };
      }
    ).structuredContent?.cardholders ?? [];
  assert.ok(cardholders.length > 0, 'sandbox org has no cardholders to test with');
  const paymentBenchmarkCardholderId = await resolveBenchmarkCardholderId();
  const cardholderId = await waitForIdleTreasuryRailCardholder(
    cardholders.map((cardholder) => cardholder.id),
    paymentBenchmarkCardholderId,
    callOrgTool,
    { timeoutMs: 5 * 60_000, pollMs: 15_000 }
  );
  assert.ok(
    cardholderId !== undefined,
    'sandbox org had no idle cardholder for the reclaim proof within 5 minutes'
  );
  record(
    cardholderId === paymentBenchmarkCardholderId
      ? `reclaim proof on shared payment-benchmark cardholder ${cardholderId} (no other idle cardholder)`
      : `reclaim proof on cardholder ${cardholderId}, away from the payment-benchmark cardholder`
  );

  const preSweepCents = await sweepResidualHeadroom();
  if (preSweepCents > 0) {
    record(`pre-mint residual sweep returned ${usd(preSweepCents)} to the pool`);
  } else {
    record('pre-mint residual sweep found nothing idle');
  }

  // After the sweep: recovering residual is what usually flips an earlier mint to reclaimed.
  const ledgerPath = pendingMintLedgerPath();
  await checkEarlierUnusedMints(new Set(cardholders.map((holder) => holder.id)), ledgerPath);

  const mintCents = 1_300;
  const createdCardIds = new Set<string>();
  let provedPoolMint = false;
  for (let mintAttempt = 1; mintAttempt <= 2; mintAttempt += 1) {
    if (mintAttempt > 1) await sweepResidualHeadroom();
    const minted = (await callOrgTool('create_card', {
      cardholder_id: cardholderId,
      amount_cents: mintCents,
      funds_source: 'company_flow',
      idempotency_key: `blackbox-treasury-${Date.now()}-${mintAttempt}`,
    })) as { structuredContent?: { cardId?: string } };
    const cardId = minted.structuredContent?.cardId;
    assert.ok(cardId !== undefined, 'create_card returned no cardId');
    createdCardIds.add(cardId);
    record(`minted ${usd(mintCents)} card ${cardId}`);

    let cardClosed = false;
    try {
      // Observation only: the provider does not promise immediate transfer visibility.
      try {
        const issued = await readCardTransfer(cardId);
        console.log(
          `  issuance funding: found=${issued !== undefined} amount=${issued?.amountCents ?? 'missing'} ` +
            `transferred=${issued?.transferredCents ?? 'missing'} ` +
            `released=${issued?.releasedCents ?? 'missing'} status=${issued?.status ?? 'missing'}`
        );
      } catch {
        console.log('  issuance funding: read unavailable; terminal assertions remain required');
      }
      // An aggregate pool balance delta cannot prove what this card drew.
      const closed = (await callOrgTool('close_card', { card_id: cardId })) as {
        structuredContent?: { status?: string };
      };
      assert.equal(closed.structuredContent?.status, 'CLOSED', 'close_card did not report CLOSED');
      cardClosed = true;
      record('closed the card unused');

      // Keep recovering while this exact card's transfer settles. Another
      // cardholder's recover_funds yield is not evidence for this transfer.
      const transfer = await waitForUnusedMintSettled(cardId, mintCents);
      assert.ok(transfer !== undefined, `no company-wallet transfer listed for ${cardId}`);
      assert.ok(
        transfer.transferredCents >= 0 && transfer.transferredCents <= mintCents,
        `transfer for ${cardId} reported an invalid pool debit ${transfer.transferredCents}`
      );
      const outcome = classifyUnusedMintTransfer(transfer, mintCents);
      if (outcome.kind === 'failed') {
        assert.fail(
          `transfer for ${cardId}: ${outcome.reason} — the full unused amount must return to the ` +
            `pool; provider row: ${JSON.stringify(transfer.raw)}`
        );
      }
      if (outcome.kind === 'settled') {
        record(
          `transfer ${outcome.status} in full: released ${usd(outcome.releasedCents)} of ${usd(mintCents)}`
        );
      } else {
        const mintedAt = transfer.raw.created_at;
        assert.ok(typeof mintedAt === 'string', `transfer for ${cardId} has no created_at`);
        recordPendingMint(ledgerPath, {
          cardId,
          transferId: String(transfer.raw.id),
          cardholderId,
          mintCents,
          mintedAt,
        });
        console.log(
          `  PENDING transfer for ${cardId} still ${outcome.status} after the in-run wait; later ` +
            `runs fail it if it is not reclaimed within ${RECLAIM_DEADLINE} of the mint ` +
            `(recorded in ${ledgerPath})`
        );
      }
      if (transfer.transferredCents === mintCents) {
        provedPoolMint = true;
        record('mint drew from the pool');
        break;
      }
      record(
        `mint drew ${usd(transfer.transferredCents)} from the pool and netted remaining cardholder headroom; retrying direct pool proof`
      );
    } finally {
      try {
        if (!cardClosed) await callOrgTool('close_card', { card_id: cardId });
      } finally {
        // The sandbox cardholder is shared. Cleanup may close only cards this test created.
        const cleaned = await cleanupTreasuryRailCards(cardholderId, createdCardIds, callOrgTool);
        if (cleaned > 0) record(`cleanup: closed ${cleaned} lingering open card(s)`);
      }
    }
  }
  assert.ok(provedPoolMint, 'both company_flow mints netted existing headroom instead of the pool');

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
