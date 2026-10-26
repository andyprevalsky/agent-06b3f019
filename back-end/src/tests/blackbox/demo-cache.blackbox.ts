#!/usr/bin/env tsx
/**
 * Black-box tests for the DEMO cache routes + flag persistence (live server).
 *
 * Covers the DB-dependent checklist items that the unit tests can't:
 *  - store set→get roundtrip + last-write-wins overwrite (#10)
 *  - secret stripping at the route boundary (#26)
 *  - purge by goalHash (#24)
 *  - create-agent persists fast_mode_cache_enabled (#3/#5)
 *  - sub-agent inherits the parent's flag (#6)
 *
 * Usage: npx tsx src/tests/blackbox/demo-cache.blackbox.ts
 * Requires a running backend (BASE_URL) + local Postgres.
 */

import express from 'express';
import demoCacheRoutes from '../../domains/demo-cache/routes';
import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { anthropicSlotKey } from '../../providers/anthropicProxyCore';
import { codeAgentSlotKey } from '../../providers/codexProxyCore';
import { rewriteOaiDemoCacheValue } from '../../domains/demo-cache/oaiDemoCacheCleaner';
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
  await test('read-only cache route acknowledges skipped persistence', async () => {
    const previous = process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH;
    process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH = '1';
    const app = express();
    app.use(express.json());
    app.use('/api/fast-cache', demoCacheRoutes);
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing loopback listener');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/fast-cache/set`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          key: 'readonly-regression',
          kind: 'llm',
          goalHash: 'readonly',
          value: { json: '{}' },
        }),
      });
      const body = (await response.json()) as JsonObject;
      assert(
        response.status === 200 && body.stored === false,
        'Skipped writes must acknowledge stored:false'
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      if (previous === undefined) delete process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH;
      else process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH = previous;
    }
  });
  const goalHash = `bbtest${Date.now().toString(16)}`;
  const key = `fastmode:v23:llm:${goalHash}:execute_loop:0:0`;

  await test('OAI trajectory cleanup deletes browser work without scheduling replacement work', async () => {
    const result = rewriteOaiDemoCacheValue({
      content: 'The public-source research is already complete.',
      tool_calls: [
        {
          id: 'browser-call',
          name: 'spawn_agent',
          arguments: JSON.stringify({
            type: 'browser',
            goal: 'Inspect one more public profile.',
            start_url: 'https://example.com/profile',
          }),
        },
      ],
    });
    const calls = (result.value as { tool_calls: unknown[] }).tool_calls;
    assert(result.browserCallsRemoved === 1, 'the browser call must be removed');
    assert(result.exploreCallsAdded === 0, 'cleanup must not introduce new executable work');
    assert(calls.length === 0, 'the saved trajectory must contain no replacement tool call');
    assert(
      (result as typeof result & { deleteEntry?: boolean }).deleteEntry === true,
      'the browser-bearing cache row must be removed from runtime replay'
    );
  });

  await test('OAI trajectory cleanup deletes nested GP, for-each, and code replay slots', async () => {
    const nestedCalls = [
      {
        label: 'general-purpose',
        call: {
          id: 'gp-call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ type: 'general_purpose', goal: 'Research one creator.' }),
        },
      },
      {
        label: 'for-each',
        call: {
          id: 'for-each-call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ type: 'for_each', goal: 'Research each creator.' }),
        },
      },
      {
        label: 'code',
        call: {
          id: 'code-call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ type: 'code', goal: 'Implement the change.' }),
        },
      },
      {
        label: 'legacy general-purpose',
        call: {
          id: 'legacy-gp-call',
          name: 'spawn_general_purpose_agent',
          arguments: JSON.stringify({ goal: 'Research one creator.' }),
        },
      },
      {
        label: 'legacy for-each',
        call: {
          id: 'legacy-for-each-call',
          name: 'spawn_general_purpose_agent_for_each',
          arguments: JSON.stringify({ goal: 'Research each creator.' }),
        },
      },
      {
        label: 'legacy code',
        call: {
          id: 'legacy-code-call',
          name: 'spawn_code_agent',
          arguments: JSON.stringify({ goal: 'Implement the change.' }),
        },
      },
    ];

    for (const { label, call } of nestedCalls) {
      const result = rewriteOaiDemoCacheValue({
        content: 'The main creator analysis already contains the evidence.',
        tool_calls: [call],
      });
      assert(
        result.nestedAgentCallsRemoved === 1,
        `${label} nested call must be classified for removal`
      );
      assert(result.deleteEntry === true, `${label} cache row must leave runtime replay`);
      assert(
        (result.value as { tool_calls: unknown[] }).tool_calls.length === 0,
        `${label} cleanup preview must contain no replacement tool call`
      );
    }
  });

  await test('OAI maintenance archives the complete nested-agent row transactionally', async () => {
    const maintenanceGoalHash = '5e1731f836723fb1';
    const maintenanceKey = `fastmode:v42:llm:${maintenanceGoalHash}:execute_loop:p:99:c:${Date.now()}`;
    const originalValue = {
      content: 'This stale turn attempted nested work.',
      reasoning: 'Replay the recorded decision.',
      usage: { input_tokens: 17, output_tokens: 3 },
      tool_calls: [
        {
          id: 'maintenance-gp-call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ type: 'general_purpose', goal: 'Research more.' }),
        },
      ],
    };
    const set = await post('/api/fast-cache/set', {
      key: maintenanceKey,
      kind: 'llm',
      goalHash: maintenanceGoalHash,
      value: originalValue,
    });
    assert(set.status === 200, `maintenance fixture set status ${set.status}`);

    const databaseUrl = process.env.DATABASE_URL;
    assert(Boolean(databaseUrl), 'isolated blackbox DATABASE_URL is required');
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/clean-oai-demo-browser-cache.ts', '--apply'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          // The maintenance script prefers this variable. Pin it to the
          // runner's disposable local database, never a developer .env value.
          FAST_MODE_CACHE_DATABASE_URL: databaseUrl,
        },
      }
    );
    assert(
      /Archived [1-9][0-9]* disallowed-agent rows/.test(output),
      'maintenance must archive at least the inserted row'
    );

    const archiveKey = `maintenance:oai-demo-no-disallowed-agent-v4:${maintenanceKey}`;
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const runtime = await prisma.fastModeCacheEntry.findUnique({
        where: { key: maintenanceKey },
      });
      assert(runtime === null, 'original runtime key must be absent after archival');
      const archived = await prisma.fastModeCacheEntry.findUnique({ where: { key: archiveKey } });
      assert(archived?.kind === 'oai_demo_backup', 'archived row must use the backup kind');
      assert(archived?.goalHash === maintenanceGoalHash, 'archival must preserve the goal hash');
      const value = archived?.value as JsonObject;
      assert(value.content === originalValue.content, 'archival must preserve content');
      assert(value.reasoning === originalValue.reasoning, 'archival must preserve reasoning');
      assert(
        JSON.stringify(value.tool_calls) === JSON.stringify(originalValue.tool_calls),
        'archival must preserve the original nested call for reversal'
      );
      assert(
        JSON.stringify(value.usage) === JSON.stringify(originalValue.usage),
        'archival must preserve provider accounting'
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  await test('#10 set→get roundtrip', async () => {
    const set = await post('/api/fast-cache/set', {
      key,
      kind: 'llm',
      goalHash,
      value: { content: 'hello', tool_calls: [] },
    });
    assert(set.status === 200, `set status ${set.status}`);
    const get = await post('/api/fast-cache/get', { key });
    assert(get.json.hit === true, 'expected hit');
    assert(get.json.value.content === 'hello', 'value roundtrip');
  });

  await test('#10 last-write-wins: second write replaces first value', async () => {
    await post('/api/fast-cache/set', {
      key,
      kind: 'llm',
      goalHash,
      value: { content: 'CHANGED' },
    });
    const get = await post('/api/fast-cache/get', { key });
    assert(get.json.value.content === 'CHANGED', 'last write must win');
  });

  await test('#10 get-many returns hits and misses in one request', async () => {
    const secondKey = `${key}:second`;
    const set = await post('/api/fast-cache/set', {
      key: secondKey,
      kind: 'llm',
      goalHash,
      value: { content: 'SECOND' },
    });
    assert(set.status === 200, `second set status ${set.status}`);
    const get = await post('/api/fast-cache/get-many', {
      keys: [key, secondKey, `${key}:missing`, key],
    });
    const results = get.json.results as Record<string, JsonObject>;
    assert(get.status === 200, `get-many status ${get.status}`);
    assert(results[key].hit === true, 'first key should hit');
    assert((results[key].value as JsonObject).content === 'CHANGED', 'first value roundtrip');
    assert(results[secondKey].hit === true, 'second key should hit');
    assert((results[secondKey].value as JsonObject).content === 'SECOND', 'second value roundtrip');
    assert(results[`${key}:missing`].hit === false, 'missing key should miss');
  });

  await test('get-position returns oldest matching trajectory slot', async () => {
    const posGoal = `bbpos${Date.now().toString(16)}`;
    const olderKey = `fastmode:v42:llm:${posGoal}:plan_loop:p:1:c:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const newerKey = `fastmode:v43:llm:${posGoal}:plan_loop:p:1:c:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    await post('/api/fast-cache/set', {
      key: olderKey,
      kind: 'llm',
      goalHash: posGoal,
      value: { content: 'OLDER' },
    });
    // Ensure newer createdAt by a later write
    await new Promise((r) => setTimeout(r, 20));
    await post('/api/fast-cache/set', {
      key: newerKey,
      kind: 'llm',
      goalHash: posGoal,
      value: { content: 'NEWER' },
    });
    const pos = await post('/api/fast-cache/get-position', {
      goalHash: posGoal,
      callSite: 'plan_loop',
      step: 1,
    });
    assert(pos.status === 200, `get-position status ${pos.status}`);
    assert(pos.json.hit === true, 'expected position hit');
    assert((pos.json.value as JsonObject).content === 'OLDER', 'must prefer oldest slot write');
    assert(pos.json.key === olderKey, 'must return older key');
    await post('/api/fast-cache/purge', { goalHash: posGoal });
  });

  await test('get-position without step matches content-addressed call sites', async () => {
    const posGoal = `bbposc${Date.now().toString(16)}`;
    const olderKey = `fastmode:v42:llm:${posGoal}:response_schema:c:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const newerKey = `fastmode:v43:llm:${posGoal}:response_schema:c:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    await post('/api/fast-cache/set', {
      key: olderKey,
      kind: 'llm',
      goalHash: posGoal,
      value: { content: 'SCHEMA_OLD' },
    });
    await new Promise((r) => setTimeout(r, 20));
    await post('/api/fast-cache/set', {
      key: newerKey,
      kind: 'llm',
      goalHash: posGoal,
      value: { content: 'SCHEMA_NEW' },
    });
    const pos = await post('/api/fast-cache/get-position', {
      goalHash: posGoal,
      callSite: 'response_schema',
    });
    assert(pos.status === 200, `get-position status ${pos.status}`);
    assert(pos.json.hit === true, 'expected content-slot hit');
    assert(
      (pos.json.value as JsonObject).content === 'SCHEMA_OLD',
      'must prefer oldest schema write'
    );
    await post('/api/fast-cache/purge', { goalHash: posGoal });
  });

  await test('get-position falls forward to higher step when exact step misses', async () => {
    const posGoal = `bbposdrift${Date.now().toString(16)}`;
    const key = `fastmode:v42:llm:${posGoal}:summarize_web_fetch:p:2:c:cccccccccccccccccccccccccccccccc`;
    await post('/api/fast-cache/set', {
      key,
      kind: 'llm',
      goalHash: posGoal,
      value: { content: 'SWF_P2' },
    });
    const pos = await post('/api/fast-cache/get-position', {
      goalHash: posGoal,
      callSite: 'summarize_web_fetch',
      step: 1,
    });
    assert(pos.status === 200, `get-position status ${pos.status}`);
    assert(pos.json.hit === true, 'expected forward-step fallback hit');
    assert((pos.json.value as JsonObject).content === 'SWF_P2', 'must replay p:2 for p:1 miss');
    assert(pos.json.key === key, 'must return p:2 key for p:1 miss');
    await post('/api/fast-cache/purge', { goalHash: posGoal });
  });

  await test('get-position does not fall back to a lower step', async () => {
    const posGoal = `bbposback${Date.now().toString(16)}`;
    const key = `fastmode:v42:llm:${posGoal}:explore_agent:p:1:c:dddddddddddddddddddddddddddddddd`;
    await post('/api/fast-cache/set', {
      key,
      kind: 'llm',
      goalHash: posGoal,
      value: { content: 'EX_P1' },
    });
    const pos = await post('/api/fast-cache/get-position', {
      goalHash: posGoal,
      callSite: 'explore_agent',
      step: 5,
    });
    assert(pos.status === 200, `get-position status ${pos.status}`);
    assert(pos.json.hit === false, 'must miss rather than replay lower-step web_search');
    await post('/api/fast-cache/purge', { goalHash: posGoal });
  });

  await test('#26 secrets stripped at the route', async () => {
    const skey = `${key}:secret`;
    await post('/api/fast-cache/set', {
      key: skey,
      kind: 'llm',
      goalHash,
      value: { Authorization: 'Bearer leak', cookie: 'x', keep: 'ok' },
    });
    const get = await post('/api/fast-cache/get', { key: skey });
    assert(get.json.value.Authorization === undefined, 'Authorization must be stripped');
    assert(get.json.value.cookie === undefined, 'cookie must be stripped');
    assert(get.json.value.keep === 'ok', 'non-secret kept');
  });

  await test('get miss returns hit:false', async () => {
    const get = await post('/api/fast-cache/get', { key: `${key}:nope` });
    assert(get.json.hit === false, 'expected miss');
  });

  await test('Anthropic proxy replays a cached provider response', async () => {
    const traceHash = `${goalHash}:anthropic`;
    const cachedBody = 'event: message\ndata: {"cached":true}\n\n';
    await post('/api/fast-cache/set', {
      key: anthropicSlotKey(traceHash, 0),
      kind: 'anthropic',
      goalHash: traceHash,
      value: { status: 200, contentType: 'text/event-stream', body: cachedBody },
    });

    const res = await fetch(`${BASE_URL}/anthropic-proxy/${traceHash}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    assert(res.status === 200, `proxy status ${res.status}`);
    assert(res.headers.get('x-fast-mode-cache') === 'hit', 'expected anthropic cache hit');
    assert(text === cachedBody, 'expected cached anthropic body');
  });

  await test('Codex proxy replays a cached provider response', async () => {
    const traceHash = `${goalHash}:codex`;
    const cachedBody = 'event: response.completed\ndata: {"cached":true}\n\n';
    await post('/api/fast-cache/set', {
      key: codeAgentSlotKey('codex', traceHash, 0),
      kind: 'codex',
      goalHash: traceHash,
      value: { status: 200, contentType: 'text/event-stream', body: cachedBody },
    });

    const res = await fetch(`${BASE_URL}/codex-proxy/${traceHash}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    assert(res.status === 200, `proxy status ${res.status}`);
    assert(res.headers.get('x-fast-mode-cache') === 'hit', 'expected codex cache hit');
    assert(text === cachedBody, 'expected cached codex body');
  });

  await test('#24 purge by goalHash removes entries', async () => {
    const purge = await post('/api/fast-cache/purge', { goalHash });
    assert(purge.status === 200, `purge status ${purge.status}`);
    assert(typeof purge.json.removed === 'number' && purge.json.removed >= 2, 'removed count');
    const get = await post('/api/fast-cache/get', { key });
    assert(get.json.hit === false, 'entry gone after purge');
  });

  await test('#3/#5 create-agent persists fast_mode_cache_enabled', async () => {
    const create = await post('/api/agents', {
      goal: `fastmode bbtest ${Date.now()}`,
      fast_mode_cache_enabled: true,
    });
    assert(create.status === 200 || create.status === 201, `create status ${create.status}`);
    const agentId = create.json.agent_id ?? create.json.id;
    assert(typeof agentId === 'string', 'agent_id returned');
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}`, { headers });
    const detail = await res.json();
    const flag = detail.agent?.fast_mode_cache_enabled;
    assert(flag === true, 'persisted flag should be true');
    // cleanup
    await fetch(`${BASE_URL}/api/agents/${agentId}`, { method: 'DELETE', headers });
  });

  await test('create-agent defaults fast_mode_cache_enabled on when omitted', async () => {
    const create = await post('/api/agents', {
      goal: `fastmode default bbtest ${Date.now()}`,
    });
    assert(create.status === 200 || create.status === 201, `create status ${create.status}`);
    const agentId = create.json.agent_id ?? create.json.id;
    assert(typeof agentId === 'string', 'agent_id returned');
    assert(
      create.json.fast_mode_cache_enabled === true,
      'create response must default Fast Mode on'
    );
    const res = await fetch(`${BASE_URL}/api/agents/${agentId}`, { headers });
    const detail = await res.json();
    assert(
      detail.agent?.fast_mode_cache_enabled === true,
      'persisted Fast Mode must default on when omitted'
    );
    await fetch(`${BASE_URL}/api/agents/${agentId}`, { method: 'DELETE', headers });
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ demo-cache blackbox: ${passed}/${passed} passed`);
}

void main();
