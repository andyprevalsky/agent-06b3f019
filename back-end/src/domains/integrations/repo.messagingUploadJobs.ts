/**
 * Integrations repo — durable messaging upload parts (MessagingUploadJob).
 *
 * The upload routes store bounded parts and acknowledge; a claimed drain parses
 * them. Claims are conditional updates, so any number of web instances can
 * drain the same queue without processing a part twice concurrently.
 */

import { Prisma, type MessageChannel } from '@prisma/client';
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

/**
 * Extend a claim this drain still holds: only while the part is unfinished and
 * its lease is still the exact one this drain set, so a claim another instance
 * took over is never extended. Returns false once the claim is lost.
 */
export async function renewMessagingUploadJobClaim(
  id: string,
  heldUntil: Date,
  until: Date
): Promise<boolean> {
  const renewed = await prisma.messagingUploadJob.updateMany({
    where: { id, processedAt: null, failedAt: null, claimedUntil: heldUntil },
    data: { claimedUntil: until },
  });
  return renewed.count === 1;
}

/** Oldest unfinished parts with attempts left and no live claim. */
export async function findClaimableMessagingUploadJobIds(
  now: Date,
  take: number,
  maxAttempts: number
) {
  const rows = await prisma.messagingUploadJob.findMany({
    where: {
      processedAt: null,
      failedAt: null,
      attempts: { lt: maxAttempts },
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
    take,
  });
  return rows.map((row) => row.id);
}

/**
 * Claim one part until `until`; false when another drain holds it or it has no
 * attempts left. Every claim counts as an attempt, so a part whose parse kills
 * the process is not reclaimed forever.
 */
export async function claimMessagingUploadJob(
  id: string,
  now: Date,
  until: Date,
  maxAttempts: number
) {
  const claimed = await prisma.messagingUploadJob.updateMany({
    where: {
      id,
      processedAt: null,
      failedAt: null,
      attempts: { lt: maxAttempts },
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    data: { claimedUntil: until, attempts: { increment: 1 } },
  });
  return claimed.count === 1;
}

/** Unfinished parts that used every attempt and hold no live claim (e.g. crashed mid-parse). */
export async function findExhaustedMessagingUploadJobs(
  now: Date,
  maxAttempts: number,
  take: number
) {
  return prisma.messagingUploadJob.findMany({
    where: {
      processedAt: null,
      failedAt: null,
      attempts: { gte: maxAttempts },
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    select: { id: true, integrationId: true, lastError: true },
    take,
  });
}

export async function findMessagingUploadJob(id: string) {
  return prisma.messagingUploadJob.findUnique({ where: { id } });
}

// updateMany: a part deleted with its integration mid-processing is a no-op.
export async function markMessagingUploadJobProcessed(id: string): Promise<void> {
  await prisma.messagingUploadJob.updateMany({
    where: { id },
    data: { processedAt: new Date(), claimedUntil: null, payload: Prisma.DbNull },
  });
}

export async function markMessagingUploadJobRetry(
  id: string,
  error: string,
  retryAt: Date
): Promise<void> {
  await prisma.messagingUploadJob.updateMany({
    where: { id },
    data: { claimedUntil: retryAt, lastError: error.slice(0, 1000) },
  });
}

export async function markMessagingUploadJobFailed(id: string, error: string): Promise<void> {
  await prisma.messagingUploadJob.updateMany({
    where: { id },
    data: {
      failedAt: new Date(),
      claimedUntil: null,
      lastError: error.slice(0, 1000),
      payload: Prisma.DbNull,
    },
  });
}

/** Messaging integrations still marked SYNCING: the candidates for finalization. */
export async function findSyncingMessagingIntegrations(platforms: string[], take: number) {
  return prisma.integration.findMany({
    where: { name: { in: platforms }, accountId: '', status: 'SYNCING' },
    select: { id: true, userId: true, name: true, config: true },
    take,
  });
}

/**
 * A user's stored history on one messaging channel: the connector's totals.
 * Derived from MessageRecord (deduplicated on insert), never accumulated from
 * upload sizes, so an incremental or re-sent upload cannot change it wrongly.
 * Counted per person on (personId, channel): reads only this user's rows,
 * never the whole channel across users.
 */
export async function countMessagingHistory(
  userId: string,
  channel: MessageChannel
): Promise<{ messages: number; contacts: number }> {
  const [row] = await prisma.$queryRaw<Array<{ messages: number; contacts: number }>>`
    SELECT COALESCE(SUM(c."n"), 0)::int AS "messages",
           COUNT(*) FILTER (WHERE c."n" > 0)::int AS "contacts"
    FROM "Person" p
    CROSS JOIN LATERAL (
      SELECT COUNT(*) AS "n" FROM "MessageRecord" m
      WHERE m."personId" = p."id" AND m."channel" = ${channel}::"MessageChannel"
    ) c
    WHERE p."userId" = ${userId}`;
  return row ?? { messages: 0, contacts: 0 };
}

/** Parts of an integration that can still run (not processed, not failed). */
export async function countPendingMessagingUploadParts(integrationId: string): Promise<number> {
  return prisma.messagingUploadJob.count({
    where: { integrationId, processedAt: null, failedAt: null },
  });
}

export async function findLatestMessagingUploadPart(integrationId: string) {
  return prisma.messagingUploadJob.findFirst({
    where: { integrationId },
    orderBy: { createdAt: 'desc' },
    select: {
      uploadId: true,
      accessedAt: true,
      contacts: true,
      messages: true,
      createdAt: true,
    },
  });
}

/**
 * Every part of one client sync: the requests sharing its `accessedAt` (a
 * chunked client sends its sync start on each), or one upload when absent.
 */
export async function findMessagingSyncParts(
  integrationId: string,
  sync: { accessedAt: string | null; uploadId: string }
) {
  return prisma.messagingUploadJob.findMany({
    where: {
      integrationId,
      ...(sync.accessedAt !== null ? { accessedAt: sync.accessedAt } : { uploadId: sync.uploadId }),
    },
    select: { processedAt: true, failedAt: true, syncComplete: true },
  });
}

/**
 * Mark a finished sync CONNECTED, but only while nothing newer arrived: the
 * integration is still SYNCING and no part was stored after the one this
 * finalization read. A request accepted meanwhile keeps the integration
 * SYNCING for the next drain instead of being overwritten by a stale view.
 */
export async function finalizeMessagingIntegrationIfCurrent(
  integrationId: string,
  latestPartCreatedAt: Date,
  config: Prisma.InputJsonValue
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "Integration"
    SET "status" = 'CONNECTED'::"IntegrationStatus",
        "isActive" = true,
        "lastSyncAt" = NOW(),
        "lastSuccessfulSyncAt" = NOW(),
        "config" = ${JSON.stringify(config)}::jsonb,
        "updatedAt" = NOW()
    WHERE "id" = ${integrationId}
      AND "status" = 'SYNCING'::"IntegrationStatus"
      AND NOT EXISTS (
        SELECT 1 FROM "MessagingUploadJob" j
        WHERE j."integrationId" = ${integrationId} AND j."createdAt" > ${latestPartCreatedAt}
      )`;
  return updated === 1;
}

/** Drop finished parts (payloads already cleared) after the retention window. */
export async function deleteFinishedMessagingUploadJobs(before: Date): Promise<number> {
  const { count } = await prisma.messagingUploadJob.deleteMany({
    where: { OR: [{ processedAt: { lt: before } }, { failedAt: { lt: before } }] },
  });
  return count;
}
