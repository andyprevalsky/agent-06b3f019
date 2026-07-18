import { prisma } from '../../providers/database';

/**
 * Find an existing user by phone number (tries both +prefix and no-prefix variants).
 * Normalizes input by stripping spaces, dashes, and parentheses before querying.
 */
export async function findUserByPhone(phone: string) {
  const normalized = phone.replace(/[\s\-()]/g, '');
  const digitsOnly = normalized.replace(/\+/g, '');
  if (digitsOnly.length === 0) {
    return null;
  }
  const phoneWithPlus = normalized.startsWith('+') ? normalized : `+${normalized}`;
  const phoneWithoutPlus = normalized.startsWith('+') ? normalized.slice(1) : normalized;

  return prisma.user.findFirst({
    where: {
      OR: [{ phone: phoneWithPlus }, { phone: phoneWithoutPlus }],
    },
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
