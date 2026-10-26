#!/usr/bin/env tsx

import {
  syncCookieCredentials,
  syncCookieBundleCredentials,
  syncBrowserPasswordCredentials,
  syncBrowserPermissionCredentials,
  syncIntegrationCredentials,
  syncOriginBlobCredentials,
  syncPasskeyCredentials,
  syncRequiredCredentialTable,
  syncSteelSessionAuthCredentials,
  type BrowserPasswordModel,
  type BrowserPermissionModel,
  type CookieModel,
  type CookieBundleModel,
  type IntegrationModel,
  type OriginMetaRow,
  type RawSqlClient,
  type SteelSessionAuthModel,
  type TransactionalSqlClient,
} from '../../../scripts/seed-local-credentials';
import {
  PrismaClient,
  type BrowserPassword,
  type BrowserPermission,
  type Cookie,
  type CookieBundle,
  type SteelSessionAuth,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

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

test('syncIntegrationCredentials keeps integration primary keys local', async () => {
  const remote = {
    id: 'remote-gpt-id',
    userId: 'seed-user',
    type: 'TOOL_SETUP' as const,
    name: 'gpt_code',
    status: 'CONNECTED' as const,
    isActive: true,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastFailedSyncAt: null,
    failureReason: null,
    config: { encryptedCredentials: 'fresh-envelope' },
    poolingEnabled: false,
    poolingEnabledOverride: null,
    rateLimitedUntil: null,
    lastUsedAt: null,
    accountId: '',
    accountEmail: null,
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
    userId_name_accountId?: { userId?: string; name?: string; accountId?: string };
  };
  assert(
    where.userId_name_accountId?.userId === remote.userId,
    'expected compound user id selector'
  );
  assert(
    where.userId_name_accountId?.name === remote.name,
    'expected compound integration name selector'
  );
  assert(where.userId_name_accountId?.accountId === '', 'expected legacy account id selector');
  const create = captured?.create as Record<string, unknown>;
  assert(!('id' in create), 'expected create not to reuse a potentially stale remote primary key');
  const update = captured?.update as Record<string, unknown>;
  assert(!('id' in update), 'expected update not to rewrite local primary key');
});

test('syncCookieCredentials preserves a local id for the same browser cookie identity', async () => {
  const remote: Cookie = {
    id: 'remote-cookie-id',
    userId: 'seed-user',
    domain: '.example.com',
    name: 'session',
    path: '/',
    value: 'fresh-cookie-value',
    expiresUtc: 123n,
    isSecure: true,
    isHttpOnly: true,
    browserSource: 'chrome',
    syncedAt: new Date('2026-07-13T00:00:00Z'),
    creationUtc: 100n,
    hasExpires: true,
    isPersistent: true,
    lastAccessUtc: 110n,
    lastUpdateUtc: 120n,
    priority: 1,
    sameSite: 0,
    sourcePort: 443,
    sourceScheme: 2,
    topFrameSiteKey: '',
    browserProfile: 'Default',
  };
  let captured: Record<string, unknown> | undefined;
  const localModel: CookieModel = {
    upsert: async (args) => {
      captured = args;
      return {};
    },
  };

  const count = await syncCookieCredentials(localModel, [remote]);

  assert(count === 1, `expected one synced cookie, got ${count}`);
  const where = captured?.where as {
    userId_domain_name_path_topFrameSiteKey_browserSource_browserProfile?: {
      userId?: string;
      domain?: string;
      name?: string;
      path?: string;
      topFrameSiteKey?: string;
      browserSource?: string;
      browserProfile?: string;
    };
  };
  const identity = where.userId_domain_name_path_topFrameSiteKey_browserSource_browserProfile;
  assert(identity?.userId === remote.userId, 'expected cookie user id selector');
  assert(identity?.domain === remote.domain, 'expected cookie domain selector');
  assert(identity?.name === remote.name, 'expected cookie name selector');
  assert(identity?.path === remote.path, 'expected cookie path selector');
  assert(identity?.topFrameSiteKey === remote.topFrameSiteKey, 'expected top-frame selector');
  assert(identity?.browserSource === remote.browserSource, 'expected browser source selector');
  assert(identity?.browserProfile === remote.browserProfile, 'expected browser profile selector');
  const update = captured?.update as Record<string, unknown>;
  assert(!('id' in update), 'expected update not to rewrite local cookie primary key');
  assert(update.value === remote.value, 'expected production cookie value refreshed');
});

test('syncCookieCredentials bounds local database writes', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const cookies: Cookie[] = Array.from({ length: 10 }, (_, index) => ({
    id: `remote-cookie-${index}`,
    userId: 'seed-user',
    domain: '.example.com',
    name: `session-${index}`,
    path: '/',
    value: `value-${index}`,
    expiresUtc: null,
    isSecure: true,
    isHttpOnly: true,
    browserSource: 'chrome',
    syncedAt: now,
    creationUtc: null,
    hasExpires: false,
    isPersistent: false,
    lastAccessUtc: null,
    lastUpdateUtc: null,
    priority: 1,
    sameSite: 0,
    sourcePort: 443,
    sourceScheme: 2,
    topFrameSiteKey: '',
    browserProfile: 'Default',
  }));
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const localModel: CookieModel = {
    upsert: async () => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWrites -= 1;
      return {};
    },
  };

  await syncCookieCredentials(localModel, cookies);

  assert(maxActiveWrites === 8, `expected eight active cookie writes, got ${maxActiveWrites}`);
});

test('durable browser-auth refs sync by natural identity and preserve local ids', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const bundle: CookieBundle = {
    id: 'remote-bundle-id',
    userId: 'seed-user',
    authRealm: 'amazon.com',
    browserSource: 'chrome',
    browserProfile: 'Default',
    accountLabel: 'Andy',
    disabledAt: null,
    disabledReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const steelSession: SteelSessionAuth = {
    id: 'remote-steel-id',
    userId: 'seed-user',
    contextId: 'steel-context-id',
    authRealm: 'amazon.com',
    authenticatedAt: now,
    disabledAt: null,
    disabledReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const captured: Record<string, Record<string, unknown>> = {};
  const bundleModel: CookieBundleModel = {
    upsert: async (args) => {
      captured.bundle = args as unknown as Record<string, unknown>;
      return {};
    },
  };
  const steelModel: SteelSessionAuthModel = {
    upsert: async (args) => {
      captured.steel = args as unknown as Record<string, unknown>;
      return {};
    },
  };

  await syncCookieBundleCredentials(bundleModel, [bundle]);
  await syncSteelSessionAuthCredentials(steelModel, [steelSession]);

  const bundleWhere = captured.bundle.where as {
    userId_authRealm_browserSource_browserProfile?: Record<string, string>;
  };
  assert(
    bundleWhere.userId_authRealm_browserSource_browserProfile?.authRealm === 'amazon.com',
    'expected CookieBundle realm in its natural identity'
  );
  const steelWhere = captured.steel.where as {
    userId_contextId_authRealm?: Record<string, string>;
  };
  assert(
    steelWhere.userId_contextId_authRealm?.contextId === 'steel-context-id',
    'expected Steel session context in its natural identity'
  );
  assert(!('id' in (captured.bundle.update as object)), 'bundle update must preserve local id');
  assert(!('id' in (captured.steel.update as object)), 'Steel update must preserve local id');
});

test('browser-state sync helpers use every schema identity instead of remote primary ids', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const origin: OriginMetaRow = {
    id: 'remote-origin-id',
    userId: 'seed-user',
    origin: 'https://example.com',
    hash: 'fresh-origin-hash',
    updatedAt: now,
  };
  const permission: BrowserPermission = {
    id: 'remote-permission-id',
    userId: 'seed-user',
    origin: 'https://example.com',
    permission: 'notifications',
    setting: 1,
    syncedAt: now,
  };
  const password: BrowserPassword = {
    id: 'remote-password-id',
    userId: 'seed-user',
    origin: 'https://example.com',
    username: 'user@example.com',
    encryptedPassword: 'fresh-envelope',
    dateLastUsed: 10n,
    dateCreated: 5n,
    browserSource: 'chrome',
    syncedAt: now,
    browserProfile: 'Default',
    disabledAt: null,
    disabledReason: null,
  };
  const captured: Record<string, Record<string, unknown>> = {};
  const originRemote: RawSqlClient = {
    $queryRawUnsafe: async (_sql: string, ...params: unknown[]) => {
      const ids = params[0] as string[];
      return ids.map((id) => ({
        id,
        payload_length: 2,
        payload: '[]',
      })) as never;
    },
    $executeRawUnsafe: async () => {
      throw new Error('origin source must not be written');
    },
  };
  const originLocal: TransactionalSqlClient = {
    $queryRawUnsafe: async () => [] as never,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      captured.origin = { sql, params };
      return 1;
    },
    $transaction: async <T>(fn: (tx: RawSqlClient) => Promise<T>) => fn(originLocal),
  };
  const permissionModel: BrowserPermissionModel = {
    upsert: async (args) => {
      captured.permission = args as unknown as Record<string, unknown>;
      return {};
    },
  };
  const passwordModel: BrowserPasswordModel = {
    upsert: async (args) => {
      captured.password = args as unknown as Record<string, unknown>;
      return {};
    },
  };

  await syncOriginBlobCredentials(originRemote, originLocal, 'LocalStorageOrigin', [origin]);
  await syncBrowserPermissionCredentials(permissionModel, [permission]);
  await syncBrowserPasswordCredentials(passwordModel, [password]);

  const originParams = captured.origin.params as unknown[];
  assert(originParams[1] === origin.userId, 'expected origin user selector');
  assert(originParams[2] === origin.origin, 'expected origin URL selector');
  assert(
    String(captured.origin.sql).includes('ON CONFLICT ("userId", origin) DO UPDATE'),
    'expected origin upsert to use its natural identity'
  );
  const permissionWhere = captured.permission.where as {
    userId_origin_permission?: { userId?: string; origin?: string; permission?: string };
  };
  assert(
    permissionWhere.userId_origin_permission?.permission === permission.permission,
    'expected permission identity selector'
  );
  const passwordWhere = captured.password.where as {
    userId_origin_username?: { userId?: string; origin?: string; username?: string };
  };
  assert(
    passwordWhere.userId_origin_username?.username === password.username,
    'expected password identity selector'
  );
  for (const [name, args] of Object.entries(captured).filter(([name]) => name !== 'origin')) {
    const update = args.update as Record<string, unknown>;
    assert(!('id' in update), `expected ${name} update not to rewrite local primary key`);
  }
});

test('required credential table sync propagates write failures', async () => {
  let failure: unknown;
  try {
    await syncRequiredCredentialTable('Cookies', async () => {
      throw new Error('database write rejected');
    });
  } catch (err) {
    failure = err;
  }

  assert(failure instanceof Error, 'expected required credential sync to reject');
  assert(failure.message.includes('Cookies'), 'expected failing table name in propagated error');
  assert(
    failure.message.includes('database write rejected'),
    'expected original database failure in propagated error'
  );
});

// Source-structure invariants for seed-local sync modes (mode branching,
// failure deferral, transient-failure retries) live in
// seed-local.part2.blackbox.ts / seed-local.part3.blackbox.ts.

test('browser-state natural-key sync crosses the real Prisma uniqueness boundary', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert(databaseUrl, 'DATABASE_URL is required for the seed-local database blackbox');
  const hostname = new URL(databaseUrl).hostname;
  assert(
    ['localhost', '127.0.0.1', '::1'].includes(hostname),
    `seed-local database blackbox requires local Postgres, got ${hostname}`
  );
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = randomUUID();
  const userId = `seed-local-blackbox-${suffix}`;
  const cookieIdentity = {
    userId,
    domain: '.example.com',
    name: 'session',
    path: '/',
    topFrameSiteKey: '',
    browserSource: 'chrome',
    browserProfile: 'Default',
  };
  const originUrl = `https://${suffix}.example.com`;
  try {
    const localCookie = await prisma.cookie.create({
      data: {
        id: `local-cookie-${suffix}`,
        ...cookieIdentity,
        value: 'stale-local-value',
      },
    });
    const localOrigin = await prisma.localStorageOrigin.create({
      data: {
        id: `local-origin-${suffix}`,
        userId,
        origin: originUrl,
        entries: [{ key: 'session', value: 'stale' }],
        hash: 'stale-hash',
      },
    });

    await syncCookieCredentials(prisma.cookie, [
      {
        ...localCookie,
        id: `remote-cookie-${suffix}`,
        value: 'fresh-production-value',
        syncedAt: new Date(localCookie.syncedAt.getTime() + 1),
      },
    ]);
    const remoteOrigin = {
      ...localOrigin,
      id: `remote-origin-${suffix}`,
      hash: 'fresh-hash',
      updatedAt: new Date(localOrigin.updatedAt.getTime() + 1),
    } satisfies OriginMetaRow;
    const remote: RawSqlClient = {
      $queryRawUnsafe: async (_sql: string, ...params: unknown[]) => {
        const ids = params[0] as string[];
        return ids.map((id) => ({
          id,
          payload_length: 37,
          payload: '[{"key":"session","value":"fresh"}]',
        })) as never;
      },
      $executeRawUnsafe: async () => {
        throw new Error('origin source must not be written');
      },
    };
    await syncOriginBlobCredentials(remote, prisma, 'LocalStorageOrigin', [remoteOrigin]);

    const cookies = await prisma.cookie.findMany({ where: cookieIdentity });
    const origins = await prisma.localStorageOrigin.findMany({
      where: { userId, origin: originUrl },
    });
    assert(cookies.length === 1, `expected one cookie identity row, got ${cookies.length}`);
    assert(cookies[0].id === localCookie.id, 'expected local cookie primary id preserved');
    assert(cookies[0].value === 'fresh-production-value', 'expected cookie value refreshed');
    assert(origins.length === 1, `expected one origin identity row, got ${origins.length}`);
    assert(origins[0].id === localOrigin.id, 'expected local origin primary id preserved');
    assert(origins[0].hash === 'fresh-hash', 'expected origin payload refreshed');
  } finally {
    await prisma.cookie.deleteMany({ where: { userId } });
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
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
