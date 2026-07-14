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
    assert.equal(capturedBody.model, 'zai-glm-4.7');
    assert.equal(capturedBody.temperature, 0.7);
    assert.equal(capturedBody.clear_thinking, true);
    assert.equal(capturedBody.reasoning_effort, 'none');
    assert.deepEqual(capturedBody.messages, options.messages);
    assert.deepEqual(capturedBody.response_format, options.response_format);
    const format = capturedBody.response_format as {
      json_schema?: { name?: string; strict?: boolean; schema?: unknown };
    };
    assert.equal(format.json_schema?.name, 'generator_response');
    assert.equal(format.json_schema?.strict, true);
    assert.deepEqual(format.json_schema?.schema, GENERATOR_JSON_SCHEMA);
    assert.equal(chunks[0]?.actual_model, 'zai-glm-4.7');
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

async function testDirectFailureSurfacesWithoutFallback(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'must-not-run';
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== CEREBRAS_API_URL) throw new Error(`Direct route leaked to ${url}`);
    return new Response('provider unavailable', { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      async () => collect(await createStreamingCompletion(directGeneratorOptions())),
      /Cerebras 503/
    );
    assert.deepEqual(calls, [CEREBRAS_API_URL]);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
  }
}

async function testDirectPreHeaderStallSurfacesPromptlyWithoutFallback(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const oldIdleTimeout = process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS;
  process.env.CEREBRAS_API_KEY = 'direct-cerebras';
  process.env.OPENROUTER_API_KEY = 'must-not-run';
  process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS = '20';
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== CEREBRAS_API_URL) throw new Error(`Direct route leaked to ${url}`);
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason ?? new Error('aborted')),
        { once: true }
      );
    });
  }) as typeof fetch;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      async () => collect(await createStreamingCompletion(directGeneratorOptions())),
      /no model output within 20ms/
    );
    assert.ok(Date.now() - startedAt < 250, 'pre-header stall must surface promptly');
    assert.deepEqual(calls, [CEREBRAS_API_URL]);
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

async function run(): Promise<void> {
  await testPhaseUsesDirectCerebras();
  await testDirectFailureSurfacesWithoutFallback();
  await testDirectPreHeaderStallSurfacesPromptlyWithoutFallback();
  process.stdout.write('PASS Chat Generator provider routes are explicit and fail closed\n');
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
