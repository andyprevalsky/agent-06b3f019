import assert from 'node:assert';
import fs from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  collectFixture,
  restoreFixture,
  type ScopedDbFixture,
} from '../../domains/archive/fixture';
import { encryptArtifact, localObjectPath } from '../../providers/traceArchive';
import { deleteArchivedBundleRowsSql } from '../../providers/traceArchiveSearchIndex';
import { jsonRoundTrip, request } from './archive-blackbox.support';

/**
 * Per-run trace-archive cost must be bounded by what the run touched, never by
 * the owning user's lifetime history (rule 28: 10k agents, heavy users).
 */

type RunSeed = { userId: string; rootAgentId: string; personId: string };

// Lifetime user history: grows with the user's account, not with one run. The
// canonical base image carries it; per-run fixtures must not re-read it.
const USER_HISTORY_TABLES = [
  'Person',
  'MessageRecord',
  'Cookie',
  'CookieBundle',
  'BrowserPassword',
  'AgentPhoneMessage',
] as const;

export async function testFixtureExcludesUserLifetimeHistory(seed: RunSeed): Promise<void> {
  const fixture = await collectFixture(seed.rootAgentId, 'start');
  for (const table of USER_HISTORY_TABLES) {
    assert.strictEqual(
      (fixture.rows[table] ?? []).length,
      0,
      `per-run fixture read the user's lifetime ${table} history`
    );
    assert(
      !fixture.table_order.includes(table as never),
      `per-run fixture restore scope still replaces the user's ${table} rows`
    );
  }
  // A base-image history row that cascades from User (onDelete: Cascade).
  await prisma.cookieBundle.create({
    data: { userId: seed.userId, authRealm: 'example.com', browserSource: 'chrome' },
  });
  const before = await userHistoryCounts(seed);
  await restoreFixture(jsonRoundTrip(fixture) as ScopedDbFixture);
  assert.deepStrictEqual(
    await userHistoryCounts(seed),
    before,
    "restoring a run fixture must leave the user's lifetime history to the base image"
  );
}

async function userHistoryCounts(seed: RunSeed) {
  return {
    people: await prisma.person.count({ where: { userId: seed.userId } }),
    messages: await prisma.messageRecord.count({ where: { personId: seed.personId } }),
    cookies: await prisma.cookie.count({ where: { userId: seed.userId } }),
    cookieBundles: await prisma.cookieBundle.count({ where: { userId: seed.userId } }),
  };
}

type PlanNode = { 'Index Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] };

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

export async function testFinalizeDeleteSeeksByRoot(seed: RunSeed): Promise<void> {
  const nodes = await prisma.$transaction(async (tx) => {
    // Force the planner to show which index (if any) can seek this predicate;
    // a tiny test table would otherwise always pick a sequential scan.
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    // A heavy user's history spread over many runs (rolled back with the
    // transaction), so the planner compares indexes on realistic statistics.
    await tx.$executeRaw`
      INSERT INTO "AgentTrajectorySearch" (
        "messageId", "userId", "rootAgentId", "agentId", surface, role, "createdAt",
        "searchText", "archivePath", "traceKind"
      )
      SELECT 'run-cost-' || ${seed.rootAgentId} || '-' || i, ${seed.userId},
             'run-cost-root-' || (i % 400), 'agent', 'WEB', 'ASSISTANT', now(),
             'history', 'db/end.fixture.json.gz.enc', 'message'
      FROM generate_series(1, 4000) AS i
    `;
    await tx.$executeRaw`ANALYZE "AgentTrajectorySearch"`;
    const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${deleteArchivedBundleRowsSql(seed.userId, seed.rootAgentId)}`
    );
    return planNodes(rows[0]['QUERY PLAN'][0].Plan);
  });
  // A btree accepts a non-leading-column condition as an Index Cond, but then
  // walks the whole index (prod: 610 MB per finalize). Only an equality on the
  // leading userId column makes rootAgentId a bounded seek.
  assert(
    nodes.some(
      (node) =>
        node['Index Name'] === 'AgentTrajectorySearch_user_root_time_idx' &&
        node['Index Cond']?.includes('"userId" =') &&
        node['Index Cond']?.includes('"rootAgentId" =')
    ),
    `finalize delete cannot seek by (userId, rootAgentId): ${JSON.stringify(nodes).slice(0, 400)}`
  );
}

function encryptedLlm(rootAgentId: string, artifactPath: string, text: string) {
  const encrypted = encryptArtifact(
    artifactPath,
    Buffer.from(
      JSON.stringify({
        root_agent_id: rootAgentId,
        agent_id: rootAgentId,
        messages: [{ role: 'assistant', content: text }],
      })
    ),
    'application/json'
  );
  assert(encrypted, 'expected test artifact encryption to be available');
  return {
    rootAgentId,
    path: artifactPath,
    ciphertextB64: encrypted.ciphertext.toString('base64'),
    metadata: encrypted.metadata,
  };
}

/**
 * A late llm/ artifact after finalization indexes that artifact alone. The
 * earlier bundle files are made unreadable: re-reading them (whole-run
 * re-index per late file, quadratic in file count) fails this case.
 */
export async function testLateLlmArtifactIndexesOnlyItself(
  baseUrl: string,
  apiKey: string,
  seed: RunSeed
): Promise<void> {
  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  const post = (route: string, body: unknown) =>
    request(`${baseUrl}/api/archive/${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const start = await post('agent-start', { agentId: seed.rootAgentId });
  assert.strictEqual(start.status, 200, JSON.stringify(start.data).slice(0, 300));
  if ((start.data as { fixture?: unknown }).fixture === null) {
    console.log('    [skipped] trace archive disabled on target backend');
    return;
  }
  const early = encryptedLlm(seed.rootAgentId, 'llm/early-dump.json.gz.enc', 'Early LLM result');
  assert.strictEqual((await post('artifact', early)).status, 200);
  const finalize = await post('agent-finalize', { rootAgentId: seed.rootAgentId });
  assert.strictEqual(finalize.status, 200, JSON.stringify(finalize.data).slice(0, 300));

  fs.writeFileSync(localObjectPath(seed.rootAgentId, early.path), Buffer.from('unreadable'));
  const late = encryptedLlm(seed.rootAgentId, 'llm/late-dump.json.gz.enc', 'Late LLM result');
  const stored = await post('artifact', late);
  assert.strictEqual(
    stored.status,
    200,
    `late llm artifact re-read the finalized bundle: ${JSON.stringify(stored.data).slice(0, 300)}`
  );
  const indexed = await prisma.agentTrajectorySearch.findMany({
    where: { userId: seed.userId, rootAgentId: seed.rootAgentId, traceKind: 'llm_context' },
    select: { searchText: true, archivePath: true },
  });
  assert(
    indexed.some((row) => row.searchText === 'Late LLM result' && row.archivePath === late.path),
    `late llm artifact was not indexed: ${JSON.stringify(indexed)}`
  );
  assert(
    indexed.some((row) => row.searchText === 'Early LLM result'),
    'indexing a late artifact must keep the finalized rows'
  );

  // A rewritten late path replaces that path's rows instead of accumulating them.
  const rewritten = encryptedLlm(seed.rootAgentId, late.path, 'Rewritten LLM result');
  assert.strictEqual((await post('artifact', rewritten)).status, 200);
  const latePathRows = await prisma.agentTrajectorySearch.findMany({
    where: { userId: seed.userId, rootAgentId: seed.rootAgentId, archivePath: late.path },
    select: { searchText: true },
  });
  assert.deepStrictEqual(
    latePathRows.map((row) => row.searchText),
    ['Rewritten LLM result'],
    'an overwritten late artifact left stale search rows'
  );
}
