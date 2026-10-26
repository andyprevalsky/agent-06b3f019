/**
 * Integrations repo — durable messaging upload parts (MessagingUploadJob).
 *
 * The upload routes store bounded parts and acknowledge; a claimed drain parses
 * them. Claims are conditional updates, so any number of web instances can
 * drain the same queue without processing a part twice concurrently.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export interface MessagingUploadPartInput {
  userId: string;
  integrationId: string;
  platform: string;
  uploadId: string;
  part: number;
  parts: number;
  payload: Prisma.InputJsonValue;
  accessedAt: string | null;
  syncComplete: boolean;
  contacts: number;
  messages: number;
}

export async function insertMessagingUploadParts(rows: MessagingUploadPartInput[]): Promise<void> {
  await prisma.messagingUploadJob.createMany({ data: rows, skipDuplicates: true });
}

/** Oldest parts that are neither finished nor held by a live claim. */
export async function findClaimableMessagingUploadJobIds(now: Date, take: number) {
  const rows = await prisma.messagingUploadJob.findMany({
    where: {
      processedAt: null,
      failedAt: null,
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
    take,
  });
  return rows.map((row) => row.id);
}

/** Claim one part until `until`; returns false when another drain holds it. */
export async function claimMessagingUploadJob(id: string, now: Date, until: Date) {
  const claimed = await prisma.messagingUploadJob.updateMany({
    where: {
      id,
      processedAt: null,
      failedAt: null,
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    data: { claimedUntil: until, attempts: { increment: 1 } },
  });
  return claimed.count === 1;
}

export async function findMessagingUploadJob(id: string) {
  return prisma.messagingUploadJob.findUnique({ where: { id } });
}

export async function markMessagingUploadJobProcessed(id: string): Promise<void> {
  await prisma.messagingUploadJob.update({
    where: { id },
    data: { processedAt: new Date(), claimedUntil: null, payload: Prisma.DbNull },
  });
}

export async function markMessagingUploadJobRetry(
  id: string,
  error: string,
  retryAt: Date
): Promise<void> {
  await prisma.messagingUploadJob.update({
    where: { id },
    data: { claimedUntil: retryAt, lastError: error.slice(0, 1000) },
  });
}

export async function markMessagingUploadJobFailed(id: string, error: string): Promise<void> {
  await prisma.messagingUploadJob.update({
    where: { id },
    data: {
      failedAt: new Date(),
      claimedUntil: null,
      lastError: error.slice(0, 1000),
      payload: Prisma.DbNull,
    },
  });
}

/** Parts of one upload that are still pending (not processed, not failed). */
export async function countPendingMessagingUploadParts(uploadId: string): Promise<number> {
  return prisma.messagingUploadJob.count({
    where: { uploadId, processedAt: null, failedAt: null },
  });
}
