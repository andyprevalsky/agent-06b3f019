#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createStreamingCompletion } from '../../providers/rose';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

function delayedCompletion(
  content: string,
  firstContentMs: number,
  finishMs: number,
  signal: AbortSignal | undefined,
  onAbort: () => void
): Response {
  const encodedContent = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`
  );
  const encodedDone = new TextEncoder().encode('data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const first = setTimeout(() => controller.enqueue(encodedContent), firstContentMs);
      const done = setTimeout(() => {
        controller.enqueue(encodedDone);
        controller.close();
      }, finishMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(first);
          clearTimeout(done);
          onAbort();
          controller.error(new Error('losing provider cancelled'));
        },
        { once: true }
      );
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalHedgeMs = process.env.CEREBRAS_CHAT_HEDGE_MS;
  process.env.CEREBRAS_API_KEY = 'generator-race-test';
  process.env.OPENROUTER_API_KEY = 'generator-race-test';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '0';
  let glmAborted = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) {
      return new Response('{"message":"token quota exceeded"}', { status: 429 });
    }
    assert.equal(url, OPENROUTER_API_URL);
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    if (model === 'qwen/qwen3.8-27b') {
      return delayedCompletion(
        '{"reasoning":"","response":"qwen finished first"}',
        650,
        750,
        init?.signal ?? undefined,
        () => undefined
      );
    }
    assert.equal(model, 'z-ai/glm-5.3-flash');
    return delayedCompletion(
      '{"reasoning":"","response":"glm spoke first"}',
      50,
      1500,
      init?.signal ?? undefined,
      () => {
        glmAborted = true;
      }
    );
  }) as typeof fetch;

  try {
    const chunks = [];
    for await (const chunk of await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'Summarize search results' }],
      provider_route: 'direct-cerebras',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'generator_response',
          strict: true,
          schema: {
            type: 'object',
            properties: { reasoning: { type: 'string' }, response: { type: 'string' } },
            required: ['reasoning', 'response'],
            additionalProperties: false,
          },
        },
      },
    }))
      chunks.push(chunk);
    const text = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('');
    assert.match(text, /qwen finished first/);
    assert.doesNotMatch(text, /glm spoke first/);
    assert.equal(glmAborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = originalCerebrasKey;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalHedgeMs === undefined) delete process.env.CEREBRAS_CHAT_HEDGE_MS;
    else process.env.CEREBRAS_CHAT_HEDGE_MS = originalHedgeMs;
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
