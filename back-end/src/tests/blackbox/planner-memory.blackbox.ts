#!/usr/bin/env tsx
/* eslint-disable max-lines */
/**
 * Planner memory blackbox: the history table is written by archive finalize
 * (never drifts from R2), embedded for semantic search (voyage-4 goal vector,
 * pgvector cosine), searchable with the visibility rules, and caches
 * the compressed critical path with no TTL.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import { prisma } from '../../providers/database';
import {
  PLANNER_MEMORY_EMBEDDING_DIM,
  PLANNER_MEMORY_INDEX_VERSION,
  embedTexts,
  plannerMemoryGoalHash,
  toVectorLiteral,
  writePlannerMemoryEmbedding,
} from '../../providers/plannerMemoryEmbedding';
import { retryWithBackoff } from '../../providers/retry';
import { upsertPlannerMemoryFromRun } from '../../providers/plannerMemoryStore';
import { readArchivedArtifact } from '../../providers/traceArchive';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const TASK = `planner-memory-blackbox-${RUN_ID}`;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface Seed {
  userId: string;
  otherUserId: string;
  benchmarkRootId: string;
  privateRootId: string;
  otherPrivateRootId: string;
}

const GOAL_BENCH = `Order a 16oz iced vanilla bean shakerato with oat milk for pickup from Blue Bottle Coffee at the Ferry Building ${RUN_ID}`;
const GOAL_PRIVATE = `Book a table for two at Nopa in San Francisco on Friday at 7pm ${RUN_ID}`;
const GOAL_OTHER = `Renew my passport at the downtown post office ${RUN_ID}`;

async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

const internalHeaders = { 'X-API-Key': API_KEY };

function userToken(userId: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  assert(secret && supabaseUrl, 'SUPABASE_JWT_SECRET and SUPABASE_URL are required');
  return jwt.sign({ sub: userId }, secret, {
    algorithm: 'HS256',
    issuer: `${supabaseUrl}/auth/v1`,
    expiresIn: '5m',
  });
}

async function seedAgent(userId: string, goal: string, status: string): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId,
      goal,
      status: status as never,
      title: goal.slice(0, 40),
      model: 'rose-labs/rose-1-ultra',
    },
  });
  await prisma.message.create({
    data: { agentId: id, role: 'USER', text: goal, metadata: {} },
  });
  await prisma.message.create({
    data: {
      agentId: id,
      role: 'ASSISTANT',
      text: '',
      metadata: {
        tool_calls: [
          {
            tool: 'spawn_agent',
            tool_call_id: `call_${id.slice(0, 8)}`,
            type: 'browser',
            start_url: 'https://order.online/store/blue-bottle-coffee-2188540?pickup=true',
            goal: 'Order and stop at payment',
          },
        ],
      },
    },
  });
  await prisma.message.create({
    data: {
      agentId: id,
      role: 'TOOL',
      text: 'Payment card requested ($12.25)',
      metadata: {
        toolName: 'spawn_browser_agent',
        toolStatus: 'FINISHED',
        toolCallId: `call_${id.slice(0, 8)}`,
        title: 'Payment card requested ($12.25)',
      },
    },
  });
  return id;
}

async function seed(): Promise<Seed> {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  await prisma.user.createMany({
    data: [
      { userId, name: 'Planner Memory Fixture User' },
      { userId: otherUserId, name: 'Unrelated User' },
    ],
    skipDuplicates: true,
  });
  return {
    userId,
    otherUserId,
    benchmarkRootId: await seedAgent(userId, GOAL_BENCH, 'COMPLETED'),
    privateRootId: await seedAgent(userId, GOAL_PRIVATE, 'COMPLETED'),
    otherPrivateRootId: await seedAgent(otherUserId, GOAL_OTHER, 'COMPLETED'),
  };
}

async function cleanup(s: Seed): Promise<void> {
  const ids = [s.benchmarkRootId, s.privateRootId, s.otherPrivateRootId];
  await prisma.plannerMemory.deleteMany({ where: { id: { in: ids } } });
  await prisma.message.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.traceArchiveFinalization.deleteMany({ where: { rootAgentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { userId: { in: [s.userId, s.otherUserId] } } });
}

async function finalize(rootAgentId: string, extra: Record<string, unknown> = {}) {
  const res = await request(`${BASE_URL}/api/archive/agent-finalize`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({ rootAgentId, force: true, ...extra }),
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data).slice(0, 300));
  return res.data as { manifest: { ref: string } | null };
}

async function search(
  body: Record<string, unknown>,
  headers: Record<string, string> = internalHeaders
) {
  const res = await request(`${BASE_URL}/api/planner-memory/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.data).slice(0, 300));
  return (
    res.data as {
      candidates: Array<{
        id: string;
        goal: string;
        critical_path: unknown;
        similarity: number;
      }>;
    }
  ).candidates;
}

/** Finalize embeds detached; wait until the row's current-model embedding lands. */
async function waitEmbedded(id: string, timeoutMs = 60_000): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 500));
  const model = await retryWithBackoff(
    async () =>
      (
        await prisma.plannerMemoryEmbedding.findUnique({
          where: { plannerMemoryId: id },
          select: { model: true },
        })
      )?.model ?? null,
    {
      maxRetries: attempts,
      fixedDelays: Array.from({ length: attempts }, () => 500),
      shouldRetryResult: (value) => value !== PLANNER_MEMORY_INDEX_VERSION,
      component: 'waitEmbedded',
    }
  );
  assert.strictEqual(model, PLANNER_MEMORY_INDEX_VERSION, `planner memory ${id} was not embedded`);
}

async function putFixture(id: string, body: Record<string, unknown>) {
  const put = await request(`${BASE_URL}/api/planner-memory/${id}`, {
    method: 'PUT',
    headers: internalHeaders,
    body: JSON.stringify({
      benchmark_task_name: TASK,
      passed: true,
      root_status: 'COMPLETED',
      ...body,
    }),
  });
  assert.strictEqual(put.status, 200, JSON.stringify(put.data).slice(0, 300));
}

export async function runTests(): Promise<boolean> {
  const s = await seed();
  const results: TestResult[] = [];
  try {
    results.push(
      await runTest(
        'finalize writes the history row in lockstep with the R2 manifest',
        async () => {
          const out = await finalize(s.benchmarkRootId, {
            benchmarkTaskName: TASK,
            benchmarkPassed: true,
            benchmarkStatus: 'COMPLETED',
          });
          assert(out.manifest?.ref, 'archive manifest must be written');
          const stored = await readArchivedArtifact({
            rootAgentId: s.benchmarkRootId,
            objectPath: 'manifest.json.gz.enc',
          });
          assert(stored, 'manifest artifact must be readable');
          const row = await prisma.plannerMemory.findUnique({ where: { id: s.benchmarkRootId } });
          assert(row, 'PlannerMemory row must exist right after finalize');
          assert.strictEqual(row.goal, GOAL_BENCH);
          assert.strictEqual(row.benchmarkTaskName, TASK);
          assert.strictEqual(row.passed, true);
          assert.strictEqual(row.rootStatus, 'COMPLETED');
          assert.strictEqual(row.userId, s.userId);
          assert.strictEqual(row.criticalPath, null);
          await waitEmbedded(s.benchmarkRootId);
          const embedding = await prisma.plannerMemoryEmbedding.findUnique({
            where: { plannerMemoryId: s.benchmarkRootId },
          });
          assert(embedding, 'finalize must schedule the retrieval embedding');
          assert.strictEqual(embedding.goalHash, plannerMemoryGoalHash(GOAL_BENCH));
        }
      )
    );

    results.push(
      await runTest(
        're-finalizing the same root is idempotent (one row, outcome updated)',
        async () => {
          await prisma.plannerMemory.update({
            where: { id: s.benchmarkRootId },
            data: {
              criticalPath: { outcome: 'passed', terminal_condition: 'stale' },
              compressorVersion: 'stale-version',
              compressedAt: new Date(),
              compressionLeaseId: randomUUID(),
              compressionLeaseUntil: new Date(Date.now() + 60_000),
            },
          });
          await finalize(s.benchmarkRootId, {
            benchmarkTaskName: TASK,
            benchmarkPassed: false,
            benchmarkStatus: 'FAILED',
            failureReason: 'second verdict',
          });
          const rows = await prisma.plannerMemory.findMany({ where: { id: s.benchmarkRootId } });
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].passed, false);
          assert.strictEqual(rows[0].criticalPath, null);
          assert.strictEqual(rows[0].compressorVersion, null);
          assert.strictEqual(rows[0].compressedAt, null);
          assert.strictEqual(rows[0].compressionLeaseId, null);
          assert.strictEqual(rows[0].compressionLeaseUntil, null);
          // Restore the passing verdict for the retrieval tests below.
          await finalize(s.benchmarkRootId, {
            benchmarkTaskName: TASK,
            benchmarkPassed: true,
            benchmarkStatus: 'COMPLETED',
          });
        }
      )
    );

    results.push(
      await runTest('private runs are rows too, visible only to their own user', async () => {
        await finalize(s.privateRootId);
        await finalize(s.otherPrivateRootId);
        await waitEmbedded(s.privateRootId);
        await waitEmbedded(s.otherPrivateRootId);
        // Isolate requested visibility scopes from semantic recall; paraphrase
        // retrieval and the similarity floor have dedicated cases below.
        const own = await search({
          goal: GOAL_PRIVATE,
          user_id: s.userId,
        });
        assert(
          own.some((c) => c.id === s.privateRootId),
          'own private run must be retrievable'
        );
        const foreign = await search({
          goal: GOAL_OTHER,
          user_id: s.userId,
        });
        assert(
          !foreign.some((c) => c.id === s.otherPrivateRootId),
          "another user's private run must never surface"
        );
        const ownBench = await search({ goal: GOAL_BENCH, user_id: s.userId });
        assert(
          ownBench.some((c) => c.id === s.benchmarkRootId),
          'a benchmark identity must still retrieve its own benchmark runs'
        );
      })
    );

    results.push(
      await runTest(
        'an owned benchmark run never reaches another user; ownerless fixtures are shared',
        async () => {
          // Prod benchmark runs execute on a real account's prod-sync data, so
          // their bundles (contacts, messages) belong to that account.
          const foreignBench = await search({ goal: GOAL_BENCH, user_id: s.otherUserId });
          assert(
            !foreignBench.some((c) => c.id === s.benchmarkRootId),
            "another user's benchmark run must never surface"
          );
          const foreignRead = await request(`${BASE_URL}/api/planner-memory/${s.benchmarkRootId}`, {
            headers: { Authorization: `Bearer ${userToken(s.otherUserId)}` },
          });
          assert.strictEqual(foreignRead.status, 404, 'non-owner GET must not read the row');
          const ownerRead = await request(`${BASE_URL}/api/planner-memory/${s.benchmarkRootId}`, {
            headers: { Authorization: `Bearer ${userToken(s.userId)}` },
          });
          assert.strictEqual(ownerRead.status, 200, 'owner GET reads its own row');

          // Curated fixtures are loaded ownerless through the internal PUT.
          const fixtureId = randomUUID();
          const fixtureGoal = `Pick up my dry cleaning on Valencia Street before 6pm ${RUN_ID}`;
          try {
            await putFixture(fixtureId, { goal: fixtureGoal });
            await waitEmbedded(fixtureId);
            const shared = await search({ goal: fixtureGoal, user_id: s.otherUserId });
            assert(
              shared.some((c) => c.id === fixtureId),
              'ownerless benchmark fixtures are shared corpus'
            );
            const fixtureRead = await request(`${BASE_URL}/api/planner-memory/${fixtureId}`, {
              headers: { Authorization: `Bearer ${userToken(s.otherUserId)}` },
            });
            assert.strictEqual(fixtureRead.status, 200, 'any user may read a shared fixture');
          } finally {
            await prisma.plannerMemory.deleteMany({ where: { id: fixtureId } });
          }
        }
      )
    );

    results.push(
      await runTest(
        'a paraphrase with no shared distinctive words retrieves the run semantically',
        async () => {
          const id = randomUUID();
          const unrelatedId = randomUUID();
          try {
            await putFixture(id, {
              goal: `Use one browser agent to reserve an accessible lakeside cabin for two near Lake Tahoe with a sauna for next weekend. Stop before payment. Run ${RUN_ID}`,
            });
            await putFixture(unrelatedId, {
              goal: `Translate my resume into Spanish and keep the formatting identical. Run ${RUN_ID}`,
            });
            const paraphrase =
              'find me a wheelchair friendly lodge by the water up in tahoe, 2 people, has a steam room';
            // Ranking check on the search layer (below the production cutoff).
            const hits = await search({
              goal: paraphrase,
              user_id: s.userId,
              min_similarity: -1,
              limit: 50,
            });
            const hit = hits.find((c) => c.id === id);
            assert(hit, 'paraphrased request must retrieve the semantically matching run');
            // The API returns only the top 20 by default, even with no similarity floor.
            // Score the unrelated fixture directly so corpus growth cannot hide it past
            // that limit while the semantic gap remains checked.
            const [queryVector] = await embedTexts([paraphrase]);
            const unrelatedScores = await prisma.$queryRaw<Array<{ similarity: number }>>`
              SELECT (1 - ("goalVector" <=> ${toVectorLiteral(queryVector)}::vector))::float8 AS similarity
              FROM "PlannerMemoryEmbedding"
              WHERE "plannerMemoryId" = ${unrelatedId}
            `;
            assert.strictEqual(unrelatedScores.length, 1, 'unrelated fixture must be embedded');
            const unrelatedSimilarity = unrelatedScores[0].similarity;
            assert(
              hit.similarity > unrelatedSimilarity + 0.1,
              `semantic match ${hit.similarity} must clearly outrank unrelated ${unrelatedSimilarity}`
            );
            // Default floor is the production cutoff (0.70): the unrelated run never surfaces.
            const defaults = await search({ goal: paraphrase, user_id: s.userId });
            assert(
              defaults.every((c) => c.similarity >= 0.7),
              'default floor must be 0.70'
            );
            assert(
              !defaults.some((c) => c.id === unrelatedId),
              'unrelated run is below the cutoff'
            );
          } finally {
            await prisma.plannerMemory.deleteMany({ where: { id: { in: [id, unrelatedId] } } });
          }
        }
      )
    );

    results.push(
      await runTest(
        'search ranks the exact goal first, excludes the current run, and applies the floor',
        async () => {
          const hits = await search({ goal: GOAL_BENCH, user_id: s.userId });
          assert(hits.length >= 1);
          assert.strictEqual(hits[0].id, s.benchmarkRootId, 'exact goal must rank first');
          assert(hits[0].similarity > 0.9, `exact goal similarity ${hits[0].similarity}`);
          for (let i = 1; i < hits.length; i += 1) {
            assert(hits[i - 1].similarity >= hits[i].similarity, 'hits must be similarity-ordered');
          }
          const excluded = await search({
            goal: GOAL_BENCH,
            user_id: s.userId,
            exclude_root_agent_id: s.benchmarkRootId,
          });
          assert(!excluded.some((c) => c.id === s.benchmarkRootId));
          const strictFloor = await search({
            goal: 'What is the capital of Mongolia and what is its population?',
            user_id: s.userId,
            min_similarity: 0.95,
          });
          assert(
            !strictFloor.some((c) => c.id === s.benchmarkRootId),
            'rows below min_similarity must not be returned'
          );
        }
      )
    );

    results.push(
      await runTest(
        'embedding is idempotent, re-embeds on goal change, and cascades on delete',
        async () => {
          const id = randomUUID();
          try {
            await putFixture(id, { goal: `Order a USB-C cable on DoorDash ${RUN_ID}` });
            const first = await prisma.plannerMemoryEmbedding.findUnique({
              where: { plannerMemoryId: id },
            });
            assert(first, 'PUT must embed synchronously');
            await putFixture(id, { goal: `Order a USB-C cable on DoorDash ${RUN_ID}` });
            const same = await prisma.plannerMemoryEmbedding.findUnique({
              where: { plannerMemoryId: id },
            });
            assert(same);
            assert.strictEqual(
              same.updatedAt.getTime(),
              first.updatedAt.getTime(),
              'unchanged goal must not re-embed'
            );
            await putFixture(id, { goal: `Book a haircut near the Ferry Building ${RUN_ID}` });
            const changed = await prisma.plannerMemoryEmbedding.findUnique({
              where: { plannerMemoryId: id },
            });
            assert(changed);
            assert.notStrictEqual(changed.goalHash, first.goalHash, 'goal change must re-embed');
            // Finalize path (no synchronous embed): a changed goal drops the stale vector.
            await upsertPlannerMemoryFromRun({
              rootAgentId: id,
              userId: null,
              goal: `Renew my passport downtown ${RUN_ID}`,
              benchmarkTaskName: TASK,
            });
            const stale = await prisma.plannerMemoryEmbedding.findUnique({
              where: { plannerMemoryId: id },
            });
            assert.strictEqual(stale, null, 'a re-finalized goal must not keep its old vector');
            await prisma.plannerMemory.delete({ where: { id } });
            const gone = await prisma.plannerMemoryEmbedding.findUnique({
              where: { plannerMemoryId: id },
            });
            assert.strictEqual(gone, null, 'embedding must cascade with its memory row');
          } finally {
            await prisma.plannerMemory.deleteMany({ where: { id } });
          }
        }
      )
    );

    results.push(
      await runTest(
        'a late detached embed write never rewrites a current goal or restores a superseded one',
        async () => {
          const id = randomUUID();
          const original = `Order a USB-C cable on DoorDash ${RUN_ID}`;
          // A drain that read the row before the synchronous embed (or a goal change) landed.
          const lateVector = Array.from({ length: PLANNER_MEMORY_EMBEDDING_DIM }, (_, i) =>
            i === 0 ? 1 : 0
          );
          const embeddingOf = () =>
            prisma.plannerMemoryEmbedding.findUniqueOrThrow({ where: { plannerMemoryId: id } });
          try {
            await putFixture(id, { goal: original });
            const current = await embeddingOf();
            assert.strictEqual(
              await writePlannerMemoryEmbedding(id, original, lateVector),
              'current'
            );
            assert.strictEqual(
              (await embeddingOf()).updatedAt.getTime(),
              current.updatedAt.getTime(),
              'a late write for an unchanged goal must not re-embed it'
            );
            const renamed = `Book a haircut near the Ferry Building ${RUN_ID}`;
            await putFixture(id, { goal: renamed });
            const replaced = await embeddingOf();
            assert.strictEqual(
              await writePlannerMemoryEmbedding(id, original, lateVector),
              'superseded'
            );
            const after = await embeddingOf();
            assert.strictEqual(
              after.goalHash,
              plannerMemoryGoalHash(renamed),
              'a late write must not restore the superseded goal'
            );
            assert.strictEqual(after.updatedAt.getTime(), replaced.updatedAt.getTime());
          } finally {
            await prisma.plannerMemory.deleteMany({ where: { id } });
          }
        }
      )
    );

    results.push(
      await runTest(
        'embed-pending (internal) drains rows whose detached embed was lost',
        async () => {
          const id = randomUUID();
          try {
            await prisma.plannerMemory.create({
              data: {
                id,
                goal: `Cancel my gym membership and confirm the date ${RUN_ID}`,
                benchmarkTaskName: TASK,
                rootStatus: 'COMPLETED',
                passed: true,
                worldModelMode: 'real',
              },
            });
            const userCall = await request(`${BASE_URL}/api/planner-memory/embed-pending`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${userToken(s.userId)}` },
              body: JSON.stringify({ limit: 1 }),
            });
            assert.strictEqual(userCall.status, 403);
            const drain = await request(`${BASE_URL}/api/planner-memory/embed-pending`, {
              method: 'POST',
              headers: internalHeaders,
              // Newest pending row first: limit 1 embeds exactly the row created above.
              body: JSON.stringify({ limit: 1 }),
            });
            assert.strictEqual(drain.status, 200, JSON.stringify(drain.data).slice(0, 300));
            assert((drain.data as { embedded: number }).embedded >= 1);
            await waitEmbedded(id, 1_000);
          } finally {
            await prisma.plannerMemory.deleteMany({ where: { id } });
          }
        }
      )
    );

    results.push(
      await runTest(
        'passed_only returns completed runs only (verdict or COMPLETED status)',
        async () => {
          const failedId = randomUUID();
          const timedOutId = randomUUID();
          try {
            for (const [id, passed, status] of [
              [failedId, false, 'COMPLETED'],
              [timedOutId, null, 'PAUSED'],
            ] as const) {
              const put = await request(`${BASE_URL}/api/planner-memory/${id}`, {
                method: 'PUT',
                headers: internalHeaders,
                body: JSON.stringify({
                  goal: `${GOAL_BENCH} variant ${id.slice(0, 6)}`,
                  benchmark_task_name: TASK,
                  passed,
                  root_status: status,
                }),
              });
              assert.strictEqual(put.status, 200);
            }
            const strict = await search({ goal: GOAL_BENCH, user_id: s.userId, passed_only: true });
            assert(
              strict.some((c) => c.id === s.benchmarkRootId),
              'benchmark pass stays retrievable'
            );
            assert(!strict.some((c) => c.id === failedId), 'failed verdict must be excluded');
            assert(!strict.some((c) => c.id === timedOutId), 'non-completed run must be excluded');
            const privateHits = await search({
              goal: `Book a table for two at Nopa on Friday ${RUN_ID}`,
              user_id: s.userId,
              passed_only: true,
            });
            assert(
              privateHits.some((c) => c.id === s.privateRootId),
              'private run with COMPLETED status and no verdict counts as completed'
            );
            const loose = await search({ goal: GOAL_BENCH, user_id: s.userId });
            assert(
              loose.some((c) => c.id === failedId),
              'without passed_only the row is still visible'
            );
          } finally {
            await prisma.plannerMemory.deleteMany({
              where: { id: { in: [failedId, timedOutId] } },
            });
          }
        }
      )
    );

    results.push(
      await runTest(
        'atomic lease elects one compressor and only its PATCH fills the TTL-free cache',
        async () => {
          const criticalPath = {
            outcome: 'passed',
            entry_points: [
              { tool: 'spawn_browser_agent', start_url: 'https://order.online/store/x' },
            ],
            critical_path: [
              { step: 1, tool: 'spawn_browser_agent', action: 'open store', result: 'menu' },
            ],
            detours: [],
            pitfalls: ['guest checkout toggle'],
            terminal_condition: 'stopped at payment approval',
            first_unmet_requirement: null,
          };
          const claims = await Promise.all(
            Array.from({ length: 100 }, () =>
              request(`${BASE_URL}/api/planner-memory/${s.benchmarkRootId}/critical-path-claim`, {
                method: 'POST',
                headers: internalHeaders,
                body: JSON.stringify({ compressor_version: 'cp-test' }),
              })
            )
          );
          assert.strictEqual(
            claims.filter((claim) => (claim.data as { claimed: boolean }).claimed).length,
            1,
            'exactly one of 100 concurrent callers must own compression'
          );
          const winner = claims.find((claim) => (claim.data as { claimed: boolean }).claimed);
          const leaseId = (winner?.data as { lease_id?: string }).lease_id;
          assert(leaseId, 'winning compression claim must carry a lease id');
          const rejected = await request(
            `${BASE_URL}/api/planner-memory/${s.benchmarkRootId}/critical-path`,
            {
              method: 'PATCH',
              headers: internalHeaders,
              body: JSON.stringify({
                critical_path: criticalPath,
                compressor_version: 'cp-test',
                lease_id: randomUUID(),
              }),
            }
          );
          assert.strictEqual(rejected.status, 409, 'a non-owner must not fill the cache');
          const patch = await request(
            `${BASE_URL}/api/planner-memory/${s.benchmarkRootId}/critical-path`,
            {
              method: 'PATCH',
              headers: internalHeaders,
              body: JSON.stringify({
                critical_path: criticalPath,
                compressor_version: 'cp-test',
                lease_id: leaseId,
              }),
            }
          );
          assert.strictEqual(patch.status, 200, JSON.stringify(patch.data).slice(0, 300));
          const hits = await search({ goal: GOAL_BENCH, user_id: s.userId });
          const hit = hits.find((c) => c.id === s.benchmarkRootId);
          assert(hit, 'row must still be retrievable');
          assert.deepStrictEqual(hit.critical_path, criticalPath);
          const cached = await request(
            `${BASE_URL}/api/planner-memory/${s.benchmarkRootId}/critical-path-claim`,
            {
              method: 'POST',
              headers: internalHeaders,
              body: JSON.stringify({ compressor_version: 'cp-test' }),
            }
          );
          assert.strictEqual((cached.data as { reason: string }).reason, 'cached');
          const missing = await request(
            `${BASE_URL}/api/planner-memory/${randomUUID()}/critical-path-claim`,
            {
              method: 'POST',
              headers: internalHeaders,
              body: JSON.stringify({ compressor_version: 'cp-test' }),
            }
          );
          assert.strictEqual(missing.status, 404);
        }
      )
    );

    results.push(
      await runTest(
        'stats count the corpus (rows, embedded, compressed, passed, tasks)',
        async () => {
          const res = await request(`${BASE_URL}/api/planner-memory/stats`, {
            headers: internalHeaders,
          });
          assert.strictEqual(res.status, 200);
          const stats = res.data as Record<string, number>;
          assert(stats.total >= 3);
          assert(stats.embedded >= 3);
          assert(stats.compressed >= 1);
          assert(stats.passed >= 1);
          assert(stats.benchmark >= 1);
          assert(stats.distinct_tasks >= 1);
        }
      )
    );

    results.push(
      await runTest(
        'stats/writes are internal-only; unauthenticated calls are rejected',
        async () => {
          const noAuth = await request(`${BASE_URL}/api/planner-memory/search`, {
            method: 'POST',
            body: JSON.stringify({ goal: GOAL_BENCH }),
          });
          assert.strictEqual(noAuth.status, 401);
          const badBody = await request(`${BASE_URL}/api/planner-memory/search`, {
            method: 'POST',
            headers: internalHeaders,
            body: JSON.stringify({ goal: '' }),
          });
          assert.strictEqual(badBody.status, 400);
          const userStats = await request(`${BASE_URL}/api/planner-memory/stats`, {
            headers: { Authorization: `Bearer ${userToken(s.userId)}` },
          });
          assert.strictEqual(userStats.status, 403);
        }
      )
    );

    results.push(
      await runTest('fixture upsert rejects scalar and array critical paths', async () => {
        for (const criticalPath of ['not-an-object', ['also', 'not', 'an', 'object']]) {
          const invalid = await request(`${BASE_URL}/api/planner-memory/${randomUUID()}`, {
            method: 'PUT',
            headers: internalHeaders,
            body: JSON.stringify({
              goal: `Invalid critical path ${RUN_ID}`,
              critical_path: criticalPath,
            }),
          });
          assert.strictEqual(invalid.status, 400);
        }
      })
    );

    results.push(
      await runTest(
        'fixture upsert (internal) creates a searchable, pre-compressed row',
        async () => {
          const id = randomUUID();
          try {
            const put = await request(`${BASE_URL}/api/planner-memory/${id}`, {
              method: 'PUT',
              headers: internalHeaders,
              body: JSON.stringify({
                goal: `Fixture goal about buying a USB-C cable on DoorDash ${RUN_ID}`,
                benchmark_task_name: TASK,
                passed: true,
                root_status: 'COMPLETED',
                critical_path: { outcome: 'passed', terminal_condition: 'done' },
                compressor_version: 'fixture',
              }),
            });
            assert.strictEqual(put.status, 200, JSON.stringify(put.data).slice(0, 300));
            const hits = await search({ goal: `buy a USB-C cable on DoorDash ${RUN_ID}` });
            const hit = hits.find((c) => c.id === id);
            assert(hit, 'fixture row must be retrievable');
            assert.deepStrictEqual(hit.critical_path, {
              outcome: 'passed',
              terminal_condition: 'done',
            });
            const del = await request(`${BASE_URL}/api/planner-memory/${id}`, {
              method: 'DELETE',
              headers: internalHeaders,
            });
            assert.strictEqual(del.status, 200);
            assert.strictEqual((del.data as { deleted: boolean }).deleted, true);
            const gone = await search({ goal: `buy a USB-C cable on DoorDash ${RUN_ID}` });
            assert(!gone.some((c) => c.id === id), 'deleted fixture row must not be retrievable');
          } finally {
            await prisma.plannerMemory.deleteMany({ where: { id } });
          }
        }
      )
    );
  } finally {
    await cleanup(s);
  }

  let allPassed = true;
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(
      `${icon} ${result.name} (${result.duration}ms)${result.error ? `\n   ${result.error}` : ''}`
    );
    if (!result.passed) allPassed = false;
  }
  return allPassed;
}

runTests()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
