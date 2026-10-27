/**
 * Blackbox (item 29): a running code session's keepalive carries the latest
 * CPU / memory / disk sample of its E2B sandbox, and the same sample goes out
 * as CODE_RESOURCES on the owning agent's realtime channel.
 *
 *   keepAliveCodeTask ── sampleSandboxResources (E2B getMetrics, mocked here)
 *     ├─ response.resources
 *     └─ broadcastCodeResources ─► POST <supabase>/realtime/v1/api/broadcast (captured)
 *
 * Unavailable: a failed or empty metrics read publishes nothing and the
 * response has no `resources`; an unmeasured resource is null (never zero).
 * A Mac session is never sampled.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { SandboxMetrics } from 'e2b';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  broadcastCodeResources,
  __flushBroadcastQueueForTests,
} from '../../providers/chat/supabaseBroadcast';
import { keepAliveCodeTask } from '../../providers/codeSessions/spawn';
import {
  RESOURCE_SAMPLE_WINDOW_MS,
  sampleSandboxResources,
  type MetricsReader,
} from '../../providers/codeSessions/sandboxResources';

config();

const GIB = 1024 ** 3;
const agentId = randomUUID();
const now = new Date('2026-10-26T18:02:15.000Z');
const originalFetch = globalThis.fetch;
const realtimeBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
const taskIds: string[] = [];

before(() => {
  // Every outbound call in this file is a realtime broadcast; capture it, send nothing.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.endsWith('/realtime/v1/api/broadcast'), `unexpected outbound call ${url}`);
    realtimeBodies.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await prisma.claudeCodeSession.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  realtimeBodies.length = 0;
});

function metric(at: string, overrides: Partial<SandboxMetrics> = {}): SandboxMetrics {
  return {
    timestamp: new Date(at),
    cpuUsedPct: 36.4,
    cpuCount: 8,
    memUsed: 11 * GIB,
    memTotal: 16 * GIB,
    memCache: GIB,
    diskUsed: 93 * GIB,
    diskTotal: 103 * GIB,
    ...overrides,
  };
}

async function e2bTask(sandboxId: string) {
  const task = await prisma.claudeCodeSession.create({
    data: { agentId, sandboxId, goal: 'resources' },
  });
  taskIds.push(task.id);
  return task;
}

function keepalive(taskId: string, read: MetricsReader, calls: string[] = []) {
  return keepAliveCodeTask(taskId, async () => undefined, {
    sample: (sandboxId) => {
      calls.push(sandboxId);
      return sampleSandboxResources(sandboxId, read, now);
    },
    publish: broadcastCodeResources,
  });
}

async function codeResourceEvents() {
  await __flushBroadcastQueueForTests();
  return realtimeBodies
    .flatMap((body) => body.messages)
    .filter((message) => message.event === 'CODE_RESOURCES');
}

test('keepalive returns and broadcasts the newest sandbox sample', async () => {
  assert.ok(process.env.SUPABASE_SERVICE_ROLE_KEY, 'broadcast needs SUPABASE_SERVICE_ROLE_KEY');
  const task = await e2bTask('sb-resources');
  const starts: Date[] = [];
  const alive = await keepalive(task.id, async (sandboxId, start) => {
    assert.equal(sandboxId, 'sb-resources');
    starts.push(start);
    return [
      metric('2026-10-26T18:01:55.000Z', { cpuUsedPct: 5 }),
      metric('2026-10-26T18:02:10.000Z'),
      metric('2026-10-26T18:02:00.000Z', { cpuUsedPct: 7 }),
    ];
  });
  const sample = {
    sampled_at: '2026-10-26T18:02:10.000Z',
    cpu: { used_pct: 36.4, cores: 8 },
    memory: { used_bytes: 11 * GIB, total_bytes: 16 * GIB },
    disk: { used_bytes: 93 * GIB, total_bytes: 103 * GIB },
  };
  assert.deepEqual(alive, {
    alive: true,
    code_session_id: null,
    awaiting_parent: null,
    resources: sample,
  });
  assert.deepEqual(starts, [new Date(now.getTime() - RESOURCE_SAMPLE_WINDOW_MS)]);

  const events = await codeResourceEvents();
  assert.equal(events.length, 1, JSON.stringify(realtimeBodies));
  assert.equal(events[0].topic, `agent:${agentId}`);
  assert.deepEqual(events[0].payload, { record: { agentId, taskId: task.id, resources: sample } });
});

test('an unmeasured resource is null, never zero', async () => {
  const task = await e2bTask('sb-resources-partial');
  const alive = await keepalive(task.id, async () => [
    metric('2026-10-26T18:02:10.000Z', { diskUsed: 0, diskTotal: 0, cpuCount: 0 }),
  ]);
  assert.deepEqual(alive.resources, {
    sampled_at: '2026-10-26T18:02:10.000Z',
    cpu: null,
    memory: { used_bytes: 11 * GIB, total_bytes: 16 * GIB },
    disk: null,
  });
  assert.equal((await codeResourceEvents()).length, 1);
});

test('unavailable: a failed or empty metrics read sends no sample', async () => {
  const task = await e2bTask('sb-resources-unavailable');
  const failed = await keepalive(task.id, async () => {
    throw new Error('E2B 502');
  });
  const empty = await keepalive(task.id, async () => []);
  const unusable = await keepalive(task.id, async () => [
    metric('2026-10-26T18:02:10.000Z', { cpuCount: 0, memTotal: 0, diskTotal: 0 }),
  ]);
  for (const response of [failed, empty, unusable]) {
    assert.deepEqual(response, { alive: true, code_session_id: null, awaiting_parent: null });
  }
  assert.deepEqual(await codeResourceEvents(), []);
});

test('a Mac session is never sampled', async () => {
  const task = await e2bTask(`local-claude-code-${randomUUID()}`);
  const calls: string[] = [];
  const alive = await keepalive(task.id, async () => [metric(now.toISOString())], calls);
  assert.equal(alive.alive, true);
  assert.equal(alive.resources, undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(await codeResourceEvents(), []);
});
