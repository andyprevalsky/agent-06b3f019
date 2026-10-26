/**
 * Heavy-user messaging ingestion (iMessage/WhatsApp/Telegram upload path).
 *
 *   POST /imessage/upload ─► MessagingUploadJob parts (≤ PART_MAX_WEIGHT messages)
 *        │ 200 ack                     │ claimed drain (in-process kick + cron)
 *        ▼                             ▼
 *   process may die here      parse part ─► MessageRecord (dedup) ─► Person stats
 *
 * Synthetic data only. These cases are sequential: one spies on the shared
 * Prisma client of this test process.
 */

import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MessageChannel } from '@prisma/client';
import {
  request,
  BASE_URL,
  authHeaders,
  assertStatus,
  assert,
  createAnonSession,
  prisma,
  upsertPersonAndMessageRecords,
} from './integrations.context';
import { retryWithBackoff } from '../../providers/retry';
import { runMessagingUploadJobs } from '../../domains/integrations/uploadService.messaging';
import { PART_MAX_WEIGHT } from '../../domains/integrations/uploadService.messagingJobs';

interface SyntheticContact {
  contact_id: string;
  contact_name: string;
  messages: Array<{ id: number; text: string; date: number; is_from_me: boolean }>;
}

function syntheticContacts(prefix: string, counts: number[]): SyntheticContact[] {
  let rowId = 1;
  return counts.map((count, c) => ({
    contact_id: `+1${prefix}${String(c).padStart(6, '0')}`,
    contact_name: `Synthetic ${c}`,
    messages: Array.from({ length: count }, (_, m) => ({
      id: rowId++,
      text: `synthetic ${c}/${m}`,
      date: 700_000_000_000_000_000 + m * 1_000_000_000,
      is_from_me: m % 2 === 0,
    })),
  }));
}

async function storedMessages(userId: string): Promise<number> {
  return prisma.messageRecord.count({ where: { person: { userId } } });
}

/**
 * Drain (as the cron does) until `done` holds (~60s budget). The test backend
 * drains the same queue concurrently, so every observation re-runs the drain.
 */
async function drainUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  return retryWithBackoff(
    async () => {
      await runMessagingUploadJobs();
      return read();
    },
    {
      maxRetries: 120,
      fixedDelays: Array.from({ length: 120 }, () => 500),
      shouldRetryResult: (value) => !done(value),
      component: 'MessagingIngestionTest',
    }
  );
}

async function drainUntilStored(userId: string, expected: number): Promise<number> {
  return drainUntil(
    () => storedMessages(userId),
    (stored) => stored >= expected
  );
}

function imessageIntegration(userId: string) {
  return prisma.integration.findFirst({ where: { userId, name: 'imessage' } });
}

function cursorOf(integration: { config: unknown } | null): unknown {
  return (integration?.config as Record<string, unknown> | null)?.lastFrontendAccessAt;
}

async function cleanupUser(userId: string): Promise<void> {
  await prisma.messageRecord.deleteMany({ where: { person: { userId } } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.messagingUploadJob.deleteMany({ where: { userId } });
}

/** An acknowledged upload is parsed even if the accepting process exits right after its 200. */
export async function testMessagingUpload_survivesProcessExitAfterAck() {
  const { userId } = await createAnonSession();
  const contacts = syntheticContacts(
    '5551',
    Array.from({ length: 40 }, () => 25)
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'messaging-ingestion-'));
  try {
    const contactsPath = path.join(dir, 'contacts.json');
    fs.writeFileSync(contactsPath, JSON.stringify(contacts));
    const child = spawnSync(
      'npx',
      [
        'tsx',
        path.join(__dirname, 'integrations.messaging-ingestion.child.ts'),
        userId,
        contactsPath,
      ],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      }
    );
    assert(
      child.status === 0 && /acked /.test(child.stdout),
      `child accepted the upload: ${child.stderr}`
    );
    const stored = await drainUntilStored(userId, 1000);
    assert(stored === 1000, `acknowledged upload survives process exit (stored ${stored}/1000)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await cleanupUser(userId);
  }
}

/** An old client's single large body is stored as bounded parts and fully ingested once. */
export async function testMessagingUpload_largeLegacyBodyIngestsInBoundedParts() {
  const session = await createAnonSession();
  const counts = [12_000, ...Array.from({ length: 50 }, () => 10)];
  const contacts = syntheticContacts('5552', counts);
  try {
    const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
      method: 'POST',
      headers: authHeaders(session.accessToken),
      body: JSON.stringify({ contacts, accessedAt: new Date().toISOString() }),
    });
    assertStatus(res.status, 200, res.data);
    const { jobId } = res.data as { jobId: string };
    const stored = await drainUntilStored(session.userId, 12_500);
    assert(stored === 12_500, `every message stored exactly once (stored ${stored}/12500)`);

    const parts = await prisma.messagingUploadJob.findMany({ where: { uploadId: jobId } });
    assert(parts.length >= 3, `large body split into bounded parts (got ${parts.length})`);
    assert(
      parts.every((part) => part.processedAt !== null && part.payload === null),
      'processed parts release their payload'
    );
    const heavy = await prisma.person.findFirst({
      where: { userId: session.userId, phoneNumber: contacts[0].contact_id },
      select: { messagesExchanged: true },
    });
    assert(
      heavy?.messagesExchanged === 12_000,
      `a contact split across parts counts its whole history (got ${heavy?.messagesExchanged})`
    );
    const integration = await drainUntil(
      () => imessageIntegration(session.userId),
      (row) => row?.status === 'CONNECTED'
    );
    assert(integration?.status === 'CONNECTED', 'integration connected after its last part');
    assert(PART_MAX_WEIGHT <= 5_000, 'parts stay bounded');
  } finally {
    await cleanupUser(session.userId);
  }
}

/** A non-final request of a chunked sync must not advance the incremental-read cursor. */
export async function testMessagingUpload_nonFinalChunkKeepsCursor() {
  const session = await createAnonSession();
  const syncStart = '2026-01-01T00:00:00.000Z';
  const post = (body: Record<string, unknown>) =>
    request(`${BASE_URL}/api/integrations/imessage/upload`, {
      method: 'POST',
      headers: authHeaders(session.accessToken),
      body: JSON.stringify(body),
    });
  try {
    const first = await post({
      contacts: syntheticContacts('5553', [3]),
      accessedAt: syncStart,
      syncComplete: false,
    });
    assertStatus(first.status, 200, first.data);
    await drainUntilStored(session.userId, 3);
    const mid = await drainUntil(
      () => imessageIntegration(session.userId),
      (row) => row?.status === 'CONNECTED'
    );
    const midCursor = cursorOf(mid);
    assert(midCursor === undefined, `cursor unchanged mid-sync (got ${String(midCursor)})`);

    const last = await post({ contacts: syntheticContacts('5554', [2]), accessedAt: syncStart });
    assertStatus(last.status, 200, last.data);
    await drainUntilStored(session.userId, 5);
    const done = await drainUntil(
      () => imessageIntegration(session.userId),
      (row) => cursorOf(row) !== undefined
    );
    const cursor = cursorOf(done);
    assert(
      cursor === syncStart,
      `final request advances the cursor to the sync start (${String(cursor)})`
    );
  } finally {
    await cleanupUser(session.userId);
  }
}

/** Seed accepted parts directly, as a previous web process left them. */
async function seedParts(
  userId: string,
  parts: Array<{ part: number; contacts: SyntheticContact[]; attempts?: number }>,
  accessedAt: string
) {
  const integration = await prisma.integration.upsert({
    where: { userId_name_accountId: { userId, name: 'imessage', accountId: '' } },
    create: { userId, name: 'imessage', type: 'DATA_SOURCE', status: 'SYNCING', config: {} },
    update: { status: 'SYNCING' },
  });
  const uploadId = `imessage-upload-${userId}-seeded`;
  await prisma.messagingUploadJob.createMany({
    data: parts.map((p) => ({
      userId,
      integrationId: integration.id,
      platform: 'imessage',
      uploadId,
      part: p.part,
      parts: parts.length,
      payload: p.contacts as unknown as object,
      accessedAt,
      syncComplete: true,
      contacts: 1,
      messages: 1,
      attempts: p.attempts ?? 0,
      claimedUntil: p.attempts !== undefined ? new Date(Date.now() - 60_000) : null,
    })),
  });
  return { uploadId };
}

/**
 * A part that crash-looped through every attempt is dead-lettered. Its sync
 * then ends SYNC_FAILED: a successful sibling must not mark the integration
 * CONNECTED or advance the incremental cursor past the unsent history.
 */
export async function testMessagingUpload_exhaustedPartFailsSyncAndKeepsCursor() {
  const { userId } = await createAnonSession();
  try {
    const { uploadId } = await seedParts(
      userId,
      [
        { part: 0, contacts: syntheticContacts('5555', [2]), attempts: 5 },
        { part: 1, contacts: syntheticContacts('5556', [3]) },
      ],
      '2026-02-01T00:00:00.000Z'
    );
    const parts = await drainUntil(
      () => prisma.messagingUploadJob.findMany({ where: { uploadId }, orderBy: { part: 'asc' } }),
      (rows) => rows[0]?.failedAt !== null && rows[1]?.processedAt !== null
    );
    assert(parts[0].failedAt !== null && parts[0].payload === null, 'exhausted part dead-lettered');
    assert(parts[1].processedAt !== null, 'sibling part processed');
    await runMessagingUploadJobs();
    const integration = await imessageIntegration(userId);
    assert(integration?.status === 'SYNC_FAILED', `sync failed (got ${integration?.status})`);
    assert(cursorOf(integration) === undefined, 'cursor not advanced past a failed part');
  } finally {
    await cleanupUser(userId);
    await prisma.integration.deleteMany({ where: { userId } });
  }
}

/** A storage failure inside a part fails the part (retried), not marks it processed. */
export async function testMessagingUpload_chunkStoreFailureLeavesPartRetryable() {
  const { userId } = await createAnonSession();
  try {
    const contacts = syntheticContacts('5557', [2]);
    // Stores fine as JSON, but converts to an invalid Date that the insert rejects.
    contacts[0].messages[0].date = 1e30;
    const { uploadId } = await seedParts(
      userId,
      [{ part: 0, contacts }],
      '2026-03-01T00:00:00.000Z'
    );
    const [part] = await drainUntil(
      () => prisma.messagingUploadJob.findMany({ where: { uploadId } }),
      (rows) => (rows[0]?.attempts ?? 0) >= 1 && rows[0]?.lastError !== null
    );
    assert(part.processedAt === null, 'a part with unstored messages is not processed');
    assert(part.failedAt === null && part.payload !== null, 'payload retained for the retry');
    assert(/contact chunk/.test(part.lastError ?? ''), `chunk failure recorded: ${part.lastError}`);
  } finally {
    await cleanupUser(userId);
    await prisma.integration.deleteMany({ where: { userId } });
  }
}

/** Contact ingestion issues O(chunks) database round trips, not O(contacts). */
export async function testContactUpsert_roundTripsScaleWithChunks() {
  const { userId } = await createAnonSession();
  const contactCount = 1000;
  let calls = 0;
  const restores: Array<() => void> = [];
  const spy = (target: Record<string, unknown>, names: string[]) => {
    for (const name of names) {
      const original = target[name] as (...args: unknown[]) => unknown;
      target[name] = (...args: unknown[]) => {
        calls++;
        return original.apply(target, args);
      };
      restores.push(() => {
        target[name] = original;
      });
    }
  };
  try {
    spy(prisma.person as unknown as Record<string, unknown>, ['update', 'findMany', 'createMany']);
    spy(prisma.messageRecord as unknown as Record<string, unknown>, ['createMany']);
    spy(prisma as unknown as Record<string, unknown>, ['$executeRaw', '$queryRaw']);
    const result = await upsertPersonAndMessageRecords(
      userId,
      Array.from({ length: contactCount }, (_, c) => ({
        identifier: `+1555${String(c).padStart(7, '0')}`,
        identifierType: 'phone' as const,
        firstName: `F${c}`,
        messages: [0, 1].map((m) => ({
          channel: MessageChannel.IMESSAGE,
          from: 'me',
          to: 'them',
          timestamp: new Date(),
          message: `m${m}`,
          externalId: `${c}-${m}`,
        })),
      })),
      'round-trip-bound'
    );
    restores.forEach((restore) => restore());
    restores.length = 0;
    const bound = Math.ceil(contactCount / 50) * 6;
    assert(result.messages === 2 * contactCount, `all messages stored (${result.messages})`);
    assert(calls <= bound, `${calls} DB calls for ${contactCount} contacts (bound ${bound})`);
    const wrong = await prisma.person.count({
      where: { userId, NOT: { messagesExchanged: 2 } },
    });
    assert(wrong === 0, `messagesExchanged set for every contact (${wrong} wrong)`);
  } finally {
    restores.forEach((restore) => restore());
    await cleanupUser(userId);
  }
}
