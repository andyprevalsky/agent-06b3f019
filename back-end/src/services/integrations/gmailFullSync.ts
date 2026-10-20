/**
 * Resumable Gmail full sync for ONE connected address, saved batch by batch.
 *
 *   profile ──► total = messagesTotal (null when the profile call fails; never guessed)
 *      │        startHistoryId (the incremental cursor once this sync completes)
 *      ▼
 *   scanning: list ids + routing metadata ──► classifyMailbox (whole-mailbox decision)
 *      ▼
 *   saving: selected messages newest → oldest, 100 per batch
 *      fetch full ─► upsert (dedup by externalId) ─► cursor.savedThrough ─► progress
 *      ▼
 *   done: caller stores historyId, clears the cursor, reports `synced`
 *
 * The cursor lives on the address's own credential row (metadata.gmailFullSync),
 * so an interrupted sync keeps every saved batch and the next run skips them.
 * Progress per batch: one cursor write, at most one progress write (coalesced
 * to 1/s per address), and a lease heartbeat at most once a minute.
 */

import { MessageChannel, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';
import {
  classifyMailbox,
  fetchFullMessages,
  fetchWithRetry,
  getGmailProfile,
  listAllMessageIds,
  scanMessageMetadata,
  type EmailMetadata,
} from './gmailParser';
import type { GmailAddressProgress, GmailSyncDeps } from './gmailSync.progress';
import { toContactsToUpsert } from './gmailSync.contacts';
import { upsertPersonAndMessageRecords } from './personMessageManager';

const log = createLogger('GmailFullSync');

export const FULL_SYNC_BATCH_SIZE = 100;
const CURSOR_KEY = 'gmailFullSync';

/** Resume state of an unfinished full sync (credential.metadata.gmailFullSync). */
export interface FullSyncCursor {
  /** Profile historyId when the sync first started; null when Google did not answer. */
  startHistoryId: string | null;
  startedAt: string;
  /** Oldest message saved so far in (internalDate desc, id desc) order. */
  savedThrough: { internalDate: number; id: string } | null;
}

export function readFullSyncCursor(metadata: unknown): FullSyncCursor | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>)[CURSOR_KEY];
  if (raw === null || typeof raw !== 'object') return null;
  const cursor = raw as Partial<FullSyncCursor>;
  if (typeof cursor.startedAt !== 'string') return null;
  const through = cursor.savedThrough;
  const validThrough =
    through !== null &&
    typeof through === 'object' &&
    typeof through.internalDate === 'number' &&
    typeof through.id === 'string';
  return {
    startHistoryId: typeof cursor.startHistoryId === 'string' ? cursor.startHistoryId : null,
    startedAt: cursor.startedAt,
    savedThrough: validThrough ? through : null,
  };
}

/** Atomic per-key write: other metadata keys (OAuth return URLs) are untouched. */
async function writeCursor(credentialId: string, cursor: FullSyncCursor): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "EmailIntegrationCredential"
    SET "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb), '{gmailFullSync}',
                               ${JSON.stringify(cursor)}::jsonb),
        "updatedAt" = NOW()
    WHERE "id" = ${credentialId}`;
}

export async function clearFullSyncCursor(credentialId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "EmailIntegrationCredential"
    SET "metadata" = "metadata" - 'gmailFullSync', "updatedAt" = NOW()
    WHERE "id" = ${credentialId} AND "metadata" ? 'gmailFullSync'`;
}

/** Newest first; ties broken by id so the order is total and stable across runs. */
function newerFirst(a: EmailMetadata, b: EmailMetadata): number {
  if (a.internalDate !== b.internalDate) return b.internalDate - a.internalDate;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function isOlderThan(m: EmailMetadata, through: { internalDate: number; id: string }): boolean {
  return (
    m.internalDate < through.internalDate ||
    (m.internalDate === through.internalDate && m.id < through.id)
  );
}

/** Remaining seconds at the rate measured so far; null until something was done. */
export function etaSec(doneInPhase: number, remaining: number, elapsedMs: number): number | null {
  if (doneInPhase <= 0 || remaining < 0 || elapsedMs <= 0) return null;
  return Math.min(31_536_000, Math.round(((elapsedMs / doneInPhase) * remaining) / 1000));
}

export interface FullSyncParams {
  userId: string;
  credential: { id: string; email: string; metadata: Prisma.JsonValue | null };
  accessToken: string;
  /** Address used for sender detection (the connected address). */
  userEmail: string;
  progress: GmailAddressProgress;
  deps: GmailSyncDeps;
  /** Renews the integration's sync lease; called often, throttled by the caller. */
  heartbeat: () => Promise<void>;
}

export interface FullSyncResult {
  historyId: string;
  contacts: number;
  messages: number;
  /** Mailbox messages listed (the final `done`). */
  listed: number;
  total: number | null;
}

async function profileOrNull(params: FullSyncParams) {
  try {
    return await getGmailProfile(params.accessToken, params.deps.fetcher);
  } catch {
    log.warn('Gmail profile unavailable; total stays unknown', {
      credentialId: params.credential.id,
    });
    return null;
  }
}

async function scanMailbox(params: FullSyncParams, total: number | null) {
  const { accessToken, deps, progress } = params;
  const ids = await listAllMessageIds((url) =>
    fetchWithRetry(url, accessToken, undefined, deps.fetcher)
  );
  const scanStart = deps.now().getTime();
  const metadata = await scanMessageMetadata(
    accessToken,
    ids,
    deps.fetcher,
    async (scanned, listed) => {
      await params.heartbeat();
      if (scanned >= listed) return;
      await progress.report({
        state: 'syncing',
        phase: 'scanning',
        unit: 'messages',
        done: scanned,
        total,
        eta_sec: etaSec(scanned, listed - scanned, deps.now().getTime() - scanStart),
      });
    }
  );
  return { ids, metadata };
}

export async function runGmailFullSync(params: FullSyncParams): Promise<FullSyncResult> {
  const { userId, credential, accessToken, deps, progress } = params;
  const resumed = readFullSyncCursor(credential.metadata);
  const profile = await profileOrNull(params);
  const total = profile?.messagesTotal ?? null;
  const cursor: FullSyncCursor = resumed ?? {
    startHistoryId: profile?.historyId ?? null,
    startedAt: deps.now().toISOString(),
    savedThrough: null,
  };
  if (resumed === null) await writeCursor(credential.id, cursor);
  log.info('Full sync starting', {
    credentialId: credential.id,
    resumed: resumed !== null,
    totalKnown: total !== null,
  });

  await progress.report({ state: 'syncing', phase: 'scanning', unit: 'messages', done: 0, total });
  const { ids, metadata } = await scanMailbox(params, total);
  const classification = classifyMailbox(metadata, params.userEmail);
  const selected = metadata.filter((m) => classification.neededIds.has(m.id)).sort(newerFirst);
  const through = cursor.savedThrough;
  const remaining = through === null ? selected : selected.filter((m) => isOlderThan(m, through));
  let settled = ids.length - remaining.length;
  log.info('Full sync selection', {
    credentialId: credential.id,
    listed: ids.length,
    selected: selected.length,
    remaining: remaining.length,
  });

  const saveStart = deps.now().getTime();
  await progress.report({
    state: 'syncing',
    phase: 'saving',
    unit: 'messages',
    done: settled,
    total,
  });
  let contacts = 0;
  let messages = 0;
  for (let i = 0; i < remaining.length; i += FULL_SYNC_BATCH_SIZE) {
    const batch = remaining.slice(i, i + FULL_SYNC_BATCH_SIZE);
    const emails = await fetchFullMessages(
      accessToken,
      batch.map((m) => m.id),
      deps.fetcher
    );
    const contactsToUpsert = await toContactsToUpsert({
      emails,
      userEmail: params.userEmail,
      userId,
      accountEmail: credential.email,
      classification,
    });
    if (contactsToUpsert.length > 0) {
      const saved = await upsertPersonAndMessageRecords(
        userId,
        contactsToUpsert,
        `gmail-full-${credential.id}-${progress.runId}`,
        credential.email,
        credential.id,
        undefined,
        { statsFromStoredChannel: MessageChannel.EMAIL }
      );
      contacts += saved.contacts;
      messages += saved.messages;
    }
    const last = batch[batch.length - 1];
    cursor.savedThrough = { internalDate: last.internalDate, id: last.id };
    await writeCursor(credential.id, cursor);
    await params.heartbeat();
    settled += batch.length;
    const savedNow = i + batch.length;
    await progress.report({
      state: 'syncing',
      phase: 'saving',
      unit: 'messages',
      done: settled,
      total,
      eta_sec: etaSec(savedNow, remaining.length - savedNow, deps.now().getTime() - saveStart),
    });
  }

  const historyId =
    cursor.startHistoryId ?? (await getGmailProfile(accessToken, deps.fetcher)).historyId;
  return { historyId, contacts, messages, listed: ids.length, total };
}
