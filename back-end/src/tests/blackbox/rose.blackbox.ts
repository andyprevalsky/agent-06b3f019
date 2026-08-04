#!/usr/bin/env tsx
/*
 * eslint-disable max-lines
 *
 * Matches the convention across the 13 other blackbox test files in
 * src/tests/blackbox/. Test runner output goes through console; coverage-driven
 * test growth pushes file lines past the 600 default. See e.g.
 * agents.blackbox.ts, integrations.blackbox.ts which use the same disable.
 */
/* eslint-disable max-lines */
/**
 * Module-level black-box tests for back-end/src/providers/rose/.
 *
 * Unlike the HTTP-level blackbox files in this directory, this suite does NOT
 * require a running backend. It stubs `global.fetch` and exercises the Rose
 * provider (`createStreamingCompletion`) directly. Mirrors the coverage of
 * `agents/tests/blackbox/rose.blackbox.py` for the TypeScript port.
 *
 * Covers:
 *   - pool resolution invariants (poolForModel / getPool / isRoseModel)
 *   - claudeAuth happy path (Anthropic SSE → CompletionChunk with `-claude` suffix)
 *   - claudeAuth 401 → falls through to waterfall
 *   - claudeAuth 400 → RoseInvalidRequest (caller sees fall-through, serves waterfall)
 *   - waterfall first-provider 500 → second provider serves the stream
 *   - all-waterfall failure → RoseAllFailed
 *   - unknown model → throws
 *   - transforms.transformSchemaForAnthropic strips unsupported keywords
 *
 * Usage:
 *   npx tsx src/tests/blackbox/rose.blackbox.ts
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

import {
  __resetAnthropicApiKeyCooldown,
  buildOpenAiResponseFormat,
  createStreamingCompletion,
  getPool,
  isRoseModel,
  markCacheable,
  POOL_REGISTRY,
  poolForModel,
  RoseAllFailed,
  RoseInvalidRequest,
  RoseRefusalError,
  RoseStallError,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  responseModel,
  type CompletionChunk,
} from '../../providers/rose';
import { buildAnthropicBody } from '../../providers/rose/claudeAuth';
import { buildCerebrasChatBody } from '../../providers/rose/cerebrasRoute';
import { buildOpenRouterCerebrasBody } from '../../providers/rose/openrouterCerebrasRoute';
import { buildOpenRouterFastChatBody } from '../../providers/rose/openrouterFastRoute';
import { buildOpenRouterBody } from '../../providers/rose/waterfall';
import { buildEnvironmentToolMessages } from '../../providers/smsSupervisor/environmentMessages';
import { buildCodexResponsesBody } from '../../providers/rose/gptAuth';
import {
  parseAnthropicSSE,
  parseOpenAISSE,
  parseResponsesSSE,
} from '../../providers/rose/streaming';
import {
  applyAnthropicResponseFormat,
  applyAnthropicToolConfig,
  extractToolsFromResponseFormat,
  transformMessagesForAnthropic,
  transformSchemaForAnthropic,
} from '../../providers/rose/transforms';
import type { CompletionMessage, RoseStreamChunk } from '../../providers/rose/types';
import {
  ANTHROPIC_API_URL,
  CODEX_API_URL,
  OPENAI_RESPONSES_API_URL,
  OPENROUTER_API_URL,
} from '../../providers/rose/transport';
import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    // Deterministic baseline: the real ANTHROPIC_API_KEY lives in back-end/.env,
    // so without this every test would engage the api-key tier. Clear it (and the
    // shared cooldown) before each case; tests that exercise the tier opt back in.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GPT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await __resetAnthropicApiKeyCooldown();
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      duration: Date.now() - start,
    };
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function findLooseObjectSchemas(schema: unknown, path = '$'): string[] {
  if (schema === null || typeof schema !== 'object') return [];

  const node = schema as Record<string, unknown>;
  const loose: string[] = [];
  const type = node.type;
  const isObjectSchema =
    type === 'object' || (Array.isArray(type) && type.some((entry) => entry === 'object'));

  if (isObjectSchema && node.additionalProperties !== false) {
    loose.push(path);
  }

  const properties = node.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      loose.push(...findLooseObjectSchemas(child, `${path}.properties.${key}`));
    }
  }

  if (node.items !== undefined) {
    loose.push(...findLooseObjectSchemas(node.items, `${path}.items`));
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => {
        loose.push(...findLooseObjectSchemas(branch, `${path}.${keyword}[${index}]`));
      });
    }
  }

  return loose;
}

// ==================== FETCH STUB ====================

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

const originalFetch = global.fetch;

function installFetchStub(handler: FetchHandler): void {
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    return handler(url, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  global.fetch = originalFetch;
}

/** Build a streaming Response from the given SSE lines. */
function sseResponse(lines: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Minimal canonical SSE payloads
const ANTHROPIC_OK_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: [DONE]',
  '',
];

const OPENROUTER_OK_SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
  '',
  'data: [DONE]',
  '',
];

const RESPONSES_OK_SSE = [
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Hello"}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":" GPT"}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10,"input_tokens_details":{"cached_tokens":2}}}}',
  '',
  'data: [DONE]',
  '',
];

async function collect(stream: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

// ==================== POOL INVARIANT TESTS ====================

async function testPool_isRoseModelVariants() {
  assert(isRoseModel('rose'), 'rose alias');
  assert(isRoseModel('rose-ultra'), 'rose-ultra alias');
  assert(isRoseModel('rose-labs/rose-1-lite'), 'rose-labs/rose-1-lite');
  assert(isRoseModel('ROSE-LABS/ROSE-1-ULTRA'), 'case-insensitive');
  assert(!isRoseModel('anthropic/claude-sonnet-4.5'), 'non-rose');
  assert(!isRoseModel(null), 'null');
  assert(!isRoseModel(''), 'empty');
}

async function testPool_forModelFuzzy() {
  assertEqual(poolForModel('rose-labs/rose-1-lite'), 'rose-1-lite', 'lite');
  assertEqual(poolForModel('rose-labs/rose-1-ultra'), 'rose-1-ultra', 'ultra');
  assertEqual(poolForModel('rose-labs/rose-1-browser-use'), 'rose-1-browser-use', 'browser-use');
  assertEqual(poolForModel('rose'), 'rose-1-lite', 'rose alias');
  assertEqual(poolForModel('rose-ultra'), 'rose-1-ultra', 'rose-ultra alias');
  // Strict resolution: unknown rose-labs/* identifiers fall through to null so
  // the caller rejects them explicitly (e.g. a typo or unreleased rose-labs/rose-2
  // must not silently route to rose-1-lite).
  assertEqual(poolForModel('rose-labs/something-ultra-new'), null, 'unknown rose-labs/*');
  assertEqual(poolForModel('rose-labs/rose-2'), null, 'future rose-labs model');
  assertEqual(poolForModel('openai/gpt-4'), null, 'non-rose');
  assertEqual(poolForModel(''), null, 'empty');
}

async function testPool_getPoolRegistryShape() {
  const lite = getPool('rose-1-lite');
  const ultra = getPool('rose-1-ultra');
  const browserUse = getPool('rose-1-browser-use');
  assertEqual(lite.name, 'rose-1-lite', 'lite.name');
  assert(lite.claudeAuthModel.startsWith('claude-'), 'lite claudeAuthModel');
  assertEqual(lite.gptAuthModel, 'gpt-5.6-terra', 'lite.gptAuthModel');
  assert(lite.waterfall.length >= 1, 'lite.waterfall length');
  assertEqual(ultra.name, 'rose-1-ultra', 'ultra.name');
  assert(ultra.claudeAuthModel.startsWith('claude-'), 'ultra claudeAuthModel');
  assertEqual(ultra.gptAuthModel, 'gpt-5.6-sol', 'ultra.gptAuthModel');
  assertEqual(browserUse.name, 'rose-1-browser-use', 'browserUse.name');
  assertEqual(browserUse.gptAuthModel, 'gpt-5.6-sol', 'browserUse.gptAuthModel');
  assertEqual(browserUse.waterfall.at(-1), 'openai/gpt-5.6-sol', 'browserUse OpenRouter fallback');
  assert(lite.waterfall !== ultra.waterfall, 'lite.waterfall !== ultra.waterfall');
  assertEqual(Object.keys(POOL_REGISTRY).length, 3, 'registry has 3 pools');
}

async function testPool_unknownModelThrows() {
  let threw = false;
  try {
    await createStreamingCompletion({
      model: 'some/unknown-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes('unknown model'),
      `expected unknown-model error, got ${err}`
    );
  }
  assert(threw, 'expected createStreamingCompletion to reject unknown model');
}

// ==================== CLAUDEAUTH TESTS ====================

async function testClaudeAuth_happyPath() {
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'test-token',
    });
    const chunks = await collect(stream);

    assertEqual(anthropicCalls, 1, 'anthropic call count');
    assertEqual(openrouterCalls, 0, 'openrouter call count');
    assert(chunks.length > 0, 'chunks emitted');
    const first = chunks[0];
    assertEqual(first.requested_model, 'rose-labs/rose-1-lite', 'requested_model');
    assertEqual(first.pool_name, 'claude-token', 'pool_name=claude-token');
    assert(
      first.actual_model.endsWith('-claude'),
      `actual_model ends with -claude, got ${first.actual_model}`
    );
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    assertEqual(text, 'Hello world', 'concatenated text');
    const usageChunk = chunks[chunks.length - 1];
    assertEqual(usageChunk.choices[0].finish_reason, 'stop', 'finish_reason=stop');
    assert(usageChunk.usage !== null && usageChunk.usage !== undefined, 'usage present');
    assertEqual(usageChunk.usage!.prompt_tokens, 10, 'prompt_tokens');
    assertEqual(usageChunk.usage!.completion_tokens, 5, 'completion_tokens');
  } finally {
    restoreFetch();
  }
}

async function testGptAuth_happyPathUsesCodexResponses() {
  let codexCalls = 0;
  let openrouterCalls = 0;
  let capturedHeaders: Headers | undefined;
  let capturedBody: Record<string, unknown> | undefined;
  installFetchStub((url, init) => {
    if (url === CODEX_API_URL) {
      codexCalls++;
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(RESPONSES_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [
        { role: 'system', content: 'be exact' },
        { role: 'user', content: 'hi' },
      ],
      gpt_token: 'gpt-token',
      gpt_account_id: 'acct_123',
      max_tokens: 123,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'unit_test',
          strict: true,
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    });
    const chunks = await collect(stream);

    assertEqual(codexCalls, 1, 'codex call count');
    assertEqual(openrouterCalls, 0, 'openrouter call count');
    assertEqual(capturedHeaders?.get('Authorization'), 'Bearer gpt-token', 'authorization header');
    assertEqual(capturedHeaders?.get('originator'), 'codex_cli_rs', 'originator header');
    assertEqual(capturedHeaders?.get('ChatGPT-Account-ID'), 'acct_123', 'account header');
    assertEqual(
      capturedHeaders?.get('session_id'),
      capturedBody?.prompt_cache_key as string,
      'session_id mirrors prompt cache key'
    );
    assertEqual(
      capturedHeaders?.get('x-client-request-id'),
      capturedBody?.prompt_cache_key as string,
      'x-client-request-id mirrors prompt cache key'
    );
    assertEqual(capturedBody?.model, getPool('rose-1-lite').gptAuthModel, 'codex model');
    assertEqual(capturedBody?.stream, true, 'stream true');
    assertEqual(capturedBody?.store, false, 'store false');
    assert(!('max_tokens' in (capturedBody ?? {})), 'max_tokens omitted');
    assert(!('max_output_tokens' in (capturedBody ?? {})), 'max_output_tokens omitted');
    assert(!('temperature' in (capturedBody ?? {})), 'temperature omitted for Codex backend');
    assertEqual(
      (capturedBody?.reasoning as Record<string, unknown>)?.effort,
      'medium',
      'default reasoning effort'
    );
    assert(
      typeof capturedBody?.prompt_cache_key === 'string' &&
        capturedBody.prompt_cache_key.startsWith('rose:'),
      'stable prompt cache key present'
    );
    const samePromptDifferentRequest = buildCodexResponsesBody({
      poolSpec: getPool('rose-1-lite'),
      messages: [
        { role: 'system', content: 'be exact' },
        { role: 'user', content: 'different live input' },
      ],
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'unit_test',
          strict: true,
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      requestId: 'different-request-id',
    });
    assertEqual(
      capturedBody?.prompt_cache_key,
      samePromptDifferentRequest.prompt_cache_key,
      'prompt cache key stable across request ids and live input'
    );
    const noSystemBody = buildCodexResponsesBody({
      poolSpec: getPool('rose-1-lite'),
      messages: [{ role: 'user', content: 'hi' }],
      requestId: 'no-system',
    });
    assertEqual(
      noSystemBody.instructions,
      'You are a helpful assistant.',
      'Codex instructions default present'
    );
    const splitSystemBody = buildCodexResponsesBody({
      poolSpec: getPool('rose-1-lite'),
      messages: [
        {
          role: 'system',
          content: `static rules${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic rules`,
        },
        { role: 'user', content: 'hi' },
      ],
      requestId: 'split-system',
    });
    assertEqual(
      splitSystemBody.instructions,
      'static rules\n\ndynamic rules',
      'Codex instructions strip internal system prompt boundary'
    );
    assert(
      !String(splitSystemBody.instructions).includes('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'),
      'Codex instructions do not send boundary sentinel'
    );
    const maxEffortBody = buildCodexResponsesBody({
      poolSpec: getPool('rose-1-lite'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
      requestId: 'max-effort',
    });
    assertEqual(
      (maxEffortBody.reasoning as Record<string, unknown>).effort,
      'xhigh',
      'max effort normalized'
    );
    assertEqual(
      ((capturedBody?.text as Record<string, unknown>)?.format as Record<string, unknown>)?.name,
      'unit_test',
      'json schema name'
    );
    assertEqual(chunks[0].pool_name, 'gpt-token', 'pool_name=gpt-token');
    assert(chunks[0].actual_model.endsWith('-gpt'), 'actual_model ends -gpt');
    assertEqual(
      chunks.map((c) => c.choices[0]?.delta?.content ?? '').join(''),
      'Hello GPT',
      'text'
    );
    assertEqual(chunks[chunks.length - 1].usage?.cache_read_input_tokens, 2, 'cache reads');
  } finally {
    restoreFetch();
  }
}

async function testGptAuth_buildBodyPreservesToolHistoryAndMultimodal() {
  const body = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-lite'),
    messages: [
      { role: 'system', content: 'be exact' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } },
        ],
      },
      {
        role: 'assistant',
        content: 'calling',
        codex_reasoning_items: [{ id: 'rs_1', encrypted_content: 'secret', summary: [] }],
        codex_message_items: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            id: 'msg_1',
            phase: 'final',
            content: [{ type: 'output_text', text: 'prior' }],
          },
        ],
        tool_calls: [{ id: 'call_lookup', function: { name: 'lookup', arguments: { q: 'x' } } }],
      },
      { role: 'tool', tool_call_id: 'call_lookup', content: '{"ok":true}' },
      { role: 'user', content: 'continue' },
    ] as never,
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Search',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ],
    temperature: 0.2,
    requestId: 'rid-tool-history',
  });
  const input = body.input as Array<Record<string, unknown>>;
  const firstContent = input[0].content as Array<Record<string, unknown>>;
  assertEqual(firstContent[1].type, 'input_image', 'image part type');
  assertEqual(firstContent[1].detail, 'high', 'image detail preserved');
  assert(
    input.some((item) => item.type === 'reasoning' && item.encrypted_content === 'secret'),
    'reasoning replayed'
  );
  const replayedReasoning = input.filter((item) => item.type === 'reasoning');
  assertEqual(replayedReasoning.length, 1, 'encrypted reasoning kept as one separate item');
  assert(
    input.some((item) => item.type === 'message' && item.id === 'msg_1'),
    'assistant message item replayed'
  );
  assert(
    input.every((item) => item.type === 'reasoning' || !('encrypted_content' in item)),
    'encrypted reasoning not mixed into visible message/tool items'
  );
  assert(
    input.some((item) => item.type === 'function_call' && item.call_id === 'call_lookup'),
    'function call replayed'
  );
  assert(
    input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_lookup'),
    'function output replayed'
  );
  assertEqual((body.tools as Array<Record<string, unknown>>)[0].name, 'lookup', 'tool converted');
  assert(!('temperature' in body), 'temperature omitted');
}

async function testGptAuth_buildBodyConvertsOrphanToolRowsToContext() {
  const body = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-lite'),
    messages: [
      { role: 'system', content: 'be exact' },
      { role: 'user', content: 'summarize prior tool output' },
      { role: 'tool', tool_call_id: 'missing_call', content: 'population: 123' },
    ] as never,
    requestId: 'rid-orphan-tool',
  });
  const input = body.input as Array<Record<string, unknown>>;
  assert(
    !input.some((item) => item.type === 'function_call_output'),
    'orphan tool rows are not sent as function_call_output'
  );
  const last = input[input.length - 1] as {
    role?: string;
    content?: Array<Record<string, unknown>>;
  };
  assertEqual(last.role, 'user', 'orphan tool row converted to user context');
  assertEqual(last.content?.[0]?.text, '[TOOL]: population: 123', 'orphan tool text preserved');
}

async function testGptAuth_buildBodyAddsInputForSystemOnlyContext() {
  const body = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-lite'),
    messages: [{ role: 'system', content: 'system only' }],
    requestId: 'rid-system-only',
  });
  assertEqual(
    JSON.stringify(body.input),
    JSON.stringify([{ role: 'user', content: [{ type: 'input_text', text: 'Begin.' }] }]),
    'system-only context gets a non-empty Codex input'
  );
}

async function testGptAuth_smsSupervisorSchemaIsStrictForCodexResponses() {
  const body = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-lite'),
    messages: [{ role: 'user', content: 'hi from sms' }],
    responseFormat: SUPERVISOR_RESPONSE_SCHEMA,
    requestId: 'rid-sms-supervisor-schema',
  });

  const schema = (((body.text as Record<string, unknown>).format as Record<string, unknown>)
    .schema ?? {}) as Record<string, unknown>;
  const looseObjects = findLooseObjectSchemas(schema);

  assertEqual(
    looseObjects.join(', '),
    '',
    'SMS supervisor schema must not contain open object shapes rejected by Codex'
  );
}

/**
 * Anthropic rejects a request declaring more than 16 union-typed parameters.
 * `z.discriminatedUnion` spells its discriminator as `enum: ["name"]`, so a
 * `const`-only extractor sent the whole envelope down the legacy single-schema
 * path — 27 nullable unions — and every claudeAuth SMS round 400'd into the
 * paid waterfall.
 */
async function testClaudeAuth_smsSupervisorLiftsNativeToolsWithoutUnions() {
  const extracted = extractToolsFromResponseFormat(SUPERVISOR_RESPONSE_SCHEMA);
  assert(extracted !== null, 'discriminated-union envelope must lift to native tools');

  const names = extracted.tools.map((tool) => tool.name as string);
  assert(names.includes('start_new_agent'), `expected start_new_agent, got ${names.join(',')}`);
  assert(names.includes('grep'), `expected grep, got ${names.join(',')}`);

  for (const tool of extracted.tools) {
    const serialized = JSON.stringify(tool.input_schema);
    const unions = (serialized.match(/"type":"null"/g) ?? []).length;
    assertEqual(String(unions), '0', `${tool.name as string} must declare no nullable unions`);
  }

  // Collapsing the union must not drop the model-facing field documentation.
  const startAgent = extracted.tools.find((tool) => tool.name === 'start_new_agent');
  const budget = (
    ((startAgent?.input_schema as Record<string, unknown>).properties as Record<string, unknown>)
      .arguments as Record<string, unknown>
  ).properties as Record<string, Record<string, unknown>>;
  assert(
    typeof budget.budget_dollars.description === 'string' &&
      budget.budget_dollars.description.length > 0,
    'budget_dollars description must survive the Anthropic transform'
  );
}

/**
 * Every OpenAI-dialect request must stamp `type: "function"` on assistant
 * tool_calls. Google (via OpenRouter) rejects a transcript without it —
 * 400 "Tool-call assistant message produced no valid function calls but is
 * followed by tool result messages. The conversation transcript is malformed."
 * — which failed the strongest waterfall leg on every SMS round and silently
 * demoted production to the last leg in the pool.
 */
async function testWaterfall_openAiToolCallsCarryFunctionType() {
  // The producer must be correct at the source...
  const injected = buildEnvironmentToolMessages('ctx', 7);
  assertEqual(
    String(injected[0].tool_calls?.[0].type),
    'function',
    'SMS environment injection must emit an OpenAI-valid tool_call'
  );

  // ...and EVERY OpenAI-dialect builder must guarantee it, for every tool_call
  // shape `CompletionMessage` permits. A builder omitted from this table is a
  // live path back to the Google 400 that demoted production.
  const shapes: Array<{ label: string; toolCall: Record<string, unknown> }> = [
    { label: 'nested without discriminator', toolCall: { id: 'x', function: { name: 'f' } } },
    { label: 'flat name/arguments', toolCall: { id: 'y', name: 'g', arguments: '{}' } },
  ];
  const builders: Array<{ label: string; build: (messages: CompletionMessage[]) => unknown }> = [
    {
      label: 'buildOpenRouterBody',
      build: (messages) => buildOpenRouterBody({ model: 'google/gemini-3.5-flash', messages }),
    },
    { label: 'buildCerebrasChatBody', build: (messages) => buildCerebrasChatBody({ messages }) },
    {
      label: 'buildOpenRouterCerebrasBody',
      build: (messages) => buildOpenRouterCerebrasBody({ messages }),
    },
    {
      label: 'buildOpenRouterFastChatBody',
      build: (messages) => buildOpenRouterFastChatBody({ messages }),
    },
  ];

  for (const { label: builderLabel, build } of builders) {
    for (const { label: shapeLabel, toolCall } of shapes) {
      const body = build([
        { role: 'assistant', content: '', tool_calls: [toolCall] },
      ] as CompletionMessage[]) as {
        messages: Array<{ tool_calls?: Array<Record<string, unknown>> }>;
      };
      const sent = body.messages[0].tool_calls?.[0];
      assertEqual(
        String(sent?.type),
        'function',
        `${builderLabel} must stamp the discriminator on a ${shapeLabel} tool_call`
      );
      const fn = sent?.function as { name?: string } | undefined;
      assert(
        typeof fn?.name === 'string' && fn.name.length > 0,
        `${builderLabel} must emit function.name for a ${shapeLabel} tool_call (got ${JSON.stringify(sent)})`
      );
    }
  }
}

/** Anthropic caps a request at four `cache_control` blocks. */
async function testClaudeAuth_bodyStaysWithinCacheBlockBudget() {
  const system = ['universal static', 'stable user block', 'third section', 'fourth section'].join(
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY
  );
  const body = buildAnthropicBody({
    poolSpec: getPool('rose-1-lite'),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'hi from sms' },
    ],
    responseFormat: SUPERVISOR_RESPONSE_SCHEMA,
  });

  const blocks = (JSON.stringify(body).match(/cache_control/g) ?? []).length;
  assert(blocks <= 4, `expected at most 4 cache_control blocks, got ${blocks}`);

  const systemBlocks = body.system as Array<Record<string, unknown>>;
  const marked = systemBlocks.filter((block) => 'cache_control' in block);
  assert(marked.length > 0, 'the longest system prefix must stay cached');
  assertEqual(
    JSON.stringify(marked[marked.length - 1]),
    JSON.stringify(systemBlocks.filter((b) => 'cache_control' in b).slice(-1)[0]),
    'the last system breakpoint is the one retained'
  );
}

async function testSchema_zodResponseModelBuildsStrictOpenAiSchema() {
  const model = responseModel(
    'AgentAction',
    z.object({
      response: z.string(),
      tool_calls: z.array(
        z.discriminatedUnion('tool', [
          z.object({
            tool: z.literal('web_search'),
            query: z.string(),
          }),
          z.object({
            tool: z.literal('attempt_completion'),
            message: z.string(),
            note: z.string().nullable(),
          }),
        ])
      ),
    })
  );

  const format = buildOpenAiResponseFormat(model);
  const schema = format.json_schema.schema;
  const looseObjects = findLooseObjectSchemas(schema);

  assertEqual(format.json_schema.name, 'AgentAction', 'response model name');
  assertEqual(looseObjects.join(', '), '', 'Zod-derived object schemas are strict');
  const toolCalls = (schema.properties as Record<string, Record<string, unknown>>).tool_calls;
  const itemSchema = toolCalls.items as Record<string, unknown>;
  assert(Array.isArray(itemSchema.anyOf), 'discriminated union maps to anyOf');
}

async function testStreaming_responsesFunctionCallItem() {
  const chunks: RoseStreamChunk[] = [];
  for await (const chunk of parseResponsesSSE(
    sseResponse([
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
      '',
      'data: [DONE]',
      '',
    ]).body!,
    { actualModel: 'gpt-5.4-gpt', poolName: 'gpt-token', requestId: 'r-tool' }
  )) {
    chunks.push(chunk);
  }
  const tool = chunks.find((chunk) => chunk.kind === 'tool_call');
  assertEqual(tool?.data.id, 'call_1', 'tool call id');
  assertEqual(tool?.data.name, 'lookup', 'tool call name');
  assertEqual(tool?.data.arguments, '{"q":"x"}', 'tool call args');
  assertEqual(chunks.find((chunk) => chunk.kind === 'usage')?.data.total_tokens, 5, 'usage total');
}

async function testStreaming_responsesReasoningDeltaEvents() {
  const chunks = await collectRose(
    parseResponsesSSE(
      sseResponse([
        'event: response.reasoning_summary_text.delta',
        'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"thinking"}',
        '',
        'event: response.reasoning_text.delta',
        'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","output_index":0,"content_index":0,"delta":" deeper"}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"answer"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
        'data: [DONE]',
        '',
      ]).body!,
      { actualModel: 'gpt-5.4-gpt', poolName: 'gpt-token', requestId: 'r-reasoning' }
    )
  );
  const reasoning = chunks
    .filter((chunk) => chunk.kind === 'reasoning')
    .map((chunk) => chunk.data.text)
    .join('');
  assertEqual(reasoning, 'thinking deeper', 'Responses reasoning deltas routed');
}

async function testStreaming_responsesReasoningItemPreserved() {
  const chunks = await collectRose(
    parseResponsesSSE(
      sseResponse([
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"secret","summary":[{"text":"brief"}]}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"answer"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
        'data: [DONE]',
        '',
      ]).body!,
      { actualModel: 'gpt-5.4-gpt', poolName: 'gpt-token', requestId: 'r-reasoning-item' }
    )
  );
  const item = chunks.find((chunk) => chunk.kind === 'codex_reasoning_item');
  assertEqual(item?.data.id, 'rs_1', 'reasoning item id preserved');
  assertEqual(item?.data.encrypted_content, 'secret', 'encrypted reasoning preserved');
}

async function testStreaming_responsesFailedContextLengthIsInvalidRequest() {
  let raised = false;
  try {
    await collect(
      parseResponsesSSE(
        sseResponse([
          'event: response.failed',
          'data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too many tokens"}}}',
          '',
          'data: [DONE]',
          '',
        ]).body!,
        { actualModel: 'gpt-5.5-gpt', poolName: 'gpt-token', requestId: 'r-context' }
      )
    );
  } catch (err) {
    raised = err instanceof RoseInvalidRequest;
  }
  assert(raised, 'context_length_exceeded raises RoseInvalidRequest');
}

async function testClaudeAuth_401FallsThroughToWaterfall() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return errorResponse(401, JSON.stringify({ error: { message: 'Unauthorized' } }));
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'test-token',
    });
    const chunks = await collect(stream);

    assertEqual(anthropicCalls, 1, 'anthropic attempted exactly once (401 is terminal, no retry)');
    assertEqual(openrouterCalls, 1, 'fell through to openrouter');
    assert(chunks.length > 0, 'chunks emitted from waterfall');
    const first = chunks[0];
    assertEqual(first.pool_name, 'rose-1-lite', 'pool_name from waterfall (not claude-token)');
    assert(
      !first.actual_model.endsWith('-claude'),
      `actual_model should NOT have -claude suffix, got ${first.actual_model}`
    );
  } finally {
    restoreFetch();
  }
}

async function testClaudeAuth_400FallsThroughNoRetry() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  let anthropicCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return errorResponse(400, JSON.stringify({ error: { message: 'bad request' } }));
    }
    if (url === OPENROUTER_API_URL) {
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'test-token',
    });
    await collect(stream);
    // Critical: 400 must NOT trigger the 3x retry loop (RoseInvalidRequest is
    // not retry-eligible). Exactly one anthropic attempt before fall-through.
    assertEqual(anthropicCalls, 1, 'anthropic 400 does NOT retry');
  } finally {
    restoreFetch();
  }
}

async function testClaudeAuth_429RetriesWithBackoffThenSucceeds() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  let anthropicCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      if (anthropicCalls === 1) {
        // 429 with a Retry-After header exercises backoffFor429's header-parse
        // branch + the in-place retry/sleep path before the second attempt.
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'retry-after': '1' },
        });
      }
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'test-token',
    });
    const chunks = await collect(stream);
    assertEqual(anthropicCalls, 2, 'anthropic retried once after 429, then succeeded in place');
    assert(chunks.length > 0, 'chunks emitted after retry');
    assert(
      chunks[0].actual_model.endsWith('-claude'),
      `served by claudeAuth after retry, got ${chunks[0].actual_model}`
    );
  } finally {
    restoreFetch();
  }
}

async function testClaudeAuth_noTokenGoesDirectToWaterfall() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  // No ANTHROPIC_API_KEY funded default configured for this test.
  delete process.env.ANTHROPIC_API_KEY;
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      // no claude_token — should skip claudeAuth entirely
    });
    await collect(stream);
    assertEqual(anthropicCalls, 0, 'no anthropic call without claude_token');
    assertEqual(openrouterCalls, 1, 'direct to openrouter');
  } finally {
    restoreFetch();
  }
}

async function testOpenAiApiKey_servesBeforeAnthropicAndOpenRouter() {
  process.env.GPT_API_KEY = 'sk-proj-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key';
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  let openAiCalls = 0;
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  let capturedBody: Record<string, unknown> | null = null;
  let capturedHeaders: Record<string, string> = {};
  installFetchStub((url, init) => {
    if (url === OPENAI_RESPONSES_API_URL) {
      openAiCalls++;
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return sseResponse(RESPONSES_OK_SSE);
    }
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const chunks = await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    assertEqual(openAiCalls, 1, 'served by OpenAI API-key path');
    assertEqual(anthropicCalls, 0, 'did NOT fall through to Anthropic');
    assertEqual(openrouterCalls, 0, 'did NOT fall through to OpenRouter');
    assertEqual(capturedHeaders.Authorization, 'Bearer sk-proj-test-key', 'sent OpenAI bearer');
    assertEqual(capturedBody?.model, 'gpt-5.6-terra', 'uses Rose Lite GPT model');
    assertEqual(capturedBody?.service_tier, 'priority', 'uses GPT fast mode');
    assert(chunks[0].actual_model.endsWith('-openai'), 'actual_model marks OpenAI key path');
  } finally {
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    restoreFetch();
  }
}

async function testOpenAiApiKey_failureFallsThroughToAnthropicBeforeOpenRouter() {
  process.env.GPT_API_KEY = 'sk-proj-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key';
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  await __resetAnthropicApiKeyCooldown();
  let openAiCalls = 0;
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  installFetchStub((url) => {
    if (url === OPENAI_RESPONSES_API_URL) {
      openAiCalls++;
      return errorResponse(401, JSON.stringify({ error: { message: 'bad key' } }));
    }
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const chunks = await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    assertEqual(openAiCalls, 1, 'OpenAI API-key path attempted');
    assertEqual(anthropicCalls, 1, 'Anthropic API-key path served after OpenAI failure');
    assertEqual(openrouterCalls, 0, 'OpenRouter not reached');
    assert(chunks[0].actual_model.endsWith('-anthropic'), 'actual_model marks Anthropic key path');
  } finally {
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await __resetAnthropicApiKeyCooldown();
    restoreFetch();
  }
}

async function testSharedOpenAiPriorityRoute_isExclusiveAndPreservesRouterConfig() {
  process.env.GPT_API_KEY = 'sk-proj-router-priority';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-run';
  process.env.OPENROUTER_API_KEY = 'sk-or-must-not-run';
  let calls = 0;
  let capturedBody: Record<string, unknown> = {};
  installFetchStub((url, init) => {
    calls += 1;
    assertEqual(url, OPENAI_RESPONSES_API_URL, 'exclusive provider URL');
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(RESPONSES_OK_SSE);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [
        { role: 'system', content: 'router-system-prompt' },
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
      claude_token: 'claude-oauth-must-not-run',
      gpt_token: 'gpt-oauth-must-not-run',
      provider_route: 'shared-openai-priority',
    });
    const chunks = await collect(stream);

    assertEqual(calls, 1, 'exactly one shared OpenAI request');
    assertEqual(capturedBody.model, 'gpt-5.6-terra', 'router provider model');
    assertEqual(capturedBody.service_tier, 'priority', 'priority service tier');
    assertEqual(capturedBody.instructions, 'router-system-prompt', 'system prompt');
    assertEqual(
      JSON.stringify(capturedBody.reasoning),
      JSON.stringify({ effort: 'medium', summary: 'auto' }),
      'reasoning config'
    );
    const text = capturedBody.text as { format?: { name?: string; strict?: boolean } };
    assertEqual(text.format?.name, 'router_decision', 'response schema name');
    assertEqual(text.format?.strict, true, 'response schema strictness');
    assertEqual(chunks[0]?.actual_model, 'gpt-5.6-terra-openai', 'actual model provenance');
    assertEqual(chunks[0]?.pool_name, 'openai-api-key', 'provider provenance');
  } finally {
    restoreFetch();
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  }
}

async function testSharedOpenAiPriorityRoute_missingKeyFailsClosedWithoutProviderCalls() {
  delete process.env.GPT_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-run';
  process.env.OPENROUTER_API_KEY = 'sk-or-must-not-run';
  let calls = 0;
  installFetchStub(() => {
    calls += 1;
    throw new Error('no provider should be called without GPT_API_KEY');
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'route this request' }],
      claude_token: 'claude-oauth-must-not-run',
      gpt_token: 'gpt-oauth-must-not-run',
      provider_route: 'shared-openai-priority',
    });
    let thrown: unknown;
    try {
      await collect(stream);
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Error, 'missing key should throw');
    assertEqual(
      (thrown as Error).message,
      'Rose shared-openai-priority route requires GPT_API_KEY',
      'clear configuration error'
    );
    assertEqual(calls, 0, 'zero fallback provider calls');
  } finally {
    restoreFetch();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  }
}

async function testSharedOpenAiPriorityRoute_invalidKeyFailsClosedWithoutFallbackCalls() {
  process.env.GPT_API_KEY = 'sk-proj-invalid';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-run';
  process.env.OPENROUTER_API_KEY = 'sk-or-must-not-run';
  const calledUrls: string[] = [];
  installFetchStub((url) => {
    calledUrls.push(url);
    if (url === OPENAI_RESPONSES_API_URL) {
      return errorResponse(401, '{"error":{"message":"invalid api key"}}');
    }
    throw new Error(`fallback provider must not run: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'route this request' }],
      claude_token: 'claude-oauth-must-not-run',
      gpt_token: 'gpt-oauth-must-not-run',
      provider_route: 'shared-openai-priority',
    });
    let thrown: unknown;
    try {
      await collect(stream);
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Error, 'invalid key should throw');
    assert(
      (thrown as Error).message.includes('OpenAI 401') &&
        (thrown as Error).message.includes('invalid api key'),
      `expected clear OpenAI auth error, got ${String(thrown)}`
    );
    assertEqual(JSON.stringify(calledUrls), JSON.stringify([OPENAI_RESPONSES_API_URL]), 'calls');
  } finally {
    restoreFetch();
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  }
}

// ANTHROPIC_API_KEY funded default: when no compute token is available but the
// key is configured, the request goes direct to Anthropic via x-api-key (NOT
// the OpenRouter waterfall), and the call carries the API-key headers — never
// the OAuth Bearer/oauth-beta combo.
async function testAnthropicApiKey_servesAsDefaultWhenNoToken() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key';
  await __resetAnthropicApiKeyCooldown();
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  let capturedHeaders: Record<string, string> = {};
  installFetchStub((url, init) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      // no claude_token / gpt_token — api-key default should engage
    });
    const chunks = await collect(stream);
    assertEqual(anthropicCalls, 1, 'served by anthropic api-key path');
    assertEqual(openrouterCalls, 0, 'did NOT fall through to openrouter');
    assertEqual(capturedHeaders['x-api-key'], 'sk-ant-api03-test-key', 'sent x-api-key header');
    assert(
      !('Authorization' in capturedHeaders),
      'api-key path must not send Authorization Bearer'
    );
    assert(
      !(capturedHeaders['anthropic-beta'] ?? '').includes('oauth-2025-04-20'),
      'api-key path must not send the oauth beta flag'
    );
    assert(chunks.length > 0, 'chunks emitted from api-key path');
    assert(
      chunks[0].actual_model.endsWith('-anthropic'),
      `actual_model should carry -anthropic suffix, got ${chunks[0].actual_model}`
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    restoreFetch();
  }
}

// A working compute token wins over the API-key default ($0 OAuth preferred).
async function testAnthropicApiKey_computeTokenTakesPrecedence() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key';
  await __resetAnthropicApiKeyCooldown();
  let oauthCalls = 0;
  let apiKeyCalls = 0;
  installFetchStub((url, init) => {
    if (url === ANTHROPIC_API_URL) {
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (headers['x-api-key']) apiKeyCalls++;
      else oauthCalls++;
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'test-oauth-token',
    });
    await collect(stream);
    assertEqual(oauthCalls, 1, 'served by OAuth claudeAuth');
    assertEqual(apiKeyCalls, 0, 'api-key default not used when OAuth token works');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    restoreFetch();
  }
}

// Out-of-credits (402) opens the breaker: the failing call falls through to the
// waterfall, AND subsequent calls skip the api-key tier entirely (no hammering)
// until the cooldown elapses.
async function testAnthropicApiKey_402OpensCircuitAndStopsHammering() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key';
  await __resetAnthropicApiKeyCooldown();
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return errorResponse(402, JSON.stringify({ error: { message: 'Insufficient credits' } }));
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    // First call: api-key 402 → falls through to waterfall.
    await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    assertEqual(anthropicCalls, 1, 'api-key attempted once');
    assertEqual(openrouterCalls, 1, 'fell through to waterfall after 402');

    // Second call: breaker is open → api-key tier skipped, straight to waterfall.
    await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content: 'hi again' }],
      })
    );
    assertEqual(anthropicCalls, 1, 'api-key NOT retried while circuit open (no hammering)');
    assertEqual(openrouterCalls, 2, 'second call served by waterfall');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    await __resetAnthropicApiKeyCooldown();
    restoreFetch();
  }
}

async function testClient_dumpContextWritesRequestAndOutput() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  const agentId = 'rose-dump-test-agent';
  const dumpDir = path.resolve(__dirname, '../../../..', '.llm-dumps', agentId);
  fs.rmSync(dumpDir, { recursive: true, force: true });

  installFetchStub((url) => {
    if (url === OPENROUTER_API_URL) {
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'credential_failure_classification',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string' } },
          required: ['reason'],
        },
      },
    };
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'classify credentials' },
        { role: 'user', content: '{"status":"FAILED"}' },
      ],
      response_format: responseFormat,
      dump_context: {
        call_site: 'credential_failure_classifier_test',
        agent_id: agentId,
        config: { classifier: 'browser_run_credential_outcomes' },
        extra: { task_id: 'task-1' },
      },
    });
    await collect(stream);

    const dumps = fs
      .readdirSync(dumpDir)
      .filter((name) => name.endsWith('-credential_failure_classifier_test.json'));
    assertEqual(dumps.length, 1, 'one dump file written');
    const payload = JSON.parse(fs.readFileSync(path.join(dumpDir, dumps[0]), 'utf8')) as {
      call_site: string;
      agent_id: string;
      message_count: number;
      messages: Array<{ role: string; content: string }>;
      config: Record<string, unknown>;
      response_format: unknown;
      extra: Record<string, unknown>;
    };
    assertEqual(payload.call_site, 'credential_failure_classifier_test', 'dump call site');
    assertEqual(payload.agent_id, agentId, 'dump agent id');
    assertEqual(payload.message_count, 2, 'dump message count');
    assertEqual(payload.messages[0].role, 'system', 'system message preserved');
    assertEqual(payload.config.temperature, 0, 'temperature dumped');
    assertEqual(payload.config.max_tokens, 200, 'max tokens dumped');
    assertEqual(
      payload.config.classifier,
      'browser_run_credential_outcomes',
      'caller config dumped'
    );
    assertEqual(payload.config.actual_model, 'google/gemini-3.5-flash', 'actual model dumped');
    assertEqual(
      JSON.stringify(payload.response_format),
      JSON.stringify(responseFormat),
      'response format dumped'
    );
    assertEqual(payload.extra.task_id, 'task-1', 'caller extra dumped');
    assertEqual(payload.extra.output, 'Hi there', 'raw model output dumped');
  } finally {
    restoreFetch();
    fs.rmSync(dumpDir, { recursive: true, force: true });
  }
}

// ==================== WATERFALL TESTS ====================

async function testWaterfall_firstFailsSecondSucceeds() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  const callModels: string[] = [];
  let orCallCount = 0;
  installFetchStub((url, init) => {
    if (url === OPENROUTER_API_URL) {
      orCallCount++;
      const body = JSON.parse((init?.body as string) ?? '{}');
      callModels.push(body.model);
      if (orCallCount === 1) {
        return errorResponse(500, 'upstream error');
      }
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const chunks = await collect(stream);
    assertEqual(orCallCount, 2, 'two openrouter attempts');
    const pool = getPool('rose-1-lite');
    assertEqual(callModels[0], pool.waterfall[0], 'first call used waterfall[0]');
    assertEqual(callModels[1], pool.waterfall[1], 'second call used waterfall[1]');
    assert(chunks.length > 0, 'waterfall emitted chunks from step 2');
    assertEqual(chunks[0].actual_model, pool.waterfall[1], 'actual_model = fallback provider');
  } finally {
    restoreFetch();
  }
}

async function testWaterfall_allFailRaisesRoseAllFailed() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  installFetchStub((url) => {
    if (url === OPENROUTER_API_URL) {
      return errorResponse(502, 'bad gateway');
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
    });
    let raised: unknown = null;
    try {
      await collect(stream);
    } catch (err) {
      raised = err;
    }
    assert(raised instanceof RoseAllFailed, `expected RoseAllFailed, got ${raised}`);
    const pool = getPool('rose-1-lite');
    assertEqual(
      (raised as RoseAllFailed).stepErrors.length,
      pool.waterfall.length,
      'stepErrors count matches waterfall length'
    );
  } finally {
    restoreFetch();
  }
}

// ==================== TRANSFORMS ====================

async function testTransforms_stripUnsupportedSchemaKeywords() {
  const input = {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0, maximum: 100 },
      name: { type: 'string', minLength: 1, maxLength: 50 },
      items: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
    $defs: {
      Sub: { type: 'number', multipleOf: 0.5 },
    },
  };
  const out = transformSchemaForAnthropic(input) as {
    type: string;
    properties: {
      count: Record<string, unknown> & { type: string };
      name: Record<string, unknown>;
      items: Record<string, unknown> & { items: Record<string, unknown> };
    };
    $defs: { Sub: Record<string, unknown> };
  };
  assert(!('minimum' in out.properties.count), 'minimum stripped');
  assert(!('maximum' in out.properties.count), 'maximum stripped');
  assert(!('minLength' in out.properties.name), 'minLength stripped');
  assert(!('maxLength' in out.properties.name), 'maxLength stripped');
  assert(!('minItems' in out.properties.items), 'minItems stripped');
  assert(!('minLength' in out.properties.items.items), 'nested minLength stripped');
  assert(!('multipleOf' in out.$defs.Sub), '$defs multipleOf stripped');
  assertEqual(out.type, 'object', 'type preserved');
  assertEqual(out.properties.count.type, 'integer', 'inner type preserved');
}

async function testTransforms_anyOfOneOfAllOfRecursed() {
  const input = {
    anyOf: [
      { type: 'integer', minimum: 0 },
      { type: 'string', minLength: 1 },
    ],
    oneOf: [{ type: 'number', multipleOf: 1 }],
    allOf: [{ type: 'array', minItems: 1 }],
  };
  const out = transformSchemaForAnthropic(input) as {
    anyOf: Record<string, unknown>[];
    oneOf: Record<string, unknown>[];
    allOf: Record<string, unknown>[];
  };
  assert(!('minimum' in out.anyOf[0]), 'anyOf[0].minimum stripped');
  assert(!('minLength' in out.anyOf[1]), 'anyOf[1].minLength stripped');
  assert(!('multipleOf' in out.oneOf[0]), 'oneOf[0].multipleOf stripped');
  assert(!('minItems' in out.allOf[0]), 'allOf[0].minItems stripped');

  const dictionary = transformSchemaForAnthropic({
    type: 'object',
    additionalProperties: { type: 'string', minLength: 1 },
  }) as { additionalProperties: Record<string, unknown> };
  assert(
    !('minLength' in dictionary.additionalProperties),
    'dictionary additionalProperties schema recursed'
  );
}

async function testTransforms_messagesForAnthropicContentBlocks() {
  const result = transformMessagesForAnthropic([
    {
      role: 'system',
      content: `static instructions${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic user context`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at these' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,abc123' },
        },
        {
          type: 'image_url',
          image_url: { url: 'https://example.com/image.png' },
        },
        {
          type: 'file',
          file: { file_data: 'data:application/pdf;base64,pdf123' },
        },
      ],
    },
    { role: 'assistant', content: 'trailing assistant should be removed' },
  ]);

  assertEqual(result.staticSystem, 'static instructions', 'static system split');
  assertEqual(result.dynamicSystem, 'dynamic user context', 'dynamic system split');
  assertEqual(result.messages.length, 1, 'trailing assistant removed');
  const content = result.messages[0].content as Array<Record<string, unknown>>;
  assertEqual(content[1].type, 'image', 'data image converted');
  assertEqual(
    (content[1].source as Record<string, unknown>).media_type,
    'image/png',
    'image media type'
  );
  assertEqual((content[2].source as Record<string, unknown>).type, 'url', 'remote image URL');
  assertEqual(content[3].type, 'document', 'data file converted to document');
}

async function testTransforms_toolConfigExtractionAndFallback() {
  const responseFormat = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'tool_envelope',
      schema: {
        type: 'object',
        properties: {
          response: { type: 'string' },
          tool_calls: {
            type: 'array',
            items: {
              anyOf: [
                {
                  description: 'Search the web',
                  type: 'object',
                  additionalProperties: false,
                  required: ['tool', 'query'],
                  properties: {
                    tool: { const: 'web_search' },
                    query: { type: 'string', minLength: 1 },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };

  const extracted = extractToolsFromResponseFormat(responseFormat);
  assert(extracted !== null, 'expected tool extraction');
  assertEqual(extracted.tools[0].name, 'web_search', 'tool name lifted');
  const inputSchema = extracted.tools[0].input_schema as {
    properties: { query: Record<string, unknown> };
    required: string[];
    additionalProperties: boolean;
  };
  assert(!('minLength' in inputSchema.properties.query), 'tool schema stripped');
  assertEqual(inputSchema.required.join(','), 'query', 'tool discriminator removed');
  assert(inputSchema.additionalProperties === false, 'additionalProperties preserved');

  const nativeBody: Record<string, unknown> = {
    output_config: { effort: 'medium', format: { type: 'json_schema' } },
    output_format: { legacy: true },
  };
  const native = applyAnthropicToolConfig(nativeBody, responseFormat, null, 'required');
  assert(native === true, 'expected native tool mode');
  assert(Array.isArray(nativeBody.tools), 'native tools installed');
  assertEqual((nativeBody.tool_choice as Record<string, unknown>).type, 'any', 'required maps any');
  assertEqual(
    (nativeBody.output_config as Record<string, unknown>).effort,
    'medium',
    'effort preserved'
  );
  assert(!('output_format' in nativeBody), 'legacy output_format removed');

  const explicitBody: Record<string, unknown> = {};
  const explicit = applyAnthropicToolConfig(
    explicitBody,
    null,
    [
      {
        name: 'finish',
        description: 'Finish',
        strict: true,
        input_schema: { type: 'object', properties: {} },
      },
    ],
    { function: { name: 'finish' } }
  );
  assert(explicit === true, 'explicit tools should use native mode');
  assertEqual(
    (explicitBody.tool_choice as Record<string, unknown>).name,
    'finish',
    'function choice normalized'
  );

  const preNormalizedBody: Record<string, unknown> = {};
  applyAnthropicToolConfig(
    preNormalizedBody,
    null,
    [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
    { type: 'tool', name: 'lookup' }
  );
  assertEqual(
    (preNormalizedBody.tool_choice as Record<string, unknown>).name,
    'lookup',
    'pre-normalized tool choice preserved'
  );

  const fallbackBody: Record<string, unknown> = { output_config: { effort: 'low' } };
  const fallback = applyAnthropicToolConfig(
    fallbackBody,
    {
      type: 'json_schema',
      json_schema: {
        name: 'plain',
        schema: { type: 'object', additionalProperties: true, properties: {} },
      },
    },
    null,
    undefined
  );
  assert(fallback === false, 'plain schema should use output_config fallback');
  const format = (fallbackBody.output_config as { format: { schema: Record<string, unknown> } })
    .format;
  assert(format.schema.additionalProperties === false, 'additionalProperties true normalized');

  const responseBody: Record<string, unknown> = {};
  applyAnthropicResponseFormat(responseBody, {
    type: 'json_schema',
    json_schema: { name: 'plain', schema: { type: 'object', maxLength: 1 } },
  });
  assert('output_config' in responseBody, 'response_format encoded as output_config');
}

// ==================== STREAMING-PARSER TESTS ====================

/**
 * Build a ReadableStream from raw chunks (each entry is one TCP write). Lets
 * tests force partial-line splits and idle-timeout scenarios that the
 * line-buffered `sseResponse` helper can't express on its own.
 */
function rawStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
}

/**
 * ReadableStream where each chunk is delayed by `delayMs`. Used to drive the
 * idle-timeout path in `iterLinesWithIdleTimeout` without sleeping the full
 * 60s default.
 */
function delayedStream(chunks: string[], delayMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
}

async function collectRose(iter: AsyncIterable<RoseStreamChunk>): Promise<RoseStreamChunk[]> {
  const out: RoseStreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

async function testStreaming_anthropic_parseErrorTolerated() {
  // Malformed JSON line is logged + skipped, NOT thrown. Stream still yields
  // the surrounding valid content, so the caller never sees the corruption.
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'data: {not valid json',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseAnthropicSSE(body, {
      actualModel: 'claude-test',
      poolName: 'claude-token',
      requestId: 'r-anth-parse-err',
    })
  );
  // metadata + content + usage + done — the malformed line was silently dropped.
  const kinds = chunks.map((c) => c.kind);
  assertEqual(kinds[0], 'metadata', 'first chunk metadata');
  assert(kinds.includes('content'), 'content chunk emitted past parse error');
  assert(kinds.includes('done'), 'done chunk emitted');
}

async function testStreaming_anthropic_thinkingDeltaEmitsReasoning() {
  // thinking_delta → kind: 'reasoning' (separate from text_delta).
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseAnthropicSSE(body, {
      actualModel: 'claude-test',
      poolName: 'claude-token',
      requestId: 'r-anth-thinking',
    })
  );
  const reasoning = chunks.find((c) => c.kind === 'reasoning');
  assert(reasoning !== undefined, 'reasoning chunk emitted');
  if (reasoning && reasoning.kind === 'reasoning') {
    assertEqual(reasoning.data.text, 'hmm', 'thinking text routed to reasoning chunk');
  }
}

async function testStreaming_anthropic_errorEventRaisesTypedError() {
  // Anthropic can emit provider errors in-band after opening a 200/SSE stream.
  // These must raise typed errors so direct auth can fall through cleanly.
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'event: error',
    'data: {"type":"error","error":{"type":"overloaded_error","message":"server busy"}}',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  let raised: unknown = null;
  try {
    await collectRose(
      parseAnthropicSSE(body, {
        actualModel: 'claude-test',
        poolName: 'claude-token',
        requestId: 'r-anth-err-evt',
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof Error, `expected typed error, got ${raised}`);
}

async function testStreaming_anthropic_emptyStreamRaisesStallError() {
  // No content_block_delta events → RoseStallError. The metadata + usage
  // chunks were going to be yielded but the iteration aborts with throw.
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  let raised: unknown = null;
  try {
    await collectRose(
      parseAnthropicSSE(body, {
        actualModel: 'claude-test',
        poolName: 'claude-token',
        requestId: 'r-anth-empty',
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof RoseStallError, `expected RoseStallError, got ${raised}`);
}

async function testStreaming_anthropic_refusalRaisesRefusalError() {
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  let raised: unknown = null;
  try {
    await collectRose(
      parseAnthropicSSE(body, {
        actualModel: 'claude-test',
        poolName: 'claude-token',
        requestId: 'r-anth-refusal',
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof RoseRefusalError, `expected RoseRefusalError, got ${raised}`);
}

async function testStreaming_anthropic_unmappedStopReasonPassthrough() {
  // A stop_reason not in the explicit map (e.g. "pause_turn") passes through
  // verbatim — guards against silent loss of new Anthropic stop reasons.
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":1}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseAnthropicSSE(body, {
      actualModel: 'claude-test',
      poolName: 'claude-token',
      requestId: 'r-anth-unmapped',
    })
  );
  const usage = chunks.find((c) => c.kind === 'usage');
  assert(usage !== undefined, 'usage chunk emitted');
  if (usage && usage.kind === 'usage') {
    assertEqual(usage.data.finish_reason, 'pause_turn', 'unmapped stop_reason passes through');
  }
}

async function testStreaming_anthropic_idleTimeoutRaisesStall() {
  // Stream never delivers a line within idleTimeoutMs → RoseStallError. We
  // pass idleTimeoutMs=50 + a stream that takes 200ms to deliver its first
  // chunk so the timeout always wins.
  const body = delayedStream(
    [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\ndata: [DONE]\n\n',
    ],
    200
  );
  let raised: unknown = null;
  try {
    await collectRose(
      parseAnthropicSSE(body, {
        actualModel: 'claude-test',
        poolName: 'claude-token',
        requestId: 'r-anth-idle',
        idleTimeoutMs: 50,
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof RoseStallError, `expected RoseStallError, got ${raised}`);
  assert(
    (raised as RoseStallError).message.includes('idle for >50ms'),
    `idle-timeout message should mention 50ms, got ${(raised as Error).message}`
  );
}

async function testStreaming_anthropic_truncatedFinalLineYielded() {
  // If the upstream closes mid-line, parseAnthropicSSE must still yield the
  // remainder so caller doesn't silently lose the diagnostic data. Send the
  // body in two raw chunks where the second arrives without a trailing
  // newline.
  const fullEvents =
    [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
      '',
    ].join('\n') + '\n';
  // The literal trailing chunk ends WITHOUT a newline — exercises the
  // "yield buffer remainder" branch in iterLinesWithIdleTimeout.
  const body = rawStream([fullEvents, 'data: [DONE]']);
  const chunks = await collectRose(
    parseAnthropicSSE(body, {
      actualModel: 'claude-test',
      poolName: 'claude-token',
      requestId: 'r-anth-trunc',
    })
  );
  assert(
    chunks.some((c) => c.kind === 'content'),
    'content emitted before truncated final line'
  );
  // Stream completed via [DONE] in the trailing chunk → done emitted.
  assert(
    chunks.some((c) => c.kind === 'done'),
    'done emitted from trailing [DONE]'
  );
}

async function testStreaming_openai_parseErrorTolerated() {
  const lines = [
    'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}',
    '',
    'data: {malformed',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"y"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseOpenAISSE(body, {
      actualModel: 'or-test',
      poolName: 'rose-1-lite',
      requestId: 'r-or-parse-err',
    })
  );
  const text = chunks
    .filter((c) => c.kind === 'content')
    .map((c) => (c.kind === 'content' ? c.data.text : ''))
    .join('');
  assertEqual(text, 'xy', 'malformed line skipped, surrounding content preserved');
}

async function testStreaming_openai_reasoningField() {
  // OpenRouter providers expose chain-of-thought via `delta.reasoning`. Must
  // be routed to `kind: 'reasoning'` (not content).
  const lines = [
    'data: {"choices":[{"index":0,"delta":{"reasoning":"thinking..."}}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseOpenAISSE(body, {
      actualModel: 'or-test',
      poolName: 'rose-1-lite',
      requestId: 'r-or-reasoning',
    })
  );
  const reasoning = chunks.find((c) => c.kind === 'reasoning');
  assert(reasoning !== undefined, 'reasoning chunk emitted');
  if (reasoning && reasoning.kind === 'reasoning') {
    assertEqual(reasoning.data.text, 'thinking...', 'reasoning text routed correctly');
  }
}

async function testStreaming_openai_reasoningContentField() {
  // Some providers use `reasoning_content` instead of `reasoning` — the
  // parser must accept both shapes (the `??` fallback in streaming.ts).
  const lines = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"deepseek-style"}}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"final"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseOpenAISSE(body, {
      actualModel: 'or-test',
      poolName: 'rose-1-lite',
      requestId: 'r-or-reasoning-content',
    })
  );
  const reasoning = chunks.find((c) => c.kind === 'reasoning');
  assert(reasoning !== undefined, 'reasoning chunk emitted from reasoning_content');
  if (reasoning && reasoning.kind === 'reasoning') {
    assertEqual(reasoning.data.text, 'deepseek-style', 'reasoning_content routed to reasoning');
  }
}

async function testStreaming_openai_emptyChoicesSkipped() {
  // OpenRouter sometimes sends `{"choices":[]}` framing chunks (e.g. usage-
  // only). They must be silently ignored, not crash the parser.
  const lines = [
    'data: {"choices":[]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"v"}}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseOpenAISSE(body, {
      actualModel: 'or-test',
      poolName: 'rose-1-lite',
      requestId: 'r-or-empty-choices',
    })
  );
  assert(
    chunks.some((c) => c.kind === 'content'),
    'content emitted past empty-choices framing chunk'
  );
}

async function testStreaming_openai_emptyStreamRaisesStallError() {
  const lines = ['data: [DONE]', ''];
  const body = rawStream([lines.join('\n') + '\n']);
  let raised: unknown = null;
  try {
    await collectRose(
      parseOpenAISSE(body, {
        actualModel: 'or-test',
        poolName: 'rose-1-lite',
        requestId: 'r-or-empty',
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof RoseStallError, `expected RoseStallError, got ${raised}`);
  assert(
    (raised as Error).message.includes('saw_done=true'),
    'message should annotate saw_done flag for diagnosability'
  );
}

async function testStreaming_openai_refusalRaisesRefusalError() {
  const lines = [
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"refusal"}]}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  let raised: unknown = null;
  try {
    await collectRose(
      parseOpenAISSE(body, {
        actualModel: 'or-test',
        poolName: 'rose-1-lite',
        requestId: 'r-or-refusal',
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof RoseRefusalError, `expected RoseRefusalError, got ${raised}`);
}

async function testStreaming_openai_emptyStreamWithoutDoneRaisesStallError() {
  // Stream closes WITHOUT a [DONE] sentinel and WITHOUT content. saw_done
  // must be false in the message so the caller can distinguish "premature
  // disconnect" from "polite empty completion".
  const body = rawStream([]); // closed immediately
  let raised: unknown = null;
  try {
    await collectRose(
      parseOpenAISSE(body, {
        actualModel: 'or-test',
        poolName: 'rose-1-lite',
        requestId: 'r-or-no-done',
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof RoseStallError, `expected RoseStallError, got ${raised}`);
  assert(
    (raised as Error).message.includes('saw_done=false'),
    'saw_done=false annotates pre-DONE disconnect'
  );
}

async function testStreaming_openai_idleTimeoutRaisesStall() {
  const body = delayedStream(
    ['data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'],
    200
  );
  let raised: unknown = null;
  try {
    await collectRose(
      parseOpenAISSE(body, {
        actualModel: 'or-test',
        poolName: 'rose-1-lite',
        requestId: 'r-or-idle',
        idleTimeoutMs: 50,
      })
    );
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof RoseStallError, `expected RoseStallError, got ${raised}`);
}

async function testStreaming_openai_usageWithCacheTokens() {
  // OpenRouter exposes Anthropic cache token counts on the OpenAI-shape
  // usage object. The parser must propagate them onto the usage chunk so the
  // outer client can wire them into the CompletionChunk.usage envelope.
  const lines = [
    'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"cache_creation_input_tokens":7,"cache_read_input_tokens":3}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseOpenAISSE(body, {
      actualModel: 'or-test',
      poolName: 'rose-1-lite',
      requestId: 'r-or-cache',
    })
  );
  const usage = chunks.find((c) => c.kind === 'usage');
  assert(usage !== undefined, 'usage chunk emitted');
  if (usage && usage.kind === 'usage') {
    assertEqual(usage.data.prompt_tokens, 10, 'prompt_tokens');
    assertEqual(usage.data.completion_tokens, 2, 'completion_tokens');
    assertEqual(usage.data.total_tokens, 12, 'total_tokens');
    assertEqual(usage.data.cache_creation_input_tokens, 7, 'cache_creation_input_tokens');
    assertEqual(usage.data.cache_read_input_tokens, 3, 'cache_read_input_tokens');
    assertEqual(usage.data.finish_reason, 'stop', 'finish_reason from delta');
  }
}

async function testStreaming_anthropic_cacheTokensInUsage() {
  // The cache_creation/cache_read token counts on `message_start.usage`
  // must be carried through into the final usage chunk so the chat client
  // can populate CompletionChunk.usage with them.
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"cache_creation_input_tokens":7,"cache_read_input_tokens":3}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    '',
    'data: [DONE]',
    '',
  ];
  const body = rawStream([lines.join('\n') + '\n']);
  const chunks = await collectRose(
    parseAnthropicSSE(body, {
      actualModel: 'claude-test',
      poolName: 'claude-token',
      requestId: 'r-anth-cache',
    })
  );
  const usage = chunks.find((c) => c.kind === 'usage');
  assert(usage !== undefined, 'usage chunk emitted');
  if (usage && usage.kind === 'usage') {
    assertEqual(usage.data.prompt_tokens, 42, 'input_tokens → prompt_tokens');
    assertEqual(usage.data.cache_creation_input_tokens, 7, 'cache creation propagated');
    assertEqual(usage.data.cache_read_input_tokens, 3, 'cache read propagated');
  }
}

// ==================== CLIENT TESTS (END-TO-END BRANCHES) ====================

async function testClient_reasoningChunkRoutedToCompletionChunk() {
  // claudeAuth path: a thinking_delta from Anthropic must surface in the
  // CompletionChunk envelope as `delta.reasoning` (not `delta.content`).
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reasoning..."}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"final"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ];
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) return sseResponse(sse);
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'tok',
    });
    const chunks = await collect(stream);
    const reasoningChunk = chunks.find((c) => c.choices[0]?.delta?.reasoning);
    assert(reasoningChunk !== undefined, 'reasoning surfaces as delta.reasoning');
    assertEqual(
      reasoningChunk!.choices[0].delta.reasoning,
      'reasoning...',
      'reasoning text propagated'
    );
    const contentChunk = chunks.find((c) => c.choices[0]?.delta?.content);
    assert(contentChunk !== undefined, 'content chunk also emitted');
    assertEqual(contentChunk!.choices[0].delta.content, 'final', 'content text propagated');
  } finally {
    restoreFetch();
  }
}

async function testClient_usageChunkExposesCacheTokens() {
  // The terminal usage chunk on the chat envelope must carry the cache
  // creation/read counts so callers (chat router/generator) can record cache
  // hit metrics — without them, claudeAuth caching is invisible to billing.
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      return sseResponse([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_creation_input_tokens":80,"cache_read_input_tokens":15}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        '',
        'data: [DONE]',
        '',
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'tok',
    });
    const chunks = await collect(stream);
    const last = chunks[chunks.length - 1];
    assert(last.usage !== undefined, 'last chunk has usage');
    assertEqual(last.usage!.prompt_tokens, 100, 'prompt_tokens propagated');
    assertEqual(last.usage!.cache_creation_input_tokens, 80, 'cache creation in usage envelope');
    assertEqual(last.usage!.cache_read_input_tokens, 15, 'cache read in usage envelope');
    assertEqual(last.choices[0].finish_reason, 'stop', 'usage chunk finish_reason mapped');
  } finally {
    restoreFetch();
  }
}

async function testClient_responseModelBuildsCodexTextFormat() {
  let capturedBody: Record<string, unknown> | null = null;
  installFetchStub((url, init) => {
    if (url === CODEX_API_URL) {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(RESPONSES_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'score it' }],
      gpt_token: 'gpt-token',
      response_model: responseModel(
        'ScoreResponse',
        z.object({
          reasoning: z.string(),
          score: z.number(),
        })
      ),
    });
    await collect(stream);

    assert(capturedBody !== null, 'captured Codex request');
    const format = ((capturedBody!.text as Record<string, unknown>).format ?? {}) as Record<
      string,
      unknown
    >;
    const schema = format.schema as Record<string, unknown>;
    assertEqual(format.name, 'ScoreResponse', 'response_model name reaches Codex text.format');
    assertEqual(
      JSON.stringify(schema.required),
      JSON.stringify(['reasoning', 'score']),
      'Zod fields become required strict schema fields'
    );
    assertEqual(schema.additionalProperties, false, 'top-level object closed');
  } finally {
    restoreFetch();
  }
}

async function testClient_responseModelConflictsWithResponseFormat() {
  let threw = false;
  try {
    await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      response_model: responseModel('ModelA', z.object({ ok: z.boolean() })),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Manual',
          strict: true,
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    });
  } catch (error) {
    threw =
      error instanceof Error && error.message.includes('either response_format or response_model');
  }
  assert(threw, 'response_model and response_format conflict rejected');
}

async function testClient_toolCallChunkPropagatesToCompletionChunk() {
  installFetchStub((url) => {
    if (url === CODEX_API_URL) {
      return sseResponse([
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
        'data: [DONE]',
        '',
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const chunks = await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content: 'use the tool' }],
        gpt_token: 'gpt-token',
      })
    );
    const toolDelta = chunks.find((chunk) => chunk.choices[0]?.delta.tool_calls);
    const toolCall = toolDelta?.choices[0]?.delta.tool_calls?.[0];
    assertEqual(toolCall?.id, 'call_1', 'tool call id reaches CompletionChunk');
    assertEqual(toolCall?.function.name, 'lookup', 'tool call name reaches CompletionChunk');
    assertEqual(toolCall?.function.arguments, '{"q":"x"}', 'tool call args reach CompletionChunk');
  } finally {
    restoreFetch();
  }
}

async function testClient_codexReasoningItemPropagatesToCompletionChunk() {
  installFetchStub((url) => {
    if (url === CODEX_API_URL) {
      return sseResponse([
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"secret","summary":[]}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"answer"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
        'data: [DONE]',
        '',
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const chunks = await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content: 'answer with reasoning item' }],
        gpt_token: 'gpt-token',
      })
    );
    const itemChunk = chunks.find((chunk) => chunk.codex_reasoning_item);
    assertEqual(itemChunk?.codex_reasoning_item?.id, 'rs_1', 'reasoning item id reaches client');
    assertEqual(
      itemChunk?.codex_reasoning_item?.encrypted_content,
      'secret',
      'encrypted reasoning reaches client'
    );
  } finally {
    restoreFetch();
  }
}

async function testClient_midStreamErrorPropagatesAfterContent() {
  // Once content has streamed to the caller, a mid-stream failure on the
  // claudeAuth path MUST propagate directly — splicing in waterfall output
  // would corrupt the response. The PreContentFallThroughError sentinel only
  // fires before any chunk has been yielded.
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  const truncatedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      // Stream some content, then close mid-stream with no [DONE] and no
      // content_block_delta close — parseAnthropicSSE will see emittedContent
      // already true, then... actually, current parser raises only on the
      // empty-content path. Use idleTimeout to force a mid-stream stall.
      controller.enqueue(
        enc.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'
        )
      );
      // NEVER close — stream sits open, idle timeout fires.
    },
  });
  let openrouterCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      return new Response(truncatedBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'tok',
    });
    const chunks: CompletionChunk[] = [];
    let raised: unknown = null;
    try {
      // Set a tight idle timeout for the claudeAuth stream by using an
      // AsyncIterator wrapper isn't trivial; the parser's default is 60s.
      // Instead drive the stream and capture the result — content should
      // have been streamed before the mid-stream error propagates. We
      // can't easily simulate this without overriding idleTimeoutMs deep
      // inside claudeAuth; the test's job here is to lock in that
      // openrouterCalls stays 0 — i.e. mid-stream failure does NOT trigger
      // waterfall fallback once content has been emitted. We do this by
      // returning early after the first content chunk so the stream is
      // gracefully cancelled (consumer break).
      for await (const c of stream) {
        chunks.push(c);
        if (c.choices[0]?.delta?.content === 'partial') break;
      }
    } catch (err) {
      raised = err;
    }
    void raised; // raised is acceptable here — early-return triggers the iterator.return() finally path
    assert(chunks.length >= 1, 'at least one content chunk emitted before break');
    assertEqual(
      openrouterCalls,
      0,
      'consumer-break must NOT fall through to waterfall (post-content guarantee)'
    );
    const partialChunk = chunks.find((c) => c.choices[0]?.delta?.content === 'partial');
    assert(partialChunk !== undefined, 'partial content emitted');
    assert(
      partialChunk!.actual_model.endsWith('-claude'),
      'actual_model carries claude suffix from claudeAuth path'
    );
  } finally {
    restoreFetch();
  }
}

async function testClient_consumerEarlyBreakClosesUpstream() {
  // Consumer breaks out of the loop early. The runWithFallThrough finally
  // must call iterator.return() so produce()'s cleanup runs and the
  // underlying socket gets released. We assert this indirectly: subsequent
  // calls to fetch must succeed (no leaked global-fetch state).
  let fetchCalls = 0;
  installFetchStub((url) => {
    fetchCalls++;
    if (url === OPENROUTER_API_URL) return sseResponse(OPENROUTER_OK_SSE);
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
    });
    let received = 0;
    for await (const chunk of stream) {
      void chunk;
      received++;
      break;
    }
    assertEqual(received, 1, 'consumer received exactly one chunk before break');
    // A second call works — the first call's stream cleanup did not leave
    // pending state behind.
    const second = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const all = await collect(second);
    assert(all.length > 0, 'second call succeeds after first was broken');
    assertEqual(fetchCalls, 2, 'two openrouter calls (one per createStreamingCompletion)');
  } finally {
    restoreFetch();
  }
}

async function testClient_claudeAuthFailedThenWaterfallFailsTooReportsTypedError() {
  // claudeAuth 401 → fall-through-error (RoseAuthError); waterfall then
  // fails on every step → RoseAllFailed. The client must surface the
  // RoseAllFailed (the terminal failure), not the original RoseAuthError.
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      return errorResponse(401, JSON.stringify({ error: { message: 'unauthorized' } }));
    }
    if (url === OPENROUTER_API_URL) {
      return errorResponse(503, 'service unavailable');
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'tok',
    });
    let raised: unknown = null;
    try {
      await collect(stream);
    } catch (err) {
      raised = err;
    }
    assert(
      raised instanceof RoseAllFailed,
      `claudeAuth then waterfall fail → RoseAllFailed (terminal), got ${raised}`
    );
    const pool = getPool('rose-1-lite');
    assertEqual(
      (raised as RoseAllFailed).stepErrors.length,
      pool.waterfall.length,
      'stepErrors covers each waterfall attempt'
    );
  } finally {
    restoreFetch();
  }
}

async function testClient_unknownPoolFromUnknownModelEmitsHelpfulMessage() {
  // poolForModel returns null → wrapStream throws "Rose: unknown model …"
  // BEFORE we even start streaming, so callers can distinguish input bugs
  // from runtime/provider issues.
  let threw: unknown = null;
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await collect(stream);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error, 'threw something');
  assert(
    (threw as Error).message.includes('rose-labs/rose-1-lite'),
    `error message should list valid models, got ${(threw as Error).message}`
  );
}

async function testClient_cacheableSystemPromptSplitOnBoundary() {
  // markCacheable embeds the SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel. On the
  // claudeAuth path, transformMessagesForAnthropic splits at the boundary
  // and applies cache_control to the static prefix only. We capture the
  // outbound POST body and inspect the system blocks.
  let capturedBody: Record<string, unknown> | null = null;
  installFetchStub((url, init) => {
    if (url === ANTHROPIC_API_URL) {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [markCacheable('STATIC_PREFIX', 'DYNAMIC_TAIL'), { role: 'user', content: 'hi' }],
      claude_token: 'tok',
    });
    await collect(stream);
    assert(capturedBody !== null, 'captured outbound body');
    const system = (capturedBody as { system: Array<Record<string, unknown>> }).system;
    assert(
      Array.isArray(system) && system.length >= 3,
      'system has identity + disclaimer + static'
    );
    // Identity + disclaimer always come first; static prefix follows w/ cache_control.
    const staticBlock = system.find(
      (b) =>
        typeof b.text === 'string' &&
        (b.text as string).includes('STATIC_PREFIX') &&
        b.cache_control !== undefined
    );
    assert(staticBlock !== undefined, 'static prefix block has cache_control: ephemeral applied');
    const dynamicBlock = system.find(
      (b) =>
        typeof b.text === 'string' &&
        (b.text as string).includes('DYNAMIC_TAIL') &&
        b.cache_control === undefined
    );
    assert(dynamicBlock !== undefined, 'dynamic tail block has NO cache_control');
  } finally {
    restoreFetch();
  }
}

async function testClient_lastUserMessageGetsCacheBreakpoint() {
  // claudeAuth's addCacheBreakpoint marker must be planted on the final user
  // message so per-conversation cache reads work. The test inspects the
  // outbound body's messages[].content[].cache_control.
  let capturedBody: Record<string, unknown> | null = null;
  installFetchStub((url, init) => {
    if (url === ANTHROPIC_API_URL) {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'a question' }],
      claude_token: 'tok',
    });
    await collect(stream);
    assert(capturedBody !== null, 'captured body');
    const messages = (capturedBody as { messages: Array<{ content: unknown }> }).messages;
    assert(messages.length === 1, 'one message');
    const content = messages[0].content;
    assert(Array.isArray(content) && content.length === 1, 'content lifted to array');
    const block = (content as Array<Record<string, unknown>>)[0];
    assertEqual(block.text, 'a question', 'preserves text');
    assert(block.cache_control !== undefined, 'last block has cache_control breakpoint');
    assertEqual(
      (block.cache_control as Record<string, unknown>).type,
      'ephemeral',
      'cache_control type=ephemeral'
    );
  } finally {
    restoreFetch();
  }
}

async function testClient_responseFormatTransformedToOutputConfig() {
  // OpenAI-shape response_format becomes Anthropic-shape output_config on
  // the claudeAuth path. claudeAuth.ts also pins output_config.effort='high'
  // — both must be present in the outbound body.
  let capturedBody: Record<string, unknown> | null = null;
  installFetchStub((url, init) => {
    if (url === ANTHROPIC_API_URL) {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'tok',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'TestResp',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              count: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    });
    await collect(stream);
    assert(capturedBody !== null, 'captured body');
    const oc = (capturedBody as { output_config?: Record<string, unknown> }).output_config;
    assert(oc !== undefined, 'output_config present');
    assertEqual(oc!.effort, 'high', 'effort=high pinned');
    const fmt = oc!.format as Record<string, unknown>;
    assertEqual(fmt.type, 'json_schema', 'format.type=json_schema');
    const schema = fmt.schema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert(!('minimum' in props.count), 'minimum stripped from schema (Anthropic incompatible)');
  } finally {
    restoreFetch();
  }
}

async function testClient_systemPromptDynamicBoundaryConstantValue() {
  // Lock in the boundary literal so changes are deliberate (other code may
  // hardcode it for legacy callers).
  assert(
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY.includes('SYSTEM_PROMPT_DYNAMIC_BOUNDARY'),
    'boundary constant exposes the sentinel string'
  );
}

async function testClient_postContentStreamErrorPropagatesDirectly() {
  // claudeAuth emits content, then the underlying ReadableStream errors
  // out. Once content has been streamed, the runWithFallThrough catch path
  // re-throws the original error (NOT PreContentFallThroughError) — exercises
  // the `else { throw err; }` branch in client.ts's claudeAuth catch.
  // Critical guarantee: openrouter must NOT be invoked (no fall-through
  // splicing once partial content is on the wire).
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  let openrouterCalls = 0;
  let pullCount = 0;
  const erroringBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      const enc = new TextEncoder();
      pullCount++;
      if (pullCount === 1) {
        // First pull: emit content. Since pull is invoked by the consumer's
        // read(), this ensures the parser actually receives + processes the
        // bytes before the next pull errors.
        controller.enqueue(
          enc.encode(
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'
          )
        );
        return;
      }
      // Subsequent pull (after parser has yielded content): error out.
      // Triggers the post-content error path in client.ts (lines 196-197).
      controller.error(new Error('upstream socket reset'));
    },
  });
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      return new Response(erroringBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'tok',
    });
    const chunks: CompletionChunk[] = [];
    let raised: unknown = null;
    try {
      for await (const c of stream) chunks.push(c);
    } catch (err) {
      raised = err;
    }
    assert(chunks.length >= 1, 'partial content emitted before error');
    assert(raised !== null, 'mid-stream error propagated to caller');
    assertEqual(
      openrouterCalls,
      0,
      'post-content error must NOT trigger waterfall (would splice models)'
    );
  } finally {
    restoreFetch();
  }
}

async function testClient_metadataChunkIsBuffered() {
  // Ensure the metadata chunk is NOT yielded directly — every CompletionChunk
  // emitted should carry actual_model + pool_name inline (parity with the
  // deleted edge function behavior).
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) return sseResponse(ANTHROPIC_OK_SSE);
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-lite',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'tok',
    });
    const chunks = await collect(stream);
    // Every chunk carries actual_model + pool_name + pool_size inline, so
    // there's no separate metadata chunk visible in `chunks`.
    for (const c of chunks) {
      assert(typeof c.actual_model === 'string', 'every chunk has actual_model');
      assert(typeof c.pool_name === 'string', 'every chunk has pool_name');
      assert(typeof c.pool_size === 'number' && c.pool_size > 0, 'every chunk has pool_size');
    }
  } finally {
    restoreFetch();
  }
}

// ==================== RUNNER ====================

async function main(): Promise<void> {
  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'pool / isRoseModel variants', fn: testPool_isRoseModelVariants },
    { name: 'pool / poolForModel fuzzy', fn: testPool_forModelFuzzy },
    { name: 'pool / POOL_REGISTRY shape', fn: testPool_getPoolRegistryShape },
    { name: 'pool / unknown model throws', fn: testPool_unknownModelThrows },
    { name: 'claudeAuth / happy path', fn: testClaudeAuth_happyPath },
    {
      name: 'gptAuth / happy path uses Codex Responses',
      fn: testGptAuth_happyPathUsesCodexResponses,
    },
    {
      name: 'gptAuth / body preserves tool history and multimodal input',
      fn: testGptAuth_buildBodyPreservesToolHistoryAndMultimodal,
    },
    {
      name: 'gptAuth / body converts orphan tool rows to context',
      fn: testGptAuth_buildBodyConvertsOrphanToolRowsToContext,
    },
    {
      name: 'gptAuth / body adds input for system-only context',
      fn: testGptAuth_buildBodyAddsInputForSystemOnlyContext,
    },
    {
      name: 'gptAuth / SMS supervisor schema is strict for Codex Responses',
      fn: testGptAuth_smsSupervisorSchemaIsStrictForCodexResponses,
    },
    {
      name: 'waterfall / OpenAI tool_calls carry the function type discriminator',
      fn: testWaterfall_openAiToolCallsCarryFunctionType,
    },
    {
      name: 'claudeAuth / SMS supervisor lifts native tools without unions',
      fn: testClaudeAuth_smsSupervisorLiftsNativeToolsWithoutUnions,
    },
    {
      name: 'claudeAuth / body stays within the cache_control block budget',
      fn: testClaudeAuth_bodyStaysWithinCacheBlockBudget,
    },
    {
      name: 'schema / Zod response_model builds strict OpenAI schema',
      fn: testSchema_zodResponseModelBuildsStrictOpenAiSchema,
    },
    {
      name: 'streaming / Responses failed context length is invalid request',
      fn: testStreaming_responsesFailedContextLengthIsInvalidRequest,
    },
    {
      name: 'claudeAuth / 401 falls through to waterfall',
      fn: testClaudeAuth_401FallsThroughToWaterfall,
    },
    {
      name: 'claudeAuth / 400 falls through (no retry)',
      fn: testClaudeAuth_400FallsThroughNoRetry,
    },
    {
      name: 'claudeAuth / 429 retries with backoff then succeeds',
      fn: testClaudeAuth_429RetriesWithBackoffThenSucceeds,
    },
    {
      name: 'claudeAuth / no token goes direct to waterfall',
      fn: testClaudeAuth_noTokenGoesDirectToWaterfall,
    },
    {
      name: 'openai api-key / serves before Anthropic and OpenRouter',
      fn: testOpenAiApiKey_servesBeforeAnthropicAndOpenRouter,
    },
    {
      name: 'openai api-key / failure falls through to Anthropic before OpenRouter',
      fn: testOpenAiApiKey_failureFallsThroughToAnthropicBeforeOpenRouter,
    },
    {
      name: 'shared OpenAI priority / exclusive route preserves router config',
      fn: testSharedOpenAiPriorityRoute_isExclusiveAndPreservesRouterConfig,
    },
    {
      name: 'shared OpenAI priority / missing key fails closed without provider calls',
      fn: testSharedOpenAiPriorityRoute_missingKeyFailsClosedWithoutProviderCalls,
    },
    {
      name: 'shared OpenAI priority / invalid key fails closed without fallback calls',
      fn: testSharedOpenAiPriorityRoute_invalidKeyFailsClosedWithoutFallbackCalls,
    },
    {
      name: 'anthropic api-key / serves as funded default when no compute token',
      fn: testAnthropicApiKey_servesAsDefaultWhenNoToken,
    },
    {
      name: 'anthropic api-key / compute token takes precedence',
      fn: testAnthropicApiKey_computeTokenTakesPrecedence,
    },
    {
      name: 'anthropic api-key / 402 opens circuit and stops hammering',
      fn: testAnthropicApiKey_402OpensCircuitAndStopsHammering,
    },
    {
      name: 'client / dump context writes request and output',
      fn: testClient_dumpContextWritesRequestAndOutput,
    },
    { name: 'waterfall / first 500 → second succeeds', fn: testWaterfall_firstFailsSecondSucceeds },
    { name: 'waterfall / all fail → RoseAllFailed', fn: testWaterfall_allFailRaisesRoseAllFailed },
    {
      name: 'transforms / strip unsupported schema keywords',
      fn: testTransforms_stripUnsupportedSchemaKeywords,
    },
    { name: 'transforms / anyOf/oneOf/allOf recursed', fn: testTransforms_anyOfOneOfAllOfRecursed },
    {
      name: 'transforms / messages convert Anthropic content blocks',
      fn: testTransforms_messagesForAnthropicContentBlocks,
    },
    {
      name: 'transforms / native tool config extraction and fallback',
      fn: testTransforms_toolConfigExtractionAndFallback,
    },
    {
      name: 'streaming / anthropic parse error tolerated',
      fn: testStreaming_anthropic_parseErrorTolerated,
    },
    {
      name: 'streaming / anthropic thinking_delta → reasoning',
      fn: testStreaming_anthropic_thinkingDeltaEmitsReasoning,
    },
    {
      name: 'streaming / anthropic error event raises typed error',
      fn: testStreaming_anthropic_errorEventRaisesTypedError,
    },
    {
      name: 'streaming / anthropic empty stream → RoseStallError',
      fn: testStreaming_anthropic_emptyStreamRaisesStallError,
    },
    {
      name: 'streaming / anthropic refusal → RoseRefusalError',
      fn: testStreaming_anthropic_refusalRaisesRefusalError,
    },
    {
      name: 'streaming / anthropic unmapped stop_reason passthrough',
      fn: testStreaming_anthropic_unmappedStopReasonPassthrough,
    },
    {
      name: 'streaming / anthropic idle timeout → RoseStallError',
      fn: testStreaming_anthropic_idleTimeoutRaisesStall,
    },
    {
      name: 'streaming / anthropic truncated final line yielded',
      fn: testStreaming_anthropic_truncatedFinalLineYielded,
    },
    {
      name: 'streaming / anthropic cache tokens propagated',
      fn: testStreaming_anthropic_cacheTokensInUsage,
    },
    {
      name: 'streaming / openai parse error tolerated',
      fn: testStreaming_openai_parseErrorTolerated,
    },
    {
      name: 'streaming / openai reasoning field → reasoning chunk',
      fn: testStreaming_openai_reasoningField,
    },
    {
      name: 'streaming / openai reasoning_content field → reasoning chunk',
      fn: testStreaming_openai_reasoningContentField,
    },
    {
      name: 'streaming / openai empty choices skipped',
      fn: testStreaming_openai_emptyChoicesSkipped,
    },
    {
      name: 'streaming / openai empty stream → RoseStallError (saw_done=true)',
      fn: testStreaming_openai_emptyStreamRaisesStallError,
    },
    {
      name: 'streaming / openai refusal → RoseRefusalError',
      fn: testStreaming_openai_refusalRaisesRefusalError,
    },
    {
      name: 'streaming / openai disconnect (saw_done=false) → RoseStallError',
      fn: testStreaming_openai_emptyStreamWithoutDoneRaisesStallError,
    },
    {
      name: 'streaming / openai idle timeout → RoseStallError',
      fn: testStreaming_openai_idleTimeoutRaisesStall,
    },
    {
      name: 'streaming / openai usage with cache tokens',
      fn: testStreaming_openai_usageWithCacheTokens,
    },
    {
      name: 'streaming / responses function_call item → tool_call',
      fn: testStreaming_responsesFunctionCallItem,
    },
    {
      name: 'streaming / responses reasoning delta events → reasoning chunk',
      fn: testStreaming_responsesReasoningDeltaEvents,
    },
    {
      name: 'streaming / responses reasoning item preserved',
      fn: testStreaming_responsesReasoningItemPreserved,
    },
    {
      name: 'client / reasoning chunk → CompletionChunk.delta.reasoning',
      fn: testClient_reasoningChunkRoutedToCompletionChunk,
    },
    {
      name: 'client / usage chunk exposes cache tokens',
      fn: testClient_usageChunkExposesCacheTokens,
    },
    {
      name: 'client / response_model builds Codex text.format',
      fn: testClient_responseModelBuildsCodexTextFormat,
    },
    {
      name: 'client / response_model conflicts with response_format',
      fn: testClient_responseModelConflictsWithResponseFormat,
    },
    {
      name: 'client / tool_call chunk propagates to CompletionChunk',
      fn: testClient_toolCallChunkPropagatesToCompletionChunk,
    },
    {
      name: 'client / codex reasoning item propagates to CompletionChunk',
      fn: testClient_codexReasoningItemPropagatesToCompletionChunk,
    },
    {
      name: 'client / consumer break does not trigger waterfall',
      fn: testClient_midStreamErrorPropagatesAfterContent,
    },
    {
      name: 'client / consumer early break closes upstream',
      fn: testClient_consumerEarlyBreakClosesUpstream,
    },
    {
      name: 'client / claudeAuth fail + waterfall fail → RoseAllFailed',
      fn: testClient_claudeAuthFailedThenWaterfallFailsTooReportsTypedError,
    },
    {
      name: 'client / unknown pool emits helpful message',
      fn: testClient_unknownPoolFromUnknownModelEmitsHelpfulMessage,
    },
    {
      name: 'client / cacheable system prompt splits on boundary',
      fn: testClient_cacheableSystemPromptSplitOnBoundary,
    },
    {
      name: 'client / last user message gets cache breakpoint',
      fn: testClient_lastUserMessageGetsCacheBreakpoint,
    },
    {
      name: 'client / response_format → output_config (effort=high)',
      fn: testClient_responseFormatTransformedToOutputConfig,
    },
    {
      name: 'client / SYSTEM_PROMPT_DYNAMIC_BOUNDARY constant exposed',
      fn: testClient_systemPromptDynamicBoundaryConstantValue,
    },
    {
      name: 'client / post-content stream error propagates directly',
      fn: testClient_postContentStreamErrorPropagatesDirectly,
    },
    {
      name: 'client / metadata chunk buffered (inline on every chunk)',
      fn: testClient_metadataChunkIsBuffered,
    },
  ];

  const results: TestResult[] = [];
  // Run sequentially — tests share process.env + global.fetch state.
  for (const t of tests) {
    const r = await runTest(t.name, t.fn);
    results.push(r);
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name} (${r.duration}ms)`);
    if (!r.passed) console.log(`    ${r.error}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('rose.blackbox runner crashed:', err);
  process.exit(1);
});
