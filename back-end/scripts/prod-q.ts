/**
 * Ad-hoc prod DB query helper (READ-ONLY use intended).
 * Reads the prod DATABASE_URL from /tmp/prod_db_url.txt and runs the SQL passed
 * as argv[2] (or a named query). Prints rows as JSON lines.
 *
 * Usage: npx tsx scripts/prod-q.ts "SELECT ... "
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

const url = readFileSync('/tmp/prod_db_url.txt', 'utf8').trim();
const p = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const sql = process.argv[2];
  if (!sql) throw new Error('pass SQL as argv[2]');
  const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(sql);
  for (const r of rows) {
    console.log(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  }
  await p.$disconnect();
}

main().catch((e) => {
  console.error('ERR', (e as Error).message);
  process.exit(1);
});
