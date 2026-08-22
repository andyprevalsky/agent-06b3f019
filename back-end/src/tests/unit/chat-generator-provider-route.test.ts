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

async function collect(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function phaseGeneratorOptions() {
  const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
  return buildGeneratorCompletionOptions({
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
    model: 'rose-labs/rose-1-lite',
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
    const chunks = await collect(await createStreamingCompletion(options));
    assert.deepEqual(calls, [CEREBRAS_API_URL]);
    assert.equal(capturedBody.model, 'gemma-4-31b');
    assert.equal(capturedBody.temperature, 0.7);
    assert.equal(capturedBody.clear_thinking, undefined);
    assert.equal(capturedBody.reasoning_effort, 'none');
    assert.deepEqual(capturedBody.messages, options.messages);
    assert.deepEqual(capturedBody.response_format, options.response_format);
    const format = capturedBody.response_format as {
      json_schema?: { name?: string; strict?: boolean; schema?: unknown };
    };
    assert.equal(format.json_schema?.name, 'generator_response');
    assert.equal(format.json_schema?.strict, true);
    assert.deepEqual(format.json_schema?.schema, GENERATOR_JSON_SCHEMA);
    assert.equal(chunks[0]?.actual_model, 'gemma-4-31b');
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
      { effort: 'minimal' },
      'generator fallback must preserve its latency-bounded reasoning effort'
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
      if (body.model === 'google/gemma-4-31b-it') {
        glmSignal = init?.signal;
        return stallingResponse(init?.signal);
      }
      if (body.model === 'google/gemini-2.5-flash-lite') return sseResponse(GENERATOR_SSE);
      throw new Error(`Unexpected OpenRouter model ${String(body.model)}`);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;

  try {
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('');
    assert.ok(text.length > 0, 'the independent fallback must rescue both silent Cerebras routes');

    const glmBody = openRouterBodies.find((body) => body.model === 'google/gemma-4-31b-it');
    const fastBody = openRouterBodies.find((body) => body.model === 'google/gemini-2.5-flash-lite');
    assert.ok(glmBody, 'a silent direct route must arm the same-model OpenRouter Cerebras spill');
    assert.ok(fastBody, 'the Cerebras spill must race the measured fast fallback model');
    assert.equal(
      (glmBody.provider as { allow_fallbacks?: boolean }).allow_fallbacks,
      true,
      'the GLM race branch must be allowed to spill beyond Cerebras'
    );
    assert.deepEqual(fastBody.response_format, directGeneratorOptions().response_format);
    assert.equal(
      fastBody.reasoning,
      undefined,
      'the fast fallback must not opt into slow provider reasoning'
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
      if (model === 'google/gemma-4-31b-it') return sseResponse(GENERATOR_SSE);
      if (model === 'google/gemini-2.5-flash-lite') {
        fastSignal = init?.signal;
        return stallingResponse(init?.signal);
      }
      throw new Error(`Unexpected OpenRouter model ${model}`);
    }
    throw new Error(`Unexpected route ${url}`);
  }) as typeof fetch;

  try {
    const chunks = await collect(await createStreamingCompletion(directGeneratorOptions()));
    assert.ok(chunks.length > 0, 'the winning GLM spill must produce a reply');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      openRouterModels,
      ['google/gemma-4-31b-it', 'google/gemini-2.5-flash-lite'],
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

// Cerebras GLM-4.7 is rate-capped hard at the org level (5 req/min across all
// models), so a burst of concurrent chats trips a 402 `quota` before any
// caller-visible content. That must NOT sink the chat AND must NOT drop to a
// generic model: the request falls over to the SAME model (GLM-4.7) via
// OpenRouter with the provider unpinned — OpenRouter still prefers Cerebras but
// may spill to another GLM-4.7 host past the cap.
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
  let openRouterBody: Record<string, unknown> = {};
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
      openRouterBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
    // Same model — never a generic one.
    assert.equal(
      openRouterBody.model,
      'google/gemma-4-31b-it',
      'fallover must stay on Gemma-4-31B'
    );
    // Provider unpinned: still prefer Cerebras, but allowed to spill past the cap.
    const provider = openRouterBody.provider as {
      order?: string[];
      allow_fallbacks?: boolean;
      only?: string[];
    };
    assert.deepEqual(provider.order, ['cerebras'], 'fallover should still prefer Cerebras');
    assert.equal(
      provider.allow_fallbacks,
      true,
      'fallover must allow spill to another Gemma-4-31B host'
    );
    assert.equal(provider.only, undefined, 'fallover must not be pinned to Cerebras only');
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

async function run(): Promise<void> {
  await testPhaseUsesDirectCerebras();
  await testDirectFailureFallsThroughToWaterfall();
  await testDirectPreHeaderStallFallsThroughToWaterfall();
  await testSilentDirectRouteRacesIndependentFallbacks();
  await testLosingFastFallbackIsAborted();
  await testDirectQuotaFallsOverToOpenRouterGlm();
  process.stdout.write(
    'PASS Chat Generator provider routes fall through on Cerebras stalls and rate caps\n'
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
