import { prisma } from '../../providers/database';

/**
 * Fetch a user's systemName and profilePicture by userId.
 */
export async function findUserCustomization(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      systemName: true,
      profilePicture: true,
    },
  });
}
