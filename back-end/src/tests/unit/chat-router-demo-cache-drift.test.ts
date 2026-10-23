#!/usr/bin/env tsx
/**
 * Router Fast Mode replay survives router prompt / response-schema drift.
 *
 * Incident 40ebcb24 (test-mass-agent-run-0, 2026-10-02): editing the `mode`
 * description in ROUTER_JSON_SCHEMA re-hashed the router content key from the
 * recorded `…c:e4fae2ba…` to `…c:2f7e2f0c…`. The exact lookup missed, the
 * opening router turn streamed live from Cerebras (573 output tokens), and T5
 * zero-live-spend failed. The opening turn must replay the goal's recorded
 * opening decision instead; follow-up turns must never borrow it.
 *
 * Run: npx tsx src/tests/unit/chat-router-demo-cache-drift.test.ts
 */

import assert from 'node:assert';
import { goalHash } from '../../providers/demoCacheNormalizeCore';
import type { CacheGetResult } from '../../providers/demoCacheStore';
import {
  isOpeningRouterTurn,
  readRouterDemoCache,
  type RouterDemoCacheDeps,
} from '../../providers/chat/routerDemoCache';

const GOAL = 'Analyze the top 50 creators in this niche across YouTube, IG, TikTok, and Substack.';
const DRIFTED_KEY =
  'fastmode:v42:llm:4ae3193053ac1d8f:chat_router:c:2f7e2f0c71d1829e0d8690dc4fe0ca18';
const RECORDED_KEY =
  'fastmode:v42:llm:4ae3193053ac1d8f:chat_router:c:94131ca163f2daa56c8e3e8cda54f952';
const RECORDED_JSON = JSON.stringify({
  reasoning: 'This is a large multi-step research and synthesis task.',
  action: 'start_superintelligence',
  query: '',
  goal: 'Identify the top 50 creators, then analyze each with for_each.',
  mode: 'plan',
});
const EXACT_JSON = JSON.stringify({
  reasoning: 'Exact recording for the current prompt.',
  action: 'start_superintelligence',
  query: '',
  goal: 'Exact goal.',
  mode: 'plan',
});

const MISS: CacheGetResult = { hit: false, value: null, blobPath: null };

interface FakeStore {
  deps: RouterDemoCacheDeps;
  positionCalls: Array<{ goalHash: string; callSite: string; step?: number | null }>;
}

function fakeStore(options: {
  exact?: Record<string, unknown>;
  recorded?: { key: string; value: unknown } | 'reject';
}): FakeStore {
  const positionCalls: FakeStore['positionCalls'] = [];
  return {
    positionCalls,
    deps: {
      cacheGet: (key) => {
        const value = options.exact?.[key];
        return Promise.resolve(value === undefined ? MISS : { hit: true, value, blobPath: null });
      },
      cacheGetPosition: (args) => {
        positionCalls.push(args);
        if (options.recorded === 'reject') {
          return Promise.reject(new Error('cache pooler unavailable'));
        }
        if (options.recorded === undefined) return Promise.resolve({ ...MISS, key: null });
        return Promise.resolve({
          hit: true,
          value: options.recorded.value,
          blobPath: null,
          key: options.recorded.key,
        });
      },
    },
  };
}

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

async function main(): Promise<void> {
  await test('opening turn replays the recorded opening decision after key drift', async () => {
    const store = fakeStore({ recorded: { key: RECORDED_KEY, value: { json: RECORDED_JSON } } });
    const result = await readRouterDemoCache(
      { agentId: 'agent-1', cacheKey: DRIFTED_KEY, driftGoal: GOAL },
      store.deps
    );
    assert.deepEqual(result, { hit: true, value: RECORDED_JSON });
    assert.deepEqual(store.positionCalls, [{ goalHash: goalHash(GOAL), callSite: 'chat_router' }]);
  });

  await test('a valid exact hit wins over the drift replay', async () => {
    const store = fakeStore({
      exact: { [DRIFTED_KEY]: { json: EXACT_JSON } },
      recorded: { key: RECORDED_KEY, value: { json: RECORDED_JSON } },
    });
    const result = await readRouterDemoCache(
      { agentId: 'agent-1', cacheKey: DRIFTED_KEY, driftGoal: GOAL },
      store.deps
    );
    assert.deepEqual(result, { hit: true, value: EXACT_JSON });
  });

  await test('follow-up turns never borrow a recorded opening decision', async () => {
    const store = fakeStore({ recorded: { key: RECORDED_KEY, value: { json: RECORDED_JSON } } });
    const result = await readRouterDemoCache(
      { agentId: 'agent-1', cacheKey: DRIFTED_KEY, driftGoal: null },
      store.deps
    );
    assert.deepEqual(result, { hit: false });
    assert.equal(store.positionCalls.length, 0, 'follow-up turns must not query the position slot');
  });

  await test('a truncated exact row falls through to the recorded opening decision', async () => {
    const store = fakeStore({
      exact: { [DRIFTED_KEY]: { json: '{\n  "' } },
      recorded: { key: RECORDED_KEY, value: { json: RECORDED_JSON } },
    });
    const result = await readRouterDemoCache(
      { agentId: 'agent-1', cacheKey: DRIFTED_KEY, driftGoal: GOAL },
      store.deps
    );
    assert.deepEqual(result, { hit: true, value: RECORDED_JSON });
  });

  await test('an invalid recorded decision is a miss, never a replay', async () => {
    const store = fakeStore({
      recorded: {
        key: RECORDED_KEY,
        value: { json: JSON.stringify({ action: 'web_search', reasoning: 'no query' }) },
      },
    });
    const result = await readRouterDemoCache(
      { agentId: 'agent-1', cacheKey: DRIFTED_KEY, driftGoal: GOAL },
      store.deps
    );
    assert.deepEqual(result, { hit: false });
  });

  await test('a failed drift lookup does not leak when the exact key hits', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const store = fakeStore({
        exact: { [DRIFTED_KEY]: { json: EXACT_JSON } },
        recorded: 'reject',
      });
      const result = await readRouterDemoCache(
        { agentId: 'agent-1', cacheKey: DRIFTED_KEY, driftGoal: GOAL },
        store.deps
      );
      assert.deepEqual(result, { hit: true, value: EXACT_JSON });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(unhandled.length, 0, 'drift rejection must be handled');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await test('a failed drift lookup on an exact miss surfaces as a cache error', async () => {
    const store = fakeStore({ recorded: 'reject' });
    await assert.rejects(
      readRouterDemoCache(
        { agentId: 'agent-1', cacheKey: DRIFTED_KEY, driftGoal: GOAL },
        store.deps
      ),
      /cache pooler unavailable/
    );
  });

  await test('only a single-user-message request is an opening router turn', () => {
    assert.equal(
      isOpeningRouterTurn([
        { role: 'system', content: 'router prompt' },
        { role: 'user', content: GOAL },
      ]),
      true
    );
    assert.equal(
      isOpeningRouterTurn([
        { role: 'system', content: 'router prompt' },
        { role: 'user', content: GOAL },
        { role: 'assistant', content: 'Started.' },
        { role: 'user', content: 'cool' },
      ]),
      false
    );
    assert.equal(
      isOpeningRouterTurn([
        { role: 'system', content: 'router prompt' },
        { role: 'user', content: GOAL },
        { role: 'user', content: '[Tool Result]\nsearch results' },
      ]),
      false
    );
    assert.equal(isOpeningRouterTurn([{ role: 'system', content: 'router prompt' }]), false);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exit(1);
  }
}

void main();
