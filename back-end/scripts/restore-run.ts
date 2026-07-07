import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

const url = readFileSync('/tmp/prod_db_url.txt', 'utf8').trim();
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: restore-run.ts <rootAgentId>');
  // Un-delete the root + every agent in its bus (the whole tree) so it renders in the FE.
  const res = await prisma.$executeRawUnsafe(
    `UPDATE "Agent" SET "deletedAt" = NULL WHERE "busId" = $1 OR id = $1`,
    root
  );
  const counts = await prisma.$queryRawUnsafe<Array<{ total: number; done: number }>>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='COMPLETED')::int AS done
     FROM "Agent" WHERE "busId" = $1 AND "parentAgentId" IS NOT NULL`,
    root
  );
  const rootRow = await prisma.$queryRawUnsafe<Array<{ status: string; cost: number; deletedAt: Date | null }>>(
    `SELECT status, "treeCostCents" AS cost, "deletedAt" FROM "Agent" WHERE id = $1`,
    root
  );
  console.log(`restored ${res} rows for tree ${root.slice(0, 8)}`);
  console.log(`root: status=${rootRow[0]?.status} cost=$${(rootRow[0]?.cost ?? 0) / 100} deletedAt=${rootRow[0]?.deletedAt}`);
  console.log(`children: ${counts[0]?.total} total, ${counts[0]?.done} completed`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
