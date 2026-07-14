#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import {
  ANTHROPIC_API_URL,
  CEREBRAS_API_URL,
  OPENROUTER_API_URL,
} from '../../providers/rose/transport';

const RESPONSES_OK_SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"{\\"reasoning\\":\\"route\\",\\"action\\":\\"direct_answer\\",\\"query\\":\\"\\",\\"goal\\":\\"\\",\\"mode\\":\\"plan\\"}"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
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

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldGptKey = process.env.GPT_API_KEY;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.GPT_API_KEY = 'shared-router-priority';
  process.env.CEREBRAS_API_KEY = 'direct-cerebras-failover';
  process.env.ANTHROPIC_API_KEY = 'anthropic-must-not-run';
  process.env.OPENROUTER_API_KEY = 'openrouter-cerebras-priority';
  const calls: string[] = [];
  let capturedBody: Record<string, unknown> = {};
  let capturedHeaders: Record<string, string> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== OPENROUTER_API_URL) throw new Error(`Router leaked to ${url}`);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    capturedHeaders = init?.headers as Record<string, string>;
    return sseResponse(RESPONSES_OK_SSE);
  }) as typeof fetch;

  try {
    const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
    assert.equal(phases.router, 'rose-labs/rose-1-lite');
    assert.equal(phases.routerProviderRoute, 'direct-cerebras');
    assert.equal(phases.generator, 'rose-labs/rose-1-lite');
    assert.equal(phases.generatorProviderRoute, 'direct-cerebras');
    const chunks = await collect(
      await createStreamingCompletion({
        model: phases.router,
        messages: [
          { role: 'system', content: 'exact-router-system-prompt' },
          { role: 'user', content: 'route this request' },
        ],
        temperature: 0.3,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'router_decision',
            strict: true,
            schema: {
              type: 'object',
              properties: { action: { type: 'string' } },
              required: ['action'],
              additionalProperties: false,
            },
          },
        },
        provider_route: 'openrouter-cerebras',
      })
    );

    assert.deepEqual(calls, [OPENROUTER_API_URL]);
    assert.equal(calls.includes(CEREBRAS_API_URL), false);
    assert.equal(capturedBody.model, 'z-ai/glm-4.7');
    assert.equal(capturedBody.stream, true);
    assert.deepEqual(capturedBody.reasoning, { effort: 'none', exclude: true });
    assert.deepEqual(capturedBody.provider, {
      only: ['cerebras'],
      allow_fallbacks: false,
      require_parameters: true,
    });
    assert.deepEqual(capturedBody.messages, [
      { role: 'system', content: 'exact-router-system-prompt' },
      { role: 'user', content: 'route this request' },
    ]);
    const format = capturedBody.response_format as {
      json_schema?: { name?: string; strict?: boolean };
    };
    assert.equal(format.json_schema?.name, 'router_decision');
    assert.equal(format.json_schema?.strict, true);
    assert.equal(capturedHeaders.Authorization, 'Bearer openrouter-cerebras-priority');
    assert.equal(chunks[0]?.actual_model, 'z-ai/glm-4.7');
    assert.equal(chunks[0]?.pool_name, 'openrouter-cerebras');
    assert.notEqual(ANTHROPIC_API_URL, CEREBRAS_API_URL);

    calls.length = 0;
    let directBody: Record<string, unknown> = {};
    let directHeaders: Record<string, string> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === OPENROUTER_API_URL) {
        return new Response('{"error":{"message":"Cerebras rate limited"}}', {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url !== CEREBRAS_API_URL) throw new Error(`Failover leaked to ${url}`);
      directBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      directHeaders = init?.headers as Record<string, string>;
      return sseResponse(RESPONSES_OK_SSE);
    }) as typeof fetch;

    const failoverChunks = await collect(
      await createStreamingCompletion({
        model: phases.generator,
        messages: [
          { role: 'system', content: 'exact-generator-system-prompt' },
          { role: 'user', content: 'generate this response' },
        ],
        provider_route: 'openrouter-cerebras',
      })
    );
    assert.deepEqual(calls, [OPENROUTER_API_URL, CEREBRAS_API_URL]);
    assert.equal(directBody.model, 'zai-glm-4.7');
    assert.equal(directBody.clear_thinking, true);
    assert.equal(directBody.reasoning_effort, 'none');
    assert.equal(directHeaders.Authorization, 'Bearer direct-cerebras-failover');
    assert.equal(failoverChunks[0]?.actual_model, 'zai-glm-4.7');
    assert.equal(failoverChunks[0]?.pool_name, 'cerebras-direct');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldGptKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = oldGptKey;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
  }

  process.stdout.write(
    'PASS Chat uses OpenRouter pinned to Cerebras with direct same-model pre-content failover\n'
  );
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
