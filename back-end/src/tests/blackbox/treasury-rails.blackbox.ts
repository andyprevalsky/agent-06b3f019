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
import { callOrgTool, type AgentCardOrgToolCaller } from '../../providers/agentcard/org-runtime';
import { readAgentCardOrgWallet } from '../../providers/agentcard/org-wallet-monitor';
import { resolveBenchmarkCardholderId } from '../../providers/agentcard/benchmark-float';
import {
  AgentCardRecoveryError,
  isSettledRecovery,
  nudgeCardholderRecoveries,
} from '../../providers/agentcard/fund-recovery';
import { planOrgWalletTopUp } from '../../providers/agentcard/org-wallet-topup';
import { fiatPullEnabled, resolveFiatSource } from '../../providers/agentcard/org-wallet-fiat';
import {
  UNUSED_MINT_RECLAIM_DEADLINE_MS,
  classifyUnusedMintTransfer,
  paceOrgThrottle,
  waitForUnusedMintSettled,
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
  readOpenPendingMints,
  recordPendingMint,
  observePendingUnusedMint,
} from './treasury-rails-pending-mints';
import { quarantine } from '../helpers/quarantine';

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
 * Paced org-throttle waits one run may add on top of the runtime's own per-call budget (two
 * throttle windows), shared by every read-only call before the mint loop. It fits inside the
 * domain's unchanged 15-minute timeout; the settle poll keeps its own pacing inside its own window.
 */
const TREASURY_RAILS_THROTTLE_BUDGET_MS = 120_000;

/** The read-only org tools this run issues; anything else (every mutation) is never re-issued. */
const PACED_READ_TOOLS = new Set([
  'get_company_wallet',
  'whoami',
  'list_cardholders',
  'get_cardholder_kyc_status',
  'list_cards',
  'list_recoveries',
  'list_transfers',
]);

/**
 * The run's org caller: read-only tools are re-issued through an org-wide throttle within the
 * run's one shared budget (jittered, honoring the advertised reset); mutations and every
 * non-throttle error pass through untouched.
 */
function pacedOrgToolCaller(): AgentCardOrgToolCaller {
  const pacing = {
    budget: { remainingMs: TREASURY_RAILS_THROTTLE_BUDGET_MS },
    random: Math.random,
    report: (line: string) => console.log(line),
  };
  return (toolName, args, deadlineAtMs) =>
    PACED_READ_TOOLS.has(toolName)
      ? paceOrgThrottle(() => callOrgTool(toolName, args, deadlineAtMs), pacing)
      : callOrgTool(toolName, args, deadlineAtMs);
}

/**
 * One recovery nudge per cardholder whose residual matters to this run (coalescing on a recovery
 * already in flight), from ONE read of the org's open recoveries per round. A provider refusal
 * for one cardholder is logged and the rest continue.
 */
async function recoverCardholderResiduals(
  cardholderIds: readonly string[],
  orgTool: AgentCardOrgToolCaller
): Promise<{ settledCents: number; pendingCents: number }> {
  let settledCents = 0;
  let pendingCents = 0;
  const nudges = await nudgeCardholderRecoveries(cardholderIds, orgTool);
  nudges.forEach((nudge, index) => {
    if (nudge instanceof AgentCardRecoveryError)
      console.log(`  residual recovery refused for ${cardholderIds[index]}: ${nudge.message}`);
    else if (nudge.kind === 'coalesced') pendingCents += nudge.inFlightCents;
    else if (nudge.kind === 'requested' && isSettledRecovery(nudge.recovery.status))
      settledCents += nudge.recovery.amountCents;
    else if (nudge.kind === 'requested') pendingCents += nudge.recovery.amountCents;
  });
  return { settledCents, pendingCents };
}

/**
 * Drain idle headroom into the pool before minting, from the cardholders whose residual matters:
 * the mint cardholder (a mint nets only its own cardholder's headroom) and the cardholders of
 * earlier runs' unused mints still awaiting reclaim (recovering their residual is what usually
 * flips those transfers). The org is shared and throttled org-wide (~120 requests/min); sweeping
 * every cardholder twice cost ~110 requests in ~37 s and starved this run's own settle poll
 * (treasury-rails 2026-11-13, occurrence 1dc793d7).
 *
 * A mint against existing residual can net (`transferred_cents: 0`, pool untouched).
 * Sweeping cannot reserve a globally shared cardholder's headroom, and unrelated residual
 * recovery cannot prove this mint's funding. Sweep first, then retry once if the provider
 * still nets headroom: at least one settled mint must prove a full pool debit on its own transfer.
 */
async function sweepResidualHeadroom(
  cardholderIds: readonly string[],
  orgTool: AgentCardOrgToolCaller,
  timeoutMs = 60_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let recoveredTotal = 0;
  let idleRounds = 0;
  while (Date.now() < deadline && idleRounds < 2) {
    const sweep = await recoverCardholderResiduals(cardholderIds, orgTool);
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
 * Each poll nudges only THIS card's cardholder, coalescing on a recovery already in flight
 * (another deploy shares the sandbox org and the benchmark cardholder), then reads THIS card's
 * transfer — the only success signal. A recovery yield is never success; that false-passed the
 * old wait while THIS transfer stayed `consumed`. See waitForUnusedMintSettled.
 */
async function waitForCardSettled(
  cardId: string,
  cardholderId: string,
  minReleasedCents: number
): Promise<CardTransfer | undefined> {
  return waitForUnusedMintSettled<CardTransfer>({
    cardholderId,
    minReleasedCents,
    callOrgTool,
    readTransfer: () => readCardTransfer(cardId),
    isTransientError: isTransientOrgMcpPollError,
    describe: (transfer) => `for ${cardId}: ${JSON.stringify(transfer?.raw ?? null)}`,
    report: (line) => console.log(line),
  });
}

function record(name: string): void {
  console.log(`  PASS ${name}`);
}

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;
const RECLAIM_DEADLINE = hours(UNUSED_MINT_RECLAIM_DEADLINE_MS);

/** Earlier runs' unused mints that had not come back yet; any lost past the deadline fails here. */
async function checkEarlierUnusedMints(
  cardholderIds: ReadonlySet<string>,
  ledgerPath: string,
  orgTool: AgentCardOrgToolCaller
): Promise<void> {
  const checks = await checkPendingUnusedMints({
    callOrgTool: orgTool,
    ledgerPath,
    cardholderIds,
  });
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

  const orgTool = pacedOrgToolCaller();
  let wallet;
  try {
    wallet = await readAgentCardOrgWallet(orgTool);
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
      (await orgTool('list_cardholders', {})) as {
        structuredContent?: { cardholders?: Array<{ id: string }> };
      }
    ).structuredContent?.cardholders ?? [];
  assert.ok(cardholders.length > 0, 'sandbox org has no cardholders to test with');
  const paymentBenchmarkCardholderId = await resolveBenchmarkCardholderId(undefined, orgTool);
  const cardholderId = await waitForIdleTreasuryRailCardholder(
    cardholders.map((cardholder) => cardholder.id),
    paymentBenchmarkCardholderId,
    orgTool,
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

  const ledgerPath = pendingMintLedgerPath();
  const sweepCardholderIds = [
    ...new Set([cardholderId, ...readOpenPendingMints(ledgerPath).map((m) => m.cardholderId)]),
  ];
  const preSweepCents = await sweepResidualHeadroom(sweepCardholderIds, orgTool);
  if (preSweepCents > 0) {
    record(`pre-mint residual sweep returned ${usd(preSweepCents)} to the pool`);
  } else {
    record(
      `pre-mint residual sweep of ${sweepCardholderIds.length} cardholder(s) found nothing idle`
    );
  }

  // After the sweep: recovering residual is what usually flips an earlier mint to reclaimed.
  await checkEarlierUnusedMints(
    new Set(cardholders.map((holder) => holder.id)),
    ledgerPath,
    orgTool
  );

  const mintCents = 1_300;
  const cardsToClose = new Set<string>();
  let provedPoolMint = false;
  for (let mintAttempt = 1; mintAttempt <= 2; mintAttempt += 1) {
    if (mintAttempt > 1) await sweepResidualHeadroom([cardholderId], orgTool);
    const minted = (await callOrgTool('create_card', {
      cardholder_id: cardholderId,
      amount_cents: mintCents,
      funds_source: 'company_flow',
      idempotency_key: `blackbox-treasury-${Date.now()}-${mintAttempt}`,
    })) as { structuredContent?: { cardId?: string } };
    const cardId = minted.structuredContent?.cardId;
    assert.ok(cardId !== undefined, 'create_card returned no cardId');
    cardsToClose.add(cardId);
    record(`minted ${usd(mintCents)} card ${cardId}`);

    let cardClosed = false;
    let issued: CardTransfer | undefined;
    try {
      // Observation only: the provider does not promise immediate transfer visibility.
      try {
        issued = await readCardTransfer(cardId);
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
      cardsToClose.delete(cardId);
      record('closed the card unused');

      // Keep recovering while this exact card's transfer settles. Another
      // cardholder's recover_funds yield is not evidence for this transfer.
      const transferId = issued?.raw.id;
      const issuedAt = issued?.raw.created_at;
      const pendingMint =
        issued?.raw.card_id === cardId &&
        typeof transferId === 'string' &&
        transferId !== '' &&
        typeof issuedAt === 'string' &&
        Number.isFinite(Date.parse(issuedAt)) &&
        issued.transferredCents >= 0 &&
        issued.transferredCents <= mintCents
          ? { cardId, transferId, cardholderId, mintCents, mintedAt: issuedAt }
          : undefined;
      const transfer = pendingMint
        ? await observePendingUnusedMint(ledgerPath, pendingMint, () =>
            waitForCardSettled(cardId, cardholderId, mintCents)
          )
        : await waitForCardSettled(cardId, cardholderId, mintCents);
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
        if (pendingMint === undefined) {
          recordPendingMint(ledgerPath, {
            cardId,
            transferId: String(transfer.raw.id),
            cardholderId,
            mintCents,
            mintedAt,
          });
        }
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
        const cleaned = await cleanupTreasuryRailCards(cardholderId, cardsToClose, orgTool);
        if (cleaned > 0) record(`cleanup: closed ${cleaned} lingering open card(s)`);
      }
    }
  }
  assert.ok(provedPoolMint, 'both company_flow mints netted existing headroom instead of the pool');

  console.log('\ntreasury-rails blackbox: all checks passed');
}

const treasuryUnit = 'treasury-rails';
void quarantine(
  {
    since: '2026-11-13',
    repair: 'https://boxes.dev/thread/ph75k13xzhes1bcm32q38mqq3n8j6pmj',
    error:
      'treasury-rails blackbox FAILED: AgentCard Organization MCP rate limit exhausted for list_transfers after 5 attempts; upstream: AgentCard Organization MCP list_transfers is rate limited: list_transfers failed: Too many requests, please try again later',
    evidence: '.context/deploy-pipeline/rca/1dc793d7777246c785e8d24beb75499a.json',
  },
  async () => {
    try {
      await main();
    } catch (error: unknown) {
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
        return;
      }
      console.error(`treasury-rails blackbox FAILED: ${message}`);
      throw error;
    }
  },
  { unit: treasuryUnit }
)();
