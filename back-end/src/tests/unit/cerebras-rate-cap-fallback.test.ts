#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  createRouterCompletionDeadline,
  streamBeforeRouterCompletionDeadline,
} from '../../providers/chat/routerCompletionDeadline';
import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import { createStreamingCompletion } from '../../providers/rose';
import { OPENROUTER_FAST_CHAT_MODEL } from '../../providers/rose/openrouterFastRoute';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

// Scaled from the chat-lifecycle web_search failure: a direct Cerebras 429
// left the fast fallback waiting behind a 500ms hedge for the slow same-model
// spill, and the full router reply then landed past the 3s completion bound.
const ROUTER_DEADLINE_MS = 800;
const FAST_REPLY_MS = 400;

function delayedCompletion(delayMs: number, signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      const payload =
        'data: {"choices":[{"index":0,"delta":{"content":"{\\"action\\":\\"direct_answer\\"}"}}]}\n\n' +
        'data: [DONE]\n\n';
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
      resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      );
    }, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true }
    );
  });
}

function neverAnswers(signal?: AbortSignal | null, onAbort?: () => void): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => {
        onAbort?.();
        reject(new Error('slow same-model host cancelled'));
      },
      { once: true }
    );
  });
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalHedgeMs = process.env.CEREBRAS_CHAT_HEDGE_MS;
  const originalNodeEnv = process.env.NODE_ENV;
  // Measure the production router deadline without synchronous development dumps.
  process.env.NODE_ENV = 'production';
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
    if (model === OPENROUTER_FAST_CHAT_MODEL) return delayedCompletion(FAST_REPLY_MS, init?.signal);
    return neverAnswers(init?.signal, () => {
      slowHostAborted = true;
    });
  }) as typeof fetch;

  const deadline = createRouterCompletionDeadline(ROUTER_DEADLINE_MS);
  const startedAt = Date.now();
  try {
    const options = buildRouterCompletionOptions({
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'Route this request' }],
      providerRoute: 'direct-cerebras',
      providerFastMode: true,
      abortSignal: deadline.signal,
    });
    let text = '';
    for await (const chunk of streamBeforeRouterCompletionDeadline(
      await createStreamingCompletion(options),
      deadline
    )) {
      text += chunk.choices[0]?.delta?.content ?? '';
    }
    const elapsedMs = Date.now() - startedAt;
    assert.equal(
      deadline.expired(),
      false,
      `a rate-capped router reply must land inside the completion bound (${elapsedMs}ms)`
    );
    assert.match(text, /direct_answer/);
    assert.equal(models[0], OPENROUTER_FAST_CHAT_MODEL, 'the fast chat route must lead');
    if (models.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(slowHostAborted, true, 'the winning fast route cancels the stalled host');
    }
  } finally {
    deadline.dispose();
    globalThis.fetch = originalFetch;
    if (originalCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = originalCerebrasKey;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalHedgeMs === undefined) delete process.env.CEREBRAS_CHAT_HEDGE_MS;
    else process.env.CEREBRAS_CHAT_HEDGE_MS = originalHedgeMs;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
