// One-off: re-key DEMO cache entries recorded by run b429f478 (2026-07-03)
// so a rerun (with the persisted-goal + canonical-ref-hash fixes) replays them.
// Non-destructive: copies rows to the new namespace, ON CONFLICT DO NOTHING.
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

const REF_RE =
  /@ref:message:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const canonicalHash = (goal: string) => sha16(goal.replace(REF_RE, '@ref:message:<uuid>'));

const ROOT_ID = 'b429f478-c38d-4809-8e90-4e5d16b812c6';
const ROOT_REFINED_HASH = 'cfcac6ad0677fb91'; // workflow-input (chat-refined) namespace, from prod logs
const DRY_RUN = process.env.DRY_RUN !== '0';

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.PROD_DB_URL! } } });
  const root = await prisma.agent.findUnique({ where: { id: ROOT_ID }, select: { goal: true } });
  if (!root) throw new Error('root agent not found');
  const rootDbHash = sha16(root.goal);
  const subs = await prisma.agent.findMany({
    where: { parentAgentId: ROOT_ID },
    select: { id: true, goal: true },
  });

  // (oldHash → newHash) pairs: root refined→persisted, subs raw→canonical.
  const pairs: Array<[string, string, string]> = [[ROOT_REFINED_HASH, rootDbHash, 'root']];
  for (const sub of subs) {
    const raw = sha16(sub.goal);
    const canon = canonicalHash(sub.goal);
    if (raw !== canon) pairs.push([raw, canon, `sub ${sub.id.slice(0, 8)}`]);
  }

  console.log(
    `root persisted hash: ${rootDbHash}; subs: ${subs.length}; rekey pairs: ${pairs.length}`
  );
  let totalCopied = 0;
  for (const [oldHash, newHash, label] of pairs) {
    const count = await prisma.fastModeCacheEntry.count({ where: { goalHash: oldHash } });
    if (count === 0) {
      console.log(`  ${label}: ${oldHash} → ${newHash} (0 rows, skip)`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  ${label}: ${oldHash} → ${newHash} (${count} rows) [dry run]`);
      continue;
    }
    const copied: number = await prisma.$executeRawUnsafe(
      `INSERT INTO "FastModeCacheEntry" (key, kind, "goalHash", value, "blobPath", "createdAt")
       SELECT replace(key, ':' || $1 || ':', ':' || $2 || ':'), kind, $2, value, "blobPath", "createdAt"
       FROM "FastModeCacheEntry" WHERE "goalHash" = $1
       ON CONFLICT (key) DO NOTHING`,
      oldHash,
      newHash
    );
    totalCopied += copied;
    console.log(`  ${label}: ${oldHash} → ${newHash} (${count} rows, ${copied} copied)`);
  }
  console.log(`total copied: ${totalCopied}${DRY_RUN ? ' (dry run — nothing written)' : ''}`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
