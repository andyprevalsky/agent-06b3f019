#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Send USDC from the Coinbase treasury to the AgentCard org (pool) wallet.
 *
 * This is the same `transferUsdcCents` the automatic top-up uses, exposed as a CLI so a human can
 * execute (and prove) the send leg without enabling the automation. Useful for the first live
 * verification and for manual recovery if the rail is ever halted.
 *
 * Destination is resolved the SAME way the rail resolves it — live MCP `get_company_wallet`
 * first, `AGENTCARD_ORG_WALLET_DEPOSIT_ADDRESS` only as a fallback — so this cannot drift from
 * what the automation would do. It never accepts an address as an argument: a hand-typed address
 * is the one mistake in this flow that is unrecoverable.
 *
 * Usage:
 *   npx tsx scripts/treasury-send.ts --amount-cents 100            # dry run, prints the plan
 *   npx tsx scripts/treasury-send.ts --amount-cents 100 --confirm  # actually sends
 */

import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import { loadCoinbaseTreasuryConfig } from '../src/providers/coinbase/config';
import { createCoinbaseTreasury } from '../src/providers/coinbase/treasury';
import { AgentCardOrgRuntime } from '../src/providers/agentcard/org-runtime';
import { extractAgentCardOrgWallet } from '../src/providers/agentcard/org-wallet-monitor';

/**
 * Resolve the LIVE org wallet, not whatever `AGENTCARD_ORG_OAUTH_CLIENT_ID` happens to point at.
 *
 * Locally that variable holds SANDBOX credentials (prod holds live), and the sandbox wallet has
 * `deposit_address: null`. Reading the sandbox wallet while sending real USDC is how you send
 * live funds to a wrong or absent destination, so this prefers the explicit `_LIVE` credentials
 * and the caller asserts `livemode` before anything moves.
 */
function useLiveOrgCredentials(): void {
  const liveId = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE?.trim();
  const liveSecret = process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET_LIVE?.trim();
  if (liveId && liveSecret) {
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = liveId;
    process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = liveSecret;
  }
}

/** Refuse larger sends without an explicit override; this is a verification tool, not a treasury UI. */
const SANITY_MAX_CENTS = 50_000;

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const cents = Number.parseInt(argValue('--amount-cents') ?? '', 10);
  if (!Number.isInteger(cents) || cents <= 0) {
    console.error('Usage: --amount-cents <positive integer> [--confirm] [--allow-large]');
    process.exit(2);
  }
  if (cents > SANITY_MAX_CENTS && !process.argv.includes('--allow-large')) {
    console.error(`Refusing ${usd(cents)} > ${usd(SANITY_MAX_CENTS)} without --allow-large.`);
    process.exit(2);
  }

  const config = loadCoinbaseTreasuryConfig();
  if (config === undefined) {
    console.error('Coinbase treasury is not configured (COINBASE_TREASURY_API_KEY_ID/_SECRET).');
    process.exit(1);
  }
  const treasury = createCoinbaseTreasury(config);

  useLiveOrgCredentials();
  const wallet = extractAgentCardOrgWallet(
    await new AgentCardOrgRuntime().callTool('get_company_wallet', {})
  );
  // Hard stop: this script moves REAL USDC. If we somehow resolved a sandbox wallet, its deposit
  // address is null or belongs to a different environment — never send against it.
  if (!wallet.livemode) {
    console.error(
      'Resolved a SANDBOX org wallet (livemode=false). Refusing to send live USDC.\n' +
        'Set AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE / _SECRET_LIVE in back-end/.env.'
    );
    process.exit(1);
  }
  const destination =
    wallet.depositAddress ?? process.env.AGENTCARD_ORG_WALLET_DEPOSIT_ADDRESS?.trim();
  if (destination === undefined || destination === '') {
    console.error('Org wallet reported no deposit address; refusing to guess one.');
    process.exit(1);
  }

  const floatCents = await treasury.getUsdcBalanceCents();
  console.log(`  network        : ${config.network}`);
  console.log(`  treasury float : ${usd(floatCents)}`);
  console.log(`  org wallet     : ${usd(wallet.availableCents)} (livemode=${wallet.livemode})`);
  console.log(`  destination    : ${destination}`);
  console.log(`  amount         : ${usd(cents)}`);

  if (floatCents < cents) {
    console.error(`\nInsufficient float: have ${usd(floatCents)}, need ${usd(cents)}.`);
    process.exit(1);
  }
  if (!process.argv.includes('--confirm')) {
    console.log('\nDRY RUN — nothing sent. Re-run with --confirm to execute.');
    return;
  }

  // Coinbase requires a bare UUID; a prefixed key is rejected with "Param: Idem".
  const idempotencyKey = randomUUID();
  console.log(`\nSending (idem=${idempotencyKey})...`);
  const { transactionHash, onchainHash } = await treasury.transferUsdcCents({
    toAddress: destination,
    cents,
    idempotencyKey,
  });
  console.log(`  transfer id    : ${transactionHash}`);
  if (onchainHash === undefined) {
    console.log('  onchain hash   : not yet broadcast — appears on a follow-up read');
  } else {
    console.log(`  onchain hash   : ${onchainHash}`);
    console.log(`  explorer       : https://basescan.org/tx/${onchainHash}`);
  }
  console.log('\nOrg wallet credit is asynchronous; re-read the wallet in a minute to confirm.');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
