import { EmailProvider, MessageChannel, type GoogleDataPurge, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { revokeGoogleGrant } from '../../providers/googleRevoke';
import { createLogger } from '../../providers/logger';

const log = createLogger('GoogleDataPurge');
const BATCH_SIZE = 1_000;

async function hasOtherConnectedGmailAccount(job: GoogleDataPurge): Promise<boolean> {
  if (job.email === null) return false;
  const count = await prisma.emailIntegrationCredential.count({
    where: {
      userId: job.userId,
      provider: EmailProvider.GMAIL,
      email: { not: job.email },
      accessToken: { not: null },
    },
  });
  return count > 0;
}

async function deleteMessageBatch(job: GoogleDataPurge, includeLegacy: boolean): Promise<boolean> {
  if (job.email === null) return true;
  const accountFilters: Prisma.MessageRecordWhereInput[] = [{ googleAccountEmail: job.email }];
  if (includeLegacy) {
    accountFilters.push({
      googleAccountEmail: null,
      OR: [
        { from: { equals: job.email, mode: 'insensitive' } },
        { to: { equals: job.email, mode: 'insensitive' } },
      ],
    });
  }
  const rows = await prisma.messageRecord.findMany({
    where: {
      person: { userId: job.userId },
      channel: MessageChannel.EMAIL,
      createdAt: { lte: job.requestedAt },
      OR: accountFilters,
    },
    select: { id: true },
    take: BATCH_SIZE,
  });
  if (rows.length > 0) {
    await prisma.messageRecord.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
  return rows.length < BATCH_SIZE;
}

async function deleteAccountDocuments(job: GoogleDataPurge, includeLegacy: boolean): Promise<void> {
  if (job.email === null) return;
  const accountFilters = [
    { googleAccountEmail: job.email },
    ...(includeLegacy ? [{ googleAccountEmail: null as null }] : []),
  ];
  const where = {
    userId: job.userId,
    source: 'gmail',
    createdAt: { lte: job.requestedAt },
    OR: accountFilters,
  };
  await prisma.userSnapshotRevision.deleteMany({ where });
  await prisma.userDataDocument.deleteMany({ where });
}

async function processClaimedJob(job: GoogleDataPurge, fetcher: typeof fetch): Promise<void> {
  const includeLegacy = !(await hasOtherConnectedGmailAccount(job));
  if (!(await deleteMessageBatch(job, includeLegacy))) {
    await prisma.googleDataPurge.update({
      where: { id: job.id },
      data: { claimedUntil: null },
    });
    return;
  }
  await deleteAccountDocuments(job, includeLegacy);
  if (job.revocationToken !== null) await revokeGoogleGrant(job.revocationToken, null, fetcher);
  await prisma.googleDataPurge.update({
    where: { id: job.id },
    data: { processedAt: new Date(), claimedUntil: null, revocationToken: null },
  });
  log.info('Google data purge complete', { jobId: job.id, userId: job.userId });
}

/** Process one bounded disconnect obligation; failed revocations remain retryable. */
export async function processGoogleDataPurge(
  jobId: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const now = new Date();
  const claimed = await prisma.googleDataPurge.updateMany({
    where: {
      id: jobId,
      processedAt: null,
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    data: { claimedUntil: new Date(Date.now() + 5 * 60_000) },
  });
  if (claimed.count !== 1) return;
  try {
    const job = await prisma.googleDataPurge.findUniqueOrThrow({ where: { id: jobId } });
    await processClaimedJob(job, fetcher);
  } catch {
    await prisma.googleDataPurge.update({ where: { id: jobId }, data: { claimedUntil: null } });
    log.error('Google data purge failed; obligation retained', { jobId });
  }
}

/** Process pending disconnect obligations, retrying after any failure. */
export async function runGoogleDataPurgeJob(): Promise<void> {
  const now = new Date();
  const candidates = await prisma.googleDataPurge.findMany({
    where: {
      processedAt: null,
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    orderBy: { requestedAt: 'asc' },
    select: { id: true },
    take: 20,
  });
  for (const candidate of candidates) await processGoogleDataPurge(candidate.id);
}
