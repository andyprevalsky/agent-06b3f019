/**
 * integration-accounts blackbox: WhatsApp multi-account (plan row I2).
 *
 *   Mac app (one Baileys auth dir + socket per linked phone)
 *     POST /api/integrations/whatsapp/connect  { accountId: '+1555…', label, claimLegacy? }
 *     POST /api/integrations/whatsapp/upload   { contacts, accountId }
 *     POST /api/integrations/whatsapp/accounts/:accountId/progress
 *   UI
 *     GET    /api/integrations                       → one account per phone
 *     DELETE /api/integrations/whatsapp/accounts/:id → that phone's messages + contacts
 *
 * Account rows store MessageRecord.sourceAccountId = phone and namespace the
 * WhatsApp key.id as "<phone>:<key.id>" (the Telegram convention).
 * Every case runs on fresh anonymous users so the shared sessions of the
 * domain (and any seeded WhatsApp history) are never touched.
 * Registered by integration-accounts.blackbox.ts.
 */
import { prisma } from '../../providers/database';
import {
  accountsOf,
  anonymousSession,
  assert,
  call,
  expectStatus,
  postProgress,
  type Session,
} from './integration-accounts.support';

const PHONE_A = '+15550001111';
const PHONE_B = '+15550002222';
const WAIT_MS = 20_000;

/** Stored externalId of an account-scoped row. */
const ns = (phone: string, id: string): string => `${phone}:${id}`;

interface WaContact {
  contact_id: string;
  contact_name: string;
  firstName: string;
  messages: Array<{ id: string; text: string; date: number; is_from_me: boolean }>;
}

function contact(phone: string, name: string, ids: string[]): WaContact {
  return {
    contact_id: phone,
    contact_name: name,
    firstName: name,
    messages: ids.map((id, i) => ({
      id,
      text: `${name} says ${id}`,
      date: Date.UTC(2026, 9, 1, 12, i),
      is_from_me: false,
    })),
  };
}

async function connect(token: string, accountId: string, claimLegacy = false): Promise<void> {
  const res = await call('/api/integrations/whatsapp/connect', {
    method: 'POST',
    auth: token,
    body: JSON.stringify({ accountId, label: accountId, ...(claimLegacy && { claimLegacy }) }),
  });
  expectStatus(res, 200, `connect ${accountId}`);
}

function postUpload(token: string, accountId: unknown, contacts: WaContact[]) {
  const body = accountId === null ? { contacts } : { contacts, accountId };
  return call('/api/integrations/whatsapp/upload', {
    method: 'POST',
    auth: token,
    body: JSON.stringify(body),
  });
}

async function upload(token: string, accountId: string | null, contacts: WaContact[]) {
  expectStatus(
    await postUpload(token, accountId, contacts),
    200,
    `upload ${accountId ?? 'legacy'}`
  );
}

/** WhatsApp message externalId → sourceAccountId stored for a user. */
async function stored(userId: string): Promise<Map<string, string | null>> {
  const rows = await prisma.messageRecord.findMany({
    where: { person: { userId }, channel: 'WHATSAPP' },
    select: { externalId: true, sourceAccountId: true },
  });
  return new Map(rows.map((r) => [r.externalId ?? '', r.sourceAccountId]));
}

/** Uploads are parsed in the background; wait until every id is stored. */
async function waitForIds(userId: string, ids: string[]): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  // Recursive poll: the lint rule bans loop + setTimeout retry shapes.
  const poll = async (): Promise<void> => {
    const rows = await stored(userId);
    if (ids.every((id) => rows.has(id))) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${ids.filter((id) => !rows.has(id)).join(',')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return poll();
  };
  return poll();
}

async function personPhones(userId: string): Promise<Set<string>> {
  const rows = await prisma.person.findMany({ where: { userId }, select: { phoneNumber: true } });
  return new Set(rows.map((r) => r.phoneNumber ?? ''));
}

function deleteAccount(token: string, accountId: string) {
  return call(`/api/integrations/whatsapp/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    auth: token,
  });
}

async function cleanupUsers(sessions: Session[]): Promise<void> {
  const userId = { in: sessions.map((s) => s.userId) };
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.integrationSyncProgress.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
}

async function twoAccountsListedSeparately(): Promise<void> {
  const s = await anonymousSession();
  try {
    const early = await postUpload(s.token, PHONE_A, [contact('+15550009999', 'X', ['x'])]);
    expectStatus(early, 404, 'upload before the account is connected');
    await connect(s.token, PHONE_A);
    await connect(s.token, PHONE_B);
    let accounts = await accountsOf(s.token, 'whatsapp');
    const ids = accounts.map((a) => a.accountId).sort();
    assert(ids.join() === [PHONE_A, PHONE_B].join(), `two accounts, got ${ids.join()}`);
    assert(
      accounts.every((a) => a.label === a.accountId && a.state === 'synced'),
      'each linked phone is its own connected account labelled by its number'
    );

    const res = await postProgress(s.token, 'whatsapp', PHONE_A, {
      runId: 'history-1',
      state: 'syncing',
      phase: 'full',
      done: 120,
      total: null,
      pct: 40,
      unit: 'messages',
    });
    expectStatus(res, 200, 'history progress for account A');
    accounts = await accountsOf(s.token, 'whatsapp');
    assert(accounts.length === 2, 'progress merges onto its row instead of adding an account');
    const a = accounts.find((x) => x.accountId === PHONE_A);
    const b = accounts.find((x) => x.accountId === PHONE_B);
    assert(a?.state === 'syncing' && a.progress.pct === 40, 'Baileys percent shown on A');
    assert(a.progress.total === null && a.progress.done === 120, 'indeterminate total kept null');
    assert(b?.state === 'synced' && b.progress.done === null, 'B is unaffected by A');

    const contacts = [contact('+15550009999', 'X', ['x'])];
    expectStatus(await postUpload(s.token, 7, contacts), 400, 'non-string accountId');
    expectStatus(await postUpload(s.token, 'not-a-phone', contacts), 400, 'non-phone accountId');
  } finally {
    await cleanupUsers([s]);
  }
}

async function deleteOneAccountKeepsTheOther(): Promise<void> {
  const s = await anonymousSession();
  const other = await anonymousSession();
  try {
    // A contact that came from another source (Contacts/VCF) before WhatsApp.
    await prisma.person.create({
      data: { userId: s.userId, firstName: 'Vcf', lastName: '', phoneNumber: '+15559990003' },
    });
    await connect(s.token, PHONE_A);
    await connect(s.token, PHONE_B);
    await upload(s.token, PHONE_A, [
      contact('+15559990001', 'OnlyA', ['a1', 'a2']),
      contact('+15559990002', 'Shared', ['a3', 'g1']),
      contact('+15559990003', 'Vcf', ['a4']),
    ]);
    const aIds = ['a1', 'a2', 'a3', 'g1', 'a4'].map((id) => ns(PHONE_A, id));
    await waitForIds(s.userId, aIds);
    // `g1` is one group message both phones received: each account keeps its own row.
    await upload(s.token, PHONE_B, [
      contact('+15559990002', 'Shared', ['b1', 'g1']),
      contact('+15559990004', 'OnlyB', ['b2']),
    ]);
    const bIds = ['b1', 'g1', 'b2'].map((id) => ns(PHONE_B, id));
    await waitForIds(s.userId, bIds);
    const rows = await stored(s.userId);
    assert(
      aIds.every((id) => rows.get(id) === PHONE_A) && bIds.every((id) => rows.get(id) === PHONE_B),
      'every row carries the phone that synced it'
    );
    // Another user's history with the same ids and phones must never be touched.
    await upload(other.token, null, [contact('+15559990001', 'OnlyA', ['a1'])]);
    await waitForIds(other.userId, ['a1']);

    expectStatus(await deleteAccount(s.token, PHONE_A), 200, 'delete WhatsApp account A');
    const left = await stored(s.userId);
    assert(
      aIds.every((id) => !left.has(id)),
      "A's messages are gone"
    );
    assert(bIds.every((id) => left.has(id)) && left.size === 3, "B's messages are kept");
    const phones = await personPhones(s.userId);
    assert(!phones.has('+15559990001'), 'a contact only A created is gone');
    assert(phones.has('+15559990002'), 'a contact B still messages is kept');
    assert(phones.has('+15559990003'), 'a contact another source created is kept');
    assert(phones.has('+15559990004'), "B's contact is kept");
    const accounts = await accountsOf(s.token, 'whatsapp');
    assert(accounts.length === 1 && accounts[0].accountId === PHONE_B, 'only B is listed');
    expectStatus(await deleteAccount(s.token, PHONE_A), 404, 'repeat delete');
    const refused = await postUpload(s.token, PHONE_A, [contact('+15559990001', 'OnlyA', ['a9'])]);
    expectStatus(refused, 404, 'a removed account cannot be resurrected by a late upload');
    assert((await stored(other.userId)).has('a1'), "another user's history is untouched");

    expectStatus(await deleteAccount(s.token, PHONE_B), 200, 'delete WhatsApp account B');
    const remaining = await personPhones(s.userId);
    assert(
      !remaining.has('+15559990002'),
      'the shared WhatsApp contact goes with the last account'
    );
    assert(
      remaining.has('+15559990003') && remaining.size === 1,
      'only the other-source contact remains'
    );
  } finally {
    await cleanupUsers([s, other]);
  }
}

async function legacyHistoryGoesWithItsAccount(): Promise<void> {
  const s = await anonymousSession();
  const unclaimed = await anonymousSession();
  try {
    // Pre-multi-account Mac app: no accountId anywhere.
    await upload(s.token, null, [contact('+15559990005', 'Legacy', ['l1'])]);
    await waitForIds(s.userId, ['l1']);
    // The phone of the Mac's legacy auth dir claims the legacy row and history.
    await connect(s.token, PHONE_A, true);
    let accounts = await accountsOf(s.token, 'whatsapp');
    assert(
      accounts.length === 1 && accounts[0].accountId === PHONE_A,
      `the legacy phone claims the legacy row, got ${accounts.map((a) => a.accountId).join()}`
    );
    const adopted = await stored(s.userId);
    assert(
      adopted.get(ns(PHONE_A, 'l1')) === PHONE_A && !adopted.has('l1'),
      'the legacy history is re-attributed to the claiming phone'
    );
    await connect(s.token, PHONE_B);
    await upload(s.token, PHONE_B, [contact('+15559990006', 'Bee', ['b9'])]);
    await waitForIds(s.userId, [ns(PHONE_B, 'b9')]);
    expectStatus(await deleteAccount(s.token, PHONE_A), 200, 'delete the claiming account');
    const ids = await stored(s.userId);
    assert(!ids.has(ns(PHONE_A, 'l1')), 'legacy history goes with the account that claimed it');
    assert(ids.has(ns(PHONE_B, 'b9')), "the second account's history is kept");
    accounts = await accountsOf(s.token, 'whatsapp');
    assert(accounts.length === 1 && accounts[0].accountId === PHONE_B, 'B remains');

    // A phone paired in a new auth dir never claims; the legacy row stays `default`.
    await upload(unclaimed.token, null, [contact('+15559990007', 'Old', ['o1'])]);
    await waitForIds(unclaimed.userId, ['o1']);
    await connect(unclaimed.token, PHONE_B);
    const both = (await accountsOf(unclaimed.token, 'whatsapp')).map((a) => a.accountId).sort();
    assert(both.join() === [PHONE_B, 'default'].join(), `default + B listed, got ${both.join()}`);
    expectStatus(await deleteAccount(unclaimed.token, 'default'), 200, 'delete default account');
    assert((await stored(unclaimed.userId)).size === 0, 'default history is gone');
    const rest = await accountsOf(unclaimed.token, 'whatsapp');
    assert(rest.length === 1 && rest[0].accountId === PHONE_B, 'B is kept');
  } finally {
    await cleanupUsers([s, unclaimed]);
  }
}

export function whatsappCases(): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    { name: 'WhatsApp: two linked phones are two accounts', fn: twoAccountsListedSeparately },
    {
      name: 'WhatsApp: deleting one account removes exactly its messages and contacts',
      fn: deleteOneAccountKeepsTheOther,
    },
    {
      name: 'WhatsApp: legacy history goes with the account that claims it',
      fn: legacyHistoryGoesWithItsAccount,
    },
  ];
}
