/**
 * Sync user data from the remote (production) Supabase database to the local Postgres.
 *
 * Reads the remote DATABASE_URL from back-end/.env (since run.sh overrides
 * process.env.DATABASE_URL to point to local). Syncs all user-scoped data for
 * the dev user without overwriting locally-spawned agents.
 *
 * Usage: DATABASE_URL=<local_url> npx tsx scripts/seed-local.ts
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';
import {
  syncBrowserPasswordCredentials,
  syncBrowserPermissionCredentials,
  syncCookieCredentials,
  syncIntegrationCredentials,
  syncOriginCredentials,
  syncPasskeyCredentials,
  syncRequiredCredentialTable,
} from './seed-local-credentials';
import { runSyncStep, syncUserRecord } from './seed-local-helpers';

// Parse .env file directly to get remote DB URL
// (process.env.DATABASE_URL is already overridden to local by run.sh)
const envPath = resolve(__dirname, '..', '.env');
const envVars = dotenv.parse(readFileSync(envPath));
const REMOTE_URL = envVars.DIRECT_DATABASE_URL || envVars.DATABASE_URL;

if (!REMOTE_URL) {
  console.error('❌ No remote DATABASE_URL found in .env');
  process.exit(1);
}

const DEV_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
// Merge production browser auth state into local by each table's natural
// identity. Matching rows are refreshed and missing production rows are added;
// local-only rows are deliberately preserved by normal/full sync. The explicit
// --passkeys-only benchmark mode is authoritative and removes stale local
// passkeys so its live-fixture preflight cannot succeed on obsolete material.
const CREDENTIALS_ONLY = process.argv.includes('--credentials-only');
const SKIP_BROWSER_AUTH_SYNC =
  process.env.BENCHMARK_SKIP_BROWSER_AUTH_SYNC === '1' ||
  process.env.BENCHMARK_WORLD_MODEL_MODE === 'simulate';
// Refresh ONLY the compute-token integrations (claude_code / gpt_code, the
// dev user's own + the shared pool) from prod. Benchmark runs invoke this at
// task setup so a frozen DB fixture or whole-DB snapshot restore can never
// leave the isolated DB with a stale/expired compute token — otherwise the
// agent's claudeAuth fetch fails and every LLM call falls through to the paid
// waterfall.
const COMPUTE_TOKENS_ONLY = process.argv.includes('--compute-tokens-only');
const PASSKEYS_ONLY = process.argv.includes('--passkeys-only');
const COMPUTE_TOKEN_SYNC_ATTEMPTS = 5;

const requestedSeedModes = [
  ['--compute-tokens-only', COMPUTE_TOKENS_ONLY],
  ['--passkeys-only', PASSKEYS_ONLY],
  ['--credentials-only', CREDENTIALS_ONLY],
].filter(([, enabled]) => enabled);
if (requestedSeedModes.length > 1) {
  throw new Error(
    `Seed modes are mutually exclusive; received ${requestedSeedModes
      .map(([flag]) => flag)
      .join(', ')}`
  );
}

const remote = new PrismaClient({ datasources: { db: { url: REMOTE_URL } } });
const local = new PrismaClient(); // uses process.env.DATABASE_URL (local)

async function syncTable(name: string, fn: () => Promise<number>): Promise<void> {
  await runSyncStep(name, fn);
}

async function syncRequiredTable(
  name: string,
  fn: () => Promise<number>,
  failures?: Error[]
): Promise<void> {
  try {
    const count = await syncRequiredCredentialTable(name, fn);
    console.log(`  ✅ ${name}: ${count} synced`);
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    console.error(`  ❌ ${failure.message}`);
    if (failures) {
      failures.push(failure);
      return;
    }
    throw failure;
  }
}

async function upsertById(model: any, records: any[]): Promise<number> {
  for (const r of records) {
    const { id, ...rest } = r;
    await model.upsert({ where: { id }, create: r, update: rest });
  }
  return records.length;
}

async function syncIntegrations(): Promise<number> {
  // Sync dev user's integrations + all pool tokens (needed for Claude Code benchmarks)
  const userIntegrations = await remote.integration.findMany({ where: { userId: DEV_USER_ID } });
  const poolIntegrations = await remote.integration.findMany({
    where: { poolingEnabled: true, userId: { not: DEV_USER_ID } },
  });
  const all = [...userIntegrations, ...poolIntegrations];
  // Pool tokens reference foreign users — ensure those User records exist locally
  const poolUserIds = [...new Set(poolIntegrations.map((i) => i.userId))];
  for (const uid of poolUserIds) {
    await syncUserRecord(remote.user, local.user, uid);
  }
  // Integrations are unique by (userId, name). A local credential may have a
  // different primary key from its production counterpart, so syncing by id
  // can collide with that compound key and fail every benchmark preflight.
  // Preserve the local id (and any dependent rows) while refreshing the
  // production credential fields.
  const syncedIds = await syncIntegrationCredentials(local.integration, all);
  const deleted = await local.integration.deleteMany({
    where: {
      name: { in: ['claude_code', 'gpt_code'] },
      id: { notIn: syncedIds.length > 0 ? syncedIds : ['__none__'] },
    },
  });
  if (deleted.count > 0) {
    console.log(`  🧹 Integrations: ${deleted.count} stale local compute tokens deleted`);
  }
  return syncedIds.length;
}

// Browser auth merge shared by full sync and --credentials-only. Production
// identities refresh or add rows, while local-only identities are preserved.
async function syncBrowserState(failures?: Error[]): Promise<void> {
  // ── Browser Context ──
  await syncRequiredTable(
    'Browser Context',
    async () => {
      const ctx = await remote.browserContext.findUnique({ where: { userId: DEV_USER_ID } });
      if (!ctx) return 0;
      const { id, ...rest } = ctx;
      await local.browserContext.upsert({
        where: { userId: DEV_USER_ID },
        create: ctx as any,
        update: rest as any,
      });
      return 1;
    },
    failures
  );

  // ── Cookies ──
  await syncRequiredTable(
    'Cookies',
    async () => {
      const cookies = await remote.cookie.findMany({ where: { userId: DEV_USER_ID } });

      for (let i = 0; i < cookies.length; i += 500) {
        const batch = cookies.slice(i, i + 500);
        await syncCookieCredentials(local.cookie, batch);
        if (cookies.length > 500 && i + 500 < cookies.length) {
          process.stdout.write(`     ${Math.min(i + 500, cookies.length)}/${cookies.length}...\r`);
        }
      }
      return cookies.length;
    },
    failures
  );

  // ── LocalStorage Origins ──
  await syncRequiredTable(
    'LocalStorage',
    async () => {
      const origins = await remote.localStorageOrigin.findMany({ where: { userId: DEV_USER_ID } });
      return syncOriginCredentials(local.localStorageOrigin, origins);
    },
    failures
  );

  // ── IndexedDB Origins ──
  await syncRequiredTable(
    'IndexedDB',
    async () => {
      const origins = await remote.indexedDBOrigin.findMany({ where: { userId: DEV_USER_ID } });
      return syncOriginCredentials(local.indexedDBOrigin, origins);
    },
    failures
  );

  // ── Browser Permissions ──
  await syncRequiredTable(
    'Browser Permissions',
    async () => {
      const perms = await remote.browserPermission.findMany({ where: { userId: DEV_USER_ID } });
      return syncBrowserPermissionCredentials(local.browserPermission, perms);
    },
    failures
  );

  // ── Cache Storage Origins ──
  await syncRequiredTable(
    'Cache Storage',
    async () => {
      const caches = await remote.cacheStorageOrigin.findMany({ where: { userId: DEV_USER_ID } });
      return syncOriginCredentials(local.cacheStorageOrigin, caches);
    },
    failures
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasEncryptedCredentials(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const encryptedCredentials = (config as Record<string, unknown>).encryptedCredentials;
  return typeof encryptedCredentials === 'string' && encryptedCredentials.length > 0;
}

async function countUsableGptCodeIntegrations(): Promise<number> {
  const now = new Date();
  const integrations = await local.integration.findMany({
    where: {
      name: 'gpt_code',
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
    select: {
      userId: true,
      poolingEnabled: true,
      config: true,
    },
  });

  return integrations.filter((integration) => {
    const isAvailableToBench = integration.userId === DEV_USER_ID || integration.poolingEnabled;
    return isAvailableToBench && hasEncryptedCredentials(integration.config);
  }).length;
}

async function syncComputeTokensWithRetries(): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= COMPUTE_TOKEN_SYNC_ATTEMPTS; attempt++) {
    try {
      const count = await syncIntegrations();
      const usableGptCodeCount = await countUsableGptCodeIntegrations();
      if (usableGptCodeCount === 0) {
        throw new Error('No usable gpt_code integrations after sync');
      }
      console.log(
        `  ✅ Compute Tokens (integrations): ${count} synced, ${usableGptCodeCount} usable gpt_code`
      );
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `  ❌ Compute Tokens (integrations): attempt ${attempt}/${COMPUTE_TOKEN_SYNC_ATTEMPTS} failed: ${message}`
      );
      if (attempt < COMPUTE_TOKEN_SYNC_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Compute token sync failed after ${COMPUTE_TOKEN_SYNC_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function syncBrowserCredentials(failures?: Error[]): Promise<void> {
  // ── Browser Passwords ──
  await syncRequiredTable(
    'Browser Passwords',
    async () => {
      const passwords = await remote.browserPassword.findMany({ where: { userId: DEV_USER_ID } });
      return syncBrowserPasswordCredentials(local.browserPassword, passwords);
    },
    failures
  );

  await syncPasskeysOnly(failures);
}

async function syncPasskeysOnly(
  failures?: Error[],
  options: { authoritative?: boolean } = {}
): Promise<void> {
  // ── Passkey Credentials ──
  await syncRequiredTable(
    'Passkey Credentials',
    async () => {
      return syncPasskeyCredentials(remote.passkeyCredential, local.passkeyCredential, DEV_USER_ID);
    },
    failures
  );

  if (options.authoritative) {
    await syncRequiredTable(
      'Stale Local Passkeys',
      async () => {
        const remoteKeys = await remote.passkeyCredential.findMany({
          where: { userId: DEV_USER_ID },
          select: { rpId: true, credentialId: true },
        });
        const liveKeys = new Set(
          remoteKeys.map(({ rpId, credentialId }) => `${rpId}\u0000${credentialId}`)
        );
        const localKeys = await local.passkeyCredential.findMany({
          where: { userId: DEV_USER_ID },
          select: { id: true, rpId: true, credentialId: true },
        });
        const staleIds = localKeys
          .filter(({ rpId, credentialId }) => !liveKeys.has(`${rpId}\u0000${credentialId}`))
          .map(({ id }) => id);
        if (staleIds.length === 0) return 0;
        const deleted = await local.passkeyCredential.deleteMany({
          where: { id: { in: staleIds } },
        });
        return deleted.count;
      },
      failures
    );
  }
}

async function syncBrowserAuthForCurrentMode(failures?: Error[]): Promise<void> {
  if (SKIP_BROWSER_AUTH_SYNC) {
    console.log('  ⏭️  Browser auth state: skipped for simulated benchmark setup');
    return;
  }

  await syncBrowserState(failures);
  await syncBrowserCredentials(failures);
}

function throwBrowserAuthSyncFailures(failures: Error[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new Error(
    `Browser auth sync failed for ${failures.length} tables: ${failures
      .map((failure) => failure.message)
      .join('; ')}`
  );
}

async function sync() {
  console.log('🔄 Syncing from production database...');
  console.log(`   Remote: ${REMOTE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`   Local:  ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') ?? 'default'}`);
  console.log(`   User:   ${DEV_USER_ID}\n`);

  // Verify remote connectivity
  await remote.$queryRaw`SELECT 1`;

  if (COMPUTE_TOKENS_ONLY) {
    await syncComputeTokensWithRetries();
    console.log('\n🔄 Compute token sync complete.');
    return;
  }

  if (PASSKEYS_ONLY) {
    console.log(
      '  ℹ️  Syncing authoritative passkeys only; browser state and passwords are excluded'
    );
    await syncPasskeysOnly(undefined, { authoritative: true });
    console.log('\n🔄 Passkey sync complete.');
    return;
  }

  if (CREDENTIALS_ONLY) {
    console.log('  ℹ️  Browser auth merge refreshes production rows and preserves local-only rows');
    await syncBrowserAuthForCurrentMode();
    console.log('\n🔄 Credential sync complete.');
    return;
  }

  // ── Global: Tools ──
  await syncTable('Tools', async () => {
    const tools = await remote.tool.findMany();
    for (const t of tools) {
      await local.tool.upsert({
        where: { name: t.name },
        create: { id: t.id, name: t.name, description: t.description, createdAt: t.createdAt },
        update: { description: t.description },
      });
    }
    return tools.length;
  });

  // ── User ──
  await syncTable('User', async () => {
    const count = await syncUserRecord(remote.user, local.user, DEV_USER_ID);
    if (count === 0) throw new Error(`User ${DEV_USER_ID} not found in remote`);
    return count;
  });

  // ── Credits ──
  await syncTable('Credits', async () => {
    const credits = await remote.credit.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.credit, credits);
  });

  // ── Subscription ──
  await syncTable('Subscription', async () => {
    const sub = await remote.subscription.findUnique({ where: { userId: DEV_USER_ID } });
    if (!sub) return 0;
    const { id, ...rest } = sub;
    await local.subscription.upsert({
      where: { userId: DEV_USER_ID },
      create: sub as any,
      update: rest as any,
    });
    return 1;
  });

  // ── Integrations ──
  await syncTable('Integrations', syncIntegrations);

  // ── Email Integration Credentials ──
  await syncTable('Email Credentials', async () => {
    const creds = await remote.emailIntegrationCredential.findMany({
      where: { userId: DEV_USER_ID },
    });
    return upsertById(local.emailIntegrationCredential, creds);
  });

  // ── People (contacts) ──
  await syncTable('People', async () => {
    const people = await remote.person.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.person, people);
  });

  // ── Message Records ──
  await syncTable('Message Records', async () => {
    const personIds = (
      await remote.person.findMany({
        where: { userId: DEV_USER_ID },
        select: { id: true },
      })
    ).map((p) => p.id);
    if (personIds.length === 0) return 0;

    // Cap at the latest 10k messages across all contacts to keep seed fast and
    // local DB lean; older history isn't needed for dev/testing.
    const MESSAGE_LIMIT = 10_000;
    const messages = await remote.messageRecord.findMany({
      where: { personId: { in: personIds } },
      orderBy: { timestamp: 'desc' },
      take: MESSAGE_LIMIT,
    });

    // Batch in groups of 500 for large datasets
    for (let i = 0; i < messages.length; i += 500) {
      const batch = messages.slice(i, i + 500);
      await Promise.all(
        batch.map((m) => {
          const { id, ...rest } = m;
          return local.messageRecord.upsert({
            where: { id },
            create: m as any,
            update: rest as any,
          });
        })
      );
      if (messages.length > 500 && i + 500 < messages.length) {
        process.stdout.write(`     ${Math.min(i + 500, messages.length)}/${messages.length}...\r`);
      }
    }
    return messages.length;
  });

  // ── Rose API Keys ──
  await syncTable('Rose API Keys', async () => {
    const keys = await remote.roseApiKey.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.roseApiKey, keys);
  });

  // ── Browser auth state (context, cookies, storage) + credentials ──
  const browserAuthSyncFailures: Error[] = [];
  await syncBrowserAuthForCurrentMode(browserAuthSyncFailures);

  // ── Goal Blueprints ──
  await syncTable('Goal Blueprints', async () => {
    const blueprints = await remote.goalBlueprint.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.goalBlueprint, blueprints);
  });

  // ── GitHub Repo Access ──
  await syncTable('GitHub Repos', async () => {
    const repos = await remote.githubRepoAccess.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.githubRepoAccess, repos);
  });

  // ── SMS Session ──
  await syncTable('SMS Session', async () => {
    const session = await remote.smsSession.findUnique({ where: { userId: DEV_USER_ID } });
    if (!session) return 0;
    const { id, ...rest } = session;
    await local.smsSession.upsert({
      where: { userId: DEV_USER_ID },
      create: session as any,
      update: rest as any,
    });
    return 1;
  });

  // ── Feedback ──
  await syncTable('Feedback', async () => {
    const feedback = await remote.feedback.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.feedback, feedback);
  });

  // ── Waitlist (global, phone-bearing only) ──
  // Not user-scoped: these are the actionable signups the admin-health
  // "Waitlist People" panel lists + texts off the waitlist. Legacy email-only
  // rows are skipped (the panel filters them out anyway), so the local copy
  // stays tiny. The invite SMS only fires in production, so seeding real
  // numbers here is safe for local dev.
  await syncTable('Waitlist', async () => {
    // Explicit select (omits invitedAt): prod may not have that column yet the
    // first time this ships, and local invitedAt should start null anyway.
    const rawRows = await remote.waitlist.findMany({
      where: { phone: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        variant: true,
        referralCode: true,
        createdAt: true,
      },
    });
    // Drop empty-string phones: they can't be texted and would reach the admin
    // invite flow with a blank SMS destination.
    const rows = rawRows.filter((r) => (r.phone ?? '').trim() !== '');
    const synced = await upsertById(local.waitlist, rows);

    // Also pull the accounts these phones belong to, so the "Waitlist People"
    // panel renders truthful account/gate status locally instead of "No account
    // yet" for everyone. Minimal projection only — never copy sensitive columns
    // (e.g. encryptedPaymentInformation) or offWaitlistAt (may be absent in prod).
    const phones = rows.map((r) => r.phone).filter((p): p is string => p !== null);
    if (phones.length > 0) {
      const accounts = await remote.user.findMany({
        where: { phone: { in: phones } },
        select: { id: true, userId: true, phone: true, usedInviteCode: true },
      });
      await upsertById(local.user, accounts);
    }
    return synced;
  });

  throwBrowserAuthSyncFailures(browserAuthSyncFailures);

  console.log('\n🔄 Sync complete.');
}

sync()
  .catch((err) => {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await remote.$disconnect();
    await local.$disconnect();
  });
