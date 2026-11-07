#!/usr/bin/env tsx
/** Model contract → native projection → provider wire schema, without network I/O. */
import assert from 'node:assert/strict';
import { z } from 'zod';

import { createStreamingCompletion } from '../../providers/rose';
import { openAiChatTools, responsesTools } from '../../providers/rose/toolContract';
import {
  applyAnthropicToolConfig,
  extractToolsFromResponseFormat,
  withNativeToolContract,
} from '../../providers/rose/transforms';
import type { CompletionOptions } from '../../providers/rose/types';
import { buildCerebrasChatBody } from '../../providers/rose/cerebrasRoute';
import { dispatchToolCall, type PendingOp } from '../../providers/smsSupervisor/supervisorTools';
import { registerUserDataGrepTool } from '../../providers/userDataSearch';
import { buildOpenRouterBody } from '../../providers/rose/waterfall';
import { buildOpenAiResponseFormat, responseModel } from '../../providers/rose/schema';
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

function verifyNestedArgumentsWithSibling(): void {
  const model = responseModel(
    'nested_tool_with_sibling',
    z.object({
      tool_calls: z.array(
        z.union([
          z.object({
            tool: z.literal('lookup'),
            arguments: z.object({ query: z.string() }),
            request_id: z.string(),
          }),
          z.object({ tool: z.literal('done'), arguments: z.object({}) }),
        ])
      ),
    })
  );
  const format = buildOpenAiResponseFormat(model);
  const original = JSON.stringify(format);
  const projected = withNativeToolContract({
    model: options.model,
    messages: options.messages,
    response_model: model,
    response_format: format,
  });
  for (const tool of [
    responsesTools(projected.tools)![0],
    record(openAiChatTools(projected.tools)![0].function),
    extractToolsFromResponseFormat(format)!.tools[0],
  ]) {
    const parameters = record(tool.parameters ?? tool.input_schema);
    assert.equal(parameters.additionalProperties, false, 'sibling wrapper must remain closed');
    assert.deepEqual(parameters.required, ['arguments', 'request_id']);
    const properties = record(parameters.properties);
    assert.deepEqual(Object.keys(properties), ['arguments', 'request_id']);
    assert.deepEqual(properties.arguments, {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    });
  }
  assert.equal(JSON.stringify(format), original, 'projection must preserve the caller schema');
}

async function verifyResponsesWire(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const keys = [
    // Isolate all regions so inherited deployments cannot select another wire fixture.
    ...Array.from({ length: 9 }, (_, index) => (index === 0 ? '' : `_${index + 1}`)).flatMap(
      (suffix) => [
        `AZURE_FOUNDRY_ENDPOINT${suffix}`,
        `AZURE_FOUNDRY_API_KEY${suffix}`,
        `AZURE_FOUNDRY_DEPLOYMENTS${suffix}`,
      ]
    ),
    'GPT_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'CEREBRAS_API_KEY',
  ];
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6.1-sol';
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    const body = record(JSON.parse(String(init?.body)));
    if (requests >= 1) {
      assert.equal(String(input), 'https://openrouter.ai/api/v1/chat/completions');
      const anthropicTools = extractToolsFromResponseFormat(SUPERVISOR_RESPONSE_SCHEMA)!.tools;
      assert.deepEqual(body.tools, openAiChatTools(anthropicTools));
      assert.equal(Object.hasOwn(body, 'anthropicTools'), false);
      assert.equal(Object.hasOwn(body, 'anthropic_tools'), false);
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
    assert.equal(body.model, 'gpt-6.1-sol', 'Ultra must retain its actual GPT-6.1 wire model');
    verifySchemas(body.tools, true);
    assert.equal(Object.hasOwn(body, 'anthropic_tools'), false);
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
    for (const provider_route of [undefined, 'openrouter-waterfall'] as const) {
      calls.length = 0;
      for await (const chunk of await createStreamingCompletion({
        ...options,
        model: 'rose-labs/rose-1-mini',
        response_format: undefined,
        provider_route,
      })) {
        calls.push(...(chunk.choices[0]?.delta.tool_calls ?? []));
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, 'attempt_completion');
    }
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function verifyCerebrasDerivedProjection(): Promise<void> {
  for (const strict of [true, false]) {
    const format = {
      ...SUPERVISOR_RESPONSE_SCHEMA,
      json_schema: { ...SUPERVISOR_RESPONSE_SCHEMA.json_schema, strict },
    };
    const derived = withNativeToolContract({ ...options, response_format: format });
    const body = buildCerebrasChatBody(derived);
    const expected = extractToolsFromResponseFormat(format)!.tools.map((tool) => ({
      ...tool,
      strict,
    }));
    assert.deepEqual(body.tools, openAiChatTools(expected));
    const rawBody = buildCerebrasChatBody({ ...derived, cerebras_tools: undefined });
    const { tools: projectedTools, ...projectedRest } = body;
    const { tools: rawTools, ...rawRest } = rawBody;
    assert.notDeepEqual(projectedTools, rawTools);
    assert.deepEqual(projectedRest, rawRest, 'only derived Cerebras tool schema may change');
    assert.deepEqual(derived.tools, extractToolsFromResponseFormat(format, false)!.tools);
    assert.deepEqual(derived.anthropic_tools, extractToolsFromResponseFormat(format)!.tools);
    assert.equal(Object.hasOwn(body, 'cerebras_tools'), false);
    assert.equal(Object.hasOwn(body, 'cerebras_tools_source'), false);
  }
  const explicit = [
    {
      name: 'grep',
      description: 'Explicit fixture',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
      strict: false,
    },
  ];
  for (const tools of [explicit, []]) {
    const caller = { ...options, tools };
    const derived = withNativeToolContract(caller);
    assert.equal(derived, caller);
    assert.equal(derived.cerebras_tools, undefined);
    assert.deepEqual(buildCerebrasChatBody(derived).tools, openAiChatTools(tools));
  }
  const projected = withNativeToolContract(options);
  for (const tools of [explicit, [], [...(projected.tools ?? [])]]) {
    const overridden = withNativeToolContract({ ...projected, tools });
    assert.deepEqual(
      buildCerebrasChatBody(overridden).tools,
      openAiChatTools(tools),
      'replacing the generic tools array must invalidate stale dialect metadata'
    );
  }
  const normalized = { ...projected, provider_fast_mode: true };
  assert.deepEqual(
    buildCerebrasChatBody(normalized).tools,
    buildCerebrasChatBody(projected).tools,
    'normalization preserving generic tool identity must preserve the derived dialect'
  );
  const plain = { model: options.model, messages: options.messages };
  assert.equal(withNativeToolContract(plain), plain);
  assert.deepEqual(
    buildCerebrasChatBody(withNativeToolContract(plain)),
    buildCerebrasChatBody(plain)
  );
  const raw = { ...options, response_model: undefined };
  assert.equal(withNativeToolContract(raw), raw);

  const captures: Array<Record<string, unknown>> = [];
  registerUserDataGrepTool(async (_userId, params) => {
    captures.push(params);
    return {
      matches: [],
      total_matches: 0,
      truncated: false,
      pattern: String(params.pattern ?? ''),
      sources: [String(params.source ?? '')],
      applied_limit: 20,
      applied_offset: 0,
      returned: 0,
      has_more: false,
      next_offset: null,
      display_order: 'oldest_first',
      context_unit: 'logical_line',
    };
  });
  const pending: PendingOp[] = [];
  const grepArgs = {
    pattern: 'Offline',
    source: 'messages',
    '-i': false,
    offset: 0,
    filters: { since: null },
  };
  assert.equal(
    (await dispatchToolCall({ tool: 'grep', arguments: grepArgs }, 'offline', pending)).success,
    true
  );
  assert.equal(captures[0]['-i'], false);
  assert.equal(captures[0].offset, 0);
  // The shared executor receives the strict call as sent; the data domain drops its nulls.
  assert.deepEqual(captures[0].filters, { since: null });
  const omittedBudget = { goal: 'Offline', start_phase: 'plan' };
  assert.equal(
    (
      await dispatchToolCall(
        { tool: 'start_new_agent', arguments: omittedBudget },
        'offline',
        pending
      )
    ).success,
    true
  );
  assert.deepEqual(pending[0].args, omittedBudget, 'no default fields are fabricated');
  assert.equal(
    (
      await dispatchToolCall(
        {
          tool: 'start_new_agent',
          arguments: {
            ...omittedBudget,
            budget_dollars: '1',
          },
        },
        'offline',
        pending
      )
    ).success,
    false
  );
  assert.equal(
    (
      await dispatchToolCall(
        {
          tool: 'grep',
          arguments: {
            ...grepArgs,
            '-i': 'false',
          },
        },
        'offline',
        pending
      )
    ).success,
    false
  );
  assert.equal(pending.length, 1);
  assert.equal(captures.length, 1);

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'offline-mocked-key';
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.cerebras.ai/v1/chat/completions');
    const body = record(JSON.parse(String(init?.body)));
    const expected = extractToolsFromResponseFormat(SUPERVISOR_RESPONSE_SCHEMA)!.tools.map(
      (tool) => ({ ...tool, strict: true })
    );
    assert.deepEqual(body.tools, openAiChatTools(expected));
    assert.equal(Object.hasOwn(body, 'cerebras_tools'), false);
    assert.equal(Object.hasOwn(body, 'cerebras_tools_source'), false);
    requests++;
    const call = {
      index: 0,
      id: 'native-original',
      type: 'function',
      function: {
        name: 'attempt_completion',
        arguments: '{}',
      },
    };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })}\n\ndata: [DONE]\n\n`
    );
  };
  try {
    const calls = [];
    for await (const chunk of await createStreamingCompletion({
      ...options,
      model: 'rose-labs/rose-1-flash',
      response_format: undefined,
    })) {
      calls.push(...(chunk.choices[0]?.delta.tool_calls ?? []));
    }
    assert.equal(requests, 1);
    assert.equal(calls[0].id, 'native-original');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = originalKey;
  }
}

async function main(): Promise<void> {
  verifyNestedArgumentsWithSibling();
  await verifyCerebrasDerivedProjection();
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
