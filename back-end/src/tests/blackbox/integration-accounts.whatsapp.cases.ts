/**
 * integration-accounts blackbox: WhatsApp multi-account (plan row I2).
 *
 *   Mac app (one Baileys auth dir + socket per linked phone)
 *     POST /api/integrations/whatsapp/connect  { accountId: '+1555…', label }
 *     POST /api/integrations/whatsapp/upload   { contacts, accountId }
 *     POST /api/integrations/whatsapp/accounts/:accountId/progress
 *   UI
 *     GET    /api/integrations                       → one account per phone
 *     DELETE /api/integrations/whatsapp/accounts/:id → that phone's messages + contacts
 *
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

async function connect(token: string, accountId: string): Promise<void> {
  const res = await call('/api/integrations/whatsapp/connect', {
    method: 'POST',
    auth: token,
    body: JSON.stringify({ accountId, label: accountId }),
  });
  expectStatus(res, 200, `connect ${accountId}`);
}

async function upload(token: string, accountId: string | null, contacts: WaContact[]) {
  const body = accountId === null ? { contacts } : { contacts, accountId };
  const res = await call('/api/integrations/whatsapp/upload', {
    method: 'POST',
    auth: token,
    body: JSON.stringify(body),
  });
  expectStatus(res, 200, `upload ${accountId ?? 'legacy'}`);
}

/** WhatsApp message externalIds stored for a user. */
async function storedIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.messageRecord.findMany({
    where: { person: { userId }, channel: 'WHATSAPP' },
    select: { externalId: true },
  });
  return new Set(rows.map((r) => r.externalId ?? ''));
}

/** Uploads are parsed in the background; wait until every id is stored. */
async function waitForIds(userId: string, ids: string[]): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  // Recursive poll: the lint rule bans loop + setTimeout retry shapes.
  const poll = async (): Promise<void> => {
    const stored = await storedIds(userId);
    if (ids.every((id) => stored.has(id))) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${ids.filter((id) => !stored.has(id)).join(',')}`);
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

    const bad = await call('/api/integrations/whatsapp/upload', {
      method: 'POST',
      auth: s.token,
      body: JSON.stringify({ contacts: [contact('+15550009999', 'X', ['x'])], accountId: 7 }),
    });
    expectStatus(bad, 400, 'non-string accountId');
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
      contact('+15559990002', 'Shared', ['a3']),
      contact('+15559990003', 'Vcf', ['a4']),
    ]);
    await waitForIds(s.userId, ['a1', 'a2', 'a3', 'a4']);
    await upload(s.token, PHONE_B, [
      contact('+15559990002', 'Shared', ['b1']),
      contact('+15559990004', 'OnlyB', ['b2']),
    ]);
    await waitForIds(s.userId, ['b1', 'b2']);
    // Another user's history with the same ids and phones must never be touched.
    await upload(other.token, null, [contact('+15559990001', 'OnlyA', ['a1'])]);
    await waitForIds(other.userId, ['a1']);

    const del = await deleteAccount(s.token, PHONE_A);
    expectStatus(del, 200, 'delete WhatsApp account A');
    const ids = await storedIds(s.userId);
    assert(
      ['a1', 'a2', 'a3', 'a4'].every((id) => !ids.has(id)),
      "A's messages are gone"
    );
    assert(ids.has('b1') && ids.has('b2') && ids.size === 2, "B's messages are kept");
    const phones = await personPhones(s.userId);
    assert(!phones.has('+15559990001'), 'a contact only A created is gone');
    assert(phones.has('+15559990002'), 'a contact B still messages is kept');
    assert(phones.has('+15559990003'), 'a contact another source created is kept');
    assert(phones.has('+15559990004'), "B's contact is kept");
    const accounts = await accountsOf(s.token, 'whatsapp');
    assert(accounts.length === 1 && accounts[0].accountId === PHONE_B, 'only B is listed');
    expectStatus(await deleteAccount(s.token, PHONE_A), 404, 'repeat delete');
    assert((await storedIds(other.userId)).has('a1'), "another user's history is untouched");

    expectStatus(await deleteAccount(s.token, PHONE_B), 200, 'delete WhatsApp account B');
    const left = await personPhones(s.userId);
    assert(!left.has('+15559990002'), 'the shared WhatsApp contact goes with the last account');
    assert(left.has('+15559990003') && left.size === 1, 'only the other-source contact remains');
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
    await connect(s.token, PHONE_A);
    let accounts = await accountsOf(s.token, 'whatsapp');
    assert(
      accounts.length === 1 && accounts[0].accountId === PHONE_A,
      `the first linked phone claims the legacy row, got ${accounts.map((a) => a.accountId).join()}`
    );
    await connect(s.token, PHONE_B);
    await upload(s.token, PHONE_B, [contact('+15559990006', 'Bee', ['b9'])]);
    await waitForIds(s.userId, ['b9']);
    expectStatus(await deleteAccount(s.token, PHONE_A), 200, 'delete the claiming account');
    const ids = await storedIds(s.userId);
    assert(!ids.has('l1'), 'legacy history goes with the account that claimed it');
    assert(ids.has('b9'), "the second account's history is kept");
    accounts = await accountsOf(s.token, 'whatsapp');
    assert(accounts.length === 1 && accounts[0].accountId === PHONE_B, 'B remains');

    // A legacy row nobody claimed is the `default` account.
    await upload(unclaimed.token, null, [contact('+15559990007', 'Old', ['o1'])]);
    await waitForIds(unclaimed.userId, ['o1']);
    expectStatus(await deleteAccount(unclaimed.token, 'default'), 200, 'delete default account');
    assert((await storedIds(unclaimed.userId)).size === 0, 'default history is gone');
    assert((await accountsOf(unclaimed.token, 'whatsapp')).length === 0, 'no account left');
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
