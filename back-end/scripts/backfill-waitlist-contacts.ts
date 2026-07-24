#!/usr/bin/env tsx
/**
 * Backfill every customer-owned phone/email into Waitlist.
 *
 * Sources:
 *   - public.User
 *   - Supabase auth.users (when that schema is present)
 *
 * Explicitly excluded:
 *   - Person (a user's third-party address book)
 *   - AgentIdentity (synthetic agent contact details)
 *   - EmailIntegrationCredential (connected mailbox metadata)
 *
 * Default mode is a read-only dry run. Pass --apply to write atomically.
 */

import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';

import {
  planWaitlistContactBackfill,
  type WaitlistBackfillExistingRow,
  type WaitlistContactSource,
} from '../src/domains/waitlist/contactBackfill';

interface AuthUserRow {
  sourceId: string;
  email: string | null;
  phone: string | null;
  seenAt: Date;
  metadata: unknown;
}

function writeLine(value: string) {
  process.stdout.write(`${value}\n`);
}

function metadataName(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  for (const key of ['full_name', 'name']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const first = typeof record.first_name === 'string' ? record.first_name.trim() : '';
  const last = typeof record.last_name === 'string' ? record.last_name.trim() : '';
  const combined = `${first} ${last}`.trim();
  return combined === '' ? null : combined;
}

async function authUsersAvailable(prisma: PrismaClient): Promise<boolean> {
  const tableName = 'auth.users';
  const rows = await prisma.$queryRaw<Array<{ available: boolean }>>`
    SELECT to_regclass(${tableName}) IS NOT NULL AS available
  `;
  return rows[0]?.available ?? false;
}

async function loadSources(prisma: PrismaClient): Promise<WaitlistContactSource[]> {
  const users = await prisma.user.findMany({
    where: {
      OR: [{ email: { not: null } }, { phone: { not: null } }],
    },
    select: {
      userId: true,
      name: true,
      email: true,
      phone: true,
      createdAt: true,
    },
  });

  const sources: WaitlistContactSource[] = users.map((user) => ({
    sourceId: user.userId,
    name: user.name,
    email: user.email,
    phone: user.phone,
    seenAt: user.createdAt,
  }));

  if (await authUsersAvailable(prisma)) {
    const authUsers = await prisma.$queryRaw<AuthUserRow[]>`
      SELECT
        id::text AS "sourceId",
        email,
        phone,
        created_at AS "seenAt",
        raw_user_meta_data AS metadata
      FROM auth.users
      WHERE NULLIF(BTRIM(email), '') IS NOT NULL
         OR NULLIF(BTRIM(phone), '') IS NOT NULL
    `;
    sources.push(
      ...authUsers.map((user) => ({
        sourceId: user.sourceId,
        name: metadataName(user.metadata),
        email: user.email,
        phone: user.phone,
        seenAt: user.seenAt,
      }))
    );
  }

  return sources;
}

async function loadExistingRows(prisma: PrismaClient): Promise<WaitlistBackfillExistingRow[]> {
  return prisma.waitlist.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      variant: true,
      createdAt: true,
    },
  });
}

function printPlan(
  plan: ReturnType<typeof planWaitlistContactBackfill>,
  mode: 'APPLY' | 'DRY RUN'
) {
  const emailEnrichments = plan.updates.filter((update) => update.data.email !== undefined).length;
  const phoneEnrichments = plan.updates.filter((update) => update.data.phone !== undefined).length;
  const nameEnrichments = plan.updates.filter((update) => update.data.name !== undefined).length;
  writeLine(`Mode: ${mode}`);
  writeLine(`Unique customer emails: ${plan.sourceEmailCount}`);
  writeLine(`Unique customer phones: ${plan.sourcePhoneCount}`);
  writeLine(`Missing emails before run: ${plan.missingEmailCount}`);
  writeLine(`Missing phones before run: ${plan.missingPhoneCount}`);
  writeLine(
    `Existing rows to enrich: ${plan.updates.length} ` +
      `(${emailEnrichments} email, ${phoneEnrichments} phone, ${nameEnrichments} name)`
  );
  writeLine(`New rows to create: ${plan.creates.length}`);
}

function assertPlanIsComplete(
  sources: WaitlistContactSource[],
  existingRows: WaitlistBackfillExistingRow[],
  plan: ReturnType<typeof planWaitlistContactBackfill>
) {
  const projectedRows = existingRows.map((row) => ({ ...row }));
  for (const update of plan.updates) {
    const row = projectedRows.find((candidate) => candidate.id === update.id);
    if (row === undefined) throw new Error(`Backfill plan references missing row ${update.id}`);
    Object.assign(row, update.data);
  }
  for (const [index, create] of plan.creates.entries()) {
    projectedRows.push({ id: `planned-${index}`, ...create });
  }

  const projectedPlan = planWaitlistContactBackfill(sources, projectedRows);
  if (
    projectedPlan.missingEmailCount !== 0 ||
    projectedPlan.missingPhoneCount !== 0 ||
    projectedPlan.updates.length !== 0 ||
    projectedPlan.creates.length !== 0
  ) {
    throw new Error('Backfill plan does not satisfy its in-memory postcondition');
  }
}

async function applyPlan(
  prisma: PrismaClient,
  plan: ReturnType<typeof planWaitlistContactBackfill>
): Promise<void> {
  const operations: Prisma.PrismaPromise<unknown>[] = plan.updates.map((update) =>
    prisma.waitlist.update({
      where: { id: update.id },
      data: update.data,
    })
  );
  if (plan.creates.length > 0) {
    operations.push(
      prisma.waitlist.createMany({
        data: plan.creates,
        skipDuplicates: true,
      })
    );
  }
  if (operations.length > 0) await prisma.$transaction(operations);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const sources = await loadSources(prisma);
    const existingRows = await loadExistingRows(prisma);
    const plan = planWaitlistContactBackfill(sources, existingRows);
    assertPlanIsComplete(sources, existingRows, plan);
    printPlan(plan, apply ? 'APPLY' : 'DRY RUN');

    if (!apply) {
      writeLine('Dry run complete. Re-run with --apply to write.');
      return;
    }

    await applyPlan(prisma, plan);

    const verificationSources = await loadSources(prisma);
    const verificationRows = await loadExistingRows(prisma);
    const verificationPlan = planWaitlistContactBackfill(verificationSources, verificationRows);
    if (
      verificationPlan.missingEmailCount !== 0 ||
      verificationPlan.missingPhoneCount !== 0 ||
      verificationPlan.updates.length !== 0 ||
      verificationPlan.creates.length !== 0
    ) {
      throw new Error(
        `Postcondition failed: ${verificationPlan.missingEmailCount} emails and ` +
          `${verificationPlan.missingPhoneCount} phones remain missing; ` +
          `${verificationPlan.updates.length} enrichments and ` +
          `${verificationPlan.creates.length} creates still planned`
      );
    }

    writeLine(
      `Backfill complete: all ${verificationPlan.sourceEmailCount} customer emails and ` +
        `${verificationPlan.sourcePhoneCount} customer phones are represented.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
