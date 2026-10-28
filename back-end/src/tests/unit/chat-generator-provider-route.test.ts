#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import {
  buildGeneratorCompletionOptions,
  GENERATOR_JSON_SCHEMA,
} from '../../providers/chat/generatorLlm';
import { GENERATOR_SYSTEM_PROMPT } from '../../providers/chat/chatPrompts';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

const GENERATOR_SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"{\\"reasoning\\":\\"fast\\",\\"response\\":\\"hello\\"}"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
  '',
  'data: [DONE]',
  '',
];

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stallingResponse(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!signal) return;
      if (signal.aborted) {
        controller.error(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// OpenRouter's Cerebras Qwen host cannot serve response_format/tools, so a
// static `order` list silently degraded to the first listed endpoint (Wafer,
// 3.9-7.6s to first token) and price balancing picked slow fp4 GLM hosts.
function assertLatencyRanked(body: Record<string, unknown>, label: string): void {
  const provider = body.provider as {
    sort?: unknown;
    order?: unknown;
    only?: unknown;
    require_parameters?: unknown;
  };
  assert.ok(provider, `${label} must carry OpenRouter provider preferences`);
  assert.equal(provider.sort, 'latency', `${label} must rank hosts by live latency`);
  assert.equal(provider.order, undefined, `${label} must not use a static host order`);
  assert.equal(provider.only, undefined, `${label} must not be pinned to one host`);
  assert.equal(
    provider.require_parameters,
    true,
    `${label} must only use hosts that honor the strict schema/tool parameters`
  );
}

async function collect(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function phaseGeneratorOptions() {
  const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
  return buildGeneratorCompletionOptions({
    agentId: 'chat-options-contract',
    model: phases.generator,
    messages: [
      { role: 'system', content: GENERATOR_SYSTEM_PROMPT },
      { role: 'user', content: 'answer this request' },
    ],
    providerRoute: phases.generatorProviderRoute,
    providerFastMode: false,
  });
}

function directGeneratorOptions() {
  return buildGeneratorCompletionOptions({
    agentId: 'chat-options-contract',
    model: 'rose-labs/rose-1-flash',
    messages: [
      { role: 'system', content: GENERATOR_SYSTEM_PROMPT },
      { role: 'user', content: 'answer this request' },
    ],
    providerRoute: 'direct-cerebras',
    providerFastMode: false,
  });
}

async function testPhaseUsesDirectCerebras(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  process.env.OPENROUTER_API_KEY = 'openrouter-must-not-run';
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  const calls: string[] = [];
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== CEREBRAS_API_URL) throw new Error(`Generator leaked to ${url}`);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(GENERATOR_SSE);
  }) as typeof fetch;
  try {
    const options = phaseGeneratorOptions();
    assert.equal(options.provider_route, 'direct-cerebras');
    const chunks = await collect(await createStreamingCompletion(options));
    assert.deepEqual(calls, [CEREBRAS_API_URL]);
    assert.equal(capturedBody.model, 'qwen-3.8-27b');
    assert.equal(capturedBody.temperature, 0.7);
    assert.equal(capturedBody.clear_thinking, undefined);
    assert.equal(capturedBody.reasoning_effort, 'low');
    assert.deepEqual(capturedBody.messages, JSON.parse(JSON.stringify(options.messages)));
    assert.deepEqual(capturedBody.response_format, options.response_format);
    const format = capturedBody.response_format as {
      json_schema?: { name?: string; strict?: boolean; schema?: unknown };
    };
    assert.equal(format.json_schema?.name, 'generator_response');
    assert.equal(format.json_schema?.strict, true);
    assert.deepEqual(format.json_schema?.schema, GENERATOR_JSON_SCHEMA);
    assert.equal(chunks[0]?.actual_model, 'qwen-3.8-27b');
    assert.equal(chunks[0]?.pool_name, 'cerebras-direct');
    assert.equal(calls.includes(OPENROUTER_API_URL), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
  }
}

async function testDirectFailureFallsThroughToWaterfall(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-waterfall';
  const calls: string[] = [];
  let waterfallBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    // Direct Cerebras attempt fails fast, pre-content...
    if (url === CEREBRAS_API_URL) return new Response('provider unavailable', { status: 503 });
    // ...so chat must fall through to the multi-provider OpenRouter waterfall
    // instead of going silent (reproduces prod agent 6d19b666).
    if (url === OPENROUTER_API_URL) {
      waterfallBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(GENERATOR_SSE);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;
  try {
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    assert.ok(
      text.length > 0,
      'a Cerebras stall must fall through and return content, not silence'
    );
    assert.ok(calls.includes(CEREBRAS_API_URL), 'the direct Cerebras attempt should run first');
    assert.ok(
      calls.includes(OPENROUTER_API_URL),
      'chat must fall through to the OpenRouter waterfall after Cerebras fails pre-content'
    );
    assert.deepEqual(
      waterfallBody.reasoning,
      { effort: 'medium' },
      'flash chat fallback runs the OpenRouter layers at the pool medium effort'
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
  }
}

async function testDirectPreHeaderStallFallsThroughToWaterfall(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const oldIdleTimeout = process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS;
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-waterfall';
  process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS = '20';
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    // Direct Cerebras stalls with no model output before the deadline...
    if (url === CEREBRAS_API_URL) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    }
    // ...and the waterfall provider serves the response instead of silence.
    if (url === OPENROUTER_API_URL) return sseResponse(GENERATOR_SSE);
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;
  try {
    const startedAt = Date.now();
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    assert.ok(text.length > 0, 'a pre-header stall must fall through and return content');
    assert.ok(Date.now() - startedAt < 500, 'the stall must surface and fail over promptly');
    assert.ok(calls.includes(CEREBRAS_API_URL), 'the direct Cerebras attempt should run first');
    assert.ok(calls.includes(OPENROUTER_API_URL), 'must fall through to the OpenRouter waterfall');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
    if (oldIdleTimeout === undefined) delete process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS;
    else process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS = oldIdleTimeout;
  }
}

async function testSilentDirectRouteRacesIndependentFallbacks(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const saved = {
    cerebrasKey: process.env.CEREBRAS_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY,
    hedgeMs: process.env.CEREBRAS_CHAT_HEDGE_MS,
    idleTimeoutMs: process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS,
  };
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-fallbacks';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '5';
  process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS = '500';

  const openRouterBodies: Record<string, unknown>[] = [];
  let directSignal: AbortSignal | null | undefined;
  let glmSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) {
      directSignal = init?.signal;
      return stallingResponse(init?.signal);
    }
    if (url === OPENROUTER_API_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      openRouterBodies.push(body);
      if (body.model === 'qwen/qwen3.8-27b') {
        glmSignal = init?.signal;
        return stallingResponse(init?.signal);
      }
      if (body.model === 'z-ai/glm-5.3-flash') return sseResponse(GENERATOR_SSE);
      throw new Error(`Unexpected OpenRouter model ${String(body.model)}`);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;

  try {
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('');
    assert.ok(text.length > 0, 'the independent fallback must rescue both silent Cerebras routes');

    const glmBody = openRouterBodies.find((body) => body.model === 'qwen/qwen3.8-27b');
    const fastBody = openRouterBodies.find((body) => body.model === 'z-ai/glm-5.3-flash');
    assert.ok(glmBody, 'a silent direct route must arm the same-model OpenRouter Cerebras spill');
    assert.ok(fastBody, 'the Cerebras spill must race the measured fast fallback model');
    assert.equal(
      (glmBody.provider as { allow_fallbacks?: boolean }).allow_fallbacks,
      true,
      'the Qwen race branch must be allowed to spill beyond Cerebras'
    );
    assertLatencyRanked(glmBody, 'same-model spill');
    assertLatencyRanked(fastBody, 'fast fallback');
    assert.deepEqual(fastBody.response_format, directGeneratorOptions().response_format);
    assert.deepEqual(
      fastBody.reasoning,
      { effort: 'low' },
      'fast fallback stamps latency-bounded minimal effort as OpenRouter low'
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      directSignal?.aborted,
      true,
      'the winning generic branch must abort direct Cerebras'
    );
    assert.equal(
      glmSignal?.aborted,
      true,
      'the winning generic branch must abort the slow GLM spill'
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ['CEREBRAS_API_KEY', saved.cerebrasKey],
      ['OPENROUTER_API_KEY', saved.openrouterKey],
      ['CEREBRAS_CHAT_HEDGE_MS', saved.hedgeMs],
      ['CEREBRAS_CHAT_IDLE_TIMEOUT_MS', saved.idleTimeoutMs],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testLosingFastFallbackIsAborted(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const saved = {
    cerebrasKey: process.env.CEREBRAS_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY,
    hedgeMs: process.env.CEREBRAS_CHAT_HEDGE_MS,
    idleTimeoutMs: process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS,
  };
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-fallbacks';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '5';
  process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS = '500';

  const openRouterModels: string[] = [];
  let fastSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) return stallingResponse(init?.signal);
    if (url === OPENROUTER_API_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const model = String(body.model);
      openRouterModels.push(model);
      if (model === 'qwen/qwen3.8-27b') return sseResponse(GENERATOR_SSE);
      if (model === 'z-ai/glm-5.3-flash') {
        fastSignal = init?.signal;
        return stallingResponse(init?.signal);
      }
      throw new Error(`Unexpected OpenRouter model ${model}`);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;

  try {
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    assert.ok(chunks.length > 0, 'the winning Qwen spill must produce a reply');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      [...openRouterModels].sort(),
      ['qwen/qwen3.8-27b', 'z-ai/glm-5.3-flash'],
      'the bounded fast fallback must not advance to the general waterfall'
    );
    assert.equal(fastSignal?.aborted, true, 'the losing fast fallback must be aborted');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ['CEREBRAS_API_KEY', saved.cerebrasKey],
      ['OPENROUTER_API_KEY', saved.openrouterKey],
      ['CEREBRAS_CHAT_HEDGE_MS', saved.hedgeMs],
      ['CEREBRAS_CHAT_IDLE_TIMEOUT_MS', saved.idleTimeoutMs],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// Cerebras Qwen is rate-capped hard at the org level (5 req/min across all
// models), so a burst of concurrent chats trips a 402 `quota` before any
// caller-visible content. The fast chat model leads; the separate stalled
// response test verifies the same-model spill starts after the hedge delay.
async function testDirectQuotaFallsOverToOpenRouterGlm(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const saved = {
    cerebras: process.env.CEREBRAS_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    gpt: process.env.GPT_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-fallback';
  // No user OAuth / shared GPT / Anthropic keys — so if the code wrongly dropped
  // to the generic waterfall it would hit an unexpected URL and fail loudly.
  delete process.env.GPT_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const calls: string[] = [];
  const openRouterBodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url === CEREBRAS_API_URL) {
      return new Response(
        JSON.stringify({
          message: 'Payment required to access this resource. Visit your billing tab.',
          type: 'payment_required_error',
          param: 'quota',
          code: 'payment_required',
        }),
        { status: 402, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url === OPENROUTER_API_URL) {
      openRouterBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse(GENERATOR_SSE);
    }
    throw new Error(`Fallover left Gemma-via-OpenRouter and hit a generic provider: ${url}`);
  }) as typeof fetch;
  try {
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    assert.equal(calls[0], CEREBRAS_API_URL, 'Cerebras must be attempted first');
    assert.ok(
      calls.includes(OPENROUTER_API_URL),
      'a Cerebras 402 quota must fall over to OpenRouter'
    );
    assert.deepEqual(
      openRouterBodies.map((body) => body.model),
      ['z-ai/glm-5.3-flash'],
      'a prompt fast reply must avoid a second paid provider request'
    );
    const [fastBody] = openRouterBodies;
    assertLatencyRanked(fastBody, 'quota fallover');
    assert.equal(
      (fastBody.provider as { allow_fallbacks?: boolean }).allow_fallbacks,
      true,
      'quota fallover must be allowed to use any host that meets the latency ranking'
    );
    assert.ok(chunks.length > 0, 'the fallover must still produce a reply');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ['CEREBRAS_API_KEY', saved.cerebras],
      ['OPENROUTER_API_KEY', saved.openrouter],
      ['GPT_API_KEY', saved.gpt],
      ['ANTHROPIC_API_KEY', saved.anthropic],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testDirectRateCapDoesNotWaitOnSlowSameModelSpill(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const saved = {
    cerebras: process.env.CEREBRAS_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    hedgeMs: process.env.CEREBRAS_CHAT_HEDGE_MS,
  };
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-fallback';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '50';
  const openRouterModels: string[] = [];
  let fastStartedAt = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) return new Response('rate cap', { status: 429 });
    if (url === OPENROUTER_API_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const model = String(body.model);
      openRouterModels.push(model);
      if (model === 'qwen/qwen3.8-27b') return stallingResponse(init?.signal);
      if (model === 'z-ai/glm-5.3-flash') {
        fastStartedAt = Date.now();
        return sseResponse(GENERATOR_SSE);
      }
      throw new Error(`Unexpected OpenRouter model ${model}`);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    assert.ok(chunks.length > 0, 'the fast fallback must answer a rate-capped turn');
    assert.ok(
      fastStartedAt - startedAt < 250,
      `the fast fallback must start immediately, not after the hedge delay (${fastStartedAt - startedAt}ms)`
    );
    assert.deepEqual(
      openRouterModels,
      ['z-ai/glm-5.3-flash'],
      'a prompt fast reply must never contact the slow same-model spill'
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ['CEREBRAS_API_KEY', saved.cerebras],
      ['OPENROUTER_API_KEY', saved.openrouter],
      ['CEREBRAS_CHAT_HEDGE_MS', saved.hedgeMs],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testDirectRateCapSilentFastFallbackArmsSameModelHedge(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const saved = {
    cerebras: process.env.CEREBRAS_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    hedgeMs: process.env.CEREBRAS_CHAT_HEDGE_MS,
  };
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-fallback';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '50';
  const openRouterModels: string[] = [];
  let fastSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) return new Response('rate cap', { status: 429 });
    if (url === OPENROUTER_API_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const model = String(body.model);
      openRouterModels.push(model);
      if (model === 'z-ai/glm-5.3-flash') {
        fastSignal = init?.signal;
        return stallingResponse(init?.signal);
      }
      if (model === 'qwen/qwen3.8-27b') return sseResponse(GENERATOR_SSE);
      throw new Error(`Unexpected OpenRouter model ${model}`);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    const elapsedMs = Date.now() - startedAt;
    assert.ok(chunks.length > 0, 'the same-model hedge must rescue a silent fast fallback');
    assert.ok(
      elapsedMs < 2_000,
      `the hedge must answer before the fast stall guard (${elapsedMs}ms)`
    );
    assert.deepEqual(openRouterModels, ['z-ai/glm-5.3-flash', 'qwen/qwen3.8-27b']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fastSignal?.aborted, true, 'the silent fast fallback must be aborted');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ['CEREBRAS_API_KEY', saved.cerebras],
      ['OPENROUTER_API_KEY', saved.openrouter],
      ['CEREBRAS_CHAT_HEDGE_MS', saved.hedgeMs],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testDirectRateCapFastFallbackRejectionStartsSameModelSpill(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const saved = {
    cerebras: process.env.CEREBRAS_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    hedgeMs: process.env.CEREBRAS_CHAT_HEDGE_MS,
  };
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'openrouter-fallback';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '50';
  const openRouterModels: string[] = [];
  let sameModelStartedAt = 0;
  let sameModelBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) return new Response('rate cap', { status: 429 });
    if (url === OPENROUTER_API_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const model = String(body.model);
      openRouterModels.push(model);
      if (model === 'z-ai/glm-5.3-flash') return new Response('fast cap', { status: 429 });
      if (model === 'qwen/qwen3.8-27b') {
        sameModelStartedAt = Date.now();
        sameModelBody = body;
        return sseResponse(GENERATOR_SSE);
      }
      throw new Error(`Unexpected OpenRouter model ${model}`);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    assert.ok(chunks.length > 0, 'the same-model spill must answer when the fast model is capped');
    assert.deepEqual(
      openRouterModels,
      ['z-ai/glm-5.3-flash', 'qwen/qwen3.8-27b'],
      'a rejected fast fallback must hand off to the same-model spill, not the generic waterfall'
    );
    // The generic waterfall requests the same model id with OpenRouter's default
    // price-weighted balancing; only the spill ranks hosts by live latency.
    assertLatencyRanked(sameModelBody, 'same-model spill after a fast rejection');
    assert.ok(
      sameModelStartedAt - startedAt < 250,
      `the same-model spill must start on the fast rejection, not after the hedge delay (${sameModelStartedAt - startedAt}ms)`
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ['CEREBRAS_API_KEY', saved.cerebras],
      ['OPENROUTER_API_KEY', saved.openrouter],
      ['CEREBRAS_CHAT_HEDGE_MS', saved.hedgeMs],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function run(): Promise<void> {
  await testPhaseUsesDirectCerebras();
  await testDirectFailureFallsThroughToWaterfall();
  await testDirectPreHeaderStallFallsThroughToWaterfall();
  await testSilentDirectRouteRacesIndependentFallbacks();
  await testLosingFastFallbackIsAborted();
  await testDirectQuotaFallsOverToOpenRouterGlm();
  await testDirectRateCapDoesNotWaitOnSlowSameModelSpill();
  await testDirectRateCapSilentFastFallbackArmsSameModelHedge();
  await testDirectRateCapFastFallbackRejectionStartsSameModelSpill();
  process.stdout.write(
    'PASS Chat Generator provider routes fall through on Cerebras stalls and rate caps\n'
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
