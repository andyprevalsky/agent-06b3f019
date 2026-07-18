#!/usr/bin/env tsx

import {
  syncCookieCredentials,
  syncCookieBundleCredentials,
  syncBrowserPasswordCredentials,
  syncBrowserPermissionCredentials,
  syncIntegrationCredentials,
  syncOriginCredentials,
  syncPasskeyCredentials,
  syncRequiredCredentialTable,
  syncSteelSessionAuthCredentials,
  type BrowserPasswordModel,
  type BrowserPermissionModel,
  type CookieModel,
  type CookieBundleModel,
  type IntegrationModel,
  type OriginModel,
  type SteelSessionAuthModel,
} from '../../../scripts/seed-local-credentials';
import {
  PrismaClient,
  type BrowserPassword,
  type BrowserPermission,
  type Cookie,
  type CookieBundle,
  type LocalStorageOrigin,
  type SteelSessionAuth,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const origin: LocalStorageOrigin = {
    id: 'remote-origin-id',
    userId: 'seed-user',
    origin: 'https://example.com',
    entries: [{ key: 'session', value: 'fresh' }],
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
  const originModel: OriginModel<LocalStorageOrigin> = {
    upsert: async (args) => {
      captured.origin = args as unknown as Record<string, unknown>;
      return {};
    },
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

  await syncOriginCredentials(originModel, [origin]);
  await syncBrowserPermissionCredentials(permissionModel, [permission]);
  await syncBrowserPasswordCredentials(passwordModel, [password]);

  const originWhere = captured.origin.where as {
    userId_origin?: { userId?: string; origin?: string };
  };
  assert(originWhere.userId_origin?.userId === origin.userId, 'expected origin user selector');
  assert(originWhere.userId_origin?.origin === origin.origin, 'expected origin URL selector');
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
  for (const [name, args] of Object.entries(captured)) {
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

test('full sync defers browser-auth failure until later tables finish', async () => {
  const source = readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const fullSyncCollector = source.indexOf('const browserAuthSyncFailures: Error[] = [];');
  const collectedBrowserSync = source.indexOf(
    'await syncBrowserAuthForCurrentMode(browserAuthSyncFailures);'
  );
  const laterTable = source.indexOf("await syncTable('Goal Blueprints'");
  const deferredFailure = source.indexOf('throwBrowserAuthSyncFailures(browserAuthSyncFailures);');
  const credentialsOnlyBranch = source.indexOf('if (CREDENTIALS_ONLY)');
  const failFastBrowserSync = source.indexOf(
    'await syncBrowserAuthForCurrentMode();',
    credentialsOnlyBranch
  );

  assert(fullSyncCollector > 0, 'expected full sync to collect browser-auth failures');
  assert(
    collectedBrowserSync > fullSyncCollector,
    'expected full sync to pass its failure collector to browser-auth sync'
  );
  assert(laterTable > collectedBrowserSync, 'expected later full-sync tables after browser auth');
  assert(
    deferredFailure > laterTable,
    'expected collected browser-auth failures to throw only after later tables finish'
  );
  assert(
    failFastBrowserSync > credentialsOnlyBranch && failFastBrowserSync < fullSyncCollector,
    'expected credentials-only sync to remain fail-fast'
  );
});

test('browser-auth sync includes every durable credential reference', async () => {
  const source = readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const browserStateStart = source.indexOf('async function syncBrowserState');
  const browserStateEnd = source.indexOf('function sleep', browserStateStart);
  const browserState = source.slice(browserStateStart, browserStateEnd);

  for (const model of ['browserProviderProfile', 'cookieBundle', 'steelSessionAuth']) {
    assert(browserState.includes(`remote.${model}`), `expected production ${model} read`);
    assert(
      browserState.includes(`local.${model}`) || browserState.includes(`tx.${model}`),
      `expected local ${model} write`
    );
  }
});

test('passkeys-only seed mode never enters browser state or password sync', async () => {
  const source = readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const flag = source.indexOf("process.argv.includes('--passkeys-only')");
  const branch = source.indexOf('if (PASSKEYS_ONLY)');
  const passkeySync = source.indexOf(
    'await syncPasskeysOnly(undefined, { authoritative: true });',
    branch
  );
  const branchReturn = source.indexOf('return;', passkeySync);
  const credentialsOnlyBranch = source.indexOf('if (CREDENTIALS_ONLY)');

  assert(flag > 0, 'expected a dedicated --passkeys-only CLI flag');
  assert(branch > flag, 'expected passkeys-only branch after flag declaration');
  assert(passkeySync > branch, 'expected passkeys-only branch to sync passkeys');
  assert(branchReturn > passkeySync, 'expected passkeys-only branch to return immediately');
  assert(
    source.includes("'Stale Local Passkeys'") &&
      source.includes('local.passkeyCredential.deleteMany'),
    'expected passkeys-only mode to remove stale local passkeys'
  );
  assert(
    credentialsOnlyBranch > branchReturn,
    'expected passkeys-only mode to return before browser state/password sync'
  );
});

test('seed-local rejects conflicting exclusive sync modes before creating database clients', async () => {
  const source = readFileSync(resolve(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const validation = source.indexOf('if (requestedSeedModes.length > 1)');
  const clients = source.indexOf('const remote = new PrismaClient');

  assert(validation > 0, 'expected mutually exclusive seed-mode validation');
  assert(clients > validation, 'expected seed-mode validation before database client creation');
  assert(
    source.includes('Seed modes are mutually exclusive; received'),
    'expected conflicting flags to be named in the failure'
  );
});

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
      },
    ]);
    await syncOriginCredentials(prisma.localStorageOrigin, [
      {
        ...localOrigin,
        id: `remote-origin-${suffix}`,
        entries: [{ key: 'session', value: 'fresh' }],
        hash: 'fresh-hash',
      },
    ]);

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
