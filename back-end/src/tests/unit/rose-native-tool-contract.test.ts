#!/usr/bin/env tsx
/**
 * A tool-envelope response_model reaches every Rose leg as native tools.
 *
 * Python Rose.complete projects an AgentAction-style response_model into
 * native tools for every leg. TS projected it only for Anthropic and sent a
 * JSON response_format to the GPT, Cerebras and OpenRouter legs. GPT-6 Sol then
 * answered the SMS supervisor with one envelope per Responses message item
 * (commentary, then final_answer). The structured-output reader keeps only the
 * final item, so the supervisor executed 1 of 5 planned tool calls (RCA
 * 2026-10-09). The pool waterfall also dropped explicit `tools` entirely.
 */

import assert from 'node:assert/strict';

import { createStreamingCompletion } from '../../providers/rose';
import { FOUNDRY_REGION_ENV_NAMES } from '../../providers/rose/foundry';
import { buildOpenRouterBody } from '../../providers/rose/waterfall';
import { applyAnthropicToolConfig, withNativeToolContract } from '../../providers/rose/transforms';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import type { CompletionChunk } from '../../providers/rose/types';
import {
  SUPERVISOR_RESPONSE_MODEL,
  SUPERVISOR_RESPONSE_SCHEMA,
} from '../../providers/smsSupervisor/schema';
import {
  buildOpenRouterCerebrasBody,
  exclusiveOpenRouterCerebrasCompletion,
} from '../../providers/rose/openrouterCerebrasRoute';
import {
  buildOpenRouterFastChatBody,
  exclusiveOpenRouterFastChatCompletion,
  OPENROUTER_CHAT_LATENCY_PROVIDER,
} from '../../providers/rose/openrouterFastRoute';

const FOUNDRY_URL = 'https://a-4989-resource.openai.azure.com/openai/v1/responses';
const SUPERVISOR_TOOLS = [
  'reply_to_agent',
  'kill_agent',
  'increase_budget',
  'start_new_agent',
  'web_search',
  'grep',
  'get_environment',
  'send_user_message',
  'attempt_completion',
];

const responsesFunctionCall = (callId: string, name: string, args: string): string =>
  `data: ${JSON.stringify({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: callId, name, arguments: args },
  })}\n\n` +
  `data: ${JSON.stringify({
    type: 'response.completed',
    response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
  })}\n\ndata: [DONE]\n\n`;

const chatFunctionCall = (callId: string, name: string, args: string): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: callId, type: 'function', function: { name, arguments: args } },
          ],
        },
      },
    ],
  })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
  'data: [DONE]\n\n';

function toolNames(tools: unknown): string[] {
  return (tools as Array<Record<string, unknown>>).map((tool) => {
    const fn = (tool.function as Record<string, unknown> | undefined) ?? tool;
    return String(fn.name);
  });
}

async function collectToolCalls(stream: AsyncIterable<CompletionChunk>) {
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  for await (const chunk of stream) {
    for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
      calls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return calls;
}

function test(name: string): void {
  process.stdout.write(`PASS rose-native-tool-contract: ${name}\n`);
}

async function verifyExclusiveOpenRouterTools(): Promise<void> {
  const options = withNativeToolContract({
    model: 'rose-labs/rose-1-flash',
    messages: [{ role: 'user' as const, content: 'Search and reply' }],
    response_model: SUPERVISOR_RESPONSE_MODEL,
    response_format: SUPERVISOR_RESPONSE_SCHEMA,
  });
  const variants = (
    SUPERVISOR_RESPONSE_SCHEMA.json_schema.schema.properties as {
      tool_calls: { items: { anyOf: Array<{ properties: Record<string, unknown> }> } };
    }
  ).tool_calls.items.anyOf;
  const originalFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), OPENROUTER_API_URL);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(toolNames(body.tools), SUPERVISOR_TOOLS);
      const tools = body.tools as Array<{
        type: string;
        function: { name: string; parameters: unknown; strict: boolean };
      }>;
      for (const [index, tool] of tools.entries()) {
        assert.equal(tool.type, 'function');
        assert.deepEqual(tool.function.parameters, variants[index].properties.arguments);
        assert.equal(tool.function.strict, true);
        assert.equal('input_schema' in tool.function, false);
      }
      assert.equal(body.tool_choice, 'required');
      assert.equal(body.response_format, undefined);
      requests++;
      const event = (delta: unknown, finish_reason?: string) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        event({
          tool_calls: [
            {
              index: 1,
              id: 'reply-id',
              function: { name: 'send_user_message', arguments: '{"message":"' },
            },
            {
              index: 0,
              id: 'search-id',
              function: { name: 'web_search', arguments: '{"query":"' },
            },
          ],
        }) +
          event(
            {
              tool_calls: [
                { index: 0, function: { arguments: 'canada eta"}' } },
                { index: 1, function: { arguments: 'Found it"}' } },
              ],
            },
            'tool_calls'
          ) +
          'data: [DONE]\n\n'
      );
    }) as typeof fetch;
    for (const stream of [
      exclusiveOpenRouterCerebrasCompletion({
        options,
        openrouterKey: 'offline-key',
        requestId: 'offline-cerebras',
      }),
      exclusiveOpenRouterFastChatCompletion({
        options,
        openrouterKey: 'offline-key',
        requestId: 'offline-fast',
      }),
    ]) {
      const calls = [];
      for await (const chunk of stream) {
        if (chunk.kind === 'tool_call') calls.push(chunk.data);
      }
      assert.deepEqual(calls, [
        { id: 'search-id', name: 'web_search', arguments: '{"query":"canada eta"}' },
        { id: 'reply-id', name: 'send_user_message', arguments: '{"message":"Found it"}' },
      ]);
    }
    assert.equal(requests, 2);
    test('both exclusive OpenRouter routes carry all nine SMS tools and fragmented parallel calls');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(buildOpenRouterCerebrasBody(options).provider, {
    only: ['cerebras'],
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.deepEqual(
    buildOpenRouterCerebrasBody(options, { allowProviderFallback: true }).provider,
    OPENROUTER_CHAT_LATENCY_PROVIDER
  );
  const builders = [
    buildOpenRouterCerebrasBody,
    (value: typeof options) => buildOpenRouterFastChatBody(value, 'offline'),
  ];
  for (const build of builders) {
    const explicit = build({
      ...options,
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      tool_choice: { name: 'lookup' },
    });
    assert.deepEqual(explicit.tools, [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: '',
          parameters: { type: 'object' },
        },
      },
    ]);
    assert.deepEqual(explicit.tool_choice, { type: 'function', function: { name: 'lookup' } });
    const empty = build({ ...options, tools: [], tool_choice: 'any' });
    assert.equal('tools' in empty, false);
    assert.equal('tool_choice' in empty, false);
  }
  test('exclusive routes preserve provider policy, named tools and tool-free requests');
}

async function main(): Promise<void> {
  await verifyExclusiveOpenRouterTools();
  const originalFetch = globalThis.fetch;
  const envKeys = [
    ...FOUNDRY_REGION_ENV_NAMES,
    'COMPUTE_TOKEN_AUTHORITY_URL',
    'COMPUTE_TOKEN_AUTHORITY_API_KEY',
    'GPT_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'CEREBRAS_API_KEY',
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  try {
    process.env.COMPUTE_TOKEN_AUTHORITY_URL = 'https://authority.example.test';
    process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY = 'fixture';
    // Responses leg (Foundry serves GPT-6 Sol for ultra without a token).
    process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
    process.env.AZURE_FOUNDRY_API_KEY = 'test-key';
    process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol';
    let responsesBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://authority.example.test/')) {
        return Response.json(
          String(input).includes('/cooldown?') ? { cooldowns: {} } : { reset: true }
        );
      }
      assert.equal(String(input), FOUNDRY_URL);
      responsesBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(responsesFunctionCall('call_sol', 'grep', '{"pattern":"passport"}'));
    }) as typeof fetch;
    const solCalls = await collectToolCalls(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-ultra',
        messages: [{ role: 'user', content: 'Filled it for me' }],
        response_model: SUPERVISOR_RESPONSE_MODEL,
      })
    );
    const sent = responsesBody as unknown as Record<string, unknown>;
    assert.deepEqual(toolNames(sent.tools), SUPERVISOR_TOOLS);
    for (const tool of sent.tools as Array<Record<string, unknown>>) {
      assert.equal(tool.type, 'function');
      assert.equal(typeof tool.parameters, 'object');
      assert.equal('input_schema' in tool, false);
    }
    assert.equal(sent.tool_choice, 'required');
    assert.equal(sent.text, undefined, 'no JSON envelope format alongside native tools');
    assert.deepEqual(solCalls, [
      { id: 'call_sol', name: 'grep', arguments: '{"pattern":"passport"}' },
    ]);
    test('Responses legs receive the supervisor envelope as required native tools');

    // rose-1-flash: Cerebras Qwen first, then the OpenRouter waterfall.
    for (const key of ['AZURE_FOUNDRY_ENDPOINT', 'AZURE_FOUNDRY_API_KEY']) delete process.env[key];
    process.env.CEREBRAS_API_KEY = 'cerebras-test';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    const chatBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      chatBodies.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (url === CEREBRAS_API_URL) return new Response('overloaded', { status: 500 });
      assert.equal(url, OPENROUTER_API_URL);
      return new Response(chatFunctionCall('call_or', 'web_search', '{"query":"canada eta"}'));
    }) as typeof fetch;
    const flashCalls = await collectToolCalls(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-flash',
        messages: [{ role: 'user', content: 'Filled it for me' }],
        response_model: SUPERVISOR_RESPONSE_MODEL,
      })
    );
    assert.deepEqual(
      chatBodies.map((entry) => entry.url),
      [CEREBRAS_API_URL, OPENROUTER_API_URL]
    );
    for (const { body } of chatBodies) {
      assert.deepEqual(toolNames(body.tools), SUPERVISOR_TOOLS);
      for (const tool of body.tools as Array<Record<string, unknown>>) {
        assert.equal(tool.type, 'function');
        const fn = tool.function as Record<string, unknown>;
        assert.equal(typeof fn.parameters, 'object');
        assert.equal('input_schema' in fn, false);
      }
      assert.equal(body.tool_choice, 'required');
      assert.equal(body.response_format, undefined);
    }
    assert.deepEqual(flashCalls, [
      { id: 'call_or', name: 'web_search', arguments: '{"query":"canada eta"}' },
    ]);
    test('Cerebras and the pool waterfall receive the same native tool contract');

    // Explicit tools used to vanish on the pool waterfall leg.
    chatBodies.length = 0;
    await collectToolCalls(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-flash',
        messages: [{ role: 'user', content: 'look it up' }],
        tools: [{ name: 'lookup', description: 'Look up', input_schema: { type: 'object' } }],
        tool_choice: { name: 'lookup' },
      })
    );
    const waterfallBody = chatBodies.find((entry) => entry.url === OPENROUTER_API_URL)?.body;
    assert.deepEqual(waterfallBody?.tools, [
      {
        type: 'function',
        function: { name: 'lookup', description: 'Look up', parameters: { type: 'object' } },
      },
    ]);
    assert.deepEqual(waterfallBody?.tool_choice, {
      type: 'function',
      function: { name: 'lookup' },
    });
    test('explicit tools survive the pool waterfall leg');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // Google AI Studio rejects the named form; plain response models keep JSON.
  const google = buildOpenRouterBody({
    model: 'google/gemini-3.8-flash',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    toolChoice: { name: 'lookup' },
  });
  assert.equal(google.tool_choice, 'required');
  const noTools = buildOpenRouterBody({
    model: 'qwen/qwen3.8-27b',
    messages: [{ role: 'user', content: 'x' }],
    toolChoice: 'any',
  });
  assert.equal('tool_choice' in noTools, false, 'tool_choice only accompanies declared tools');
  test('OpenRouter tool_choice follows the Python dialect rules');

  // Anthropic accepts the OpenAI function shape, like apply_anthropic_tool_config.
  const anthropicBody: Record<string, unknown> = {};
  applyAnthropicToolConfig(
    anthropicBody,
    null,
    [
      {
        type: 'function',
        function: { name: 'lookup', description: 'Look up', parameters: { type: 'object' } },
      },
    ],
    { type: 'function', function: { name: 'lookup' } }
  );
  assert.deepEqual(anthropicBody.tools, [
    { name: 'lookup', description: 'Look up', input_schema: { type: 'object' } },
  ]);
  assert.deepEqual(anthropicBody.tool_choice, { type: 'tool', name: 'lookup' });
  test('Anthropic legs accept OpenAI-shaped tools and named tool_choice');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
