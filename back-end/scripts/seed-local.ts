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

const remote = new PrismaClient({ datasources: { db: { url: REMOTE_URL } } });
const local = new PrismaClient(); // uses process.env.DATABASE_URL (local)

async function syncTable(name: string, fn: () => Promise<number>): Promise<void> {
  try {
    const count = await fn();
    console.log(`  ✅ ${name}: ${count} synced`);
  } catch (err) {
    console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

async function upsertById(model: any, records: any[]): Promise<number> {
  for (const r of records) {
    const { id, ...rest } = r;
    await model.upsert({ where: { id }, create: r, update: rest });
  }
  return records.length;
}

async function sync() {
  console.log('🔄 Syncing from production database...');
  console.log(`   Remote: ${REMOTE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`   Local:  ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') ?? 'default'}`);
  console.log(`   User:   ${DEV_USER_ID}\n`);

  // Verify remote connectivity
  await remote.$queryRaw`SELECT 1`;

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
    const user = await remote.user.findUnique({ where: { userId: DEV_USER_ID } });
    if (!user) throw new Error(`User ${DEV_USER_ID} not found in remote`);
    const { id, ...rest } = user;
    await local.user.upsert({
      where: { userId: DEV_USER_ID },
      create: user as any,
      update: rest as any,
    });
    return 1;
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
  await syncTable('Integrations', async () => {
    // Sync dev user's integrations + all pool tokens (needed for Claude Code benchmarks)
    const userIntegrations = await remote.integration.findMany({ where: { userId: DEV_USER_ID } });
    const poolIntegrations = await remote.integration.findMany({
      where: { poolingEnabled: true, userId: { not: DEV_USER_ID } },
    });
    const all = [...userIntegrations, ...poolIntegrations];
    // Pool tokens reference foreign users — ensure those User records exist locally
    const poolUserIds = [...new Set(poolIntegrations.map((i) => i.userId))];
    for (const uid of poolUserIds) {
      const user = await remote.user.findUnique({ where: { userId: uid } });
      if (user) {
        const { id, ...rest } = user;
        await local.user.upsert({
          where: { userId: uid },
          create: user as any,
          update: rest as any,
        });
      }
    }
    return upsertById(local.integration, all);
  });

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

  // ── Browser Context ──
  await syncTable('Browser Context', async () => {
    const ctx = await remote.browserContext.findUnique({ where: { userId: DEV_USER_ID } });
    if (!ctx) return 0;
    const { id, ...rest } = ctx;
    await local.browserContext.upsert({
      where: { userId: DEV_USER_ID },
      create: ctx as any,
      update: rest as any,
    });
    return 1;
  });

  // ── Cookies ──
  await syncTable('Cookies', async () => {
    const cookies = await remote.cookie.findMany({ where: { userId: DEV_USER_ID } });

    for (let i = 0; i < cookies.length; i += 500) {
      const batch = cookies.slice(i, i + 500);
      await Promise.all(
        batch.map((c) => {
          const { id, ...rest } = c;
          return local.cookie.upsert({ where: { id }, create: c as any, update: rest as any });
        })
      );
      if (cookies.length > 500 && i + 500 < cookies.length) {
        process.stdout.write(`     ${Math.min(i + 500, cookies.length)}/${cookies.length}...\r`);
      }
    }
    return cookies.length;
  });

  // ── LocalStorage Origins ──
  await syncTable('LocalStorage', async () => {
    const origins = await remote.localStorageOrigin.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.localStorageOrigin, origins);
  });

  // ── IndexedDB Origins ──
  await syncTable('IndexedDB', async () => {
    const origins = await remote.indexedDBOrigin.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.indexedDBOrigin, origins);
  });

  // ── Browser Permissions ──
  await syncTable('Browser Permissions', async () => {
    const perms = await remote.browserPermission.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.browserPermission, perms);
  });

  // ── Cache Storage Origins ──
  await syncTable('Cache Storage', async () => {
    const caches = await remote.cacheStorageOrigin.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.cacheStorageOrigin, caches);
  });

  // ── Browser Passwords ──
  await syncTable('Browser Passwords', async () => {
    const passwords = await remote.browserPassword.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.browserPassword, passwords);
  });

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
