/**
 * integration-accounts blackbox: iMessage device accounts (plan row I1).
 *
 *   Mac A ─┐  POST /api/integrations/imessage/upload { contacts, account: { id, label, mode } }
 *   Mac B ─┴► one Integration row + one message set per Mac device id
 *             DELETE /api/integrations/imessage/accounts/:deviceId → exactly that Mac's messages
 *
 * Invariants:
 *   - two Macs are two accounts, listed separately with their labels and progress
 *   - the same chat.db ROWID on two Macs stores two messages (no cross-device dedup loss);
 *     re-uploading a batch from the same Mac stores nothing new
 *   - deleting one Mac removes exactly its messages; the other Mac and legacy rows stay
 *   - a `sync` upload for a removed Mac answers 410 and recreates nothing; `connect` reconnects
 *   - the first Mac claims the legacy row and adopts its messages without duplicating them
 *   - the default (legacy) account delete removes only the legacy, device-less messages
 *   - owner scoping and validation
 * Registered by integration-accounts.blackbox.ts.
 */
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import {
  accountsOf,
  anonymousSession,
  assert,
  call,
  expectStatus,
  postProgress,
  type Res,
  type Session,
} from './integration-accounts.support';

type Users = () => { a: Session; b: Session };

const APPLE_EPOCH_OFFSET_SECONDS = 978307200;
const appleNanos = (iso: string) =>
  (Math.floor(new Date(iso).getTime() / 1000) - APPLE_EPOCH_OFFSET_SECONDS) * 1_000_000_000;

function contactWith(handle: string, rows: Array<{ id: number; text: string }>) {
  return {
    contact_id: handle,
    contact_name: 'Alice Example',
    firstName: 'Alice',
    lastName: 'Example',
    messages: rows.map((row) => ({
      id: row.id,
      text: row.text,
      date: appleNanos('2026-10-01T12:00:00.000Z') + row.id,
      is_from_me: row.id % 2 === 0,
      contactHandle: handle,
    })),
  };
}

function upload(
  token: string,
  contacts: unknown[],
  account?: { id: string; label?: string | null; mode: string }
): Promise<Res> {
  return call('/api/integrations/imessage/upload', {
    method: 'POST',
    auth: token,
    body: JSON.stringify({ contacts, accessedAt: new Date().toISOString(), account }),
  });
}

/** iMessage rows of one user, by source account (`null` = legacy / device-less). */
async function messagesBySource(userId: string): Promise<Map<string | null, string[]>> {
  const rows = await prisma.messageRecord.findMany({
    where: { person: { userId }, channel: 'IMESSAGE' },
    select: { sourceAccountId: true, externalId: true },
    orderBy: { externalId: 'asc' },
  });
  const bySource = new Map<string | null, string[]>();
  for (const row of rows) {
    const list = bySource.get(row.sourceAccountId) ?? [];
    list.push(row.externalId ?? '');
    bySource.set(row.sourceAccountId, list);
  }
  return bySource;
}

/** Wait for the legacy upload's background processing (every 250 ms, up to 20 s). */
async function waitFor(label: string, probe: () => Promise<boolean>): Promise<void> {
  const attempts = 80;
  const ready = await retryWithBackoff(probe, {
    maxRetries: attempts,
    fixedDelays: Array<number>(attempts).fill(250),
    shouldRetryResult: (ok) => !ok,
    component: 'imessage-accounts-blackbox',
  });
  assert(ready, `timed out waiting for ${label}`);
}

const HANDLE = '+15555550101';

/** A user of its own, so other cases' progress-only accounts do not appear. */
let macOwner: Session | null = null;
async function macUser(): Promise<Session> {
  macOwner ??= await anonymousSession();
  return macOwner;
}

async function twoMacsAreTwoAccounts(): Promise<void> {
  const a = await macUser();
  const macA = await upload(a.token, [contactWith(HANDLE, [{ id: 1, text: 'from mac a #1' }])], {
    id: 'mac-a-0001',
    label: "Andy's MacBook Pro",
    mode: 'connect',
  });
  expectStatus(macA, 200, 'Mac A connect batch');
  assert(macA.data.accountId === 'mac-a-0001', 'the response names the device account');
  // Same ROWID on a second Mac: a different message that must not be deduplicated away.
  const macB = await upload(a.token, [contactWith(HANDLE, [{ id: 1, text: 'from mac b #1' }])], {
    id: 'mac-b-0002',
    label: "Andy's iMac",
    mode: 'connect',
  });
  expectStatus(macB, 200, 'Mac B connect batch');
  const more = await upload(
    a.token,
    [
      contactWith(HANDLE, [
        { id: 1, text: 'from mac a #1' },
        { id: 2, text: 'from mac a #2' },
      ]),
    ],
    { id: 'mac-a-0001', mode: 'sync' }
  );
  expectStatus(more, 200, 'Mac A sync batch (one replayed row, one new)');
  assert(
    (more.data.stored as { messages: number }).messages === 2,
    'the batch reports what it processed'
  );

  const bySource = await messagesBySource(a.userId);
  assert(
    JSON.stringify(bySource.get('mac-a-0001')) === JSON.stringify(['mac-a-0001:1', 'mac-a-0001:2']),
    `Mac A keeps its two messages exactly once, got ${JSON.stringify([...bySource])}`
  );
  assert(
    JSON.stringify(bySource.get('mac-b-0002')) === JSON.stringify(['mac-b-0002:1']),
    'Mac B keeps its own ROWID 1 message'
  );

  const progress = await postProgress(a.token, 'imessage', 'mac-a-0001', {
    runId: 'run-a',
    seq: 1,
    state: 'syncing',
    phase: 'uploading',
    done: 500,
    total: 1200,
    unit: 'messages',
  });
  expectStatus(progress, 200, 'Mac A progress');
  const accounts = await accountsOf(a.token, 'imessage');
  const ids = accounts.map((x) => x.accountId).sort();
  assert(
    JSON.stringify(ids) === JSON.stringify(['mac-a-0001', 'mac-b-0002']),
    `two device accounts are listed separately, got ${JSON.stringify(ids)}`
  );
  const listedA = accounts.find((x) => x.accountId === 'mac-a-0001')!;
  const listedB = accounts.find((x) => x.accountId === 'mac-b-0002')!;
  assert(listedA.label === "Andy's MacBook Pro" && listedB.label === "Andy's iMac", 'labels');
  assert(listedA.state === 'syncing' && listedA.progress.pct === 41.6, 'progress joins Mac A');
  assert(listedA.progress.total === 1200 && listedA.progress.unit === 'messages', 'total/unit');
  assert(listedB.state === 'synced' && listedB.progress.done === null, 'Mac B has no run yet');
}

async function deleteOneMacKeepsTheOther(users: Users): Promise<void> {
  const a = await macUser();
  const { b } = users();
  // A device-less upload from an older Mac app: the legacy/default account.
  expectStatus(
    await upload(a.token, [contactWith('+15555550199', [{ id: 77, text: 'legacy' }])]),
    200,
    'legacy upload'
  );
  await waitFor('legacy messages', async () => (await messagesBySource(a.userId)).has(null));

  const foreign = await call('/api/integrations/imessage/accounts/mac-a-0001', {
    method: 'DELETE',
    auth: b.token,
  });
  expectStatus(foreign, 404, "another user cannot delete Mac A's account");

  const del = await call('/api/integrations/imessage/accounts/mac-a-0001', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(del, 200, 'delete Mac A');
  let bySource = await messagesBySource(a.userId);
  assert(!bySource.has('mac-a-0001'), "Mac A's messages are gone");
  assert(bySource.get('mac-b-0002')?.length === 1, "Mac B's messages are kept");
  assert(JSON.stringify(bySource.get(null)) === '["77"]', 'legacy messages are kept');
  const progressLeft = await prisma.integrationSyncProgress.count({
    where: { userId: a.userId, provider: 'imessage', accountId: 'mac-a-0001' },
  });
  assert(progressLeft === 0, "Mac A's progress row is cleared");
  const ids = (await accountsOf(a.token, 'imessage')).map((x) => x.accountId).sort();
  assert(JSON.stringify(ids) === '["default","mac-b-0002"]', `remaining: ${JSON.stringify(ids)}`);

  expectStatus(
    await call('/api/integrations/imessage/accounts/mac-a-0001', {
      method: 'DELETE',
      auth: a.token,
    }),
    404,
    'repeat delete'
  );
  const stale = await upload(a.token, [contactWith(HANDLE, [{ id: 3, text: 'late' }])], {
    id: 'mac-a-0001',
    mode: 'sync',
  });
  expectStatus(stale, 410, 'a sync batch for a removed Mac');
  assert(stale.data.error === 'ACCOUNT_REMOVED', 'typed removal error');
  bySource = await messagesBySource(a.userId);
  assert(!bySource.has('mac-a-0001'), 'a removed Mac stores nothing');
  const rows = await prisma.integration.count({
    where: { userId: a.userId, name: 'imessage', accountId: 'mac-a-0001' },
  });
  assert(rows === 0, 'a sync batch never recreates a removed account');

  const legacyDel = await call('/api/integrations/imessage/accounts/default', {
    method: 'DELETE',
    auth: a.token,
  });
  expectStatus(legacyDel, 200, 'delete the default account');
  bySource = await messagesBySource(a.userId);
  assert(!bySource.has(null), 'the default account removes only device-less messages');
  assert(bySource.get('mac-b-0002')?.length === 1, 'Mac B survives the default delete');

  const reconnect = await upload(a.token, [contactWith(HANDLE, [{ id: 3, text: 'again' }])], {
    id: 'mac-a-0001',
    label: "Andy's MacBook Pro",
    mode: 'connect',
  });
  expectStatus(reconnect, 200, 'connecting again creates the account again');
  bySource = await messagesBySource(a.userId);
  assert(JSON.stringify(bySource.get('mac-a-0001')) === '["mac-a-0001:3"]', 'fresh account');
  await cleanupUser(a.userId);
}

async function firstMacAdoptsLegacy(): Promise<void> {
  const c = await anonymousSession();
  const legacyRows = [
    { id: 1, text: 'one' },
    { id: 2, text: 'two' },
  ];
  expectStatus(await upload(c.token, [contactWith(HANDLE, legacyRows)]), 200, 'legacy upload');
  await waitFor(
    'legacy rows',
    async () => (await messagesBySource(c.userId)).get(null)?.length === 2
  );

  const claim = await upload(
    c.token,
    [contactWith(HANDLE, [...legacyRows, { id: 3, text: 'three' }])],
    { id: 'mac-c-0003', label: 'Studio', mode: 'connect' }
  );
  expectStatus(claim, 200, 'first device batch');
  const bySource = await messagesBySource(c.userId);
  assert(
    JSON.stringify([...bySource.keys()]) === '["mac-c-0003"]' &&
      JSON.stringify(bySource.get('mac-c-0003')) ===
        '["mac-c-0003:1","mac-c-0003:2","mac-c-0003:3"]',
    `legacy messages are adopted, not duplicated: ${JSON.stringify([...bySource])}`
  );
  const rows = await prisma.integration.findMany({
    where: { userId: c.userId, name: 'imessage' },
    select: { accountId: true, accountEmail: true },
  });
  assert(
    rows.length === 1 && rows[0].accountId === 'mac-c-0003' && rows[0].accountEmail === 'Studio',
    `the legacy row becomes the device row: ${JSON.stringify(rows)}`
  );
  await cleanupUser(c.userId);
}

async function deviceUploadValidation(users: Users): Promise<void> {
  const { a } = users();
  const contacts = [contactWith(HANDLE, [{ id: 9, text: 'x' }])];
  for (const [account, label] of [
    [{ id: 'default', mode: 'connect' }, 'reserved default id'],
    [{ id: 'has spaces', mode: 'connect' }, 'id charset'],
    [{ id: 'mac-ok-1', mode: 'merge' }, 'mode'],
    [{ id: 'mac-ok-1', mode: 'connect', label: 'x'.repeat(121) }, 'label length'],
  ] as const) {
    expectStatus(await upload(a.token, contacts, account), 400, label);
  }
  expectStatus(
    await call('/api/integrations/imessage/upload', {
      method: 'POST',
      body: JSON.stringify({ contacts, account: { id: 'mac-ok-1', mode: 'connect' } }),
    }),
    401,
    'unauthenticated device upload'
  );
}

export async function cleanupUser(userId: string): Promise<void> {
  await prisma.messageRecord.deleteMany({ where: { person: { userId } } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.integrationSyncProgress.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
}

export function imessageCases(users: Users): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'iMessage: two Macs are two accounts; same ROWID kept per device',
      fn: () => twoMacsAreTwoAccounts(),
    },
    {
      name: 'iMessage: deleting one Mac removes exactly its messages; 410 after removal',
      fn: () => deleteOneMacKeepsTheOther(users),
    },
    {
      name: 'iMessage: the first Mac claims the legacy row and adopts its messages',
      fn: () => firstMacAdoptsLegacy(),
    },
    { name: 'iMessage: device upload validation', fn: () => deviceUploadValidation(users) },
  ];
}
