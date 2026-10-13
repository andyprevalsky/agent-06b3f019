#!/usr/bin/env tsx
/** Model contract → native projection → provider wire schema, without network I/O. */
import assert from 'node:assert/strict';

import { createStreamingCompletion } from '../../providers/rose';
import { openAiChatTools, responsesTools } from '../../providers/rose/toolContract';
import {
  applyAnthropicToolConfig,
  extractToolsFromResponseFormat,
  withNativeToolContract,
} from '../../providers/rose/transforms';
import type { CompletionOptions } from '../../providers/rose/types';
import { buildOpenRouterBody } from '../../providers/rose/waterfall';
import {
  SUPERVISOR_RESPONSE_MODEL,
  SUPERVISOR_RESPONSE_SCHEMA,
} from '../../providers/smsSupervisor/schema';

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const options: CompletionOptions = {
  model: 'rose-labs/rose-1-ultra',
  messages: [{ role: 'user', content: 'Schema transport regression' }],
  response_model: SUPERVISOR_RESPONSE_MODEL,
  response_format: SUPERVISOR_RESPONSE_SCHEMA,
};

function verifySchemas(tools: unknown, strict: boolean): void {
  assert(Array.isArray(tools));
  const properties = record(SUPERVISOR_RESPONSE_SCHEMA.json_schema.schema.properties);
  const variants = record(record(properties.tool_calls).items).anyOf;
  assert(Array.isArray(variants));
  assert.equal(tools.length, 9);
  assert.equal(tools.length, variants.length);
  for (const toolValue of tools) {
    const tool = record(toolValue);
    const fn = record(tool.function ?? tool);
    const variant = variants.find((value: unknown) => {
      const discriminator = record(record(record(value).properties).tool);
      return Array.isArray(discriminator.enum) && discriminator.enum[0] === fn.name;
    });
    assert(variant, `unknown native tool ${String(fn.name)}`);
    const definition = record(variant);
    assert.deepEqual(fn.parameters, record(definition.properties).arguments);
    assert.equal(fn.description, definition.description ?? '');
    assert.equal(fn.strict, strict);
  }
}

function verifyProjection(): void {
  const original = JSON.stringify(options);
  const projected = withNativeToolContract(options);
  verifySchemas(responsesTools(projected.tools), true);
  verifySchemas(openAiChatTools(projected.tools), true);
  for (const strict of [true, false, undefined]) {
    const format = structuredClone(SUPERVISOR_RESPONSE_SCHEMA);
    if (strict === undefined) Reflect.deleteProperty(format.json_schema, 'strict');
    else format.json_schema.strict = strict;
    const result = withNativeToolContract({ ...options, response_format: format });
    verifySchemas(responsesTools(result.tools), strict ?? false);
    assert.equal(Object.hasOwn(result.tools![0], 'strict'), strict !== undefined);
  }
  for (const tools of [[], [{ name: 'custom', input_schema: { type: 'object' } }]]) {
    const explicit = { ...options, tools };
    assert.equal(withNativeToolContract(explicit), explicit);
  }
  const plain = { ...options, response_model: undefined };
  assert.equal(withNativeToolContract(plain), plain);
  const anthropicBody: Record<string, unknown> = {};
  applyAnthropicToolConfig(anthropicBody, SUPERVISOR_RESPONSE_SCHEMA);
  const anthropicTools = extractToolsFromResponseFormat(SUPERVISOR_RESPONSE_SCHEMA)!.tools;
  assert.deepEqual(anthropicBody.tools, anthropicTools);
  for (const model of [
    'anthropic/claude-haiku-4.5',
    'qwen/qwen3.8-27b',
    'anthropic/claude-haiku-4.5',
  ]) {
    const request = {
      model,
      messages: [],
      tools: projected.tools,
      anthropicTools,
      toolChoice: 'any',
    };
    const body = buildOpenRouterBody(request);
    assert.deepEqual(
      body.tools,
      openAiChatTools(model.startsWith('anthropic/') ? anthropicTools : projected.tools)
    );
    assert.equal(Object.hasOwn(body, 'anthropicTools'), false);
  }
  assert.equal(JSON.stringify(options), original, 'provider steps must not mutate caller schemas');
}

async function verifyResponsesWire(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const keys = [
    'AZURE_FOUNDRY_ENDPOINT',
    'AZURE_FOUNDRY_API_KEY',
    'AZURE_FOUNDRY_DEPLOYMENTS',
    'GPT_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'CEREBRAS_API_KEY',
  ];
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol';
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    const body = record(JSON.parse(String(init?.body)));
    if (requests === 1) {
      assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
      const anthropicTools = extractToolsFromResponseFormat(SUPERVISOR_RESPONSE_SCHEMA)!.tools;
      assert.deepEqual(body.tools, openAiChatTools(anthropicTools));
      assert.equal(Object.hasOwn(body, 'anthropicTools'), false);
      assert.equal(body.response_format, undefined);
      assert.equal(body.tool_choice, 'required');
      requests++;
      const tool = {
        index: 0,
        id: 'schema_call',
        type: 'function',
        function: { name: 'attempt_completion', arguments: '{}' },
      };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [tool] } }] })}\n\ndata: [DONE]\n\n`
      );
    }
    assert.equal(String(input), 'https://a-4989-resource.openai.azure.com/openai/v1/responses');
    verifySchemas(body.tools, true);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.text, undefined);
    requests++;
    const item = {
      type: 'function_call',
      call_id: 'schema_call',
      name: 'attempt_completion',
      arguments: '{}',
    };
    return new Response(
      `data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\ndata: [DONE]\n\n`
    );
  };
  try {
    const calls = [];
    for await (const chunk of await createStreamingCompletion({
      ...options,
      response_format: undefined,
    })) {
      calls.push(...(chunk.choices[0]?.delta.tool_calls ?? []));
    }
    assert.equal(requests, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'attempt_completion');
    delete process.env.AZURE_FOUNDRY_ENDPOINT;
    delete process.env.AZURE_FOUNDRY_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    calls.length = 0;
    for await (const chunk of await createStreamingCompletion({
      ...options,
      model: 'rose-labs/rose-1-mini',
      response_format: undefined,
    })) {
      calls.push(...(chunk.choices[0]?.delta.tool_calls ?? []));
    }
    assert.equal(requests, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'attempt_completion');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  verifyProjection();
  await verifyResponsesWire();
  process.stdout.write(
    'PASS native schema projection, provider compatibility, explicit tools and Responses wire contract\n'
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
