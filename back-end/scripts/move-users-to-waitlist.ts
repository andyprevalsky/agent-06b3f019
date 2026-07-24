#!/usr/bin/env tsx
/**
 * Put every non-anonymous customer behind the waitlist gate except the three
 * explicitly protected accounts. Default mode is read-only; --apply writes a
 * recovery snapshot before changing access state.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

import { planWaitlistAccessReset } from '../src/domains/waitlist/accessReset';

const PROTECTED_USERS = [
  {
    userId: '1f85ff25-6e29-4c1b-8739-f917bd101a30',
    label: 'Andy',
  },
  {
    userId: '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9',
    label: 'Tamy',
  },
  {
    userId: '5824c58c-7f11-4c92-8f81-33eb3c324a2f',
    label: 'Aman',
  },
] as const;
const PROTECTED_USER_IDS = new Set(PROTECTED_USERS.map((user) => user.userId));
const PROTECTED_ACCESS_CODE = 181818;

async function loadUsers(prisma: PrismaClient) {
  return prisma.user.findMany({
    where: { isAnonymous: false },
    select: {
      userId: true,
      isAnonymous: true,
      usedInviteCode: true,
      offWaitlistAt: true,
    },
    orderBy: { userId: 'asc' },
  });
}

function writeLine(value: string) {
  process.stdout.write(`${value}\n`);
}

function writeRecoverySnapshot(users: Awaited<ReturnType<typeof loadUsers>>): string {
  const contextDirectory = resolve(process.cwd(), '..', '.context');
  mkdirSync(contextDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(contextDirectory, `waitlist-access-reset-${timestamp}.json`);
  writeFileSync(path, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function activeTargetSubscriptionCount(
  prisma: PrismaClient,
  targetUserIds: string[]
): Promise<number> {
  return prisma.subscription.count({
    where: {
      userId: { in: targetUserIds },
      currentPeriodEnd: { gt: new Date() },
    },
  });
}

async function verifyPostcondition(prisma: PrismaClient, targetUserIds: string[]) {
  const [targetsStillOffWaitlist, protectedWithoutAccess, activeTargetSubscriptions] =
    await Promise.all([
      prisma.user.count({
        where: {
          userId: { in: targetUserIds },
          OR: [{ usedInviteCode: { not: null } }, { offWaitlistAt: { not: null } }],
        },
      }),
      prisma.user.count({
        where: {
          userId: { in: [...PROTECTED_USER_IDS] },
          usedInviteCode: null,
        },
      }),
      activeTargetSubscriptionCount(prisma, targetUserIds),
    ]);
  if (
    targetsStillOffWaitlist !== 0 ||
    protectedWithoutAccess !== 0 ||
    activeTargetSubscriptions !== 0
  ) {
    throw new Error(
      `Postcondition failed: ${targetsStillOffWaitlist} targets retain access state, ` +
        `${protectedWithoutAccess} protected users lack access, and ` +
        `${activeTargetSubscriptions} targets have active subscriptions`
    );
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const users = await loadUsers(prisma);
    const plan = planWaitlistAccessReset(users, PROTECTED_USER_IDS);
    const activeSubscriptions = await activeTargetSubscriptionCount(prisma, plan.targetUserIds);
    if (activeSubscriptions !== 0) {
      throw new Error(
        `${activeSubscriptions} target users have active subscriptions; refusing to alter billing`
      );
    }

    writeLine(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    writeLine(`Protected accounts: ${PROTECTED_USERS.map((user) => user.label).join(', ')}`);
    writeLine(`Accounts moving to waitlist: ${plan.targetUserIds.length}`);
    writeLine(`Accounts requiring an access-state reset: ${plan.targetsNeedingReset}`);
    writeLine(`Protected accounts requiring access: ${plan.protectedUsersNeedingAccess.length}`);
    writeLine(`Active target subscriptions: ${activeSubscriptions}`);
    if (!apply) {
      writeLine('Dry run complete. Re-run with --apply to write.');
      return;
    }

    const snapshotPath = writeRecoverySnapshot(users);
    await prisma.$transaction([
      prisma.user.updateMany({
        where: {
          userId: { in: plan.targetUserIds },
          isAnonymous: false,
        },
        data: {
          usedInviteCode: null,
          offWaitlistAt: null,
        },
      }),
      prisma.user.updateMany({
        where: { userId: { in: plan.protectedUsersNeedingAccess } },
        data: { usedInviteCode: PROTECTED_ACCESS_CODE },
      }),
    ]);

    await verifyPostcondition(prisma, plan.targetUserIds);
    writeLine(`Moved ${plan.targetUserIds.length} accounts to the waitlist.`);
    writeLine(`Protected ${PROTECTED_USERS.map((user) => user.label).join(', ')}.`);
    writeLine(`Recovery snapshot: ${snapshotPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
