#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Wire USD from Brex to the Coinbase treasury — the fiat leg of the funding rail.
 *
 * This is the same `transferToCoinbase` the hourly replenish cron uses, exposed as a CLI so a
 * human can execute (and prove) the wire leg without enabling the automation. It is the
 * counterpart to `treasury-send.ts`, which covers the next hop (Coinbase USDC -> org wallet).
 *
 * Destination is resolved the SAME way the rail resolves it — the Brex payment instrument named
 * by `BREX_COINBASE_COUNTERPARTY_ID` — so this cannot drift from what the automation would do.
 * It never accepts an instrument id as an argument: a hand-typed instrument is the one mistake in
 * this flow that moves real money to the wrong bank account.
 *
 * Usage:
 *   npx tsx scripts/brex-wire.ts --amount-cents 1000            # dry run, prints the plan
 *   npx tsx scripts/brex-wire.ts --amount-cents 1000 --confirm  # actually wires
 *   npx tsx scripts/brex-wire.ts --status                       # recent wires + settlement state
 */

import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import {
  createBrexTreasury,
  loadBrexConfig,
  railsAreCompatible,
} from '../src/providers/brex/treasury';

/** Refuse larger wires without an explicit override; this is a verification tool, not a treasury UI. */
const SANITY_MAX_CENTS = 100_000;

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

interface BrexTransferSummary {
  id?: string;
  status?: string;
  display_name?: string;
  external_memo?: string;
  payment_type?: string;
  created_at?: string;
  estimated_delivery_date?: string;
  amount?: { amount?: number };
}

/**
 * Print recent outbound transfers with their settlement state.
 *
 * A wire is accepted instantly but settles asynchronously, so `transferId` alone never proves the
 * money landed. This is the read-only answer to "did it actually go through?" without needing the
 * Brex dashboard.
 */
async function printRecentTransfers(baseUrl: string, apiToken: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/transfers?limit=10`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!response.ok) {
    console.error(`Brex returned HTTP ${response.status} listing transfers.`);
    process.exit(1);
  }
  const body = (await response.json()) as { items?: BrexTransferSummary[] };
  console.log('  status      amount     created     eta         payee / memo');
  for (const item of body.items ?? []) {
    const amount = usd(item.amount?.amount ?? 0);
    console.log(
      `  ${(item.status ?? '?').padEnd(11)} ${amount.padStart(9)}  ` +
        `${(item.created_at ?? '?').padEnd(11)} ${(item.estimated_delivery_date ?? '-').padEnd(11)} ` +
        `${item.display_name ?? '?'} — ${item.external_memo ?? ''}`
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--status')) {
    const statusConfig = loadBrexConfig();
    if (statusConfig === undefined) {
      console.error('Brex is not configured (BREX_API_TOKEN missing in back-end/.env).');
      process.exit(1);
    }
    await printRecentTransfers(statusConfig.baseUrl, statusConfig.apiToken);
    return;
  }

  const cents = Number.parseInt(argValue('--amount-cents') ?? '', 10);
  if (!Number.isInteger(cents) || cents <= 0) {
    console.error('Usage: --amount-cents <positive integer> [--confirm] [--allow-large]');
    process.exit(2);
  }
  if (cents > SANITY_MAX_CENTS && !process.argv.includes('--allow-large')) {
    console.error(`Refusing ${usd(cents)} > ${usd(SANITY_MAX_CENTS)} without --allow-large.`);
    process.exit(2);
  }

  const config = loadBrexConfig();
  if (config === undefined) {
    console.error('Brex is not configured (BREX_API_TOKEN missing in back-end/.env).');
    process.exit(1);
  }
  if (config.coinbaseCounterpartyId === undefined) {
    console.error('BREX_COINBASE_COUNTERPARTY_ID is not set; refusing to guess a destination.');
    process.exit(1);
  }
  const brex = createBrexTreasury(config);

  // Resolve and PRINT the destination rail before anything moves. `transferToCoinbase` fails
  // closed on a mismatch too, but showing it here means the operator confirms the actual
  // instrument rather than trusting an env var they cannot see.
  const instrumentRail = await brex.getCounterpartyRail();
  if (instrumentRail === undefined) {
    console.error(
      `BREX_COINBASE_COUNTERPARTY_ID ${config.coinbaseCounterpartyId} matches no Brex payment ` +
        'instrument. Refusing to send.'
    );
    process.exit(1);
  }
  const railOk = railsAreCompatible(instrumentRail, config.processingType);
  const availableCents = await brex.getAvailableCents();

  console.log(`  instrument     : ${config.coinbaseCounterpartyId}`);
  console.log(`  instrument rail: ${instrumentRail}`);
  console.log(`  transfer rail  : ${config.processingType}`);
  console.log(`  rails match    : ${railOk ? 'YES' : 'NO'}`);
  console.log(`  brex available : ${usd(availableCents)}`);
  console.log(`  amount         : ${usd(cents)}`);

  if (!railOk) {
    console.error(
      `\nRail mismatch: instrument is ${instrumentRail} but BREX_TRANSFER_PROCESSING_TYPE is ` +
        `${config.processingType}. Refusing to send.`
    );
    process.exit(1);
  }
  if (availableCents < cents) {
    console.error(`\nInsufficient funds: have ${usd(availableCents)}, need ${usd(cents)}.`);
    process.exit(1);
  }
  if (!process.argv.includes('--confirm')) {
    console.log('\nDRY RUN — nothing sent. Re-run with --confirm to execute.');
    return;
  }

  const idempotencyKey = randomUUID();
  console.log(`\nWiring (idempotency_key=${idempotencyKey})...`);
  const { transferId } = await brex.transferToCoinbase({
    cents,
    idempotencyKey,
    description: 'Rose treasury float replenish',
  });
  console.log(`  transfer id    : ${transferId}`);
  console.log(
    '\nWire settlement is asynchronous (same-day to 1 business day). Confirm arrival with:\n' +
      '  npx tsx scripts/treasury-send.ts --amount-cents 100   (prints the Coinbase float)'
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  // `possiblySent` distinguishes "definitely not sent" from "may already be moving". Printing only
  // the message makes an ambiguous failure look clean, the operator re-runs with --confirm, and the
  // retry carries a NEW idempotency key — so Brex applies no dedup and the wire goes out twice.
  if ((error as { possiblySent?: boolean })?.possiblySent === true) {
    console.error(
      '\n⚠️  THIS WIRE MAY ALREADY BE IN FLIGHT. Do NOT re-run with --confirm.\n' +
        '   A retry mints a new idempotency key, so Brex will NOT de-duplicate it and you would\n' +
        '   wire twice. Check first:\n' +
        '     npx tsx scripts/brex-wire.ts --status\n' +
        '   Only re-send if the transfer is absent from that list.'
    );
  }
  process.exit(1);
});
