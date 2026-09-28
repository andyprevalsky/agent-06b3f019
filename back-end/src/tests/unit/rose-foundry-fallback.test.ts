#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { createStreamingCompletion } from '../../providers/rose';
import { foundryComplete, orderedFoundryDeployments } from '../../providers/rose/foundry';
import { POOL_REGISTRY } from '../../providers/rose/pools';

const sse = (text: string): string =>
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
  `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n` +
  'data: [DONE]\n\n';

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(
    [
      'AZURE_FOUNDRY_ENDPOINT',
      'AZURE_FOUNDRY_API_KEY',
      'AZURE_FOUNDRY_DEPLOYMENTS',
      'GPT_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
    ].map((key) => [key, process.env[key]])
  );
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol,gpt-6-sol-b';
  delete process.env.GPT_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const attempts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://a-4989-resource.openai.azure.com/openai/v1/responses');
    assert.equal((init?.headers as Record<string, string>)['api-key'], 'test-key');
    assert.equal(init?.redirect, 'manual');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    attempts.push(String(body.model));
    assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.service_tier, 'priority');
    if (attempts.length === 1)
      return new Response('', { status: 429, headers: { 'retry-after-ms': '2000' } });
    return new Response(sse('Hi'), { status: 200 });
  }) as typeof fetch;

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'Say hi' }],
      effort: 'high',
      route_key: 'agent-1',
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], orderedFoundryDeployments('gpt-6-sol', 'agent-1')[0]);
    assert.notEqual(attempts[0], attempts[1]);
    assert.equal(chunks[0]?.actual_model, 'gpt-6-sol-foundry');
    assert.equal(chunks[0]?.pool_name, 'foundry');
    assert.equal(chunks[0]?.choices[0]?.delta.content, 'Hi');
    assert.deepEqual(orderedFoundryDeployments('gpt-6-sol', 'agent-1').sort(), [
      'gpt-6-sol',
      'gpt-6-sol-b',
    ]);
    process.stdout.write('Foundry fallback: 429 spill, Responses shape and provenance passed\n');

    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol-third';
    process.env.OPENROUTER_API_KEY = 'test-openrouter';
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const host = new URL(String(input)).host;
      hosts.push(host);
      if (host.endsWith('azure.com')) return new Response('', { status: 429 });
      assert.equal(host, 'openrouter.ai');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenRouter' }, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200 }
      );
    }) as typeof fetch;
    const fallback = await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    const fallbackChunks = [];
    for await (const chunk of fallback) fallbackChunks.push(chunk);
    assert.deepEqual(hosts, ['a-4989-resource.openai.azure.com', 'openrouter.ai']);
    assert.equal(fallbackChunks[0]?.choices[0]?.delta.content, 'OpenRouter');
    process.stdout.write('Foundry ceiling: pre-content 429 falls through to OpenRouter\n');

    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol-reader-a,gpt-6-sol-reader-b';
    const readerAttempts: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      readerAttempts.push(String((JSON.parse(String(init?.body)) as { model: string }).model));
      if (readerAttempts.length === 1)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('reader failed before content'));
            },
          }),
          { status: 200 }
        );
      return new Response(sse('Recovered'), { status: 200 });
    }) as typeof fetch;
    const recovered = [];
    for await (const chunk of foundryComplete({
      poolSpec: POOL_REGISTRY['rose-1-ultra'],
      messages: [{ role: 'user', content: 'Say hi' }],
      requestId: 'reader-error-probe',
      routeKey: 'agent-1',
    }))
      recovered.push(chunk);
    assert.equal(readerAttempts.length, 2);
    assert.equal(recovered.find((chunk) => chunk.kind === 'content')?.data.text, 'Recovered');
    process.stdout.write('Foundry reader: pre-content failure tries next deployment\n');

    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol-partial-a,gpt-6-sol-partial-b';
    const partialAttempts: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      partialAttempts.push(String((JSON.parse(String(init?.body)) as { model: string }).model));
      let reads = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (reads++ === 0)
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial' })}\n\n`
                  )
                );
              else controller.error(new Error('reader failed after content'));
            },
          },
          { highWaterMark: 0 }
        ),
        { status: 200 }
      );
    }) as typeof fetch;
    const partialChunks = [];
    await assert.rejects(async () => {
      for await (const chunk of foundryComplete({
        poolSpec: POOL_REGISTRY['rose-1-ultra'],
        messages: [{ role: 'user', content: 'Say hi' }],
        requestId: 'partial-reader-probe',
        routeKey: 'agent-1',
      }))
        partialChunks.push(chunk);
    }, /reader failed after content/);
    assert.equal(partialAttempts.length, 1);
    assert.equal(partialChunks.find((chunk) => chunk.kind === 'content')?.data.text, 'Partial');
    process.stdout.write('Foundry reader: post-content failure never splices deployments\n');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
