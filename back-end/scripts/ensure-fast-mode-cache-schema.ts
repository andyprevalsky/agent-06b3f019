/**
 * Ensure the shared DEMO cache database has the minimal table/indexes used
 * by /api/fast-cache. This intentionally does not sync the whole Prisma schema:
 * FAST_MODE_CACHE_DATABASE_URL points at the shared/prod cache DB, while the
 * normal app DATABASE_URL can still be local.
 */
import { PrismaClient } from '@prisma/client';

const url =
  process.env.FAST_MODE_CACHE_DATABASE_URL ??
  process.env.DEMO_CACHE_DATABASE_URL ??
  (process.env.NODE_ENV === 'production' ? process.env.DATABASE_URL : undefined);

if (!url) {
  console.error(
    'FAST_MODE_CACHE_DATABASE_URL is required outside production; DEMO cache must not fall back to the local app database.'
  );
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url } },
});

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FastModeCacheEntry" (
      "key" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "goalHash" TEXT NOT NULL,
      "value" JSONB,
      "blobPath" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "FastModeCacheEntry_pkey" PRIMARY KEY ("key")
    )
  `);
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "FastModeCacheEntry_goalHash_idx" ON "FastModeCacheEntry"("goalHash")'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "FastModeCacheEntry_kind_idx" ON "FastModeCacheEntry"("kind")'
  );
  console.log(JSON.stringify({ ok: true, table: 'FastModeCacheEntry' }));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });
