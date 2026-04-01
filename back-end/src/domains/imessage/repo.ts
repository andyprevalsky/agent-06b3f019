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

/** Pop (find + delete) the oldest pending iMessage for a user, atomically.
 *  Uses FOR UPDATE SKIP LOCKED to prevent concurrent pops from grabbing the same row.
 */
export async function popOldestForUser(userId: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<
      Array<{
        id: string;
        userId: string;
        agentId: string;
        phoneNumber: string;
        message: string;
        createdAt: Date;
      }>
    >(
      `SELECT * FROM "ImessageQueue" WHERE "userId" = $1 ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      userId
    );

    if (rows.length === 0) {
      return null;
    }

    const oldest = rows[0];
    await tx.imessageQueue.delete({
      where: { id: oldest.id },
    });

    return oldest;
  });
}
