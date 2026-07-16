#!/usr/bin/env tsx
/**
 * Black-box REGRESSION: synchronous Chat must survive a Cerebras stall by
 * falling through to a DIFFERENT provider/model — it must never go silent.
 *
 * Prod agent 6d19b666-e4ba-4359-8553-be24002bd482: a user sent a follow-up to a
 * COMPLETED agent, chat mode ran (RouterLLM + GeneratorLLM), and the completion
 * died with "Cerebras produced no model output within 1200ms (request_id=...)".
 * The user got NO response (silence).
 *
 * Root cause (now fixed): the `openrouter-cerebras` chat route failed
 * pre-content and its ONLY "fallback" retried the SAME model (GLM-4.7) on the
 * SAME provider (Cerebras) over a different transport. When that also produced
 * no token before the pre-content deadline, `client.ts` rethrew a terminal
 * RoseStallError — there was no path to a different provider/model.
 *
 * This test drives the real Rose chat entry point (`createStreamingCompletion`,
 * same as cerebras.blackbox.ts / openrouter-cerebras.blackbox.ts) with the
 * Cerebras (GLM-4.7) attempt stubbed to fail fast pre-content (HTTP 503), and a
 * DIFFERENT waterfall model (gemini/kimi, also via OpenRouter) stubbed to return
 * real content. The fix routes the pre-content stall to the multi-provider
 * OpenRouter waterfall, so chat returns usable content instead of silence.
 *
 * On the pre-fix code the same-provider Cerebras failover ran, no waterfall
 * model was ever requested, and the completion threw — which is exactly the
 * silence this regression guards against.
 */

import assert from 'node:assert/strict';

import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import { OPENROUTER_CEREBRAS_MODEL } from '../../providers/rose/openrouterCerebrasRoute';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

/** A successful OpenRouter SSE stream carrying real content from a fallback model. */
const FALLBACK_SSE = [
  'data: {"model":"google/gemini-3.5-flash","choices":[{"index":0,"delta":{"content":"the very top: take the freight elevator to the tower level"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":10,"total_tokens":18}}',
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

/** A streaming body that accepts the connection but never emits a token. */
function stallingCerebrasResponse(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!signal) return;
      if (signal.aborted) {
        controller.error(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function requestedModel(init?: RequestInit): string {
  try {
    return (JSON.parse(String(init?.body)) as { model?: string }).model ?? '';
  } catch {
    return '';
  }
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  const oldIdleTimeout = process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS;

  process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
  process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS = '150';

  const openRouterModels: string[] = [];
  let directCerebrasCalled = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === OPENROUTER_API_URL) {
      const model = requestedModel(init);
      openRouterModels.push(model);
      if (model === OPENROUTER_CEREBRAS_MODEL) {
        // The GLM-4.7-on-Cerebras attempt fails fast, pre-content (503 ->
        // RoseServerError -> fall-through).
        return new Response('cerebras upstream unavailable', { status: 503 });
      }
      // A DIFFERENT waterfall model (gemini/kimi) succeeds — the cross-provider
      // fallback the fix introduces.
      return sseResponse(FALLBACK_SSE);
    }
    if (url === CEREBRAS_API_URL) {
      // The old same-provider direct-Cerebras failover would land here. Post-fix
      // it must never run.
      directCerebrasCalled = true;
      return stallingCerebrasResponse(init?.signal);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const content: string[] = [];
  let thrown: unknown = null;
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [
        { role: 'system', content: 'You are Rose.' },
        { role: 'user', content: 'follow-up to a completed agent' },
      ],
      temperature: 0.7,
      provider_route: 'openrouter-cerebras',
    });
    for await (const chunk of stream as AsyncIterable<CompletionChunk>) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) content.push(text);
    }
  } catch (error) {
    thrown = error;
  } finally {
    globalThis.fetch = originalFetch;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldIdleTimeout === undefined) delete process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS;
    else process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS = oldIdleTimeout;
  }

  // The GLM-4.7-on-Cerebras attempt ran first...
  assert.ok(
    openRouterModels.includes(OPENROUTER_CEREBRAS_MODEL),
    'expected the OpenRouter -> Cerebras (GLM-4.7) chat attempt to run first'
  );
  // ...and after it stalled pre-content, chat fell through to a DIFFERENT model
  // (the real multi-provider waterfall), not back to Cerebras.
  const fellThroughToDifferentModel = openRouterModels.some(
    (model) => model !== OPENROUTER_CEREBRAS_MODEL && model.length > 0
  );
  assert.ok(
    fellThroughToDifferentModel,
    'Expected chat to fall through to a DIFFERENT provider/model after Cerebras ' +
      `stalled pre-content, but only ${JSON.stringify(openRouterModels)} were requested. ` +
      'Synchronous chat was pinned to GLM-4.7 on Cerebras with no cross-provider ' +
      'fallback (reproduces prod agent 6d19b666-e4ba-4359-8553-be24002bd482).'
  );
  assert.ok(
    !directCerebrasCalled,
    'Expected NO same-provider direct-Cerebras failover; the fallback must leave Cerebras.'
  );

  if (thrown) {
    const detail = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    throw new Error(
      `Expected chat to fall through and return content, but it threw: ${detail}. ` +
        'A Cerebras stall must never silence the whole chat turn.'
    );
  }
  assert.ok(
    content.join('').trim().length > 0,
    'Expected non-empty completion content from a fallback provider; got silence.'
  );

  process.stdout.write('PASS chat falls through to a different provider when Cerebras stalls\n');
}

// A stream that ends CLEANLY (a finish chunk + [DONE]) without ever emitting a
// caller-visible content chunk. The openrouter-cerebras route does not throw on
// this, so the fallback must detect the empty output and still fall through
// rather than return silence.
const EMPTY_SSE = [
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":0,"total_tokens":8}}',
  '',
  'data: [DONE]',
  '',
];

async function runEmptyCerebrasStream(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const oldCerebrasKey = process.env.CEREBRAS_API_KEY;
  process.env.OPENROUTER_API_KEY = 'blackbox-openrouter-key';
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';

  const openRouterModels: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === OPENROUTER_API_URL) {
      const model = requestedModel(init);
      openRouterModels.push(model);
      // Cerebras returns a clean, empty stream; the waterfall model serves content.
      return sseResponse(model === OPENROUTER_CEREBRAS_MODEL ? EMPTY_SSE : FALLBACK_SSE);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const content: string[] = [];
  let thrown: unknown = null;
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [
        { role: 'system', content: 'You are Rose.' },
        { role: 'user', content: 'follow-up after an empty Cerebras stream' },
      ],
      temperature: 0.7,
      provider_route: 'openrouter-cerebras',
    });
    for await (const chunk of stream as AsyncIterable<CompletionChunk>) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) content.push(text);
    }
  } catch (error) {
    thrown = error;
  } finally {
    globalThis.fetch = originalFetch;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
  }

  assert.ok(
    thrown === null,
    `a clean empty Cerebras stream should fall through, not throw: ${String(thrown)}`
  );
  assert.ok(
    openRouterModels.some((model) => model !== OPENROUTER_CEREBRAS_MODEL && model.length > 0),
    'a Cerebras stream that ends cleanly with no content must fall through to a waterfall model'
  );
  assert.ok(
    content.join('').trim().length > 0,
    'expected fallback content after an empty Cerebras stream; got silence'
  );
  process.stdout.write('PASS chat falls through when Cerebras ends cleanly with no output\n');
}

void run()
  .then(runEmptyCerebrasStream)
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
