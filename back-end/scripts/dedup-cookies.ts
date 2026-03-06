#!/usr/bin/env tsx
console.log("SCRIPT LOADED");
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BATCH_SIZE = 5000;
const BATCH_TIMEOUT_MS = 30000;
const userId = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function deleteBatch(batchNum: number): Promise<number> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const start = Date.now();
      const deleted = await withTimeout(
        prisma.$executeRawUnsafe(
          `DELETE FROM "Cookie" WHERE id IN (SELECT id FROM "Cookie" WHERE "userId" = $1 LIMIT $2)`,
          userId,
          BATCH_SIZE
        ),
        BATCH_TIMEOUT_MS,
        `batch ${batchNum}`
      );
      console.log(`  [batch ${batchNum}] deleted ${deleted} in ${Date.now() - start}ms (attempt ${attempt})`);
      return deleted;
    } catch (err: any) {
      const isRetryable = err.meta?.code === '40P01' || err.message?.includes('timed out');
      if (isRetryable && attempt < 5) {
        console.log(`  [batch ${batchNum}] ${err.meta?.code || 'timeout'} on attempt ${attempt}, retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
  return 0;
}

async function main() {
  const scriptStart = Date.now();
  console.log("Starting cookie cleanup...");

  const countBefore = await withTimeout(
    prisma.$queryRaw<{count: bigint}[]>`SELECT COUNT(*) as count FROM "Cookie" WHERE "userId" = ${userId}`,
    10000,
    'count query'
  );
  console.log(`Cookies for user: ${countBefore[0].count}`);

  let totalDeleted = 0;
  let batch = 0;
  while (true) {
    batch++;
    const deleted = await deleteBatch(batch);
    totalDeleted += deleted;
    if (batch % 10 === 0 || deleted < BATCH_SIZE) {
      const elapsed = ((Date.now() - scriptStart) / 1000).toFixed(1);
      console.log(`[${elapsed}s] Progress: ${totalDeleted} deleted so far`);
    }
    if (deleted < BATCH_SIZE) break;
  }

  const elapsed = ((Date.now() - scriptStart) / 1000).toFixed(1);
  console.log(`[${elapsed}s] Done. Deleted ${totalDeleted} cookies.`);

  // Just delete all remaining NULL topFrameSiteKey rows — they're all dupes
  console.log("Deleting all remaining NULL topFrameSiteKey rows...");
  const nullDeleted = await withTimeout(
    prisma.$executeRaw`DELETE FROM "Cookie" WHERE "topFrameSiteKey" IS NULL`,
    60000,
    'NULL delete'
  );
  console.log(`Deleted ${nullDeleted} NULL rows`);

  const finalCount = await prisma.$queryRaw<{count: bigint}[]>`SELECT COUNT(*) as count FROM "Cookie"`;
  console.log(`Total cookies remaining: ${finalCount[0].count}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
