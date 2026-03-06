#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const userId = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

  const [totalResult, distinctResult, topDupes, sampleDupes] = await Promise.all([
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) as count FROM "Cookie" WHERE "userId" = $1`, userId
    ),
    prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) as count FROM (SELECT DISTINCT domain, name, path, "topFrameSiteKey" FROM "Cookie" WHERE "userId" = $1) t`, userId
    ),
    prisma.$queryRawUnsafe<{ domain: string; name: string; dupes: bigint }[]>(`
      SELECT domain, name, COUNT(*) as dupes
      FROM "Cookie" WHERE "userId" = $1
      GROUP BY domain, name
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 15
    `, userId),
    prisma.$queryRawUnsafe<{ domain: string; name: string; id: string; synced_at: string }[]>(`
      SELECT domain, name, id, "syncedAt"::text as synced_at
      FROM "Cookie"
      WHERE "userId" = $1 AND domain = '.google.com' AND name = 'NID'
      ORDER BY "syncedAt" DESC
      LIMIT 5
    `, userId),
  ]);

  console.log(`Total rows: ${totalResult[0].count}`);
  console.log(`Distinct (domain,name,path,topFrameSiteKey): ${distinctResult[0].count}`);
  console.log(`\nDuplicate ratio: ${Number(totalResult[0].count) / Number(distinctResult[0].count)}x`);
  console.log(`\nTop 15 duplicated cookies:`);
  for (const d of topDupes) {
    console.log(`  ${d.domain} / ${d.name}: ${d.dupes} copies`);
  }
  console.log(`\nSample dupes (.google.com/NID):`);
  for (const s of sampleDupes) {
    console.log(`  id=${s.id} syncedAt=${s.synced_at}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
