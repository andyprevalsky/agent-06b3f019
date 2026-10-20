/**
 * Passwords and passkeys as integration accounts (plan row I7).
 *
 *   Mac app upload (chrome Default, chrome Profile 1, safari, …)
 *        │  POST /api/integrations/passwords/upload | passwords/apple/upload | passkeys/upload
 *        ▼
 *   BrowserPassword  unique (userId, origin, username, browserSource, browserProfile)
 *   PasskeyCredential  browserSource = account
 *        │
 *        ├── GET /api/integrations      provider `<source>_passwords`, one account per profile
 *        │                              (`default` = no profile), progress done/total = batch
 *        ├── DELETE /api/integrations/<provider>/accounts/<profile|default>
 *        │                              removes only that source+profile's rows
 *        └── readers (auth options, browser session passwords) see ONE login per
 *            origin+username: enabled > user-synced > newest use > newest sync
 */
import crypto from 'node:crypto';
import { prisma } from '../../providers/database';
import { getAuthOptions } from '../../providers/authOptions';
import { upsertIntegration } from '../../domains/integrations/repo';
import { findPasswords } from '../../domains/browser-session/repo';
import {
  accountsOf,
  anonymousSession,
  assert,
  BASE_URL,
  call,
  expectStatus,
  type Account,
  type Session,
} from './integration-accounts.support';

const SITE = 'https://shop.example';
const USERNAME = 'ana@example.com';

function encryptPayload(payload: unknown): { data: string; iv: string; key: string } {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const data = cipher.update(JSON.stringify(payload), 'utf8', 'hex') + cipher.final('hex');
  return { data, iv: iv.toString('hex'), key: key.toString('hex') };
}

interface UploadEntry {
  origin?: string;
  username?: string;
  encryptedPassword: string;
  browserSource: string;
  browserProfile?: string;
  dateLastUsed?: number;
}

function uploadPasswords(token: string, entries: UploadEntry[]) {
  const now = Date.now();
  const passwords = entries.map((entry) => ({
    origin: entry.origin ?? SITE,
    username: entry.username ?? USERNAME,
    encryptedPassword: entry.encryptedPassword,
    dateLastUsed: entry.dateLastUsed ?? now,
    dateCreated: now - 60_000,
    browserSource: entry.browserSource,
    ...(entry.browserProfile !== undefined && { browserProfile: entry.browserProfile }),
  }));
  return call('/api/integrations/passwords/upload', {
    method: 'POST',
    auth: token,
    body: JSON.stringify(encryptPayload({ passwords })),
  });
}

async function storedPasswords(userId: string) {
  const rows = await prisma.browserPassword.findMany({
    where: { userId },
    orderBy: [{ browserSource: 'asc' }, { browserProfile: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    key: `${row.browserSource}/${row.browserProfile}`,
    origin: row.origin,
    username: row.username,
    encryptedPassword: row.encryptedPassword,
  }));
}

function accountIds(accounts: Account[]): string[] {
  return accounts.map((account) => account.accountId).sort();
}

async function cleanupUser(userId: string): Promise<void> {
  const where = { userId };
  await prisma.integrationSyncProgress.deleteMany({ where });
  await prisma.browserPassword.deleteMany({ where });
  await prisma.passkeyCredential.deleteMany({ where });
  await prisma.integration.deleteMany({ where });
}

async function withSession(fn: (session: Session) => Promise<void>): Promise<void> {
  const session = await anonymousSession();
  try {
    await fn(session);
  } finally {
    await cleanupUser(session.userId);
  }
}

/** The bug: one login saved in two browsers or two Chrome profiles kept only the last upload. */
async function sameLoginFromEverySourceIsKept(): Promise<void> {
  await withSession(async ({ token, userId }) => {
    const first = await uploadPasswords(token, [
      {
        encryptedPassword: 'ct-chrome-default',
        browserSource: 'chrome',
        browserProfile: 'Default',
      },
      { encryptedPassword: 'ct-chrome-p1', browserSource: 'chrome', browserProfile: 'Profile 1' },
    ]);
    expectStatus(first, 200, 'chrome upload');
    assert(
      first.data.passwordCount === 2,
      `two Chrome profiles stored, got ${first.data.passwordCount}`
    );
    // A later upload from another browser must not overwrite the Chrome rows.
    expectStatus(
      await uploadPasswords(token, [{ encryptedPassword: 'ct-safari', browserSource: 'safari' }]),
      200,
      'safari upload'
    );
    const rows = await storedPasswords(userId);
    assert(
      JSON.stringify(rows.map((row) => [row.key, row.encryptedPassword])) ===
        JSON.stringify([
          ['chrome/Default', 'ct-chrome-default'],
          ['chrome/Profile 1', 'ct-chrome-p1'],
          ['safari/', 'ct-safari'],
        ]),
      `one row per source+profile, got ${JSON.stringify(rows.map((row) => row.key))}`
    );
  });
}

async function reuploadIsIdempotent(): Promise<void> {
  await withSession(async ({ token, userId }) => {
    const batch = (suffix: string): UploadEntry[] => [
      { encryptedPassword: `ct-a-${suffix}`, browserSource: 'chrome', browserProfile: 'Default' },
      { encryptedPassword: `ct-b-${suffix}`, browserSource: 'chrome', browserProfile: 'Profile 1' },
    ];
    expectStatus(await uploadPasswords(token, batch('1')), 200, 'first upload');
    const before = await storedPasswords(userId);
    expectStatus(await uploadPasswords(token, batch('2')), 200, 'same accounts again');
    const now = Date.now();
    // Duplicates of one source+profile inside one batch keep the most recently used.
    const dup = await uploadPasswords(token, [
      {
        encryptedPassword: 'ct-old',
        browserSource: 'chrome',
        browserProfile: 'Default',
        dateLastUsed: now - 5_000,
      },
      {
        encryptedPassword: 'ct-new',
        browserSource: 'chrome',
        browserProfile: 'Default',
        dateLastUsed: now,
      },
    ]);
    expectStatus(dup, 200, 'duplicates inside one batch');
    assert(
      dup.data.passwordCount === 1,
      `one row for a duplicated key, got ${dup.data.passwordCount}`
    );
    const after = await storedPasswords(userId);
    assert(after.length === 2, `re-uploads create no duplicates, got ${after.length} rows`);
    assert(
      JSON.stringify(after.map((row) => row.id)) === JSON.stringify(before.map((row) => row.id)),
      're-uploads update the same rows in place'
    );
    assert(
      after[0].encryptedPassword === 'ct-new' && after[1].encryptedPassword === 'ct-b-2',
      `latest values win: ${JSON.stringify(after.map((row) => row.encryptedPassword))}`
    );
  });
}

async function eachSourceProfileIsAnAccount(): Promise<void> {
  await withSession(async ({ token, userId }) => {
    // A pre-profile upload left the legacy whole-source row; profiles now claim it.
    const legacy = await upsertIntegration({
      userId,
      name: 'chrome_passwords',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      config: { browserSource: 'chrome', passwordCount: 9 },
    });
    const res = await uploadPasswords(token, [
      {
        encryptedPassword: 'a1',
        browserSource: 'chrome',
        browserProfile: 'Default',
        origin: 'https://a.example',
      },
      {
        encryptedPassword: 'a2',
        browserSource: 'chrome',
        browserProfile: 'Default',
        origin: 'https://b.example',
      },
      {
        encryptedPassword: 'a3',
        browserSource: 'chrome',
        browserProfile: 'Default',
        origin: 'https://c.example',
      },
      {
        encryptedPassword: 'b1',
        browserSource: 'chrome',
        browserProfile: 'Profile 1',
        origin: 'https://a.example',
      },
      {
        encryptedPassword: 'b2',
        browserSource: 'chrome',
        browserProfile: 'Profile 1',
        origin: 'https://b.example',
      },
      { encryptedPassword: 's1', browserSource: 'safari' },
    ]);
    expectStatus(res, 200, 'multi-account upload');
    const chrome = await accountsOf(token, 'chrome_passwords');
    assert(
      JSON.stringify(accountIds(chrome)) === JSON.stringify(['Default', 'Profile 1']),
      `each Chrome profile is an account (legacy row claimed), got ${JSON.stringify(accountIds(chrome))}`
    );
    const byId = new Map(chrome.map((account) => [account.accountId, account]));
    for (const [accountId, total] of [
      ['Default', 3],
      ['Profile 1', 2],
    ] as const) {
      const account = byId.get(accountId)!;
      assert(account.state === 'synced', `${accountId} synced, got ${account.state}`);
      assert(
        account.progress.done === total &&
          account.progress.total === total &&
          account.progress.pct === 100 &&
          account.progress.unit === 'passwords',
        `${accountId} progress is the uploaded batch: ${JSON.stringify(account.progress)}`
      );
      assert(account.lastSyncAt !== null, `${accountId} has a sync time`);
    }
    const stored = await prisma.integration.findUniqueOrThrow({ where: { id: legacy.id } });
    assert(
      stored.accountId === 'Default',
      `the legacy row became Default, got '${stored.accountId}'`
    );
    const safari = await accountsOf(token, 'safari_passwords');
    assert(
      safari.length === 1 && safari[0].accountId === 'default' && safari[0].progress.total === 1,
      `a profile-less source is its default account: ${JSON.stringify(safari)}`
    );
  });
}

async function deleteRemovesOnlyThatAccount(): Promise<void> {
  await withSession(async ({ token, userId }) => {
    expectStatus(
      await uploadPasswords(token, [
        { encryptedPassword: 'd', browserSource: 'chrome', browserProfile: 'Default' },
        { encryptedPassword: 'p', browserSource: 'chrome', browserProfile: 'Profile 1' },
        {
          encryptedPassword: 'p2',
          browserSource: 'chrome',
          browserProfile: 'Profile 1',
          origin: 'https://x.example',
        },
        { encryptedPassword: 's', browserSource: 'safari' },
      ]),
      200,
      'seed upload'
    );
    const other = await anonymousSession();
    try {
      const foreign = await call('/api/integrations/chrome_passwords/accounts/Profile%201', {
        method: 'DELETE',
        auth: other.token,
      });
      expectStatus(foreign, 404, "another user deleting this user's profile");
      assert((await storedPasswords(userId)).length === 4, 'a foreign delete removes nothing');
    } finally {
      await cleanupUser(other.userId);
    }

    const res = await call('/api/integrations/chrome_passwords/accounts/Profile%201', {
      method: 'DELETE',
      auth: token,
    });
    expectStatus(res, 200, 'delete chrome Profile 1');
    assert(
      JSON.stringify((await storedPasswords(userId)).map((row) => row.key)) ===
        JSON.stringify(['chrome/Default', 'safari/']),
      'only chrome/Profile 1 rows are removed'
    );
    const chrome = await accountsOf(token, 'chrome_passwords');
    assert(
      JSON.stringify(accountIds(chrome)) === JSON.stringify(['Default']),
      `Profile 1 is no longer listed, got ${JSON.stringify(accountIds(chrome))}`
    );
    const progress = await prisma.integrationSyncProgress.count({
      where: { userId, provider: 'chrome_passwords', accountId: 'Profile 1' },
    });
    assert(progress === 0, 'the deleted account progress row is gone');
    expectStatus(
      await call('/api/integrations/chrome_passwords/accounts/Profile%201', {
        method: 'DELETE',
        auth: token,
      }),
      404,
      'repeat delete'
    );

    expectStatus(
      await call('/api/integrations/safari_passwords/accounts/default', {
        method: 'DELETE',
        auth: token,
      }),
      200,
      'delete safari default account'
    );
    assert(
      JSON.stringify((await storedPasswords(userId)).map((row) => row.key)) ===
        JSON.stringify(['chrome/Default']),
      'safari rows are removed and Chrome Default is untouched'
    );
    assert((await accountsOf(token, 'safari_passwords')).length === 0, 'safari account is gone');
  });
}

async function applePasswordsImportIsAnAccount(): Promise<void> {
  await withSession(async ({ token, userId }) => {
    const csv = [
      'Title,URL,Username,Password,Notes,OTPAuth',
      'Shop,https://shop.example/login,ana@example.com,pw-1,,',
      'Bank,https://bank.example/,ana@example.com,pw-2,,',
    ].join('\n');
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'passwords.csv');
    const response = await fetch(`${BASE_URL}/api/integrations/passwords/apple/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const body = (await response.json()) as { passwordCount?: number };
    assert(
      response.status === 200,
      `apple import 200, got ${response.status} ${JSON.stringify(body)}`
    );
    assert(body.passwordCount === 2, `two Apple passwords, got ${body.passwordCount}`);
    // The same login already synced from Chrome stays a separate row.
    expectStatus(
      await uploadPasswords(token, [
        { encryptedPassword: 'chrome', browserSource: 'chrome', browserProfile: 'Default' },
      ]),
      200,
      'chrome upload'
    );
    const apple = await accountsOf(token, 'apple_passwords');
    assert(
      apple.length === 1 &&
        apple[0].accountId === 'default' &&
        apple[0].progress.done === 2 &&
        apple[0].progress.total === 2,
      `apple import is one account with batch progress: ${JSON.stringify(apple)}`
    );
    expectStatus(
      await call('/api/integrations/apple_passwords/accounts/default', {
        method: 'DELETE',
        auth: token,
      }),
      200,
      'delete apple account'
    );
    assert(
      JSON.stringify((await storedPasswords(userId)).map((row) => row.key)) ===
        JSON.stringify(['chrome/Default']),
      'only the Apple import is removed'
    );
  });
}

async function passkeySourcesAreAccounts(): Promise<void> {
  await withSession(async ({ token, userId }) => {
    const passkey = (credentialId: string, browserSource: string) => ({
      rpId: 'passkeys.example',
      credentialId,
      privateKey: crypto.randomBytes(32).toString('base64'),
      userHandle: 'user-handle',
      signCount: 0,
      browserSource,
    });
    const res = await call('/api/integrations/passkeys/upload', {
      method: 'POST',
      auth: token,
      body: JSON.stringify(
        encryptPayload({
          passkeys: [
            passkey('cred-v1', 'cdp_virtual'),
            passkey('cred-v2', 'cdp_virtual'),
            passkey('cred-c1', 'chrome'),
          ],
        })
      ),
    });
    expectStatus(res, 200, 'passkey upload');
    const virtual = await accountsOf(token, 'cdp_virtual_passkeys');
    const chrome = await accountsOf(token, 'chrome_passkeys');
    assert(
      virtual.length === 1 &&
        virtual[0].accountId === 'default' &&
        virtual[0].progress.done === 2 &&
        virtual[0].progress.total === 2 &&
        virtual[0].progress.unit === 'passkeys',
      `virtual authenticator source is one account with progress: ${JSON.stringify(virtual)}`
    );
    assert(chrome.length === 1 && chrome[0].progress.total === 1, 'chrome passkeys account');
    expectStatus(
      await call('/api/integrations/chrome_passkeys/accounts/default', {
        method: 'DELETE',
        auth: token,
      }),
      200,
      'delete chrome passkeys'
    );
    const left = await prisma.passkeyCredential.findMany({
      where: { userId },
      select: { credentialId: true },
      orderBy: { credentialId: 'asc' },
    });
    assert(
      JSON.stringify(left.map((row) => row.credentialId)) ===
        JSON.stringify(['cred-v1', 'cred-v2']),
      `only chrome passkeys are removed: ${JSON.stringify(left)}`
    );
    assert((await accountsOf(token, 'chrome_passkeys')).length === 0, 'chrome passkeys unlisted');
  });
}

/**
 * Readers that hand credentials to agents see one login per origin+username:
 * enabled first, then user-synced over agent-created, then most recently used,
 * then most recently synced.
 */
async function readersPreferOneLoginDeterministically(): Promise<void> {
  await withSession(async ({ userId }) => {
    const origin = 'https://bank.example';
    const now = Date.now();
    const row = (
      browserSource: string,
      browserProfile: string,
      dateLastUsed: number,
      extra: { disabledAt?: Date; syncedAt?: Date } = {}
    ) => ({
      userId,
      origin,
      username: USERNAME,
      encryptedPassword: `ct-${browserSource}-${browserProfile}`,
      dateLastUsed: BigInt(dateLastUsed),
      dateCreated: BigInt(now - 100_000),
      browserSource,
      browserProfile,
      ...extra,
    });
    await prisma.browserPassword.createMany({
      data: [
        row('chrome', 'Default', now - 30_000),
        row('safari', '', now - 20_000),
        row('agent_signup', '', now - 1_000),
        row('chrome', 'Profile 1', now, { disabledAt: new Date() }),
        // Same use time as safari but synced earlier: safari still wins the tie.
        row('arc', '', now - 20_000, { syncedAt: new Date(now - 86_400_000) }),
      ],
    });
    const expected = await prisma.browserPassword.findFirstOrThrow({
      where: { userId, browserSource: 'safari' },
    });

    const options = await getAuthOptions(userId, 'bank.example');
    const forLogin = options.passwords.filter((password) => password.username === USERNAME);
    assert(
      forLogin.length === 1 && forLogin[0].id === expected.id,
      `auth options offer one login (safari): ${JSON.stringify(forLogin.map((p) => p.browserSource))}`
    );
    assert(
      forLogin[0].ref === `pwd:${USERNAME}`,
      `the ref has no collision suffix: ${forLogin[0].ref}`
    );

    const session = (await findPasswords(userId)).filter((password) => password.origin === origin);
    assert(
      session.length === 1 && session[0].id === expected.id,
      `browser session passwords carry the same single login: ${JSON.stringify(session.map((p) => p.id))}`
    );

    // With every user-synced row disabled, the enabled agent row is used.
    await prisma.browserPassword.updateMany({
      where: { userId, browserSource: { in: ['chrome', 'safari', 'arc'] } },
      data: { disabledAt: new Date() },
    });
    const agentOnly = (await findPasswords(userId)).filter(
      (password) => password.origin === origin
    );
    assert(
      agentOnly.length === 1 && agentOnly[0].encryptedPassword === 'ct-agent_signup-',
      'the enabled agent-created login is used when nothing else is enabled'
    );
  });
}

export function passwordCases(): Array<{ name: string; fn: () => Promise<void> }> {
  return [
    {
      name: 'passwords: the same login from two browsers and two Chrome profiles is kept per source',
      fn: sameLoginFromEverySourceIsKept,
    },
    { name: 'passwords: re-uploading a source+profile is idempotent', fn: reuploadIsIdempotent },
    {
      name: 'passwords: each source+profile is an account with batch progress',
      fn: eachSourceProfileIsAnAccount,
    },
    {
      name: 'passwords: deleting one account removes only that source+profile',
      fn: deleteRemovesOnlyThatAccount,
    },
    {
      name: 'passwords: Apple Passwords import is its own account',
      fn: applePasswordsImportIsAnAccount,
    },
    { name: 'passkeys: each source is an account; delete one', fn: passkeySourcesAreAccounts },
    {
      name: 'passwords: credential readers see one login with a deterministic preference',
      fn: readersPreferOneLoginDeterministically,
    },
  ];
}
