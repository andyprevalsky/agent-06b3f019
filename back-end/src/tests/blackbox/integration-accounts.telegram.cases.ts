/**
 * integration-accounts blackbox: Telegram multi-account sessions (plan row I8).
 * Registered by integration-accounts.blackbox.ts.
 *
 *   Mac session A ─ connect {accountId: A} ─┐        ┌─ GET /api/integrations → A and B
 *   Mac session B ─ connect {accountId: B} ─┼─ upload {accountId} → MessageRecord.sourceAccountId
 *                                           └─ DELETE /telegram/accounts/A → only A's rows go
 *
 * Invariants covered:
 *   - two Telegram accounts (accountId = Telegram user id) are two listed accounts
 *   - uploads are attributed to their account; equal message ids from two accounts both stay
 *   - deleting one account removes exactly its messages, row and progress; the other survives
 *   - an upload for a removed account is refused and never resurrects it
 *   - claiming the legacy row moves its unattributed messages to the claiming account
 *   - the legacy `default` account deletes only unattributed Telegram messages
 */
import { prisma } from '../../providers/database';
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

interface TgMessage {
  id: string;
  text: string;
}

function connect(token: string, body?: Record<string, unknown>): Promise<Res> {
  return call('/api/integrations/telegram/connect', {
    method: 'POST',
    auth: token,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function upload(
  token: string,
  accountId: string | undefined,
  contactId: string,
  messages: TgMessage[]
): Promise<Res> {
  return call('/api/integrations/telegram/upload', {
    method: 'POST',
    auth: token,
    body: JSON.stringify({
      ...(accountId === undefined ? {} : { accountId }),
      accessedAt: new Date().toISOString(),
      contacts: [
        {
          contact_id: contactId,
          contact_name: `Contact ${contactId}`,
          messages: messages.map((m, i) => ({
            id: m.id,
            text: m.text,
            date: Date.UTC(2026, 9, 1, 12, i),
            is_from_me: false,
          })),
        },
      ],
    }),
  });
}

async function telegramRows(userId: string) {
  return prisma.messageRecord.findMany({
    where: { person: { userId }, channel: 'TELEGRAM' },
    select: { externalId: true, sourceAccountId: true, message: true },
    orderBy: { externalId: 'asc' },
  });
}

/** Uploads are parsed in the background; wait until the expected rows are visible. */
async function waitForTelegramRows(userId: string, count: number, label: string) {
  const deadline = Date.now() + 30_000;
  const poll = async (): Promise<Awaited<ReturnType<typeof telegramRows>>> => {
    const rows = await telegramRows(userId);
    if (rows.length === count || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return poll();
  };
  const rows = await poll();
  assert(rows.length === count, `${label}: expected ${count} Telegram rows, got ${rows.length}`);
  return rows;
}

/** Background uploads that should be no-ops: give them time, then prove nothing changed. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

async function cleanupUser(userId: string): Promise<void> {
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.integrationSyncProgress.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
}

async function withUser(fn: (s: Session) => Promise<void>): Promise<void> {
  const session = await anonymousSession();
  try {
    await fn(session);
  } finally {
    await cleanupUser(session.userId);
  }
}

async function twoAccountsListSeparately(): Promise<void> {
  await withUser(async (s) => {
    expectStatus(await connect(s.token, { accountId: '700001', label: '@alice' }), 200, 'A');
    expectStatus(await connect(s.token, { accountId: '700002', label: 'Bob Work' }), 200, 'B');
    expectStatus(await connect(s.token, { accountId: '700001', label: '@alice' }), 200, 'A again');
    const list = await accountsOf(s.token, 'telegram');
    assert(list.length === 2, `two Telegram accounts, got ${JSON.stringify(list)}`);
    const a = list.find((x) => x.accountId === '700001');
    const b = list.find((x) => x.accountId === '700002');
    assert(a?.label === '@alice' && b?.label === 'Bob Work', 'each account keeps its own label');
    assert(a.state === 'synced' && b.state === 'synced', 'connected accounts read synced');
    const legacy = await prisma.integration.count({
      where: { userId: s.userId, name: 'telegram', accountId: '' },
    });
    assert(legacy === 0, 'account-scoped connects never create the legacy row');
    expectStatus(await connect(s.token, { accountId: '../x' }), 400, 'non-numeric accountId');
    expectStatus(await connect(s.token, { accountId: '1', extra: true }), 400, 'unknown field');
  });
}

async function uploadsAreAttributedPerAccount(): Promise<void> {
  await withUser(async (s) => {
    await connect(s.token, { accountId: '700001' });
    await connect(s.token, { accountId: '700002' });
    // Telegram private-chat message ids are per-account counters: both accounts
    // can have message 42 with the same contact.
    expectStatus(await upload(s.token, '700001', '555000111', [{ id: '42', text: 'A' }]), 200, 'A');
    expectStatus(await upload(s.token, '700002', '555000111', [{ id: '42', text: 'B' }]), 200, 'B');
    const rows = await waitForTelegramRows(s.userId, 2, 'two accounts');
    assert(
      JSON.stringify(rows.map((r) => [r.sourceAccountId, r.externalId, r.message])) ===
        JSON.stringify([
          ['700001', '700001:42', 'A'],
          ['700002', '700002:42', 'B'],
        ]),
      `rows attributed per account: ${JSON.stringify(rows)}`
    );
    expectStatus(await upload(s.token, '700001', '555000111', [{ id: '42', text: 'A' }]), 200, 'A');
    await settle();
    assert((await telegramRows(s.userId)).length === 2, 'a replayed upload is deduplicated');
  });
}

async function deleteOneAccountKeepsTheOther(): Promise<void> {
  await withUser(async (s) => {
    await connect(s.token, { accountId: '700001' });
    await connect(s.token, { accountId: '700002' });
    await upload(s.token, '700001', '555000222', [
      { id: '1', text: 'a1' },
      { id: '2', text: 'a2' },
    ]);
    await upload(s.token, '700002', '555000222', [{ id: '1', text: 'b1' }]);
    await waitForTelegramRows(s.userId, 3, 'before delete');
    const person = await prisma.person.findFirstOrThrow({
      where: { userId: s.userId, phoneNumber: '555000222' },
    });
    await prisma.messageRecord.create({
      data: {
        personId: person.id,
        channel: 'WHATSAPP',
        from: 'me',
        to: '555000222',
        timestamp: new Date(),
        message: 'other channel',
        externalId: 'wa-1',
      },
    });
    for (const accountId of ['700001', '700002']) {
      await postProgress(s.token, 'telegram', accountId, {
        runId: 'r',
        state: 'synced',
        done: 2,
        total: 2,
        unit: 'chats',
      });
    }
    const other = await anonymousSession();
    try {
      const foreign = await call('/api/integrations/telegram/accounts/700001', {
        method: 'DELETE',
        auth: other.token,
      });
      expectStatus(foreign, 404, "another user deleting A's account");
    } finally {
      await cleanupUser(other.userId);
    }
    const res = await call('/api/integrations/telegram/accounts/700001', {
      method: 'DELETE',
      auth: s.token,
    });
    expectStatus(res, 200, 'delete account 700001');
    const rows = await telegramRows(s.userId);
    assert(
      rows.length === 1 && rows[0].sourceAccountId === '700002',
      `only B's messages remain: ${JSON.stringify(rows)}`
    );
    const whatsapp = await prisma.messageRecord.count({
      where: { personId: person.id, channel: 'WHATSAPP' },
    });
    assert(whatsapp === 1, 'messages of other channels are untouched');
    const list = await accountsOf(s.token, 'telegram');
    assert(list.length === 1 && list[0].accountId === '700002', 'B is still listed');
    assert(list[0].progress.total === 2 && list[0].progress.unit === 'chats', 'B progress kept');
    const progressRows = await prisma.integrationSyncProgress.count({
      where: { userId: s.userId, provider: 'telegram', accountId: '700001' },
    });
    assert(progressRows === 0, "A's progress row is gone");
    const again = await call('/api/integrations/telegram/accounts/700001', {
      method: 'DELETE',
      auth: s.token,
    });
    expectStatus(again, 404, 'repeat delete');

    const late = await upload(s.token, '700001', '555000222', [{ id: '3', text: 'late' }]);
    expectStatus(late, 404, 'upload for a removed account');
    assert(late.data.error === 'TELEGRAM_ACCOUNT_NOT_CONNECTED', 'typed not-connected error');
    await settle();
    assert((await telegramRows(s.userId)).length === 1, 'the late upload stored nothing');
    const resurrected = await prisma.integration.count({
      where: { userId: s.userId, name: 'telegram', accountId: '700001' },
    });
    assert(resurrected === 0, 'an upload never recreates a removed account');
  });
}

async function claimMovesLegacyMessages(): Promise<void> {
  await withUser(async (s) => {
    expectStatus(await connect(s.token), 200, 'legacy connect');
    expectStatus(
      await upload(s.token, undefined, '555000333', [{ id: '7', text: 'old' }]),
      200,
      'u'
    );
    let rows = await waitForTelegramRows(s.userId, 1, 'legacy upload');
    assert(rows[0].sourceAccountId === null && rows[0].externalId === '7', 'legacy row shape');
    const res = await connect(s.token, { accountId: '700003', label: '@me', claimLegacy: true });
    expectStatus(res, 200, 'claiming connect');
    const list = await accountsOf(s.token, 'telegram');
    assert(list.length === 1 && list[0].accountId === '700003', 'the legacy row was adopted');
    rows = await telegramRows(s.userId);
    assert(
      rows[0].sourceAccountId === '700003' && rows[0].externalId === '700003:7',
      `legacy messages now belong to the account: ${JSON.stringify(rows)}`
    );
    await upload(s.token, '700003', '555000333', [{ id: '7', text: 'old' }]);
    await settle();
    assert((await telegramRows(s.userId)).length === 1, 're-syncing a claimed message dedups');
  });
}

async function defaultAccountDeletesOnlyUnattributed(): Promise<void> {
  await withUser(async (s) => {
    await connect(s.token);
    await upload(s.token, undefined, '555000444', [{ id: '9', text: 'legacy' }]);
    await waitForTelegramRows(s.userId, 1, 'legacy upload');
    await connect(s.token, { accountId: '700004' });
    await upload(s.token, '700004', '555000444', [{ id: '10', text: 'new' }]);
    await waitForTelegramRows(s.userId, 2, 'account upload');
    let list = await accountsOf(s.token, 'telegram');
    assert(list.length === 2, `default + 700004 listed, got ${JSON.stringify(list)}`);
    const res = await call('/api/integrations/telegram/accounts/default', {
      method: 'DELETE',
      auth: s.token,
    });
    expectStatus(res, 200, 'delete the default account');
    const rows = await telegramRows(s.userId);
    assert(
      rows.length === 1 && rows[0].sourceAccountId === '700004',
      `only attributed rows remain: ${JSON.stringify(rows)}`
    );
    list = await accountsOf(s.token, 'telegram');
    assert(list.length === 1 && list[0].accountId === '700004', 'the real account survives');
  });
}

export function telegramCases(): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    { name: 'telegram: two accounts connect and list separately', fn: twoAccountsListSeparately },
    { name: 'telegram: uploads are attributed per account', fn: uploadsAreAttributedPerAccount },
    { name: 'telegram: delete one account keeps the other', fn: deleteOneAccountKeepsTheOther },
    { name: 'telegram: claiming the legacy row moves its messages', fn: claimMovesLegacyMessages },
    {
      name: 'telegram: default account deletes only unattributed messages',
      fn: defaultAccountDeletesOnlyUnattributed,
    },
  ];
}
