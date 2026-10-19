import { prisma } from '../../providers/database';
import { OLDEST_ACCOUNT_FIRST, phoneLookupVariants } from '../../providers/phoneAccountLookup';

/**
 * Find the account that owns a phone number (tries both +prefix and no-prefix
 * variants). Normalizes input by stripping spaces, dashes, and parentheses.
 * Legacy rows can hold one number in both forms; the oldest
 * account always wins so login is deterministic.
 */
export async function findUserByPhone(phone: string) {
  const variants = phoneLookupVariants(phone);
  if (variants === null) {
    return null;
  }

  return prisma.user.findFirst({
    where: { phone: { in: variants } },
    orderBy: OLDEST_ACCOUNT_FIRST,
    select: { userId: true },
  });
}

/**
 * Find a user by userId.
 */
export async function findUserById(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
  });
}

/**
 * Create a new user record.
 */
export async function createUser(data: {
  userId: string;
  phone?: string;
  name?: string | null;
  email?: string | null;
  isAnonymous: boolean;
}) {
  return prisma.user.create({ data });
}

/**
 * Update a user record.
 */
export async function updateUser(
  userId: string,
  data: {
    phone?: string;
    name?: string;
    isAnonymous?: boolean;
    onboardingCompletedAt?: Date;
  }
) {
  return prisma.user.update({
    where: { userId },
    data,
  });
}

/**
 * Backfill the user's email only when none is stored yet. The WHERE guard makes
 * the check-and-set atomic — if a concurrent request already wrote an email,
 * this write becomes a no-op instead of clobbering it.
 */
export async function backfillUserEmail(userId: string, email: string) {
  return prisma.user.updateMany({
    where: { userId, OR: [{ email: null }, { email: '' }] },
    data: { email },
  });
}

/**
 * Transfer agents from one user to another.
 */
export async function transferAgents(fromUserId: string, toUserId: string) {
  return prisma.agent.updateMany({
    where: { userId: fromUserId },
    data: { userId: toUserId },
  });
}

/**
 * Transfer goal blueprints from one user to another.
 */
export async function transferGoalBlueprints(fromUserId: string, toUserId: string) {
  return prisma.goalBlueprint.updateMany({
    where: { userId: fromUserId },
    data: { userId: toUserId },
  });
}

/**
 * Find browser context for a user.
 */
export async function findBrowserContext(userId: string) {
  return prisma.browserContext.findUnique({
    where: { userId },
  });
}

/**
 * Transfer browser context from one user to another.
 */
export async function transferBrowserContext(fromUserId: string, toUserId: string) {
  return prisma.browserContext.updateMany({
    where: { userId: fromUserId },
    data: { userId: toUserId },
  });
}

/**
 * Delete browser context for a user.
 */
export async function deleteBrowserContext(userId: string) {
  return prisma.browserContext.deleteMany({
    where: { userId },
  });
}
