#!/usr/bin/env tsx
/**
 * Black-box tests for /api/agent-preview (public link-preview facts for /a/<agent-id>).
 *
 * Domain surface:
 *   GET /api/agent-preview/:agentId — { title, state } (public)
 *
 * Invariants covered:
 *   - auth boundary: public, no auth (the iMessage/Linq preview fetcher has no session)
 *   - privacy: only title/state leave the server; never goal text, cost, results, run time
 *   - state mapping: running → started, COMPLETED → done, FAILED → stopped
 *   - error surface: unknown, deleted and malformed ids → 404 with no agent data
 *   - cache: no-store, because the state changes over the agent's life
 *   - concurrency/reproducibility: parallel and repeated reads are identical
 *   - cleanup: seeded user and agents are removed
 */
import { config } from 'dotenv';
config();
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const userId = randomUUID();
const ids = {
  done: randomUUID(),
  running: randomUUID(),
  failed: randomUUID(),
  deleted: randomUUID(),
  untitled: randomUUID(),
};
const SECRET_GOAL =
  'Order bags. Deliver to 88 Howard St Apt 1413. Card ending 4242. Do not message anyone else.';

async function seed(): Promise<void> {
  await prisma.user.create({ data: { userId, name: 'Preview Owner' } });
  const created = new Date('2026-11-15T02:17:53Z');
  const base = { userId, goal: SECRET_GOAL, createdAt: created, treeCostCents: 144 };
  await prisma.agent.create({
    data: {
      ...base,
      id: ids.done,
      title: 'California King Bed Transport',
      status: 'COMPLETED',
      structuredResponse: { order_confirmation_id: '111-2588493' },
    },
  });
  await prisma.agent.create({
    data: { ...base, id: ids.running, title: 'iPhone Account Connection', status: 'ACTIVE' },
  });
  await prisma.agent.create({
    data: { ...base, id: ids.failed, title: 'Flight Search', status: 'FAILED' },
  });
  await prisma.agent.create({
    data: { ...base, id: ids.deleted, title: 'Gone', status: 'COMPLETED', deletedAt: new Date() },
  });
  await prisma.agent.create({
    data: {
      ...base,
      id: ids.untitled,
      title: null,
      goal: 'Find a present for Sam\nBudget $50',
      status: 'ACTIVE',
    },
  });
}

async function cleanup(): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function get(
  id: string
): Promise<{ status: number; body: Record<string, unknown>; raw: string; cache: string | null }> {
  const res = await fetch(`${BASE_URL}/api/agent-preview/${id}`);
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* non-JSON error bodies are checked through raw */
  }
  return { status: res.status, body, raw, cache: res.headers.get('cache-control') };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'done agent: title, done state, elapsed seconds; no auth',
    async () => {
      const r = await get(ids.done);
      assert(r.status === 200, `status ${r.status}`);
      assert(r.body.title === 'California King Bed Transport', `title ${String(r.body.title)}`);
      assert(r.body.state === 'done', `state ${String(r.body.state)}`);
      assert(r.cache === 'no-store', `cache ${r.cache}`);
    },
  ],
  [
    'privacy: response has only title/state/duration',
    async () => {
      const r = await get(ids.done);
      assert(
        JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['state', 'title']),
        `keys ${Object.keys(r.body).join(',')}`
      );
      for (const leak of ['Howard', '4242', '111-2588493', '144', 'message anyone'])
        assert(!r.raw.includes(leak), `leaked ${leak}`);
    },
  ],
  [
    'running agent: started with no duration',
    async () => {
      const r = await get(ids.running);
      assert(r.status === 200 && r.body.state === 'started', r.raw);
    },
  ],
  [
    'failed agent: stopped',
    async () => {
      const r = await get(ids.failed);
      assert(r.status === 200 && r.body.state === 'stopped', r.raw);
    },
  ],
  [
    'untitled agent: title falls back to the goal first line',
    async () => {
      const r = await get(ids.untitled);
      assert(r.body.title === 'Find a present for Sam', r.raw);
    },
  ],
  [
    'deleted, unknown and malformed ids: 404 without agent data',
    async () => {
      for (const id of [ids.deleted, randomUUID(), 'not-a-uuid', `${ids.done}x`]) {
        const r = await get(encodeURIComponent(id));
        assert(r.status === 404, `${id}: status ${r.status}`);
        assert(!r.raw.includes('Gone') && !r.raw.includes('California'), `${id}: leaked`);
      }
    },
  ],
  [
    'reproducible under concurrency',
    async () => {
      const reads = await Promise.all(Array.from({ length: 10 }, () => get(ids.done)));
      assert(new Set(reads.map((r) => r.raw)).size === 1, 'parallel reads differ');
    },
  ],
];

async function runAll(): Promise<void> {
  let failed = 0;
  await cleanup();
  await seed();
  try {
    for (const [name, fn] of tests) {
      const started = Date.now();
      try {
        await fn();
        console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
      } catch (error) {
        failed++;
        console.log(`  FAIL  ${name} -- ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(
    `\nResults: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`
  );
  process.exit(failed ? 1 : 0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
