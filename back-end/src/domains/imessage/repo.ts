import { prisma } from '../../providers/database';

/** Create a new iMessage queue entry. */
export async function createQueueEntry(
  userId: string,
  agentId: string,
  phoneNumber: string,
  message: string
) {
  return prisma.imessageQueue.create({
    data: {
      userId,
      agentId,
      phoneNumber,
      message,
    },
  });
}

/** Pop (find + delete) the oldest pending iMessage for a user, atomically. */
export async function popOldestForUser(userId: string) {
  return prisma.$transaction(async (tx) => {
    const oldest = await tx.imessageQueue.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    if (!oldest) {
      return null;
    }

    await tx.imessageQueue.delete({
      where: { id: oldest.id },
    });

    return oldest;
  });
}
