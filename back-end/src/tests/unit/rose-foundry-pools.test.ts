#!/usr/bin/env tsx

/**
 * Flash falls back to Azure gpt-6-luna; mini and browser-use retain gpt-5.6-luna.
 * Speed pools keep their direct Cerebras hop first; Foundry serves only after it
 * fails before content. The shared Sol deployment list never receives Luna.
 */

import assert from 'node:assert/strict';

import { createStreamingCompletion } from '../../providers/rose';
import {
  FOUNDRY_REGION_ENV_NAMES,
  foundryRegions,
  foundryRoutePlan,
} from '../../providers/rose/foundry';
import { POOL_REGISTRY } from '../../providers/rose/pools';
import { CEREBRAS_API_URL } from '../../providers/rose/transport';

const FOUNDRY_URL = 'https://a-4989-resource.openai.azure.com/openai/v1/responses';

const foundrySse =
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'luna ok' })}\n\n` +
  `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n` +
  'data: [DONE]\n\n';

const cerebrasSse =
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'from-cerebras' }, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
  'data: [DONE]\n\n';

/** Region-1 deployment order for a route key (the tests configure only region 1). */
const orderedFoundryDeployments = (model: string, routeKey: string): string[] =>
  foundryRoutePlan(foundryRegions(), model, routeKey).map(({ deployment }) => deployment);

async function main(): Promise<void> {
  const envKeys = [
    ...FOUNDRY_REGION_ENV_NAMES,
    'CEREBRAS_API_KEY',
    'GPT_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol';
  process.env.CEREBRAS_API_KEY = 'csk-test';
  process.env.OPENROUTER_API_KEY = 'ork-test';
  delete process.env.GPT_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const attempts: string[] = [];
  const foundryModels: string[] = [];
  const foundryEfforts: string[] = [];
  let cerebrasStatus = 200;
  // 0 = the pool pipeline must never reach OpenRouter; otherwise its status.
  let openRouterStatus = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === CEREBRAS_API_URL) {
      attempts.push('cerebras');
      if (cerebrasStatus === 200) return new Response(cerebrasSse, { status: 200 });
      return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
        status: cerebrasStatus,
      });
    }
    if (url === FOUNDRY_URL) {
      attempts.push('foundry');
      const body = JSON.parse(String(init?.body)) as {
        model: unknown;
        reasoning?: { effort?: unknown };
      };
      foundryModels.push(String(body.model));
      foundryEfforts.push(String(body.reasoning?.effort));
      return new Response(foundrySse, { status: 200 });
    }
    if (url.includes('openrouter.ai')) {
      attempts.push('openrouter');
      if (openRouterStatus === 0) {
        return new Response('OpenRouter must not be reached', { status: 500 });
      }
      return new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
        status: openRouterStatus,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const run = async (model: string, providerRoute?: 'direct-cerebras' | 'openrouter-waterfall') => {
    const stream = await createStreamingCompletion({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      route_key: 'agent-1',
      ...(providerRoute ? { provider_route: providerRoute } : {}),
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  };
  const text = (chunks: Awaited<ReturnType<typeof run>>) =>
    chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('');

  try {
    for (const pool of ['rose-1-mini', 'rose-1-flash', 'rose-1-browser-use'] as const) {
      assert.equal(POOL_REGISTRY[pool].foundryEnabled, true, pool);
      assert.deepEqual(
        orderedFoundryDeployments(
          POOL_REGISTRY[pool].foundryModel ?? POOL_REGISTRY[pool].gptAuthModel,
          'agent-1'
        ),
        [pool === 'rose-1-flash' ? 'gpt-6-luna' : 'gpt-5.6-luna']
      );
    }
    assert.deepEqual(orderedFoundryDeployments('gpt-6-sol', 'agent-1'), ['gpt-6-sol']);

    let chunks = await run('rose-labs/rose-1-flash');
    assert.deepEqual(attempts, ['cerebras'], 'a healthy Cerebras hop stays primary');
    assert.equal(text(chunks), 'from-cerebras');

    cerebrasStatus = 402;
    for (const pool of ['rose-labs/rose-1-flash', 'rose-labs/rose-1-browser-use']) {
      attempts.length = 0;
      chunks = await run(pool);
      assert.deepEqual(attempts, ['cerebras', 'foundry'], pool);
      assert.equal(
        chunks[0]?.actual_model,
        pool === 'rose-labs/rose-1-flash' ? 'gpt-6-luna-foundry' : 'gpt-5.6-luna-foundry',
        pool
      );
      assert.equal(text(chunks), 'luna ok', pool);
    }

    attempts.length = 0;
    chunks = await run('rose-labs/rose-1-mini');
    assert.deepEqual(attempts, ['foundry']);
    assert.equal(chunks[0]?.actual_model, 'gpt-5.6-luna-foundry');
    assert.deepEqual(foundryModels, ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna']);
    // A fallback layer keeps the pool's fast effort; xhigh TTFT is slow on fast GPT layers.
    assert.deepEqual(foundryEfforts, ['medium', 'low', 'low']);

    // Chat-exclusive routes end at OpenRouter; with Cerebras and OpenRouter both
    // out of credit, funded Azure serves the turn as the last resort.
    openRouterStatus = 402;
    for (const route of ['direct-cerebras', 'openrouter-waterfall'] as const) {
      attempts.length = 0;
      chunks = await run('rose-labs/rose-1-flash', route);
      assert.equal(attempts.at(-1), 'foundry', route);
      assert(attempts.includes('openrouter'), route);
      assert.equal(attempts.filter((name) => name === 'foundry').length, 1, route);
      assert.equal(chunks[0]?.actual_model, 'gpt-6-luna-foundry', route);
      assert.equal(text(chunks), 'luna ok', route);
    }
    process.stdout.write(
      'Foundry Luna backs mini and speed pools after Cerebras, before OpenRouter\n'
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
