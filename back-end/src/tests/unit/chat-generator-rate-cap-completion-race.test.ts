#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createStreamingCompletion } from '../../providers/rose';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

function delayedCompletion(
  content: string,
  firstContentMs: number,
  finishMs: number,
  signal: AbortSignal | undefined,
  onAbort: () => void,
  /** null: the body closes without any finish_reason. */
  finishReason: string | null = 'stop',
  /** Error the stream at finishMs instead of closing it. */
  failMidStream = false
): Response {
  const encodedContent = new TextEncoder().encode(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: { content },
          ...(finishReason !== null ? { finish_reason: finishReason } : {}),
        },
      ],
    })}\n\n`
  );
  const encodedDone = new TextEncoder().encode('data: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const first = setTimeout(() => controller.enqueue(encodedContent), firstContentMs);
      const done = setTimeout(() => {
        if (failMidStream) {
          controller.error(new TypeError('terminated'));
          return;
        }
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

/**
 * A structured chat reply is usable only once it is complete, so the rate-cap
 * fallback race must latch on the first COMPLETED answer for every json_schema
 * call, not just the generator. Production (2026-11-11, agent 9e369cc8): after a
 * Cerebras 429 the router's GLM leg streamed its first chunk at 441 ms, latched
 * the race, then kept streaming an unclosed decision until the 15 s router
 * deadline, while the same-model Qwen leg would have finished in about 2 s.
 */
async function raceScenario(params: {
  schemaName: string;
  schemaProperties: Record<string, { type: string }>;
  glmContent: string;
  qwenContent: string;
  /** GLM ends early: at its token cap, without any finish_reason, or by a read error. */
  glmTruncated?: boolean;
  glmEnd?: 'length' | 'no-finish-reason' | 'read-error';
  /** Qwen stops at its token cap too, so the final waterfall must answer. */
  qwenTruncated?: boolean;
  waterfallContent?: string;
}): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalHedgeMs = process.env.CEREBRAS_CHAT_HEDGE_MS;
  process.env.CEREBRAS_API_KEY = 'generator-race-test';
  process.env.OPENROUTER_API_KEY = 'generator-race-test';
  process.env.CEREBRAS_CHAT_HEDGE_MS = '0';
  let glmAborted = false;
  let qwenRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === CEREBRAS_API_URL) {
      return new Response('{"message":"token quota exceeded"}', { status: 429 });
    }
    assert.equal(url, OPENROUTER_API_URL);
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    if (model === 'qwen/qwen3.8-27b') {
      qwenRequests += 1;
      // The rose-1-flash waterfall that runs after both fallback legs fail
      // leads with the same Qwen model; its request is the second one.
      if (params.waterfallContent && qwenRequests > 1) {
        return delayedCompletion(params.waterfallContent, 10, 20, init?.signal ?? undefined, () => {
          return undefined;
        });
      }
      return delayedCompletion(
        params.qwenContent,
        650,
        750,
        init?.signal ?? undefined,
        () => undefined,
        params.qwenTruncated ? 'length' : 'stop'
      );
    }
    assert.equal(model, 'z-ai/glm-5.3-flash');
    return delayedCompletion(
      params.glmContent,
      50,
      params.glmTruncated || params.glmEnd ? 300 : 1500,
      init?.signal ?? undefined,
      () => {
        glmAborted = true;
      },
      params.glmTruncated || params.glmEnd === 'length'
        ? 'length'
        : params.glmEnd === 'no-finish-reason' || params.glmEnd === 'read-error'
          ? null
          : 'stop',
      params.glmEnd === 'read-error'
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
          name: params.schemaName,
          strict: true,
          schema: {
            type: 'object',
            properties: params.schemaProperties,
            required: Object.keys(params.schemaProperties),
            additionalProperties: false,
          },
        },
      },
    }))
      chunks.push(chunk);
    const text = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('');
    const expected = params.waterfallContent ?? params.qwenContent;
    assert.equal(text, expected, `${params.schemaName}: first completed answer wins`);
    if (!params.glmTruncated && !params.glmEnd) {
      assert.equal(glmAborted, true, `${params.schemaName}: the slower GLM leg is cancelled`);
    }
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

async function run(): Promise<void> {
  await raceScenario({
    schemaName: 'generator_response',
    schemaProperties: { reasoning: { type: 'string' }, response: { type: 'string' } },
    glmContent: '{"reasoning":"","response":"glm spoke first"}',
    qwenContent: '{"reasoning":"","response":"qwen finished first"}',
  });
  await raceScenario({
    schemaName: 'router_decision',
    schemaProperties: {
      reasoning: { type: 'string' },
      action: { type: 'string' },
      queries: { type: 'array' },
    },
    glmContent: '{"reasoning":"glm spoke first","action":"web_search","queries":["a","a ',
    qwenContent: '{"reasoning":"qwen finished first","action":"web_search","queries":["a"]}',
  });
  // A leg that reaches its token cap first ends with unclosed JSON; it must not
  // win over a leg that finishes cleanly.
  await raceScenario({
    schemaName: 'router_decision',
    schemaProperties: {
      reasoning: { type: 'string' },
      action: { type: 'string' },
      queries: { type: 'array' },
    },
    glmContent: '{"reasoning":"glm hit its cap","action":"web_search","queries":["a","a a","a a a',
    qwenContent: '{"reasoning":"qwen finished cleanly","action":"web_search","queries":["a"]}',
    glmTruncated: true,
  });
  // Both fallback legs stop at their token caps: the classified fall-through
  // error hands the call to the final waterfall instead of failing the turn.
  await raceScenario({
    schemaName: 'router_decision',
    schemaProperties: {
      reasoning: { type: 'string' },
      action: { type: 'string' },
      queries: { type: 'array' },
    },
    glmContent: '{"reasoning":"glm hit its cap","action":"web_search","queries":["a","a a',
    qwenContent: '{"reasoning":"qwen hit its cap","action":"web_search","queries":["b","b b',
    glmTruncated: true,
    qwenTruncated: true,
    waterfallContent: '{"reasoning":"waterfall answered","action":"web_search","queries":["c"]}',
  });
  // A body that closes without any finish_reason is not a clean completion.
  await raceScenario({
    schemaName: 'router_decision',
    schemaProperties: {
      reasoning: { type: 'string' },
      action: { type: 'string' },
      queries: { type: 'array' },
    },
    glmContent: '{"reasoning":"glm closed early","action":"web_search","queries":["a","a ',
    qwenContent: '{"reasoning":"qwen finished cleanly","action":"web_search","queries":["a"]}',
    glmEnd: 'no-finish-reason',
  });
  // A GLM read error mid-stream plus a capped Qwen leg still reaches the waterfall.
  await raceScenario({
    schemaName: 'router_decision',
    schemaProperties: {
      reasoning: { type: 'string' },
      action: { type: 'string' },
      queries: { type: 'array' },
    },
    glmContent: '{"reasoning":"glm read failed","action":"web_search","queries":["a',
    qwenContent: '{"reasoning":"qwen hit its cap","action":"web_search","queries":["b","b b',
    glmEnd: 'read-error',
    qwenTruncated: true,
    waterfallContent: '{"reasoning":"waterfall answered","action":"web_search","queries":["c"]}',
  });
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
