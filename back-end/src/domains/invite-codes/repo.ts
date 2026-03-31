/**
 * Invite-codes domain repo — all Prisma calls.
 */

import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import type { InviteCodeInfo } from './types';

const log = createLogger('InviteCodes');

/**
 * Get a user's invite code and usage stats.
 */
export async function getUserInviteCode(userId: string): Promise<InviteCodeInfo | null> {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      inviteCode: true,
      inviteCodeUses: true,
    },
  });
}

/**
 * Check if an invite code is already taken by another user.
 */
export async function isInviteCodeTaken(inviteCode: number): Promise<boolean> {
  const existing = await prisma.user.findUnique({
    where: { inviteCode },
  });
  return !!existing;
}

/**
 * Upsert user with an invite code.
 */
export async function upsertUserInviteCode(
  userId: string,
  inviteCode: number
): Promise<InviteCodeInfo> {
  return prisma.user.upsert({
    where: { userId },
    create: {
      userId,
      inviteCode,
      inviteCodeUses: 0,
    },
    update: {
      inviteCode,
    },
    select: {
      inviteCode: true,
      inviteCodeUses: true,
    },
  });
}

/**
 * Get whether a user has already used an invite code.
 */
export async function getUserUsedInviteCode(
  userId: string
): Promise<{ usedInviteCode: number | null } | null> {
  return prisma.user.findUnique({
    where: { userId },
    select: { usedInviteCode: true },
  });
}

/**
 * Record that a user used the master invite code.
 */
export async function recordMasterCodeUse(userId: string, inviteCode: number): Promise<void> {
  await prisma.user.upsert({
    where: { userId },
    create: {
      userId,
      usedInviteCode: inviteCode,
    },
    update: {
      usedInviteCode: inviteCode,
    },
  });
}

/**
 * Find the user who owns a given invite code.
 */
export async function findInviter(
  inviteCode: number
): Promise<{ userId: string; inviteCodeUses: number } | null> {
  return prisma.user.findUnique({
    where: { inviteCode },
    select: {
      userId: true,
      inviteCodeUses: true,
    },
  });
}

/**
 * Use an invite code: increment inviter's usage count and record which code the new user used.
 * Runs as a transaction.
 */
export async function useInviteCodeTransaction(inviteCode: number, userId: string): Promise<void> {
  await prisma.$transaction([
    // Update the inviter's use count
    prisma.user.update({
      where: { inviteCode },
      data: {
        inviteCodeUses: {
          increment: 1,
        },
      },
    }),
    // Update the new user to record which code they used
    prisma.user.upsert({
      where: { userId },
      create: {
        userId,
        usedInviteCode: inviteCode,
      },
      update: {
        usedInviteCode: inviteCode,
      },
    }),
  ]);
}

/**
 * Create a user record if it doesn't exist.
 * Returns usedInviteCode field and whether the user was newly created.
 */
export async function findOrCreateUser(
  userId: string
): Promise<{ usedInviteCode: number | null; isNew: boolean }> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { usedInviteCode: true },
  });

  if (user) {
    return { usedInviteCode: user.usedInviteCode, isNew: false };
  }

  const created = await prisma.user.create({
    data: { userId },
    select: { usedInviteCode: true },
  });
  log.info('Created user record', { userId });

  return { usedInviteCode: created.usedInviteCode, isNew: true };
}
