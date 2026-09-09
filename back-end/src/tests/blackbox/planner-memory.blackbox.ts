#!/usr/bin/env tsx
/**
 * Planner memory blackbox: the history table is written by archive finalize
 * (never drifts from R2), searchable by goal with the visibility rules, and
 * caches the compressed critical path with no TTL.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { tokenizePlannerMemoryGoal } from '../../providers/plannerMemoryStore';
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
        lexical_coverage: number;
        trgm_similarity: number;
      }>;
    }
  ).candidates;
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
        }
      )
    );

    results.push(
      await runTest(
        're-finalizing the same root is idempotent (one row, outcome updated)',
        async () => {
          await finalize(s.benchmarkRootId, {
            benchmarkTaskName: TASK,
            benchmarkPassed: false,
            benchmarkStatus: 'FAILED',
            failureReason: 'second verdict',
          });
          const rows = await prisma.plannerMemory.findMany({ where: { id: s.benchmarkRootId } });
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0].passed, false);
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
        const own = await search({
          goal: `Book a table for two at Nopa on Friday ${RUN_ID}`,
          user_id: s.userId,
        });
        assert(
          own.some((c) => c.id === s.privateRootId),
          'own private run must be retrievable'
        );
        const foreign = await search({
          goal: `Renew my passport downtown ${RUN_ID}`,
          user_id: s.userId,
        });
        assert(
          !foreign.some((c) => c.id === s.otherPrivateRootId),
          "another user's private run must never surface"
        );
        const shared = await search({
          goal: `Blue Bottle shakerato pickup Ferry Building ${RUN_ID}`,
          user_id: s.otherUserId,
        });
        assert(
          shared.some((c) => c.id === s.benchmarkRootId),
          'benchmark runs are shared corpus'
        );
      })
    );

    results.push(
      await runTest(
        'candidate generation preserves a coverage-perfect constrained goal ahead of 30 closer partials',
        async () => {
          const desiredId = randomUUID();
          const distractorIds = Array.from({ length: 30 }, () => randomUUID());
          const query = `Reserve an accessible lakeside cabin for two near Tahoe with a sauna ${RUN_ID}`;
          try {
            await prisma.plannerMemory.create({
              data: {
                id: desiredId,
                goal: `${query}\n\nOperational constraints: keep one browser session, verify live availability, stop before payment, and return the cancellation terms.`,
                goalTokens: tokenizePlannerMemoryGoal(
                  `${query}\n\nOperational constraints: keep one browser session, verify live availability, stop before payment, and return the cancellation terms.`
                ),
                benchmarkTaskName: TASK,
                rootStatus: 'COMPLETED',
                passed: true,
                worldModelMode: 'real',
              },
            });
            await prisma.plannerMemory.createMany({
              data: distractorIds.map((id, index) => {
                const goal = `Reserve an accessible lakeside cabin for two near Tahoe with a spa ${RUN_ID} option ${index}`;
                return {
                  id,
                  goal,
                  goalTokens: tokenizePlannerMemoryGoal(goal),
                  benchmarkTaskName: TASK,
                  rootStatus: 'COMPLETED',
                  passed: true,
                  worldModelMode: 'real',
                };
              }),
            });
            const hits = await search({ goal: query, user_id: s.userId, limit: 20 });
            const desired = hits.find((candidate) => candidate.id === desiredId);
            assert(
              desired,
              'coverage-perfect stored goal must survive the bounded candidate query'
            );
            assert.strictEqual(desired.lexical_coverage, 1);
          } finally {
            await prisma.plannerMemory.deleteMany({
              where: { id: { in: [desiredId, ...distractorIds] } },
            });
          }
        }
      )
    );

    results.push(
      await runTest(
        'search ranks the lexically closest goal first and excludes the current run',
        async () => {
          const hits = await search({ goal: GOAL_BENCH, user_id: s.userId });
          assert(hits.length >= 1);
          // The shared local DB may hold near-identical benchmark goals (memory
          // fixtures); the seeded row is the exact goal text, so it must carry the
          // maximum trigram similarity and sit in the top 3 by lexical rank.
          const seeded = hits.find((c) => c.id === s.benchmarkRootId) as
            ((typeof hits)[number] & { trgm_similarity: number }) | undefined;
          assert(seeded, 'seeded goal must be retrieved');
          const maxTrgm = Math.max(
            ...hits.map((c) => (c as { trgm_similarity: number }).trgm_similarity)
          );
          assert(
            seeded.trgm_similarity >= maxTrgm - 1e-9,
            'exact goal text must have the top trigram similarity'
          );
          assert(
            hits.slice(0, 3).some((c) => c.id === s.benchmarkRootId),
            'seeded goal must rank in the top 3'
          );
          const excluded = await search({
            goal: GOAL_BENCH,
            user_id: s.userId,
            exclude_root_agent_id: s.benchmarkRootId,
          });
          assert(!excluded.some((c) => c.id === s.benchmarkRootId));
          const nothing = await search({ goal: `zqxjv wplmk ${randomUUID()}`, user_id: s.userId });
          assert.strictEqual(nothing.filter((c) => c.id === s.benchmarkRootId).length, 0);
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
      await runTest('stats count the corpus (rows, compressed, passed, tasks)', async () => {
        const res = await request(`${BASE_URL}/api/planner-memory/stats`, {
          headers: internalHeaders,
        });
        assert.strictEqual(res.status, 200);
        const stats = res.data as Record<string, number>;
        assert(stats.total >= 3);
        assert(stats.compressed >= 1);
        assert(stats.passed >= 1);
        assert(stats.benchmark >= 1);
        assert(stats.distinct_tasks >= 1);
      })
    );

    results.push(
      await runTest('writes are internal-only; unauthenticated calls are rejected', async () => {
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
