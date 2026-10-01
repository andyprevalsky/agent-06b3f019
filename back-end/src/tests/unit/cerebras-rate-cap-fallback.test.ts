#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createStreamingCompletion } from '../../providers/rose';
import { OPENROUTER_FAST_CHAT_MODEL } from '../../providers/rose/openrouterFastRoute';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

function completion(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const payload =
        'data: {"choices":[{"index":0,"delta":{"content":"{\\"action\\":\\"direct_answer\\"}"}}]}\n\n' +
        'data: [DONE]\n\n';
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalHedgeMs = process.env.CEREBRAS_CHAT_HEDGE_MS;
  process.env.CEREBRAS_API_KEY = 'cerebras-rate-cap-test';
  process.env.OPENROUTER_API_KEY = 'openrouter-rate-cap-test';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '0';
  const models: string[] = [];
  let slowHostAborted = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) {
      return new Response('{"message":"token quota exceeded"}', { status: 429 });
    }
    assert.equal(url, OPENROUTER_API_URL);
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    models.push(model);
    if (model === OPENROUTER_FAST_CHAT_MODEL) return completion();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          slowHostAborted = true;
          reject(new Error('slow same-model host cancelled'));
        },
        { once: true }
      );
    });
  }) as typeof fetch;

  try {
    const chunks = [];
    for await (const chunk of await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'Route this request' }],
      provider_route: 'direct-cerebras',
    })) {
      chunks.push(chunk);
    }
    const text = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('');
    assert.match(text, /direct_answer/);
    assert.ok(models.includes('qwen/qwen3.8-27b'));
    assert.ok(models.includes(OPENROUTER_FAST_CHAT_MODEL));
    assert.equal(slowHostAborted, true, 'the winning fast route cancels the stalled host');
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
