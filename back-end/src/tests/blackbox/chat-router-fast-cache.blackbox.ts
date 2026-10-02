#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentKey } from '../../providers/fastCacheNormalizeKeys';
import { readRouterFastCache } from '../../providers/chat/routerFastCache';
import { fastCacheWriteAllowed } from '../../providers/fastCacheStore';
import { ROUTER_SYSTEM_PROMPT } from '../../providers/chat/chatPrompts';
import { ROUTER_JSON_SCHEMA } from '../../providers/chat/routerDecisionJsonSchema';
import { parseRouterDecisionJson } from '../../providers/chat/routerDecision';
import { markCacheable } from '../../providers/rose/cache';

const tasks = JSON.parse(
  readFileSync(new URL('../../../../agents/benchmarks/tasks.json', import.meta.url), 'utf8')
) as Array<{ name: string; prompt: string }>;
const goal = tasks.find((task) => task.name === 'test-mass-agent-run-0')?.prompt;
assert.ok(goal, 'mass-agent task must be in the canonical benchmark catalog');
const request = {
  model: 'rose-labs/rose-1-flash',
  temperature: 0,
  effort: 'minimal',
  response_format: {
    type: 'json_schema',
    name: 'router_decision',
    strict: true,
    schema: ROUTER_JSON_SCHEMA,
  },
  provider_fast_mode: true,
  provider_route: 'direct-cerebras',
  messages: [markCacheable(ROUTER_SYSTEM_PROMPT), { role: 'user', content: goal }],
};
const newKey = contentKey(goal, 'chat_router', request);
const oldKey = contentKey(goal, 'chat_router', { ...request, temperature: 0.3 });
const cachedDecision = JSON.stringify({
  action: 'start_superintelligence',
  reasoning: 'Use one agent per creator.',
  goal: 'Identify 50 creators, use spawn_general_purpose_agent_for_each, and synthesize the results.',
  mode: 'plan',
});

async function main(): Promise<void> {
  assert.notEqual(newKey, oldKey, 'router temperature change must change exact cache key');
  assert.equal(
    newKey,
    'fastmode:v42:llm:4ae3193053ac1d8f:chat_router:c:5df9d6c359479c8fefff9e0e16f7f1e7',
    'captured failed-run key'
  );
  assert.equal(
    oldKey,
    'fastmode:v42:llm:4ae3193053ac1d8f:chat_router:c:e4fae2bafa8c8914a865a79437f1cc66',
    'captured passing-run key'
  );
  const requestedKeys: string[] = [];
  const get = async (key: string) => {
    requestedKeys.push(key);
    return key === oldKey
      ? { hit: true, value: { json: cachedDecision } }
      : { hit: false, value: null };
  };

  const result = await readRouterFastCache({ goal, request, get });
  assert.equal(result.hit, true, 'demo router must reuse the verified prior decision');
  assert.equal(result.json, cachedDecision);
  assert.equal(parseRouterDecisionJson(result.json).action, 'start_superintelligence');
  assert.deepEqual(
    requestedKeys,
    [newKey, oldKey],
    'only the exact prior-temperature key may replay'
  );

  const otherGoal = 'Find the best local restaurants';
  const otherKeys: string[] = [];
  const ordinary = await readRouterFastCache({
    goal: otherGoal,
    request,
    get: async (key) => {
      otherKeys.push(key);
      return { hit: false, value: null };
    },
  });
  assert.equal(ordinary.hit, false, 'ordinary chat remains eligible for live routing');
  assert.equal(otherKeys.length, 1, 'prior-temperature replay is demo-only');

  await assert.rejects(
    readRouterFastCache({
      goal,
      request,
      get: async () => ({ hit: false, value: null }),
    }),
    /demo router cache miss/i,
    'demo cache absence must fail before starting a live model'
  );
  await assert.rejects(
    readRouterFastCache({
      goal,
      request,
      get: async (key) => ({
        hit: key === oldKey,
        value: {
          json: JSON.stringify({ action: 'web_search', reasoning: 'wrong route', query: 'x' }),
        },
      }),
    }),
    /demo router cache miss/i,
    'a valid but wrong legacy route must not replay'
  );

  assert.equal(fastCacheWriteAllowed(true, {}), true, 'production default permits demo writes');
  assert.equal(
    fastCacheWriteAllowed(true, { FAST_MODE_CACHE_DISABLE_WRITE_THROUGH: '1' }),
    false,
    'shared-cache predeploy lane is read-only for chat routing too'
  );

  process.stdout.write('PASS demo router replays prior decision after temperature key drift\n');
  process.stdout.write('PASS ordinary chat has no legacy lookup\n');
  process.stdout.write('PASS demo cache absence fails closed\n');
  process.stdout.write('PASS backend chat obeys shared-cache read-only flag\n');
}

void main();
