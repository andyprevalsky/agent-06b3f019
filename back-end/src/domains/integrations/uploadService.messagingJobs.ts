/**
 * Integrations upload service — durable messaging ingestion (iMessage, WhatsApp, Telegram).
 *
 *   POST /<platform>/upload ──► enqueueMessagingUpload ──► MessagingUploadJob parts (DB)
 *                                         │                         ▲
 *                                         └─► kickMessagingUploadJobs  │ claim (lease)
 *   cron (every minute) ──► runMessagingUploadJobs ──► drain ─────────┘
 *                                                       │
 *                                parse part ──► processed (payload cleared)
 *                                    │ error ──► retry with backoff ──► failed after MAX_ATTEMPTS
 *                                    ▼
 *                     last pending part of the upload ──► integration CONNECTED
 *
 * Parts are bounded (PART_MAX_WEIGHT messages), so each parse holds a bounded
 * payload in memory and an old client's single large body becomes many parts.
 * Message inserts deduplicate on (personId, channel, externalId), so a part
 * re-run after a crash or lease expiry is idempotent.
 */

import { randomUUID } from 'node:crypto';
import { IntegrationStatus, type Prisma } from './types';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import * as jobsRepo from './repo.messagingUploadJobs';
import { parseIMessageData } from '../../services/integrations/iMessageParser';
import { parseWhatsAppData } from '../../services/integrations/whatsappParser';
import { parseTelegramData } from '../../services/integrations/telegramParser';

const log = createLogger('MessagingUploadJobs');

/** Max messages (contacts without messages weigh 1) in one stored part. */
export const PART_MAX_WEIGHT = 5_000;
const CLAIM_LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const CLAIM_BATCH = 10;

export type MessagingPlatform = 'imessage' | 'whatsapp' | 'telegram';

interface UploadContact {
  messages?: unknown[];
}

const PARSERS: Record<
  MessagingPlatform,
  (userId: string, contacts: never[], jobId: string) => Promise<void>
> = {
  imessage: parseIMessageData,
  whatsapp: parseWhatsAppData,
  telegram: parseTelegramData,
};

/** Split contacts into parts of at most PART_MAX_WEIGHT messages, slicing large contacts. */
export function splitMessagingUpload<T extends UploadContact>(contacts: T[]): T[][] {
  const parts: T[][] = [];
  let current: T[] = [];
  let weight = 0;
  const push = (contact: T, w: number) => {
    if (weight + w > PART_MAX_WEIGHT && current.length > 0) {
      parts.push(current);
      current = [];
      weight = 0;
    }
    current.push(contact);
    weight += w;
  };
  for (const contact of contacts) {
    const messages = Array.isArray(contact.messages) ? contact.messages : [];
    if (messages.length <= PART_MAX_WEIGHT) {
      push(contact, Math.max(1, messages.length));
      continue;
    }
    for (let i = 0; i < messages.length; i += PART_MAX_WEIGHT) {
      const slice = messages.slice(i, i + PART_MAX_WEIGHT);
      push({ ...contact, messages: slice }, slice.length);
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Store an acknowledged upload as durable parts and start draining them. */
export async function enqueueMessagingUpload(params: {
  userId: string;
  integrationId: string;
  platform: MessagingPlatform;
  contacts: UploadContact[];
  totalMessages: number;
  accessedAt: string | null;
  syncComplete: boolean;
}): Promise<string> {
  const uploadId = `${params.platform}-upload-${params.userId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const parts = splitMessagingUpload(params.contacts);
  await jobsRepo.insertMessagingUploadParts(
    parts.map((contacts, part) => ({
      userId: params.userId,
      integrationId: params.integrationId,
      platform: params.platform,
      uploadId,
      part,
      parts: parts.length,
      payload: contacts as unknown as Prisma.InputJsonValue,
      accessedAt: params.accessedAt,
      syncComplete: params.syncComplete,
      contacts: params.contacts.length,
      messages: params.totalMessages,
    }))
  );
  log.info('Messaging upload queued', {
    uploadId,
    platform: params.platform,
    parts: parts.length,
    messages: params.totalMessages,
  });
  kickMessagingUploadJobs();
  return uploadId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mark the integration synced once every part of an upload is processed. */
async function finalizeUpload(
  job: NonNullable<Awaited<ReturnType<typeof jobsRepo.findMessagingUploadJob>>>
) {
  if ((await jobsRepo.countPendingMessagingUploadParts(job.uploadId)) > 0) return;
  const integration = await repo.findIntegrationByUserAndName(job.userId, job.platform);
  if (integration === null) return;
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  await repo.updateIntegration(integration.id, {
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: {
      ...config,
      contacts: job.contacts,
      messages: job.messages,
      lastJobId: job.uploadId,
      lastUploadedAt: new Date().toISOString(),
      // Only a client's final request may advance its incremental-read cursor;
      // earlier requests of the same sync keep the previous cursor so a failed
      // sync resumes instead of skipping the unsent history.
      ...(job.syncComplete && job.accessedAt !== null
        ? { lastFrontendAccessAt: job.accessedAt }
        : {}),
    } as Prisma.InputJsonValue,
  });
}

async function recordFailure(id: string, attempts: number, error: unknown, integrationId: string) {
  const message = errorMessage(error);
  if (attempts < MAX_ATTEMPTS) {
    const retryAt = new Date(Date.now() + 2 ** attempts * 60_000);
    await jobsRepo.markMessagingUploadJobRetry(id, message, retryAt);
    log.warn('Messaging upload part failed; will retry', { jobId: id, attempts, error: message });
    return;
  }
  await jobsRepo.markMessagingUploadJobFailed(id, message);
  await repo.updateIntegrationStatus(integrationId, IntegrationStatus.SYNC_FAILED, {
    lastSyncAt: new Date(),
    lastFailedSyncAt: new Date(),
    failureReason: message,
  });
  log.error('Messaging upload part failed permanently', { jobId: id, attempts, error: message });
}

async function processClaimedPart(id: string): Promise<void> {
  const job = await jobsRepo.findMessagingUploadJob(id);
  if (job === null) return;
  try {
    const parse = PARSERS[job.platform as MessagingPlatform];
    if (parse === undefined) throw new Error(`Unknown messaging platform: ${job.platform}`);
    const contacts = (job.payload ?? []) as never[];
    await parse(job.userId, contacts, `${job.uploadId}#${job.part}`);
    await jobsRepo.markMessagingUploadJobProcessed(id);
  } catch (error: unknown) {
    await recordFailure(id, job.attempts, error, job.integrationId);
    return;
  }
  await finalizeUpload(job);
}

async function drain(): Promise<void> {
  for (;;) {
    const ids = await jobsRepo.findClaimableMessagingUploadJobIds(new Date(), CLAIM_BATCH);
    if (ids.length === 0) return;
    for (const id of ids) {
      const now = new Date();
      if (
        !(await jobsRepo.claimMessagingUploadJob(id, now, new Date(now.getTime() + CLAIM_LEASE_MS)))
      ) {
        continue;
      }
      try {
        await processClaimedPart(id);
      } catch (error: unknown) {
        // Bookkeeping failed (e.g. the integration was deleted meanwhile). The
        // lease expires and the part is retried; keep draining the others.
        log.error('Messaging upload part bookkeeping failed', {
          jobId: id,
          error: errorMessage(error),
        });
      }
    }
  }
}

let draining: Promise<void> | null = null;
let rerun = false;

function startDrain(): Promise<void> {
  if (draining !== null) {
    rerun = true;
    return draining;
  }
  draining = (async () => {
    do {
      rerun = false;
      await drain();
    } while (rerun);
  })()
    .catch((error: unknown) => {
      log.error('Messaging upload drain failed', { error: errorMessage(error) });
    })
    .finally(() => {
      draining = null;
    });
  return draining;
}

/** Start draining in the background (one drain per process; parts are claimed in the DB). */
export function kickMessagingUploadJobs(): void {
  void startDrain();
}

/** Drain every claimable part now; the cron entrypoint and a restarted process's recovery path. */
export async function runMessagingUploadJobs(): Promise<void> {
  await startDrain();
}
