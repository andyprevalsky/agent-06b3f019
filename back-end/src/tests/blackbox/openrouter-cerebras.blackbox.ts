#!/usr/bin/env tsx
/**
 * Black-box contract for synchronous Chat routed through OpenRouter to only
 * Cerebras. The request must never use another OpenRouter provider or model.
 */

import assert from 'node:assert/strict';

import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

const OK_SSE = [
  'data: {"model":"google/gemma-4-31b-it","provider":"Cerebras","choices":[{"index":0,"delta":{"content":"{\\"reasoning\\":\\"brief\\",\\"response\\":\\"done\\"}"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":3}}}',
  '',
  'data: [DONE]',
  '',
];

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      lines.forEach((line) => controller.enqueue(encoder.encode(`${line}\n`)));
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
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
  process.env.CEREBRAS_API_KEY = 'must-not-run';
  const calls: string[] = [];
  let body: Record<string, unknown> = {};

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(OK_SSE);
  }) as typeof fetch;

  try {
    const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
    const chunks = await collect(
      await createStreamingCompletion({
        model: phases.generator,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'reply' },
        ],
        temperature: 0.7,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'generator_response',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                reasoning: { type: 'string' },
                response: { type: 'string' },
              },
              required: ['reasoning', 'response'],
              additionalProperties: false,
            },
          },
        },
        provider_route: 'openrouter-cerebras',
      })
    );

    assert.deepEqual(calls, [OPENROUTER_API_URL]);
    assert.equal(calls.includes(CEREBRAS_API_URL), false);
    assert.equal(body.model, 'google/gemma-4-31b-it');
    assert.deepEqual(body.reasoning, { effort: 'none', exclude: true });
    assert.deepEqual(body.provider, {
      only: ['cerebras'],
      allow_fallbacks: false,
      require_parameters: true,
    });
    assert.equal(chunks[0]?.actual_model, 'google/gemma-4-31b-it');
    assert.equal(chunks[0]?.pool_name, 'openrouter-cerebras');
    assert.equal(chunks.at(-1)?.usage?.cache_read_input_tokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
  }

  process.stdout.write('PASS synchronous Chat uses only Cerebras through OpenRouter\n');
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
