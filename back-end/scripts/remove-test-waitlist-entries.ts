#!/usr/bin/env tsx
/**
 * Remove unmistakable fixture contacts from Waitlist only.
 *
 * Customer accounts and their agent history are never touched. The shared
 * classifier also prevents the customer-contact backfill from recreating these
 * rows. Default mode is read-only; --apply writes a recovery snapshot first.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { isWaitlistTestContact } from '../src/domains/waitlist/contactBackfill';

type WaitlistRow = Awaited<ReturnType<typeof loadRows>>[number];

function writeLine(value: string) {
  process.stdout.write(`${value}\n`);
}

async function loadRows(prisma: PrismaClient) {
  return prisma.waitlist.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      variant: true,
      referralCode: true,
      createdAt: true,
      invitedAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

function testRows(rows: WaitlistRow[]): WaitlistRow[] {
  return rows.filter((row) =>
    isWaitlistTestContact({
      name: row.name,
      email: row.email,
      phone: row.phone,
    })
  );
}

function printSummary(rows: WaitlistRow[], mode: 'APPLY' | 'DRY RUN') {
  const variants = new Map<string, number>();
  for (const row of rows) {
    const variant = row.variant ?? '(none)';
    variants.set(variant, (variants.get(variant) ?? 0) + 1);
  }
  writeLine(`Mode: ${mode}`);
  writeLine(`Fixture waitlist rows matched: ${rows.length}`);
  for (const [variant, count] of [...variants].sort((left, right) => right[1] - left[1])) {
    writeLine(`  ${variant}: ${count}`);
  }
}

function writeRecoverySnapshot(rows: WaitlistRow[]): string {
  const contextDirectory = resolve(process.cwd(), '..', '.context');
  mkdirSync(contextDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(contextDirectory, `removed-test-waitlist-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const matches = testRows(await loadRows(prisma));
    printSummary(matches, apply ? 'APPLY' : 'DRY RUN');
    if (!apply) {
      writeLine('Dry run complete. Re-run with --apply to delete these exact rows.');
      return;
    }

    const snapshotPath = writeRecoverySnapshot(matches);
    const result = await prisma.waitlist.deleteMany({
      where: { id: { in: matches.map((row) => row.id) } },
    });
    if (result.count !== matches.length) {
      throw new Error(`Expected to delete ${matches.length} rows, deleted ${result.count}`);
    }

    const remaining = testRows(await loadRows(prisma));
    if (remaining.length !== 0) {
      throw new Error(`${remaining.length} fixture waitlist rows remain after cleanup`);
    }
    writeLine(`Deleted ${result.count} fixture waitlist rows.`);
    writeLine(`Recovery snapshot: ${snapshotPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
