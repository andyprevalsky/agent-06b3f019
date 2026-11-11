#!/usr/bin/env tsx
/**
 * Black-box contract for the exclusive synchronous Chat Cerebras route.
 */

import assert from 'node:assert/strict';

import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import { retryWithBackoff } from '../../providers/retry';
import { quarantine } from '../helpers/quarantine';
import { fetchLiveCerebrasModelIds } from './cerebras.live.cases';

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

/**
 * RCA ef18929c: a single transient non-OK /models response from a shared gate
 * VM failed the live probe. Transient statuses are retried; any other non-OK
 * status fails immediately and names the HTTP status.
 */
async function assertModelsReadRetriesOnlyTransientStatuses(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const modelsUrl = CEREBRAS_API_URL.replace('/chat/completions', '/models');
  const statuses: number[] = [];
  const serve = (queue: number[]) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      assert.equal(String(input), modelsUrl);
      const status = queue.shift() ?? 200;
      statuses.push(status);
      return status === 200
        ? new Response(JSON.stringify({ data: [{ id: 'qwen-3.8-27b' }] }), { status })
        : new Response('{"type":"too_many_requests_error"}', { status });
    }) as typeof fetch;
  };
  try {
    serve([503]);
    const ids = await fetchLiveCerebrasModelIds(modelsUrl, 'blackbox-cerebras-key');
    assert.deepEqual([...ids], ['qwen-3.8-27b']);
    assert.deepEqual(statuses, [503, 200]);

    statuses.length = 0;
    serve([401]);
    await assert.rejects(
      fetchLiveCerebrasModelIds(modelsUrl, 'blackbox-cerebras-key'),
      /Cerebras \/models must be reachable for the live probe: HTTP 401/
    );
    assert.deepEqual(statuses, [401]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  process.stdout.write('PASS Cerebras /models read retries transient statuses only\n');
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
        model: 'rose-labs/rose-1-flash',
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
    assert.equal(body.model, 'qwen-3.8-27b');
    assert.equal(body.stream, true);
    assert.equal(body.clear_thinking, undefined);
    assert.notEqual(body.model, 'zai-glm-4.7');
    assert.notEqual(body.model, 'gemma-4-31b');
    assert.notEqual(body.model, 'gpt-oss-120b');
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(headers['X-Cerebras-Version-Patch'], '2');
    assert.equal(chunks[0]?.actual_model, 'qwen-3.8-27b');
    assert.equal(chunks[0]?.pool_name, 'cerebras-direct');
    assert.equal(chunks.at(-1)?.usage?.cache_read_input_tokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = oldCerebrasKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
  }

  process.stdout.write('PASS synchronous Chat uses direct Cerebras qwen-3.8-27b exclusively\n');

  await assertModelsReadRetriesOnlyTransientStatuses();

  // Live inventory probe: the archived GLM id must stay 404, and the configured
  // chat model must not return model_archived. Skipped when no real key.
  const liveKey = process.env.CEREBRAS_API_KEY;
  if (liveKey && !liveKey.startsWith('blackbox-') && liveKey.length > 20) {
    const { CEREBRAS_CHAT_MODEL, ARCHIVED_CEREBRAS_CHAT_MODEL, buildCerebrasChatBody } =
      await import('../../providers/rose/cerebrasRoute');
    const ids = await fetchLiveCerebrasModelIds(
      CEREBRAS_API_URL.replace('/chat/completions', '/models'),
      liveKey
    );
    assert.equal(
      ids.has(ARCHIVED_CEREBRAS_CHAT_MODEL),
      false,
      `archived ${ARCHIVED_CEREBRAS_CHAT_MODEL} must not reappear in Cerebras inventory`
    );
    assert.equal(
      ids.has(CEREBRAS_CHAT_MODEL),
      true,
      `CEREBRAS_CHAT_MODEL=${CEREBRAS_CHAT_MODEL} must be present in Cerebras /models`
    );

    const probeBody = {
      ...buildCerebrasChatBody({
        messages: [{ role: 'user', content: 'Reply with ok' }],
        max_tokens: 8,
      }),
      stream: false,
    };
    delete (probeBody as { stream_options?: unknown }).stream_options;
    const probe = await retryWithBackoff(
      async () => {
        const started = Date.now();
        const live = await fetch(CEREBRAS_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(probeBody),
        });
        return {
          ok: live.ok,
          status: live.status,
          text: await live.text(),
          elapsedMs: Date.now() - started,
        };
      },
      {
        maxRetries: 5,
        getBackoffDelayMs: (_error, attempt) => 1_000 * attempt * attempt,
        shouldRetryResult: (result) => {
          const queueExceeded =
            result.status === 429 ||
            result.status === 402 ||
            /too_many_requests|queue_exceeded|high traffic|payment_required/i.test(result.text);
          return !result.ok && result.status !== 404 && queueExceeded;
        },
        component: 'cerebras-chat-probe',
      }
    );
    assert.notEqual(
      probe.status,
      404,
      `chat model must not be archived: HTTP ${probe.status} ${probe.text.slice(0, 200)}`
    );
    const quotaRejected = probe.status === 402 || /payment_required|quota/i.test(probe.text);
    if (quotaRejected) {
      // Inventory already proved the configured chat model is listed and the
      // archived GLM id is gone. A 402 here is the shared Cerebras org quota
      // (or a rate cap reported as payment_required), not an archived model.
      process.stdout.write(
        `SKIP live Cerebras chat probe: quota/payment_required after inventory ok (${probe.status})\n`
      );
    } else {
      assert.equal(
        probe.status >= 200 && probe.status < 300,
        true,
        `chat model probe must succeed: HTTP ${probe.status} ${probe.text.slice(0, 200)}`
      );
      // The latency ratchet is quarantined (FLAKY d2ba002c: one 23.6 s Cerebras response, rerun passed);
      // it still runs and reports; the status/inventory assertions above stay blocking.
      const ratchetUnit = 'cerebras';
      await quarantine(
        {
          since: '2026-11-11',
          repair: 'pending-handoff:d2ba002c0abd4af6a10da8c847d6ec2c',
          error:
            'AssertionError [ERR_ASSERTION]: chat model probe must stay under the lifecycle ratchet (23593ms)',
          evidence: '.context/rca-cerebras/d2ba002c/findings.json',
        },
        () => {
          assert.ok(
            probe.elapsedMs < 5_000,
            `chat model probe must stay under the lifecycle ratchet (${probe.elapsedMs}ms)`
          );
        },
        { unit: ratchetUnit }
      )();
      process.stdout.write(
        `PASS live Cerebras chat model ${CEREBRAS_CHAT_MODEL} responds in ${probe.elapsedMs}ms\n`
      );
    }
  } else {
    process.stdout.write('SKIP live Cerebras inventory probe (no real CEREBRAS_API_KEY)\n');
  }
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
