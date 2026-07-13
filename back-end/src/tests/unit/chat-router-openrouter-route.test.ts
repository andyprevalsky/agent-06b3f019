#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { createStreamingCompletion, type CompletionChunk } from '../../providers/rose';
import {
  ANTHROPIC_API_URL,
  OPENAI_RESPONSES_API_URL,
  OPENROUTER_API_URL,
} from '../../providers/rose/transport';

const RESPONSES_OK_SSE = [
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"{\\"reasoning\\":\\"route\\",\\"action\\":\\"direct_answer\\",\\"query\\":\\"\\",\\"goal\\":\\"\\",\\"mode\\":\\"plan\\"}"}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10,"input_tokens_details":{"cached_tokens":0}}}}',
  '',
  'data: [DONE]',
  '',
];

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
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
  const oldGptKey = process.env.GPT_API_KEY;
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.GPT_API_KEY = 'shared-router-priority';
  process.env.ANTHROPIC_API_KEY = 'anthropic-must-not-run';
  process.env.OPENROUTER_API_KEY = 'openrouter-must-not-run';
  const calls: string[] = [];
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url !== OPENAI_RESPONSES_API_URL) throw new Error(`Router leaked to ${url}`);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(RESPONSES_OK_SSE);
  }) as typeof fetch;

  try {
    const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');
    assert.equal(phases.router, 'rose-labs/rose-1-lite');
    assert.equal(phases.routerProviderRoute, 'shared-openai-priority');
    assert.equal(phases.generator, 'rose-labs/rose-1-lite');
    assert.equal(phases.generatorProviderRoute, 'openrouter-waterfall');
    const chunks = await collect(
      await createStreamingCompletion({
        model: phases.router,
        messages: [
          { role: 'system', content: 'exact-router-system-prompt' },
          { role: 'user', content: 'route this request' },
        ],
        temperature: 0.3,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'router_decision',
            strict: true,
            schema: {
              type: 'object',
              properties: { action: { type: 'string' } },
              required: ['action'],
              additionalProperties: false,
            },
          },
        },
        provider_route: phases.routerProviderRoute,
      })
    );

    assert.deepEqual(calls, [OPENAI_RESPONSES_API_URL]);
    assert.equal(capturedBody.model, 'gpt-5.6-terra');
    assert.equal(capturedBody.service_tier, 'priority');
    assert.equal(capturedBody.instructions, 'exact-router-system-prompt');
    assert.deepEqual(capturedBody.reasoning, { effort: 'medium', summary: 'auto' });
    const format = capturedBody.text as { format?: { name?: string; strict?: boolean } };
    assert.equal(format.format?.name, 'router_decision');
    assert.equal(format.format?.strict, true);
    assert.equal(chunks[0]?.actual_model, 'gpt-5.6-terra-openai');
    assert.equal(chunks[0]?.pool_name, 'openai-api-key');
    assert.notEqual(ANTHROPIC_API_URL, OPENROUTER_API_URL);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldGptKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = oldGptKey;
    if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
    if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
  }

  process.stdout.write('PASS Chat Router uses exact shared Terra priority route\n');
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
