// One-off prod repair (not committed): finish the interrupted agent-index write of
// run 20261008-204907-14684 under the shared Hub index advisory lock.
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import { agentIdsFromHubBundle } from '../src/providers/benchmarkHubLookup';
import { hubAgentIndexAfterPut, parseHubAgentRunIndex, parseHubAgentRunIndexRevision } from '../src/providers/benchmarkHubAgentIndex';

const RUN_ID = '20261008-204907-14684';
const APPLY = process.argv.includes('--apply');
const s3 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
const Bucket = process.env.R2_BUCKET_TRACE_ARCHIVE!;
async function get(key: string): Promise<string> {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key: `benchmark-hub/${key}` }));
  return Buffer.from(await r.Body!.transformToByteArray()).toString('utf8');
}
const prisma = new PrismaClient();
(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'benchmark-hub:index'}))`;
    const [rawIndex, rawFloor, rawCatalog] = await Promise.all([get('agent-run-index.json'), get('agent-run-index-revision.json'), get('index.json')]);
    const floor = parseHubAgentRunIndexRevision(rawFloor);
    const trailing = parseHubAgentRunIndex(rawIndex)!;
    const catalog = JSON.parse(rawCatalog) as Array<{ run_id: string; uploaded_at: string }>;
    const newest = [...catalog].sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0];
    console.log(JSON.stringify({ floor, indexRevision: trailing.revision, complete: trailing.complete, agents: trailing.agents.size, newest: newest.run_id, newestUploadedAt: newest.uploaded_at }));
    if (floor !== 14184 || trailing.revision !== 14183 || newest.run_id !== RUN_ID) throw new Error('state changed since diagnosis; refusing');
    fs.writeFileSync('/home/boxes/rose/.context/hub-stall/backup/agent-run-index.rev14183.json', rawIndex, { mode: 0o600 });
    const bundle = JSON.parse(await get(`runs/${RUN_ID}.json`));
    const ids = agentIdsFromHubBundle(bundle);
    const repaired = hubAgentIndexAfterPut(trailing, false, RUN_ID, ids);
    console.log(JSON.stringify({ derivedAgentIds: ids.length, repairedRevision: repaired.revision, repairedAgents: repaired.agents.size, complete: repaired.complete }));
    if (repaired.revision !== floor) throw new Error('repaired revision does not equal floor');
    if (!APPLY) { console.log('dry run; not writing'); return; }
    const doc = { version: 1, revision: repaired.revision, complete: repaired.complete, agents: Object.fromEntries(repaired.agents) };
    await s3.send(new PutObjectCommand({ Bucket, Key: 'benchmark-hub/agent-run-index.json', Body: JSON.stringify(doc), ContentType: 'application/json' }));
    const check = parseHubAgentRunIndex(await get('agent-run-index.json'))!;
    console.log(JSON.stringify({ written: true, readBackRevision: check.revision, readBackAgents: check.agents.size }));
  }, { maxWait: 30_000, timeout: 50_000 });
  await prisma.$disconnect();
})().catch(async (e) => { console.error('repair failed:', e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });
