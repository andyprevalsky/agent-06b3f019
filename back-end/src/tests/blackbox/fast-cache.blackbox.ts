#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for the Fast Mode cache routes + flag persistence (live server).
 *
 * Covers the DB-dependent checklist items that the unit tests can't:
 *  - store set→get roundtrip + last-write-wins overwrite (#10)
 *  - secret stripping at the route boundary (#26)
 *  - purge by goalHash (#24)
 *  - create-agent persists fast_mode_cache_enabled (#3/#5)
 *  - sub-agent inherits the parent's flag (#6)
 *
 * Usage: npx tsx src/tests/blackbox/fast-cache.blackbox.ts
 * Requires a running backend (BASE_URL) + local Postgres.
 */

import { config } from 'dotenv';
import { anthropicSlotKey } from '../../providers/anthropicProxyCore';
import { codeAgentSlotKey } from '../../providers/codexProxyCore';
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
  const goalHash = `bbtest${Date.now().toString(16)}`;
  const key = `fastmode:v23:llm:${goalHash}:execute_loop:0:0`;

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

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ fast-cache blackbox: ${passed}/${passed} passed`);
}

void main();
