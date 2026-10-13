#!/usr/bin/env tsx
/**
 * RCA scratch repro (not committed): production browser-session init against a
 * real Kernel browser with a user whose google.com realm has the prod shape of
 * agent 07281fc3's user (synthetic values, real origin keys and byte sizes).
 *
 * Run from back-end/ with DATABASE_URL/DIRECT_URL pointing at the LOCAL DB.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { prisma } from '../../back-end/src/providers/database';
import { initSession, closeBrowserSession } from '../../back-end/src/domains/browser-session/service';

const host = new URL(process.env.DATABASE_URL ?? '').hostname;
if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`refusing non-local DB ${host}`);

type Shape = {
  ls: Array<{ origin: string; b: number; n: number }>;
  idb: Array<{ origin: string; b: number }>;
  cs: Array<{ origin: string; n: number }>;
  perm: Array<{ origin: string; permission: string; setting: number }>;
};
const shape = JSON.parse(
  readFileSync(new URL('./prod-shape.json', import.meta.url), 'utf8')
) as Shape;
const START_URL = process.argv[2] ?? 'https://admin.google.com/ac/users';
const RUNS = Number(process.argv[3] ?? '1');
const RECEIPTS = new URL('./receipts.jsonl', import.meta.url);

async function seed(userId: string) {
  for (const row of shape.ls) {
    const per = Math.max(1, row.n);
    const valueLen = Math.max(1, Math.floor(row.b / per) - 30);
    const entries = Array.from({ length: per }, (_, i) => ({ key: `k${i}`, value: 'v'.repeat(valueLen) }));
    await prisma.localStorageOrigin.create({
      data: { userId, origin: row.origin, entries, hash: randomUUID() },
    });
  }
  for (const row of shape.idb) {
    if (row.b > 10_000_000) {
      // The memory blackbox generator: 540k records, 78.6 MB serialized.
      await prisma.$executeRaw`
        INSERT INTO "IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
        SELECT ${randomUUID()}, ${userId}, ${row.origin},
          ('[{"name":"ODPMC","objectStores":[{"name":"modules","records":[' ||
            (SELECT string_agg(jsonb_build_object('key', 'record-key-' || i,
                'value', jsonb_build_object('key', 'record-key-' || i,
                  'value', md5(i::text) || md5((i * 7)::text)))::text, ',' ORDER BY i)
              FROM generate_series(1, 540000) i) || ']}]}]')::jsonb,
          'synthetic-origin', now()`;
    } else {
      const records = Math.max(1, Math.floor(row.b / 120));
      const databases = [
        {
          name: 'synthetic',
          objectStores: [
            {
              name: 'store',
              records: Array.from({ length: records }, (_, i) => ({
                key: `r${i}`,
                value: { key: `r${i}`, value: 'x'.repeat(64) },
              })),
            },
          ],
        },
      ];
      await prisma.indexedDBOrigin.create({
        data: { userId, origin: row.origin, databases, hash: randomUUID() },
      });
    }
  }
  for (const row of shape.cs) {
    const caches = Array.from({ length: Math.max(1, row.n) }, (_, i) => ({ name: `cache-${i}` }));
    await prisma.cacheStorageOrigin.create({
      data: { userId, origin: row.origin, caches, hash: randomUUID() },
    });
  }
  for (const row of shape.perm) {
    await prisma.browserPermission.create({
      data: { userId, origin: row.origin, permission: row.permission, setting: row.setting },
    });
  }
}

async function main() {
  const userId = `rca-state-injection-${randomUUID()}`;
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, name: 'RCA state injection repro' } });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'RCA state injection repro',
      proxyCountry: 'US',
      proxyState: 'CA',
      proxyCity: 'San Francisco',
    },
  });
  try {
    await seed(userId);
    if (process.env.APPLY_MIGRATION) {
      // Deploy applies this before the fixed backend starts.
      const sql = readFileSync(process.env.APPLY_MIGRATION, 'utf8');
      await prisma.$executeRawUnsafe(`DO $mig$ BEGIN ${sql} END $mig$`);
    }
    for (let run = 1; run <= RUNS; run++) {
      const started = Date.now();
      let outcome = 'ok';
      let detail: unknown = null;
      try {
        const result = await initSession(userId, agentId, START_URL, randomUUID());
        detail = result.browser_session_metadata;
        await closeBrowserSession(result.session_id, false).catch((e) => {
          console.error('close failed', e);
        });
      } catch (error) {
        outcome = 'error';
        detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      const receipt = {
        at: new Date().toISOString(),
        rev: process.env.REPRO_REV ?? 'unknown',
        startUrl: START_URL,
        run,
        outcome,
        elapsedMs: Date.now() - started,
        detail,
      };
      appendFileSync(RECEIPTS, JSON.stringify(receipt) + '\n');
      console.log('REPRO_RECEIPT', JSON.stringify(receipt));
    }
  } finally {
    await prisma.browserSession.updateMany({
      where: { agentId, status: { in: ['ACTIVE', 'PAUSED'] } },
      data: { status: 'CLOSED' },
    });
    for (const model of [
      prisma.localStorageOrigin,
      prisma.indexedDBOrigin,
      prisma.cacheStorageOrigin,
      prisma.browserPermission,
    ] as const) {
      await (model as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({
        where: { userId },
      });
    }
    // Retire exactly the provider profile and rows this repro created.
    const profiles = await prisma.browserProviderProfile.findMany({
      where: { provider: 'kernel', context: { userId } },
      select: { profileId: true },
    });
    for (const { profileId } of profiles) {
      const res = await fetch(`https://api.onkernel.com/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.KERNEL_API_KEY ?? ''}` },
      });
      console.log('REPRO_PROFILE_CLEANUP', profileId, res.status);
    }
    const contexts = await prisma.browserContext.findMany({ where: { userId }, select: { id: true } });
    await prisma.browserSession.deleteMany({ where: { contextId: { in: contexts.map((c) => c.id) } } });
    await prisma.agentIdentity.deleteMany({ where: { userId } });
    await prisma.mintedAccount.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
