#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { createStreamingCompletion } from '../../providers/rose';
import { postOpenAIResponsesStream, postOpenRouterStream } from '../../providers/rose/transport';

async function testAbortRemainsConnectedWhileBodyIsConsumed(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const upstream = new AbortController();
  let providerSignal: AbortSignal | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    providerSignal = init?.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        providerSignal?.addEventListener(
          'abort',
          () => controller.error(providerSignal?.reason ?? new Error('aborted')),
          { once: true }
        );
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    const response = await postOpenAIResponsesStream({
      body: { model: 'gpt-test', stream: true },
      openAiKey: 'sk-test',
      requestId: 'abort-test',
      abortSignal: upstream.signal,
    });
    assert(response.body, 'streaming response body');
    const read = response.body.getReader().read();

    upstream.abort(new Error('cache won'));
    await assert.rejects(
      Promise.race([
        read,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('provider body remained connected')), 30)
        ),
      ]),
      /cache won/
    );
    assert.equal(providerSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCompletionAbortReachesPriorityOpenAiBody(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.GPT_API_KEY;
  const upstream = new AbortController();
  let providerSignal: AbortSignal | null = null;
  process.env.GPT_API_KEY = 'sk-test';

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    providerSignal = init?.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        providerSignal?.addEventListener(
          'abort',
          () => controller.error(providerSignal?.reason ?? new Error('aborted')),
          { once: true }
        );
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'route this' }],
      provider_route: 'shared-openai-priority',
      abort_signal: upstream.signal,
    });
    const next = stream[Symbol.asyncIterator]().next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    upstream.abort(new Error('cache won completion hedge'));

    await assert.rejects(next, /cache won completion hedge/);
    assert.equal(providerSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = oldKey;
  }
}

async function testOpenRouterAbortRemainsConnectedAfterHeaders(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const upstream = new AbortController();
  let providerSignal: AbortSignal | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    providerSignal = init?.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        providerSignal?.addEventListener(
          'abort',
          () => controller.error(providerSignal?.reason ?? new Error('aborted')),
          { once: true }
        );
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    const response = await postOpenRouterStream({
      body: { model: 'google/gemini-3.5-flash', stream: true },
      openrouterKey: 'or-test',
      requestId: 'openrouter-abort-test',
      abortSignal: upstream.signal,
    });
    assert(response.body, 'streaming OpenRouter body');
    const read = response.body.getReader().read();
    upstream.abort(new Error('discard speculative router'));
    await assert.rejects(
      Promise.race([
        read,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('OpenRouter body remained connected')), 30)
        ),
      ]),
      /discard speculative router/
    );
    assert.equal(providerSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void testAbortRemainsConnectedWhileBodyIsConsumed()
  .then(testCompletionAbortReachesPriorityOpenAiBody)
  .then(testOpenRouterAbortRemainsConnectedAfterHeaders)
  .then(() => {
    process.stdout.write('rose-stream-abort tests passed\n');
  });
