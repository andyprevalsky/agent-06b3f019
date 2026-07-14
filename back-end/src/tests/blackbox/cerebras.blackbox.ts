#!/usr/bin/env tsx
/**
 * Black-box contract for the exclusive synchronous Chat Cerebras route.
 */

import assert from 'node:assert/strict';

import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

const OK_SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"{\\"reasoning\\":\\"brief\\",\\"response\\":\\"done\\"}"}}]}',
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
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
  process.env.OPENROUTER_API_KEY = 'must-not-run';
  const calls: string[] = [];
  let body: Record<string, unknown> = {};
  let headers: Record<string, string> = {};

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    headers = init?.headers as Record<string, string>;
    return sseResponse(OK_SSE);
  }) as typeof fetch;

  try {
    const chunks = await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
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
        provider_route: 'direct-cerebras',
      })
    );

    assert.deepEqual(calls, [CEREBRAS_API_URL]);
    assert.equal(calls.includes(OPENROUTER_API_URL), false);
    assert.equal(body.model, 'zai-glm-4.7');
    assert.equal(body.stream, true);
    assert.equal(body.clear_thinking, true);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(headers['X-Cerebras-Version-Patch'], '2');
    assert.equal(chunks[0]?.actual_model, 'zai-glm-4.7');
    assert.equal(chunks[0]?.pool_name, 'cerebras-direct');
    assert.equal(chunks.at(-1)?.usage?.cache_read_input_tokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
  }

  process.stdout.write('PASS synchronous Chat uses direct Cerebras GLM-4.7 exclusively\n');
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
