import { prisma } from '../../providers/database';

export async function createFeedback(userId: string, feedback: string): Promise<void> {
  await prisma.feedback.create({
    data: {
      userId,
      feedback,
    },
  });
}
