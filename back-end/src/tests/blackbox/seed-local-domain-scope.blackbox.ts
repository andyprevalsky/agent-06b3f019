#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  authRealmSyncWhere,
  cookieSyncWhere,
  createScopedBrowserAuthReaders,
  originSyncWhere,
  passkeySyncWhere,
} from '../../../scripts/cookie-domain-scope';
import { selectRemoteDatabaseUrl } from '../../../scripts/seed-remote-database-url';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

test('runtime seed reads prefer the pooled production endpoint', () => {
  assert.equal(
    selectRemoteDatabaseUrl({
      DATABASE_URL: 'postgresql://pooler.example.test:6543/postgres?pgbouncer=true',
      DIRECT_DATABASE_URL: 'postgresql://db.example.test:5432/postgres',
    }),
    'postgresql://pooler.example.test:6543/postgres?pgbouncer=true'
  );
});

test('runtime seed reads fall back to the direct endpoint when no pooler is configured', () => {
  assert.equal(
    selectRemoteDatabaseUrl({
      DIRECT_DATABASE_URL: 'postgresql://db.example.test:5432/postgres',
    }),
    'postgresql://db.example.test:5432/postgres'
  );
});

test('an explicit benchmark domain scopes every browser-auth selector', () => {
  const domains = ['amazon.com'];

  assert.deepEqual(cookieSyncWhere('user-1', domains), {
    userId: 'user-1',
    OR: [
      { domain: 'amazon.com' },
      { domain: '.amazon.com' },
      { domain: { endsWith: '.amazon.com' } },
    ],
  });
  assert.deepEqual(authRealmSyncWhere('user-1', domains), {
    userId: 'user-1',
    OR: [
      { authRealm: 'amazon.com' },
      { authRealm: '.amazon.com' },
      { authRealm: { endsWith: '.amazon.com' } },
    ],
  });
  assert.deepEqual(originSyncWhere('user-1', domains), {
    userId: 'user-1',
    OR: [
      { origin: { endsWith: '://amazon.com' } },
      { origin: { contains: '://amazon.com:' } },
      { origin: { contains: '://amazon.com/' } },
      { origin: { endsWith: '.amazon.com' } },
      { origin: { contains: '.amazon.com:' } },
      { origin: { contains: '.amazon.com/' } },
    ],
  });
  assert.deepEqual(passkeySyncWhere('user-1', domains), {
    userId: 'user-1',
    OR: [
      { rpId: 'amazon.com' },
      { rpId: '.amazon.com' },
      { rpId: { endsWith: '.amazon.com' } },
      { authRealm: 'amazon.com' },
      { authRealm: '.amazon.com' },
      { authRealm: { endsWith: '.amazon.com' } },
      { origin: { endsWith: '://amazon.com' } },
      { origin: { contains: '://amazon.com:' } },
      { origin: { contains: '://amazon.com/' } },
      { origin: { endsWith: '.amazon.com' } },
      { origin: { contains: '.amazon.com:' } },
      { origin: { contains: '.amazon.com/' } },
    ],
  });
});

test('no benchmark domain preserves the complete browser-auth fallback', () => {
  for (const where of [
    cookieSyncWhere('user-1', []),
    authRealmSyncWhere('user-1', []),
    originSyncWhere('user-1', []),
    passkeySyncWhere('user-1', []),
  ]) {
    assert.deepEqual(where, { userId: 'user-1' });
  }
});

test('the executed browser-auth read boundary scopes every domain-bearing table', async () => {
  type Row = { table: string };
  type Rows = {
    cookie: Row;
    cookieBundle: Row;
    steelSessionAuth: Row;
    localStorageOrigin: Row;
    indexedDBOrigin: Row;
    browserPermission: Row;
    cacheStorageOrigin: Row;
    browserPassword: Row;
    passkeyCredential: Row;
  };
  const captured = new Map<keyof Rows, Record<string, unknown>>();
  const reader =
    (table: keyof Rows) =>
    async (where: Record<string, unknown>): Promise<Row[]> => {
      captured.set(table, where);
      return [{ table }];
    };
  const scoped = createScopedBrowserAuthReaders<Rows>(
    {
      cookie: reader('cookie'),
      cookieBundle: reader('cookieBundle'),
      steelSessionAuth: reader('steelSessionAuth'),
      localStorageOrigin: reader('localStorageOrigin'),
      indexedDBOrigin: reader('indexedDBOrigin'),
      browserPermission: reader('browserPermission'),
      cacheStorageOrigin: reader('cacheStorageOrigin'),
      browserPassword: reader('browserPassword'),
      passkeyCredential: reader('passkeyCredential'),
    },
    'user-1',
    ['amazon.com']
  );

  for (const table of Object.keys(scoped) as Array<keyof Rows>) {
    assert.deepEqual(await scoped[table](), [{ table }]);
  }

  assert.deepEqual(captured.get('cookie'), cookieSyncWhere('user-1', ['amazon.com']));
  assert.deepEqual(captured.get('cookieBundle'), authRealmSyncWhere('user-1', ['amazon.com']));
  assert.deepEqual(captured.get('steelSessionAuth'), authRealmSyncWhere('user-1', ['amazon.com']));
  for (const table of [
    'localStorageOrigin',
    'indexedDBOrigin',
    'browserPermission',
    'cacheStorageOrigin',
    'browserPassword',
  ] as const) {
    assert.deepEqual(captured.get(table), originSyncWhere('user-1', ['amazon.com']));
  }
  assert.deepEqual(captured.get('passkeyCredential'), passkeySyncWhere('user-1', ['amazon.com']));
});

test('seed-local consumes each scoped reader exactly once in the live credential path', () => {
  const source = readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const occurrences = (needle: string): number => source.split(needle).length - 1;
  for (const table of [
    'cookie',
    'cookieBundle',
    'steelSessionAuth',
    'localStorageOrigin',
    'indexedDBOrigin',
    'browserPermission',
    'cacheStorageOrigin',
    'browserPassword',
    'passkeyCredential',
  ]) {
    // Match the call site, not its argument list. Blob-bearing readers now take
    // a page because the unpaged whole-table read OOM-killed every bench guest.
    // The invariant is unchanged and still strict: exactly ONE call site per
    // table — no bypass of the scoped reader, no duplicate read.
    assert.equal(
      occurrences(`scopedRemoteBrowserAuth.${table}(`),
      1,
      `${table} must execute through its scoped reader`
    );
  }
});

test('authoritative passkey reconciliation is limited to the selected domains', () => {
  const source = readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const start = source.indexOf('if (options.authoritative)');
  const end = source.indexOf('async function syncBrowserAuthForCurrentMode', start);
  const reconciliation = source.slice(start, end);
  const scopedWhere = 'passkeySyncWhere(DEV_USER_ID, SEED_COOKIE_DOMAINS)';

  assert(start > 0 && end > start, 'expected authoritative passkey reconciliation block');
  assert.equal(
    reconciliation.split(scopedWhere).length - 1,
    2,
    'remote and local reconciliation reads must share the domain-scoped selector'
  );
  assert(
    !reconciliation.includes('where: { userId: DEV_USER_ID }'),
    'authoritative reconciliation must not fall back to an unscoped user-wide read'
  );
});

async function main(): Promise<void> {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAIL ${name}\n`);
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
    }
  }

  process.stdout.write(`\nResults: ${tests.length - failures} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
