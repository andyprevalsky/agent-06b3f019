#!/usr/bin/env tsx
/**
 * Agent speed: create-body resolution, inheritance and the request body each
 * provider leg actually sends for standard / fast / ultrafast. Also pins the
 * rose-1-flash fallback order (Cerebras -> Azure gpt-6-luna -> OpenRouter) and
 * the medium effort on its Azure and OpenRouter layers.
 *
 * Run: npx tsx src/tests/unit/agent-speed.test.ts (via scripts/run-unit-tests.ts)
 */

import assert from 'node:assert/strict';
import { createAgentSchema } from '../../domains/agents/types';
import {
  applyFastModeDefault,
  applySpeedDefault,
  applySpeedInheritance,
  disableFastModeForWorldModel,
  resolvedSpeed,
} from '../../domains/agents/agentExecutionMode';
import { claudeAuthComplete } from '../../providers/rose/claudeAuth';
import { gptAuthComplete, openAiApiKeyComplete } from '../../providers/rose/gptAuth';
import {
  FOUNDRY_REGION_ENV_NAMES,
  __resetFoundryCooldowns,
  foundryComplete,
  foundryConfigured,
  foundryModels,
  foundryRequestFor,
} from '../../providers/rose/foundry';
import { waterfallComplete } from '../../providers/rose/waterfall';
import { POOL_REGISTRY } from '../../providers/rose/pools';
import {
  agentSpeedFromRow,
  normalizeAgentSpeed,
  type AgentSpeed,
} from '../../providers/rose/speed';
import { createStreamingCompletion } from '../../providers/rose';

const SPEEDS: AgentSpeed[] = ['standard', 'fast', 'ultrafast'];
const PARENT = '00000000-0000-4000-8000-000000000001';
const messages = [{ role: 'user' as const, content: 'Say hi' }];

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** Run one leg against a fetch stub that records the request and rejects it pre-content. */
async function captureLeg(run: () => AsyncIterable<unknown>): Promise<Captured[]> {
  const captured: Captured[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ error: { message: 'stub rejects' } }), { status: 400 });
  }) as typeof fetch;
  try {
    for await (const chunk of run()) void chunk;
  } catch {
    // A 400 is the expected pre-content rejection; only the request matters here.
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured.length > 0, 'leg must send a request');
  return captured;
}

function createBody(extra: Record<string, unknown>) {
  return createAgentSchema.parse({ goal: 'x', ...extra });
}

async function main(): Promise<void> {
  const savedEnv = Object.fromEntries(
    [...FOUNDRY_REGION_ENV_NAMES, 'OPENROUTER_API_KEY'].map((k) => [k, process.env[k]])
  );
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];

  await test('speed values normalize; unknown or absent is standard', () => {
    assert.equal(normalizeAgentSpeed(undefined), 'standard');
    assert.equal(normalizeAgentSpeed('turbo'), 'standard');
    for (const speed of SPEEDS) assert.equal(normalizeAgentSpeed(speed), speed);
    assert.equal(agentSpeedFromRow({ speed: null, fastModeCacheEnabled: true }), 'fast');
    assert.equal(agentSpeedFromRow({ speed: null, fastModeCacheEnabled: false }), 'standard');
    assert.equal(
      agentSpeedFromRow({ speed: 'ultrafast', fastModeCacheEnabled: false }),
      'ultrafast'
    );
  });

  await test('create body: explicit speed, legacy boolean, and absent-both resolve', () => {
    const cases: Array<[Record<string, unknown>, AgentSpeed]> = [
      [{ speed: 'fast' }, 'fast'],
      [{ speed: 'ultrafast' }, 'ultrafast'],
      [{ speed: 'standard', fast_mode_cache_enabled: true }, 'standard'],
      [{ fast_mode_cache_enabled: true }, 'fast'],
      [{ fast_mode_cache_enabled: false }, 'standard'],
      [{}, 'standard'],
    ];
    for (const [extra, expected] of cases) {
      const body = createBody(extra);
      applySpeedDefault(body);
      applyFastModeDefault(body, PARENT);
      assert.equal(resolvedSpeed(body), expected, JSON.stringify(extra));
    }
    // The legacy cache-key bit keeps its own default: speed never changes it.
    const absent = createBody({});
    applySpeedDefault(absent);
    applyFastModeDefault(absent, PARENT);
    assert.equal(absent.fast_mode_cache_enabled, true);
  });

  await test('sub-agents inherit the parent speed unless the request sets one', () => {
    const sub = (extra: Record<string, unknown> = {}) =>
      createBody({ parent_agent_id: PARENT, parent_workflow_id: 'wf', ...extra });
    const inherited = sub();
    applySpeedDefault(inherited);
    applySpeedInheritance(inherited, { speed: 'ultrafast', fastModeCacheEnabled: false });
    assert.equal(resolvedSpeed(inherited), 'ultrafast');
    const legacyParent = sub();
    applySpeedDefault(legacyParent);
    applySpeedInheritance(legacyParent, { speed: null, fastModeCacheEnabled: true });
    assert.equal(resolvedSpeed(legacyParent), 'fast');
    const explicit = sub({ speed: 'standard' });
    applySpeedDefault(explicit);
    applySpeedInheritance(explicit, { speed: 'ultrafast', fastModeCacheEnabled: true });
    assert.equal(resolvedSpeed(explicit), 'standard');
    const foreign = sub();
    applySpeedDefault(foreign);
    applySpeedInheritance(foreign, null);
    assert.equal(resolvedSpeed(foreign), 'standard');
  });

  await test('Simulator mode keeps its standard provider contract', () => {
    const body = createBody({ speed: 'ultrafast', world_model_mode: 'simulate' });
    applySpeedDefault(body);
    disableFastModeForWorldModel(body);
    assert.equal(resolvedSpeed(body), 'standard');
  });

  const ultra = POOL_REGISTRY['rose-1-ultra'];
  const flash = POOL_REGISTRY['rose-1-flash'];

  await test('Claude legs: fast mode for fast and ultrafast on Opus 5.5, none for standard', async () => {
    for (const auth of [
      { mode: 'oauth' as const, token: 'sk-ant-oat-test' },
      { mode: 'apiKey' as const, key: 'sk-ant-api-test' },
    ]) {
      for (const speed of SPEEDS) {
        const [request] = await captureLeg(() =>
          claudeAuthComplete({ poolSpec: ultra, messages, auth, requestId: 'r', speed })
        );
        assert.equal(request.body.model, 'claude-opus-5-5');
        const beta = request.headers['anthropic-beta'] ?? '';
        if (speed === 'standard') {
          assert.equal(request.body.speed, undefined, `${auth.mode} standard`);
          assert.ok(!beta.includes('fast-mode-2026-02-01'), `${auth.mode} standard beta`);
        } else {
          assert.equal(request.body.speed, 'fast', `${auth.mode} ${speed}`);
          assert.ok(beta.includes('fast-mode-2026-02-01'), `${auth.mode} ${speed} beta`);
        }
      }
    }
  });

  await test('Claude legs: models without fast mode never receive speed', async () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-4-7', 'claude-haiku-4-5']) {
      const [request] = await captureLeg(() =>
        claudeAuthComplete({
          poolSpec: { ...ultra, claudeAuthModel: model },
          messages,
          auth: { mode: 'oauth', token: 'sk-ant-oat-test' },
          requestId: 'r',
          speed: 'ultrafast',
        })
      );
      assert.equal(request.body.speed, undefined, model);
    }
  });

  await test('GPT OAuth: fast -> priority, ultrafast -> ultrafast where listed', async () => {
    const tierFor = async (model: string, speed: AgentSpeed) => {
      const [request] = await captureLeg(() =>
        gptAuthComplete({
          poolSpec: { ...ultra, gptAuthModel: model },
          messages,
          gptToken: 'gpt-test',
          requestId: 'r',
          speed,
        })
      );
      assert.equal(request.body.model, model);
      return request.body.service_tier;
    };
    assert.equal(await tierFor('gpt-6.1-sol', 'standard'), undefined);
    assert.equal(await tierFor('gpt-6.1-sol', 'fast'), 'priority');
    assert.equal(await tierFor('gpt-6.1-sol', 'ultrafast'), 'ultrafast');
    // gpt-6-sol lists priority only, so ultrafast never sends a tier it rejects.
    assert.equal(await tierFor('gpt-6-sol', 'ultrafast'), 'priority');
  });

  await test('OpenAI API key: same tiers as GPT OAuth (no hardcoded priority)', async () => {
    const tierFor = async (model: string, speed: AgentSpeed) => {
      const [request] = await captureLeg(() =>
        openAiApiKeyComplete({
          poolSpec: ultra,
          model,
          messages,
          openAiKey: 'sk-test',
          requestId: 'r',
          speed,
        })
      );
      return request.body.service_tier;
    };
    assert.equal(await tierFor('gpt-6.1-sol', 'standard'), undefined);
    assert.equal(await tierFor('gpt-6.1-sol', 'fast'), 'priority');
    assert.equal(await tierFor('gpt-6.1-sol', 'ultrafast'), 'ultrafast');
    assert.equal(await tierFor('gpt-6-sol', 'ultrafast'), 'priority');
  });

  await test('Azure Foundry: priority for fast and ultrafast, none for standard', async () => {
    process.env.AZURE_FOUNDRY_ENDPOINT_2 = 'https://speed-fixture-2.openai.azure.com';
    process.env.AZURE_FOUNDRY_API_KEY_2 = 'test-key';
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_2 = 'gpt-6-sol';
    __resetFoundryCooldowns();
    try {
      for (const speed of SPEEDS) {
        const [request] = await captureLeg(() =>
          foundryComplete(
            foundryRequestFor({
              poolSpec: ultra,
              options: { model: 'x', messages, speed },
              requestId: 'r',
            })
          )
        );
        assert.equal(
          request.body.service_tier,
          speed === 'standard' ? undefined : 'priority',
          speed
        );
      }
    } finally {
      for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
      __resetFoundryCooldowns();
    }
  });

  await test('OpenRouter waterfall: speed hint only for fast/ultrafast', async () => {
    for (const speed of SPEEDS) {
      const requests = await captureLeg(() =>
        waterfallComplete({
          poolSpec: flash,
          messages,
          openrouterKey: 'or-test',
          requestId: 'r',
          speed,
        })
      );
      for (const request of requests) {
        assert.equal(request.body.speed, speed === 'standard' ? undefined : 'fast', speed);
      }
    }
  });

  await test('createStreamingCompletion without speed sends no tier or speed', async () => {
    process.env.AZURE_FOUNDRY_ENDPOINT_2 = 'https://speed-fixture-2.openai.azure.com';
    process.env.AZURE_FOUNDRY_API_KEY_2 = 'test-key';
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_2 = 'gpt-6-sol';
    process.env.OPENROUTER_API_KEY = 'or-test';
    __resetFoundryCooldowns();
    try {
      const requests = await captureLeg(async function* () {
        const stream = await createStreamingCompletion({
          model: 'rose-labs/rose-1-ultra',
          messages,
          claude_token: 'sk-ant-oat-test',
          gpt_token: 'gpt-test',
        });
        yield* stream;
      });
      for (const request of requests) {
        assert.equal(request.body.speed, undefined, request.url);
        assert.equal(request.body.service_tier, undefined, request.url);
      }
    } finally {
      for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
      __resetFoundryCooldowns();
    }
  });

  await test('rose-1-flash Azure leg is gpt-6-luna only, at medium, in any listing region', async () => {
    assert.deepEqual(foundryModels(flash), ['gpt-6-luna']);
    assert.equal(flash.waterfallReasoningEffort, 'medium');
    assert.deepEqual([...flash.waterfall], ['qwen/qwen3.8-27b', 'google/gemini-3.8-flash']);
    assert.equal(flash.cerebrasModel, 'qwen-3.8-27b');
    assert.equal(flash.cerebrasReasoningEffort, 'high');
    assert.equal(flash.directAuthEnabled, false);
    assert.equal(flash.gptAuthModel, 'gpt-5.6-luna');
    // Fixture deployment lists mirror today's resources: 2/4 never serve 6-luna.
    process.env.AZURE_FOUNDRY_ENDPOINT_2 = 'https://speed-fixture-2.openai.azure.com';
    process.env.AZURE_FOUNDRY_API_KEY_2 = 'k2';
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_2 = 'gpt-5.6-luna,gpt-6-sol,gpt-6.1-sol';
    process.env.AZURE_FOUNDRY_ENDPOINT_3 = 'https://speed-fixture-3.openai.azure.com';
    process.env.AZURE_FOUNDRY_API_KEY_3 = 'k3';
    process.env.AZURE_FOUNDRY_DEPLOYMENTS_3 = 'gpt-6-sol,gpt-6-luna';
    __resetFoundryCooldowns();
    try {
      assert.equal(foundryConfigured(flash), true);
      const requests = await captureLeg(() =>
        foundryComplete(
          foundryRequestFor({
            poolSpec: flash,
            options: { model: 'x', messages, effort: 'high', speed: 'fast' },
            requestId: 'r',
          })
        )
      );
      for (const request of requests) {
        assert.equal(request.url, 'https://speed-fixture-3.openai.azure.com/openai/v1/responses');
        assert.equal(request.body.model, 'gpt-6-luna');
        assert.deepEqual(request.body.reasoning, { effort: 'medium', summary: 'auto' });
        assert.equal(request.body.service_tier, 'priority');
      }
      // Without a listed gpt-6-luna deployment the leg skips (never 5.6 Luna).
      process.env.AZURE_FOUNDRY_DEPLOYMENTS_3 = 'gpt-6-sol';
      assert.equal(foundryConfigured(flash), false);
    } finally {
      for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
      __resetFoundryCooldowns();
    }
  });

  await test('rose-1-flash OpenRouter layers run at medium', async () => {
    const requests = await captureLeg(() =>
      waterfallComplete({
        poolSpec: flash,
        messages,
        openrouterKey: 'or-test',
        requestId: 'r',
        reasoningEffort: 'high',
      })
    );
    assert.deepEqual(
      requests.map((r) => [r.body.model, (r.body.reasoning as { effort?: string }).effort]),
      [
        ['qwen/qwen3.8-27b', 'medium'],
        ['google/gemini-3.8-flash', 'medium'],
      ]
    );
  });

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (failures.length > 0) {
    process.stderr.write(
      `\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
    );
    process.exit(1);
  }
  process.stdout.write(`\n✅ ${passed} agent-speed tests passed\n`);
}

void main();
