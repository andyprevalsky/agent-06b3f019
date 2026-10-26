#!/usr/bin/env tsx
/**
 * Black-box tests for DEMO cache cross-user isolation (live server + local DB).
 *
 * The shared DEMO store is keyed by goal text and trace hash, never by owner,
 * so any reader of a DEMO prompt replays what any writer stored there. These
 * cases pin that only recorder accounts write it, while any user still replays:
 *  - agent-flag writeEnabled is false for a non-recorder DEMO run
 *  - code-agent proxies route a non-recorder session replay-only and never
 *    record its live misses
 *
 * Usage: npx tsx src/tests/blackbox/demo-cache-isolation.blackbox.ts
 */

import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { anthropicSlotKey, resolveAnthropic } from '../../providers/anthropicProxyCore';
import { codeAgentSlotKey, resolveCodex } from '../../providers/codexProxyCore';
import {
  buildFastModeAnthropicEnv,
  buildFastModeCodexEnv,
} from '../../providers/codeAgentFastModeEnv';
import { resolveFastModeWriteEnabled } from '../../providers/demoCacheAccountPolicy';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.TEST_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const headers = {
  'X-API-Key': API_KEY,
  'X-User-Id': USER_ID,
  'Content-Type': 'application/json',
};

type JsonObject = Record<string, unknown>;

async function post(path: string, body: unknown): Promise<{ status: number; json: JsonObject }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as JsonObject;
  return { status: res.status, json };
}

async function main(): Promise<void> {
  const goalHash = `bbiso${Date.now().toString(16)}`;

  await test('only recorder accounts write the shared DEMO namespace', async () => {
    // The DEMO namespace is keyed by goal text alone, so every reader of a DEMO
    // prompt replays whatever any writer stored there. A non-recorder user may
    // replay the recording but must never add their own live outputs to it.
    const databaseUrl = process.env.DATABASE_URL;
    assert(databaseUrl, 'DATABASE_URL must point at the runner database');
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const demoGoal =
      'DEMO fleet concurrency probe alpha: call attempt_completion with result READY and stop. Do not use other tools.';
    const otherUserId = randomUUID();
    const agentIds = { recorder: randomUUID(), other: randomUUID(), otherPrivate: randomUUID() };
    try {
      await prisma.user.create({ data: { userId: otherUserId, name: 'DEMO isolation user' } });
      const rows = [
        { id: agentIds.recorder, userId: USER_ID, goal: demoGoal },
        { id: agentIds.other, userId: otherUserId, goal: demoGoal },
        { id: agentIds.otherPrivate, userId: otherUserId, goal: `private goal ${Date.now()}` },
      ];
      for (const row of rows) {
        await prisma.agent.create({
          data: { ...row, status: 'COMPLETED', title: 'demo isolation', model: 'rose-1-ultra' },
        });
      }
      const flag = async (agentId: string) =>
        (await post('/api/fast-cache/agent-flag', { agentId })).json;

      const recorder = await flag(agentIds.recorder);
      assert(recorder.enabled === true, 'recorder DEMO run must replay');
      assert(recorder.writeEnabled === true, 'recorder DEMO run must still record');

      const other = await flag(agentIds.other);
      assert(other.enabled === true, 'any user running a DEMO prompt still replays the demo');
      assert(other.writeEnabled === false, "a non-recorder's live outputs must never be stored");
      assert(
        resolveFastModeWriteEnabled(other.enabled === true, otherUserId) === false,
        'code-agent proxy must not record a non-recorder DEMO session'
      );
      assert(
        resolveFastModeWriteEnabled(true, USER_ID) === true,
        'code-agent proxy still records a recorder DEMO session'
      );

      const otherPrivate = await flag(agentIds.otherPrivate);
      assert(otherPrivate.enabled === false, 'non-DEMO goals never read the shared store');
      assert(otherPrivate.writeEnabled === false, 'non-DEMO goals never write the shared store');
    } finally {
      await prisma.agent.deleteMany({ where: { id: { in: Object.values(agentIds) } } });
      await prisma.user.deleteMany({ where: { userId: otherUserId } });
      await prisma.$disconnect();
    }
  });

  await test('code-agent proxies replay but never record a non-recorder DEMO session', async () => {
    const nonRecorderWrite = resolveFastModeWriteEnabled(true, randomUUID());
    const codexUrl = buildFastModeCodexEnv(
      'demo goal',
      true,
      'https://api.example.com/codex-proxy',
      nonRecorderWrite
    ).CODEX_FAST_MODE_PROXY_URL;
    assert(/\/replay-only$/.test(codexUrl ?? ''), `codex non-recorder URL ${codexUrl}`);
    const anthropicUrl = buildFastModeAnthropicEnv(
      'demo goal',
      true,
      'https://api.example.com/anthropic-proxy',
      nonRecorderWrite
    ).ANTHROPIC_BASE_URL;
    assert(/\/replay-only$/.test(anthropicUrl ?? ''), `anthropic non-recorder URL ${anthropicUrl}`);
    const recorderUrl = buildFastModeCodexEnv(
      'demo goal',
      true,
      'https://api.example.com/codex-proxy',
      resolveFastModeWriteEnabled(true, USER_ID)
    ).CODEX_FAST_MODE_PROXY_URL;
    assert(/\/[0-9a-f]{16}$/.test(recorderUrl ?? ''), `codex recorder URL ${recorderUrl}`);

    // A live miss on the replay-only route is served but never stored.
    const writes: string[] = [];
    const deps = {
      cacheGet: async () => ({ hit: false, value: null, blobPath: null }),
      cacheSet: async (args: { key: string }) => {
        writes.push(args.key);
      },
    };
    const upstream = { status: 200, contentType: 'text/event-stream', body: 'data: {}\n\n' };
    const missTrace = `${goalHash}:replay-only-miss`;
    await resolveCodex(
      missTrace,
      'POST',
      '/backend-api/codex/responses',
      { model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] },
      {},
      { ...deps, fetchUpstream: async () => upstream },
      true,
      { sessionId: 'non-recorder', writeEnabled: false }
    );
    await resolveAnthropic(
      missTrace,
      { model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] },
      {},
      { ...deps, fetchUpstream: async () => upstream },
      true,
      { sessionId: 'non-recorder', writeEnabled: false }
    );
    assert(writes.length === 0, `replay-only misses wrote ${writes.join(', ')}`);

    // The live replay-only routes still serve the recording.
    for (const [kind, key, url, body] of [
      [
        'codex',
        codeAgentSlotKey('codex', `${goalHash}:replay-codex`, 0),
        `${BASE_URL}/codex-proxy/${goalHash}:replay-codex/replay-only/backend-api/codex/responses`,
        { model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] },
      ],
      [
        'anthropic',
        anthropicSlotKey(`${goalHash}:replay-anthropic`, 0),
        `${BASE_URL}/anthropic-proxy/${goalHash}:replay-anthropic/replay-only/v1/messages`,
        { model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] },
      ],
    ] as const) {
      await post('/api/fast-cache/set', {
        key,
        kind,
        goalHash,
        value: { status: 200, contentType: 'text/event-stream', body: 'data: {"cached":true}\n\n' },
      });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer test' },
        body: JSON.stringify(body),
      });
      await res.text();
      assert(res.status === 200, `${kind} replay-only status ${res.status}`);
      assert(res.headers.get('x-fast-mode-cache') === 'hit', `${kind} replay-only must replay`);
    }
  });

  const purge = await post('/api/fast-cache/purge', { goalHash });
  assert(purge.status === 200, `purge status ${purge.status}`);

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ demo-cache-isolation blackbox: ${passed}/${passed} passed`);
}

void main();
