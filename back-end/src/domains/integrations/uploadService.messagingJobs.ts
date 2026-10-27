/**
 * Integrations upload service — durable messaging ingestion (iMessage, WhatsApp, Telegram).
 *
 *   POST /<platform>/upload ──► enqueueMessagingUpload ──► MessagingUploadJob parts (DB)
 *                                         │                         ▲
 *                     then mark SYNCING ──┴─► kickMessagingUploadJobs  │ claim (lease)
 *   cron (every minute) ──► runMessagingUploadJobs ──► drain ─────────┘
 *                                                       │
 *                                parse part ──► processed (payload cleared)
 *                                    │ error ──► retry with backoff ──► failed after MAX_ATTEMPTS
 *                                    │ crash ──► lease expires; each claim counts an attempt
 *                                    ▼
 *                     latest client sync fully processed, none failed ──► CONNECTED
 *                     (+ cursor only once its final request arrived)
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
const RETENTION_MS = 7 * 24 * 60 * 60_000;

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

/**
 * Store an acknowledged upload as durable parts. The caller marks the
 * integration SYNCING only after this returns, then kicks the drain: a drain
 * that finalizes in between sees either no SYNCING flag or every part.
 */
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
  return uploadId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markIntegrationFailed(integrationId: string, message: string) {
  await repo.updateIntegrationStatus(integrationId, IntegrationStatus.SYNC_FAILED, {
    lastSyncAt: new Date(),
    lastFailedSyncAt: new Date(),
    failureReason: message.slice(0, 1000),
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
  await markIntegrationFailed(integrationId, message);
  log.error('Messaging upload part failed permanently', { jobId: id, attempts, error: message });
}

/**
 * Dead-letter parts that used every attempt without recording a result: a
 * parse that killed the process (OOM, deploy) never reaches recordFailure.
 */
async function failExhaustedParts(): Promise<void> {
  const exhausted = await jobsRepo.findExhaustedMessagingUploadJobs(
    new Date(),
    MAX_ATTEMPTS,
    CLAIM_BATCH
  );
  for (const part of exhausted) {
    const message = part.lastError ?? `no result after ${MAX_ATTEMPTS} attempts (process lost)`;
    await jobsRepo.markMessagingUploadJobFailed(part.id, message);
    await markIntegrationFailed(part.integrationId, message);
    log.error('Messaging upload part exhausted its attempts', { jobId: part.id });
  }
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
  }
}

/**
 * Mark an integration synced once its latest client sync is fully processed.
 * A sync with any failed part stays SYNC_FAILED and keeps the previous cursor,
 * so the client re-sends that history. Only a sync whose final request has
 * arrived (`syncComplete`) advances the incremental-read cursor. Runs from
 * every drain, so a finalization interrupted by a crash is retried.
 */
async function finalizeIntegration(integration: { id: string; config: unknown }): Promise<void> {
  if ((await jobsRepo.countPendingMessagingUploadParts(integration.id)) > 0) return;
  const latest = await jobsRepo.findLatestMessagingUploadPart(integration.id);
  if (latest === null) return;
  const parts = await jobsRepo.findMessagingSyncParts(integration.id, latest);
  if (parts.some((part) => part.failedAt !== null)) {
    // A later request of this sync set SYNCING again after a part failed.
    await markIntegrationFailed(integration.id, 'a part of the latest messaging sync failed');
    return;
  }
  if (parts.some((part) => part.processedAt === null)) return;
  const complete = parts.some((part) => part.syncComplete);
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  await repo.updateIntegration(integration.id, {
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: {
      ...config,
      contacts: latest.contacts,
      messages: latest.messages,
      lastJobId: latest.uploadId,
      lastUploadedAt: new Date().toISOString(),
      ...(complete
        ? { lastFrontendAccessAt: latest.accessedAt ?? latest.createdAt.toISOString() }
        : {}),
    } as Prisma.InputJsonValue,
  });
}

async function finalizeSyncedIntegrations(): Promise<void> {
  const syncing = await jobsRepo.findSyncingMessagingIntegrations(Object.keys(PARSERS), 100);
  for (const integration of syncing) {
    try {
      await finalizeIntegration(integration);
    } catch (error: unknown) {
      log.error('Messaging upload finalization failed; retried next drain', {
        integrationId: integration.id,
        error: errorMessage(error),
      });
    }
  }
}

async function drain(): Promise<void> {
  await failExhaustedParts();
  for (;;) {
    const ids = await jobsRepo.findClaimableMessagingUploadJobIds(
      new Date(),
      CLAIM_BATCH,
      MAX_ATTEMPTS
    );
    if (ids.length === 0) break;
    for (const id of ids) {
      const now = new Date();
      const until = new Date(now.getTime() + CLAIM_LEASE_MS);
      if (!(await jobsRepo.claimMessagingUploadJob(id, now, until, MAX_ATTEMPTS))) continue;
      try {
        await processClaimedPart(id);
      } catch (error: unknown) {
        // Recording the outcome failed. The lease expires and the part is
        // claimed again (counting an attempt); keep draining the others.
        log.error('Messaging upload part bookkeeping failed', {
          jobId: id,
          error: errorMessage(error),
        });
      }
    }
  }
  await finalizeSyncedIntegrations();
  await jobsRepo.deleteFinishedMessagingUploadJobs(new Date(Date.now() - RETENTION_MS));
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
