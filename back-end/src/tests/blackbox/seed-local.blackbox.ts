#!/usr/bin/env tsx

import { syncPasskeyCredentials } from '../../../scripts/seed-local-credentials';

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
