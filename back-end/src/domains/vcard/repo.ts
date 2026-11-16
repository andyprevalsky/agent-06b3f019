import { prisma } from '../../providers/database';

/**
 * Fetch a user's systemName, profilePicture and phone (for routing) by userId.
 */
export async function findUserCustomization(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      systemName: true,
      profilePicture: true,
      phone: true,
    },
  });
}
