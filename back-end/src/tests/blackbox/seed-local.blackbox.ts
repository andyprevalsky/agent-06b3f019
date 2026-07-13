#!/usr/bin/env tsx

import {
  syncCookieCredentials,
  syncIntegrationCredentials,
  syncPasskeyCredentials,
  type CookieModel,
  type IntegrationModel,
} from '../../../scripts/seed-local-credentials';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type PasskeyRecord = {
  id: string;
  userId: string;
  authRealm: string;
  rpId: string;
  credentialId: string;
  encryptedPrivateKey: string;
  userHandle: string | null;
  signCount: bigint;
  origin: string | null;
  browserSource: string;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
  disabledReason: string | null;
};

function compoundKey(pk: { userId: string; rpId: string; credentialId: string }) {
  return `${pk.userId}:${pk.rpId}:${pk.credentialId}`;
}

test('syncPasskeyCredentials copies passkeys and never moves local signCount backward', async () => {
  const userId = 'seed-user';
  const now = new Date('2026-06-25T00:00:00Z');
  const remoteRows: PasskeyRecord[] = [
    {
      id: 'remote-existing',
      userId,
      authRealm: 'amazon.com',
      rpId: 'amazon.com',
      credentialId: 'amazon-cred',
      encryptedPrivateKey: 'remote-key',
      userHandle: null,
      signCount: 100n,
      origin: 'https://www.amazon.com',
      browserSource: 'chrome',
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      disabledReason: null,
    },
    {
      id: 'remote-new',
      userId,
      authRealm: 'github.com',
      rpId: 'github.com',
      credentialId: 'github-cred',
      encryptedPrivateKey: 'github-key',
      userHandle: 'handle',
      signCount: 3n,
      origin: 'https://github.com',
      browserSource: 'chrome',
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      disabledReason: null,
    },
  ];
  const localRows = new Map<string, PasskeyRecord>([
    [
      compoundKey(remoteRows[0]),
      {
        ...remoteRows[0],
        id: 'local-existing',
        encryptedPrivateKey: 'old-local-key',
        signCount: 250n,
      },
    ],
  ]);
  const upserts: Array<{ create: PasskeyRecord; update: Partial<PasskeyRecord> }> = [];

  const remoteModel = {
    findMany: async ({ where }: { where: { userId: string } }) =>
      remoteRows.filter((row) => row.userId === where.userId),
    findUnique: async () => null,
    upsert: async () => undefined,
  };
  const localModel = {
    findMany: async () => [],
    findUnique: async ({
      where,
    }: {
      where: { userId_rpId_credentialId: { userId: string; rpId: string; credentialId: string } };
    }) => {
      const row = localRows.get(compoundKey(where.userId_rpId_credentialId));
      return row ? { signCount: row.signCount } : null;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId_rpId_credentialId: { userId: string; rpId: string; credentialId: string } };
      create: PasskeyRecord;
      update: Partial<PasskeyRecord>;
    }) => {
      upserts.push({ create, update });
      const key = compoundKey(where.userId_rpId_credentialId);
      const existing = localRows.get(key);
      localRows.set(key, existing ? ({ ...existing, ...update } as PasskeyRecord) : create);
    },
  };

  const count = await syncPasskeyCredentials(remoteModel, localModel, userId);

  assert(count === 2, `expected two synced passkeys, got ${count}`);
  assert(localRows.get(compoundKey(remoteRows[0]))?.signCount === 250n, 'expected local max kept');
  assert(
    localRows.get(compoundKey(remoteRows[0]))?.encryptedPrivateKey === 'remote-key',
    'expected existing credential material refreshed'
  );
  assert(
    localRows.get(compoundKey(remoteRows[1]))?.signCount === 3n,
    'expected new passkey copied'
  );
  assert(!('id' in upserts[0].update), 'expected update not to rewrite local primary key');
});

test('syncIntegrationCredentials preserves a local id for the same user and name', async () => {
  const remote = {
    id: 'remote-gpt-id',
    userId: 'seed-user',
    type: 'API' as const,
    name: 'gpt_code',
    status: 'CONNECTED' as const,
    isActive: true,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastFailedSyncAt: null,
    failureReason: null,
    config: { encryptedCredentials: 'fresh-envelope' },
    poolingEnabled: false,
    rateLimitedUntil: null,
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };
  let captured: Record<string, unknown> | undefined;
  const localModel: IntegrationModel = {
    upsert: async (args) => {
      captured = args;
      return { id: 'local-gpt-id' };
    },
  };

  const ids = await syncIntegrationCredentials(localModel, [remote]);

  assert(ids.length === 1 && ids[0] === 'local-gpt-id', 'expected preserved local id');
  const where = captured?.where as {
    userId_name?: { userId?: string; name?: string };
  };
  assert(where.userId_name?.userId === remote.userId, 'expected compound user id selector');
  assert(where.userId_name?.name === remote.name, 'expected compound integration name selector');
  const update = captured?.update as Record<string, unknown>;
  assert(!('id' in update), 'expected update not to rewrite local primary key');
});

test('syncCookieCredentials preserves a local id for the same compound cookie key', async () => {
  const now = new Date('2026-07-12T00:00:00Z');
  const remoteCookie = {
    id: 'remote-cookie-id',
    userId: 'seed-user',
    domain: '.example.com',
    name: 'session',
    path: '/',
    value: 'fresh-value',
    expiresUtc: null,
    isSecure: true,
    isHttpOnly: true,
    browserSource: 'chrome',
    syncedAt: now,
    creationUtc: null,
    hasExpires: true,
    isPersistent: true,
    lastAccessUtc: null,
    lastUpdateUtc: null,
    priority: 1,
    sameSite: -1,
    sourcePort: -1,
    sourceScheme: 0,
    topFrameSiteKey: '',
    browserProfile: 'Default',
  };
  let captured: Record<string, unknown> | undefined;
  const localModel: CookieModel = {
    upsert: async (args) => {
      captured = args;
      return { id: 'local-cookie-id' };
    },
  };

  const count = await syncCookieCredentials(localModel, [remoteCookie]);

  assert(count === 1, `expected one synced cookie, got ${count}`);
  const where = captured?.where as Record<string, Record<string, unknown>>;
  const compound = where.userId_domain_name_path_topFrameSiteKey_browserSource_browserProfile;
  assert(compound.userId === remoteCookie.userId, 'expected compound cookie user id selector');
  assert(compound.domain === remoteCookie.domain, 'expected compound cookie domain selector');
  assert(compound.name === remoteCookie.name, 'expected compound cookie name selector');
  const update = captured?.update as Record<string, unknown>;
  assert(!('id' in update), 'expected update not to rewrite local cookie primary key');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (err) {
      failed++;
      process.stderr.write(`FAIL ${name}\n`);
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }
  process.stdout.write(`\nResults: ${tests.length - failed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
