import { prisma } from '../../providers/database';

/**
 * Find an existing user by phone number (tries both +prefix and no-prefix variants).
 */
export async function findUserByPhone(phone: string) {
  const phoneWithPlus = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneWithoutPlus = phone.startsWith('+') ? phone.slice(1) : phone;

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
  isAnonymous: boolean;
}) {
  return prisma.user.create({ data });
}

/**
 * Update a user record.
 */
export async function updateUser(
  userId: string,
  data: { phone?: string; name?: string; isAnonymous?: boolean; onboardingCompletedAt?: Date }
) {
  return prisma.user.update({
    where: { userId },
    data,
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
