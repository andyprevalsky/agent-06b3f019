#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { prisma } from '../../providers/database';
import { createStreamingCompletion } from '../../providers/rose';
import {
  FOUNDRY_REGION_ENV_NAMES,
  __resetFoundryCooldowns,
  foundryComplete,
  foundryRegions,
  foundryRoutePlan,
} from '../../providers/rose/foundry';
import { buildCodexResponsesBody, openAiApiKeyComplete } from '../../providers/rose/gptAuth';
import { RosePaymentRequiredError, RoseRateLimitError } from '../../providers/rose/errors';
import { POOL_REGISTRY } from '../../providers/rose/pools';
import type { CompletionMessage, ResponseFormat } from '../../providers/rose/types';

const sse = (text: string): string =>
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
  `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n` +
  'data: [DONE]\n\n';

/** Region-1 deployment order for a route key (the tests configure only region 1). */
const orderedFoundryDeployments = (model: string, routeKey: string): string[] =>
  foundryRoutePlan(foundryRegions(), model, routeKey).map(({ deployment }) => deployment);

const TEST_AUTHORITY = 'https://foundry-authority.example.test';
const TEST_AUTHORITY_KEY = 'fixture-authority-key';

/** Exercise the real shared-cooldown client without contacting a DB or authority. */
function withSharedAuthority(providerFetch: typeof fetch): typeof fetch {
  const cooldowns: Record<
    string,
    { strikes: number; remainingSeconds: number; rateLimitedUntil: string }
  > = {};
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== TEST_AUTHORITY) {
      assert(
        [
          'https://a-4989-resource.openai.azure.com',
          'https://openrouter.ai',
          'https://api.openai.com',
        ].includes(url.origin),
        `Unexpected fixture endpoint: ${url.origin}`
      );
      return providerFetch(input, init);
    }
    assert.equal((init?.headers as Record<string, string>)['X-API-Key'], TEST_AUTHORITY_KEY);
    assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/json');
    if (url.pathname === '/api/integrations/compute-code/foundry-deployment/cooldown') {
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      const keys = (url.searchParams.get('keys') ?? '').split(',');
      assert(keys.length > 0 && keys.every((key) => key.includes(':gpt-6-sol')));
      return Response.json({
        cooldowns: Object.fromEntries(
          keys.filter((key) => cooldowns[key]).map((key) => [key, cooldowns[key]])
        ),
      });
    }
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as {
      type?: string;
      source?: string;
      region: string;
      deployment: string;
      retryAfterSeconds?: number;
    };
    assert.equal(body.region, 'a-4989-resource.openai.azure.com');
    const key = `${body.region}:${body.deployment}`;
    if (url.pathname === '/api/integrations/compute-code/foundry-deployment/served') {
      delete cooldowns[key];
      return Response.json({ reset: true });
    }
    assert.equal(url.pathname, '/api/integrations/compute-code/token/rate-limited');
    assert.equal(body.type, 'foundry');
    assert.equal(body.source, 'pool');
    const seconds = body.retryAfterSeconds ?? 30;
    assert(Number.isFinite(seconds) && seconds > 0);
    const state = {
      strikes: 1,
      remainingSeconds: seconds,
      rateLimitedUntil: new Date(Date.now() + seconds * 1000).toISOString(),
    };
    cooldowns[key] = state;
    return Response.json(state);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(
    [
      ...FOUNDRY_REGION_ENV_NAMES,
      'GPT_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'COMPUTE_TOKEN_AUTHORITY_URL',
      'COMPUTE_TOKEN_AUTHORITY_API_KEY',
    ].map((key) => [key, process.env[key]])
  );
  // Region 1 only: a developer .env may configure AZURE_FOUNDRY_*_2.._9.
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  __resetFoundryCooldowns();
  process.env.COMPUTE_TOKEN_AUTHORITY_URL = TEST_AUTHORITY;
  process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY = TEST_AUTHORITY_KEY;
  // The 429 cases persist a deployment cooldown (up to the 5-minute rung) in the local
  // database; clear this region's rows too, so a rerun starts from the same clean slate.
  await prisma.integration.deleteMany({
    where: {
      userId: '00000000-0000-0000-0000-000000000000',
      name: 'foundry_deployment_cooldown',
      accountId: { startsWith: 'a-4989-resource.openai.azure.com:' },
    },
  });
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6.1-sol,gpt-6.1-sol-b';
  delete process.env.GPT_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const attempts: string[] = [];
  globalThis.fetch = withSharedAuthority((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    assert.equal(String(input), 'https://a-4989-resource.openai.azure.com/openai/v1/responses');
    assert.equal((init?.headers as Record<string, string>)['api-key'], 'test-key');
    assert.equal(init?.redirect, 'manual');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    attempts.push(String(body.model));
    assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.service_tier, 'priority');
    if (attempts.length === 1)
      return new Response('', { status: 429, headers: { 'retry-after-ms': '2000' } });
    return new Response(sse('Hi'), { status: 200 });
  }) as typeof fetch);

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'Say hi' }],
      effort: 'high',
      speed: 'fast',
      route_key: 'agent-1',
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], orderedFoundryDeployments('gpt-6.1-sol', 'agent-1')[0]);
    assert.notEqual(attempts[0], attempts[1]);
    assert.equal(chunks[0]?.actual_model, 'gpt-6.1-sol-foundry');
    assert.equal(chunks[0]?.pool_name, 'foundry');
    assert.equal(chunks[0]?.choices[0]?.delta.content, 'Hi');
    assert.deepEqual(orderedFoundryDeployments('gpt-6.1-sol', 'agent-1').sort(), [
      'gpt-6.1-sol',
      'gpt-6.1-sol-b',
    ]);
    process.stdout.write('Foundry fallback: 429 spill, Responses shape and provenance passed\n');

    // Compare the complete HTTP body against the GPT compute-token builder,
    // including instructions, input, cache key, tools/JSON, effort and tier.
    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6.1-sol-parity';
    const poolSpec = POOL_REGISTRY['rose-1-ultra'];
    const messages: CompletionMessage[] = [
      { role: 'system', content: 'Follow the supplied response contract.' },
      { role: 'user', content: 'Return the result.' },
    ];
    const schema: ResponseFormat = {
      type: 'json_schema',
      json_schema: {
        name: 'result',
        strict: true,
        schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    };
    const tools = [
      {
        name: 'answer',
        description: 'Return the result',
        parameters: schema.json_schema?.schema,
        strict: true,
      },
    ];
    for (const scenario of [
      {
        name: 'strict-json',
        responseFormat: schema,
        tools: undefined,
        toolChoice: undefined,
        fast: true,
      },
      {
        name: 'forced-tool',
        responseFormat: undefined,
        tools,
        toolChoice: { type: 'function', name: 'answer' },
        fast: false,
      },
    ]) {
      let captured: Record<string, unknown> | undefined;
      globalThis.fetch = withSharedAuthority((async (
        _input: string | URL | Request,
        init?: RequestInit
      ) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(sse('ok'), { status: 200 });
      }) as typeof fetch);
      const requestId = `parity-${scenario.name}`;
      const opts = {
        poolSpec,
        messages,
        responseFormat: scenario.responseFormat,
        tools: scenario.tools,
        toolChoice: scenario.toolChoice,
        temperature: 0.7,
        effort: 'xhigh',
        speed: scenario.fast ? ('fast' as const) : ('standard' as const),
        requestId,
        routeKey: 'agent-parity',
      };
      for await (const _chunk of foundryComplete(opts)) {
        void _chunk; // Drain the stream so the HTTP request and parser finish.
      }
      assert(captured);
      assert.deepEqual(
        captured,
        buildCodexResponsesBody({
          ...opts,
          modelOverride: 'gpt-6.1-sol-parity',
          ...(scenario.fast ? { serviceTier: 'priority' as const } : {}),
        })
      );
      assert(!('temperature' in captured), 'GPT compute also omits temperature');
    }
    process.stdout.write('Foundry payload: exact GPT compute body parity passed\n');

    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6.1-sol-third';
    process.env.OPENROUTER_API_KEY = 'test-openrouter';
    const hosts: string[] = [];
    globalThis.fetch = withSharedAuthority((async (input: string | URL | Request) => {
      const host = new URL(String(input)).host;
      hosts.push(host);
      if (host.endsWith('azure.com')) return new Response('', { status: 429 });
      assert.equal(host, 'openrouter.ai');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenRouter' }, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200 }
      );
    }) as typeof fetch);
    const fallback = await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    const fallbackChunks = [];
    for await (const chunk of fallback) fallbackChunks.push(chunk);
    assert.deepEqual(hosts, ['a-4989-resource.openai.azure.com', 'openrouter.ai']);
    assert.equal(fallbackChunks[0]?.choices[0]?.delta.content, 'OpenRouter');
    process.stdout.write('Foundry ceiling: pre-content 429 falls through to OpenRouter\n');

    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6.1-sol-reader-a,gpt-6.1-sol-reader-b';
    const readerAttempts: string[] = [];
    globalThis.fetch = withSharedAuthority((async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      readerAttempts.push(String((JSON.parse(String(init?.body)) as { model: string }).model));
      if (readerAttempts.length === 1)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('reader failed before content'));
            },
          }),
          { status: 200 }
        );
      return new Response(sse('Recovered'), { status: 200 });
    }) as typeof fetch);
    const recovered = [];
    for await (const chunk of foundryComplete({
      poolSpec: POOL_REGISTRY['rose-1-ultra'],
      messages: [{ role: 'user', content: 'Say hi' }],
      requestId: 'reader-error-probe',
      routeKey: 'agent-1',
    }))
      recovered.push(chunk);
    assert.equal(readerAttempts.length, 2);
    assert.equal(recovered.find((chunk) => chunk.kind === 'content')?.data.text, 'Recovered');
    process.stdout.write('Foundry reader: pre-content failure tries next deployment\n');

    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6.1-sol-partial-a,gpt-6.1-sol-partial-b';
    const partialAttempts: string[] = [];
    globalThis.fetch = withSharedAuthority((async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      partialAttempts.push(String((JSON.parse(String(init?.body)) as { model: string }).model));
      let reads = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (reads++ === 0)
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial' })}\n\n`
                  )
                );
              else controller.error(new Error('reader failed after content'));
            },
          },
          { highWaterMark: 0 }
        ),
        { status: 200 }
      );
    }) as typeof fetch);
    const partialChunks = [];
    await assert.rejects(async () => {
      for await (const chunk of foundryComplete({
        poolSpec: POOL_REGISTRY['rose-1-ultra'],
        messages: [{ role: 'user', content: 'Say hi' }],
        requestId: 'partial-reader-probe',
        routeKey: 'agent-1',
      }))
        partialChunks.push(chunk);
    }, /reader failed after content/);
    assert.equal(partialAttempts.length, 1);
    assert.equal(partialChunks.find((chunk) => chunk.kind === 'content')?.data.text, 'Partial');
    process.stdout.write('Foundry reader: post-content failure never splices deployments\n');

    for (const code of [
      'insufficient_quota',
      'credit_balance_exhausted',
      'organization_usage_limit_exceeded',
      'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded',
    ]) {
      let calls = 0;
      globalThis.fetch = withSharedAuthority((async () => {
        calls++;
        return new Response(JSON.stringify({ error: { code } }), { status: 429 });
      }) as typeof fetch);
      await assert.rejects(async () => {
        for await (const _ of openAiApiKeyComplete({
          poolSpec: POOL_REGISTRY['rose-1-ultra'],
          model: 'gpt-6.1-sol',
          messages: [{ role: 'user', content: 'hi' }],
          openAiKey: 'test-key',
          requestId: `credit-${code}`,
        })) {
          void _;
        }
      }, RosePaymentRequiredError);
      assert.equal(calls, 1, `${code}: no retry`);
    }
    globalThis.fetch = withSharedAuthority(
      (async () =>
        new Response(
          'event: error\ndata: {"type":"error","error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining"}}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )) as typeof fetch
    );
    await assert.rejects(async () => {
      for await (const _ of openAiApiKeyComplete({
        poolSpec: POOL_REGISTRY['rose-1-ultra'],
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'hi' }],
        openAiKey: 'test-key',
        requestId: 'in-band-credit',
      })) {
        void _;
      }
    }, RosePaymentRequiredError);
    globalThis.fetch = withSharedAuthority(
      (async () =>
        new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
          status: 429,
          headers: { 'retry-after': '60' },
        })) as typeof fetch
    );
    await assert.rejects(async () => {
      for await (const _ of openAiApiKeyComplete({
        poolSpec: POOL_REGISTRY['rose-1-ultra'],
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'hi' }],
        openAiKey: 'test-key',
        requestId: 'ordinary-rate-limit',
      })) {
        void _;
      }
    }, RoseRateLimitError);
    let nonObjectCalls = 0;
    globalThis.fetch = withSharedAuthority((async () => {
      nonObjectCalls++;
      return new Response('null', { status: 429, headers: { 'retry-after': '60' } });
    }) as typeof fetch);
    await assert.rejects(async () => {
      for await (const _ of openAiApiKeyComplete({
        poolSpec: POOL_REGISTRY['rose-1-ultra'],
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'hi' }],
        openAiKey: 'test-key',
        requestId: 'non-object-rate-limit',
      })) {
        void _;
      }
    }, RoseRateLimitError);
    assert.equal(nonObjectCalls, 1, 'non-object error body remains an ordinary 429');
    process.stdout.write('GPT key: credit 429s cool; ordinary 429 stays transient\n');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
