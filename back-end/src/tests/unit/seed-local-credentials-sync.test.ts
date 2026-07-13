#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import type {
  BrowserPassword,
  BrowserPermission,
  CacheStorageOrigin,
  Cookie,
  IndexedDBOrigin,
  LocalStorageOrigin,
  PasskeyCredential,
  Prisma,
} from '@prisma/client';

import {
  syncBrowserPasswords,
  syncBrowserPermissions,
  syncCacheStorageOrigins,
  syncCookies,
  syncIndexedDBOrigins,
  syncLocalStorageOrigins,
  syncPasskeyCredentials,
} from '../../../scripts/seed-local-credentials';

const now = new Date('2026-07-13T00:00:00.000Z');
const userId = 'user-1';

async function testBrowserStateUpserts(): Promise<void> {
  const cookie: Cookie = {
    id: 'cookie-remote',
    userId,
    domain: '.example.com',
    name: 'session',
    path: '/',
    value: 'encrypted',
    expiresUtc: 1n,
    isSecure: true,
    isHttpOnly: true,
    browserSource: 'chrome',
    syncedAt: now,
    creationUtc: 1n,
    hasExpires: true,
    isPersistent: true,
    lastAccessUtc: 2n,
    lastUpdateUtc: 3n,
    priority: 1,
    sameSite: 0,
    sourcePort: 443,
    sourceScheme: 2,
    topFrameSiteKey: '',
    browserProfile: 'Default',
  };
  const cookieCalls: Prisma.CookieUpsertArgs[] = [];
  const cookieCount = await syncCookies(
    {
      upsert: async (args) => {
        cookieCalls.push(args);
        return { id: 'cookie-local' };
      },
    },
    [cookie],
    1
  );
  assert.equal(cookieCount, 1);
  assert.equal(
    cookieCalls[0]?.where.userId_domain_name_path_topFrameSiteKey_browserSource_browserProfile
      ?.name,
    'session'
  );
  assert.equal(cookieCalls[0]?.update.id, undefined);

  const localStorage: LocalStorageOrigin = {
    id: 'local-storage-remote',
    userId,
    origin: 'https://example.com',
    entries: { token: 'value' },
    hash: 'local-hash',
    updatedAt: now,
  };
  const localStorageCalls: Prisma.LocalStorageOriginUpsertArgs[] = [];
  assert.equal(
    await syncLocalStorageOrigins(
      {
        upsert: async (args) => {
          localStorageCalls.push(args);
        },
      },
      [localStorage],
      1
    ),
    1
  );
  assert.deepEqual(localStorageCalls[0]?.where.userId_origin, {
    userId,
    origin: 'https://example.com',
  });

  const indexedDB: IndexedDBOrigin = {
    id: 'indexed-db-remote',
    userId,
    origin: 'https://example.com',
    databases: [{ name: 'auth' }],
    hash: 'indexed-hash',
    updatedAt: now,
  };
  const indexedDBCalls: Prisma.IndexedDBOriginUpsertArgs[] = [];
  assert.equal(
    await syncIndexedDBOrigins(
      {
        upsert: async (args) => {
          indexedDBCalls.push(args);
        },
      },
      [indexedDB],
      1
    ),
    1
  );
  assert.equal(indexedDBCalls[0]?.create.id, 'indexed-db-remote');

  const permission: BrowserPermission = {
    id: 'permission-remote',
    userId,
    origin: 'https://example.com',
    permission: 'notifications',
    setting: 1,
    syncedAt: now,
  };
  const permissionCalls: Prisma.BrowserPermissionUpsertArgs[] = [];
  assert.equal(
    await syncBrowserPermissions(
      {
        upsert: async (args) => {
          permissionCalls.push(args);
        },
      },
      [permission],
      1
    ),
    1
  );
  assert.equal(permissionCalls[0]?.where.userId_origin_permission?.permission, 'notifications');

  const cacheStorage: CacheStorageOrigin = {
    id: 'cache-storage-remote',
    userId,
    origin: 'https://example.com',
    caches: [{ name: 'assets' }],
    hash: 'cache-hash',
    updatedAt: now,
  };
  const cacheCalls: Prisma.CacheStorageOriginUpsertArgs[] = [];
  assert.equal(
    await syncCacheStorageOrigins(
      {
        upsert: async (args) => {
          cacheCalls.push(args);
        },
      },
      [cacheStorage],
      1
    ),
    1
  );
  assert.equal(cacheCalls[0]?.update.id, undefined);

  const password: BrowserPassword = {
    id: 'password-remote',
    userId,
    origin: 'https://example.com',
    username: 'andy',
    encryptedPassword: 'encrypted',
    dateLastUsed: 1n,
    dateCreated: 1n,
    browserSource: 'chrome',
    syncedAt: now,
    browserProfile: 'Default',
    disabledAt: null,
    disabledReason: null,
  };
  const passwordCalls: Prisma.BrowserPasswordUpsertArgs[] = [];
  assert.equal(
    await syncBrowserPasswords(
      {
        upsert: async (args) => {
          passwordCalls.push(args);
        },
      },
      [password],
      1
    ),
    1
  );
  assert.equal(passwordCalls[0]?.where.userId_origin_username?.username, 'andy');
}

async function testPasskeyCounterNeverRollsBack(): Promise<void> {
  const passkey: PasskeyCredential = {
    id: 'passkey-remote',
    userId,
    authRealm: 'amazon.com',
    rpId: 'amazon.com',
    credentialId: 'credential-1',
    encryptedPrivateKey: 'encrypted',
    userHandle: null,
    signCount: 4n,
    origin: 'https://www.amazon.com',
    browserSource: 'cdp_virtual',
    disabledAt: null,
    disabledReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const upserts: Prisma.PasskeyCredentialUpsertArgs[] = [];
  const remote = {
    findMany: async () => [passkey],
    findUnique: async () => null,
    upsert: async () => undefined,
  };
  const local = {
    findMany: async () => [],
    findUnique: async () => ({ signCount: 9n }),
    upsert: async (args: Prisma.PasskeyCredentialUpsertArgs) => {
      upserts.push(args);
    },
  };

  assert.equal(await syncPasskeyCredentials(remote, local, userId), 1);
  assert.equal(upserts[0]?.update.signCount, 9n);
  assert.equal(upserts[0]?.where.userId_rpId_credentialId?.credentialId, 'credential-1');
}

async function run(): Promise<void> {
  await testBrowserStateUpserts();
  await testPasskeyCounterNeverRollsBack();
  process.stdout.write('seed-local credential sync preserves browser keys and passkey counters\n');
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
