#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  buildGeneratorCompletionOptions,
  GENERATOR_JSON_SCHEMA,
} from '../../providers/chat/generatorLlm';
import { GENERATOR_SYSTEM_PROMPT } from '../../providers/chat/chatPrompts';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import {
  ANTHROPIC_API_URL,
  OPENAI_RESPONSES_API_URL,
  OPENROUTER_API_URL,
} from '../../providers/rose/transport';

const GENERATOR_SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"{\\"reasoning\\":\\"fast\\",\\"response\\":\\"hello\\"}"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
  '',
  'data: [DONE]',
  '',
];

function sseResponse(lines: string[], failAfterLines = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      if (failAfterLines) controller.error(new Error('midstream disconnect'));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function generatorOptions() {
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

async function testExactExclusiveGeminiRequest(): Promise<void> {
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'generator-openrouter';
  process.env.GPT_API_KEY = 'openai-must-not-run';
  process.env.ANTHROPIC_API_KEY = 'anthropic-must-not-run';
  const calls: string[] = [];
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== OPENROUTER_API_URL) throw new Error(`Generator leaked to ${url}`);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(GENERATOR_SSE);
  }) as typeof fetch;
  try {
    const options = generatorOptions();
    const chunks = await collect(await createStreamingCompletion(options));
    assert.deepEqual(calls, [OPENROUTER_API_URL]);
    assert.equal(capturedBody.model, 'google/gemini-3.5-flash');
    assert.equal(capturedBody.temperature, 0.7);
    assert.deepEqual(capturedBody.messages, options.messages);
    assert.deepEqual(capturedBody.response_format, options.response_format);
    const format = capturedBody.response_format as {
      json_schema?: { name?: string; strict?: boolean; schema?: unknown };
    };
    assert.equal(format.json_schema?.name, 'generator_response');
    assert.equal(format.json_schema?.strict, true);
    assert.deepEqual(format.json_schema?.schema, GENERATOR_JSON_SCHEMA);
    assert.equal(Object.hasOwn(capturedBody, 'reasoning'), false, 'no effort invented');
    assert.equal(chunks[0]?.actual_model, 'google/gemini-3.5-flash');
    assert.equal(chunks[0]?.pool_name, 'rose-1-lite');
    assert.equal(calls.includes(OPENAI_RESPONSES_API_URL), false);
    assert.equal(calls.includes(ANTHROPIC_API_URL), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testFallbackBoundary(): Promise<void> {
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'generator-openrouter';
  let models: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    assert.equal(url, OPENROUTER_API_URL);
    const body = JSON.parse(String(init?.body)) as { model: string };
    models.push(body.model);
    if (models.length === 1) return new Response('provider unavailable', { status: 503 });
    return sseResponse(GENERATOR_SSE);
  }) as typeof fetch;
  try {
    const chunks = await collect(await createStreamingCompletion(generatorOptions()));
    assert.deepEqual(models, ['google/gemini-3.5-flash', 'moonshotai/kimi-k2.7-code']);
    assert.equal(chunks[0]?.actual_model, 'moonshotai/kimi-k2.7-code');

    models = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      return sseResponse([GENERATOR_SSE[0], ''], true);
    }) as typeof fetch;
    await assert.rejects(
      async () => collect(await createStreamingCompletion(generatorOptions())),
      /midstream disconnect/
    );
    assert.deepEqual(models, ['google/gemini-3.5-flash'], 'never splice providers midstream');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  }
}

async function run(): Promise<void> {
  await testExactExclusiveGeminiRequest();
  await testFallbackBoundary();
  process.stdout.write('PASS Chat Generator exclusive Gemini-to-Kimi OpenRouter waterfall\n');
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
