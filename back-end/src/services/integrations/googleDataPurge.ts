import { MessageChannel } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';

const log = createLogger('GoogleDataPurge');
const BATCH_SIZE = 1_000;

/** Process bounded disconnect obligations, retrying after any failure. */
export async function runGoogleDataPurgeJob(): Promise<void> {
  const now = new Date();
  const candidates = await prisma.googleDataPurge.findMany({
    where: {
      processedAt: null,
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    orderBy: { requestedAt: 'asc' },
    take: 20,
  });

  for (const job of candidates) {
    const claimed = await prisma.googleDataPurge.updateMany({
      where: {
        id: job.id,
        processedAt: null,
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
      },
      data: { claimedUntil: new Date(Date.now() + 5 * 60_000) },
    });
    if (claimed.count !== 1) continue;

    try {
      // Older Gmail rows lack source attribution. Their sender or recipient
      // still identifies the connected account; keep unrelated email imports.
      const rows = await prisma.messageRecord.findMany({
        where: {
          person: { userId: job.userId },
          channel: MessageChannel.EMAIL,
          createdAt: { lte: job.requestedAt },
          OR: [
            { googleAccountEmail: job.email },
            {
              googleAccountEmail: null,
              OR: [
                { from: { equals: job.email, mode: 'insensitive' } },
                { to: { equals: job.email, mode: 'insensitive' } },
              ],
            },
          ],
        },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (rows.length > 0) {
        await prisma.messageRecord.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
      }

      if (rows.length < BATCH_SIZE) {
        await prisma.userSnapshotRevision.deleteMany({
          where: {
            userId: job.userId,
            source: 'gmail',
            createdAt: { lte: job.requestedAt },
          },
        });
        await prisma.userDataDocument.deleteMany({
          where: {
            userId: job.userId,
            source: 'gmail',
            createdAt: { lte: job.requestedAt },
          },
        });
        await prisma.googleDataPurge.update({
          where: { id: job.id },
          data: { processedAt: new Date(), claimedUntil: null },
        });
        log.info('Google data purge complete', { jobId: job.id, userId: job.userId });
      } else {
        await prisma.googleDataPurge.update({
          where: { id: job.id },
          data: { claimedUntil: null },
        });
      }
    } catch {
      await prisma.googleDataPurge.update({
        where: { id: job.id },
        data: { claimedUntil: null },
      });
      log.error('Google data purge failed; obligation retained', {
        jobId: job.id,
      });
    }
  }
}
