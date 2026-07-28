#!/usr/bin/env tsx
/**
 * Bulk-import a hand-curated roster of people into Waitlist.
 *
 * Usage:
 *   npx tsx scripts/import-waitlist-roster.ts <roster.tsv>            # dry run
 *   npx tsx scripts/import-waitlist-roster.ts <roster.tsv> --apply    # write
 *
 * Roster format: tab-separated, one person per line, no header:
 *   name <TAB> email <TAB> phone <TAB> category
 * Email and phone may each be blank, but at least one is required. Blank lines
 * and `#` comments are ignored.
 *
 * The roster file is contact PII — keep it out of the repo (e.g. under
 * .context/, which is gitignored). This script hardcodes no roster data.
 *
 * Planning is pure and lives in src/domains/waitlist/rosterImport.ts; this
 * script is the DB-facing shell around it. Default mode is a read-only dry run.
 * Pass --apply to write atomically.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

import { parseRoster, planRosterImport } from '../src/domains/waitlist/rosterImport';

function writeLine(value: string) {
  process.stdout.write(`${value}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const rosterPath = args.find((arg) => !arg.startsWith('--'));

  if (!rosterPath) {
    writeLine('Usage: npx tsx scripts/import-waitlist-roster.ts <roster.tsv> [--apply]');
    process.exitCode = 1;
    return;
  }

  const { entries, errors } = parseRoster(readFileSync(rosterPath, 'utf8'));
  if (errors.length > 0) {
    writeLine(`Roster has ${errors.length} problem(s):`);
    for (const error of errors) writeLine(`  ! ${error}`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.waitlist.findMany({
      select: { id: true, email: true, phone: true },
    });
    const plan = planRosterImport(entries, existing);

    writeLine(`Roster entries: ${entries.length}`);
    writeLine(`Existing waitlist rows: ${existing.length}`);
    writeLine('');

    writeLine(`Creates (${plan.creates.length}):`);
    for (const create of plan.creates) {
      writeLine(
        `  + ${create.name} | ${create.email ?? '-'} | ${create.phone ?? '-'} | ${create.variant}`
      );
    }
    writeLine('');

    writeLine(`Updates (${plan.updates.length}):`);
    for (const update of plan.updates) {
      const fields = Object.entries(update.data)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      writeLine(`  ~ ${update.name} (${update.id}) | ${fields}`);
    }
    writeLine('');

    writeLine(`Skipped (${plan.skipped.length}):`);
    for (const skip of plan.skipped) {
      writeLine(`  = ${skip.name} | ${skip.reason}`);
    }
    writeLine('');

    if (!apply) {
      writeLine('Dry run. Re-run with --apply to write.');
      return;
    }

    await prisma.$transaction(async (tx) => {
      for (const update of plan.updates) {
        await tx.waitlist.update({ where: { id: update.id }, data: update.data });
      }
      if (plan.creates.length > 0) {
        await tx.waitlist.createMany({ data: plan.creates, skipDuplicates: true });
      }
    });

    writeLine(`Applied: ${plan.creates.length} created, ${plan.updates.length} updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.exitCode = 1;
  writeLine(`Failed: ${error instanceof Error ? error.message : String(error)}`);
});
