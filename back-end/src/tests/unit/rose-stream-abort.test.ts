#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { createStreamingCompletion } from '../../providers/rose';
import { FOUNDRY_REGION_ENV_NAMES } from '../../providers/rose/foundry';
import { __resetGptApiKeyCooldown } from '../../providers/computeCredentials';
import { postOpenAIResponsesStream, postOpenRouterStream } from '../../providers/rose/transport';
import { withIsolatedFundedKeyCooldowns } from '../blackbox/funded-key-cooldown.support';

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
  let resolveProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    resolveProviderStarted = resolve;
  });
  process.env.GPT_API_KEY = 'sk-test';
  await __resetGptApiKeyCooldown();

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
    resolveProviderStarted();
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'route this' }],
      provider_route: 'shared-openai-priority',
      abort_signal: upstream.signal,
    });
    const next = stream[Symbol.asyncIterator]().next();
    // The shared-key cooldown lookup may cross the database before fetch starts.
    // Abort only after the provider has received the signal being tested.
    await Promise.race([
      providerStarted,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('priority provider did not start')), 2_000)
      ),
    ]);
    assert(providerSignal, 'provider fetch started');
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

/** A provider that never sends a byte; aborting the caller's signal must end it. */
function hangingFetch(onSignal: (signal: AbortSignal) => void): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    onSignal(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function expectAbortEndsCompletion(model: string, reason: string): Promise<AbortSignal[]> {
  const originalFetch = globalThis.fetch;
  const upstream = new AbortController();
  const signals: AbortSignal[] = [];
  globalThis.fetch = hangingFetch((signal) => signals.push(signal));
  try {
    const stream = await createStreamingCompletion({
      model,
      messages: [{ role: 'user', content: 'route this' }],
      abort_signal: upstream.signal,
    });
    const next = stream[Symbol.asyncIterator]().next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    upstream.abort(new Error(reason));
    await assert.rejects(
      Promise.race([
        next,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`${model}: completion ignored the abort signal`)),
            2_000
          )
        ),
      ]),
      new RegExp(reason)
    );
    return signals;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Regression: the funded-OpenAI-key hop ignored abort_signal, so a caller could
// not bound it (planner-memory card builds stalled ~11 min on a hung key).
async function testCompletionAbortReachesDefaultOpenAiKeyRoute(): Promise<void> {
  await withEnv(
    { GPT_API_KEY: 'sk-test', ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: 'or-test' },
    async () => {
      const signals = await expectAbortEndsCompletion('rose-labs/rose-1-ultra', 'caller deadline');
      assert(signals.length >= 1 && signals.every((signal) => signal.aborted));
    }
  );
}

async function testCompletionAbortReachesWaterfall(): Promise<void> {
  await withEnv(
    {
      GPT_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      CEREBRAS_API_KEY: undefined,
      OPENROUTER_API_KEY: 'or-test',
      ...Object.fromEntries(FOUNDRY_REGION_ENV_NAMES.map((name) => [name, undefined])),
    },
    async () => {
      const signals = await expectAbortEndsCompletion(
        'rose-labs/rose-1-mini',
        'waterfall deadline'
      );
      assert(signals.length >= 1 && signals.every((signal) => signal.aborted));
    }
  );
}

void withIsolatedFundedKeyCooldowns(async () => {
  await testAbortRemainsConnectedWhileBodyIsConsumed();
  await testCompletionAbortReachesPriorityOpenAiBody();
  await testOpenRouterAbortRemainsConnectedAfterHeaders();
  await testCompletionAbortReachesDefaultOpenAiKeyRoute();
  await testCompletionAbortReachesWaterfall();
}).then(() => {
  process.stdout.write('rose-stream-abort tests passed\n');
});
