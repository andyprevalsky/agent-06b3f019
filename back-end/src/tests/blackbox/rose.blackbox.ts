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
  __resetGptApiKeyCooldown,
  buildOpenAiResponseFormat,
  createStreamingCompletion,
  getPool,
  isRoseModel,
  markCacheable,
  POOL_REGISTRY,
  poolForModel,
  RoseAllFailed,
  RoseInvalidRequest,
  RoseRateLimitError,
  RoseRefusalError,
  RoseStallError,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  responseModel,
  type CompletionChunk,
  type SubscriptionCredential,
  type SubscriptionLeaseFailure,
  type SubscriptionLeases,
} from '../../providers/rose';
import { buildAnthropicBody, claudeAuthComplete } from '../../providers/rose/claudeAuth';
import { FOUNDRY_REGION_ENV_NAMES } from '../../providers/rose/foundry';
import { buildCerebrasChatBody } from '../../providers/rose/cerebrasRoute';
import { buildOpenRouterCerebrasBody } from '../../providers/rose/openrouterCerebrasRoute';
import { buildOpenRouterFastChatBody } from '../../providers/rose/openrouterFastRoute';
import { buildOpenRouterBody } from '../../providers/rose/waterfall';
import { buildEnvironmentToolMessages } from '../../providers/smsSupervisor/environmentMessages';
import {
  buildCodexResponsesBody,
  supportsPromptCacheBreakpoints,
} from '../../providers/rose/gptAuth';
import {
  boundedRateLimitBackoffMs,
  extractRateLimitedUntil,
  providerRequiredWaitMs,
  resetIsFarFuture,
} from '../../providers/rose/rateLimitReset';
import {
  parseAnthropicSSE,
  parseOpenAISSE,
  parseResponsesSSE,
} from '../../providers/rose/streaming';
import { RosePaymentRequiredError } from '../../providers/rose/errors';
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
  CEREBRAS_API_URL,
  CODEX_API_URL,
  OPENAI_RESPONSES_API_URL,
  OPENROUTER_API_URL,
} from '../../providers/rose/transport';
import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';
import { withIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';
import { assertLocalDatabase } from './assertLocalDatabase';

// In-process provider cases still reach Prisma (Foundry shared cooldowns, which
// withIsolatedFundedKeyCooldowns does not intercept). A direct `npx tsx` run
// would load back-end/.env and stamp production cooldown rows.
assertLocalDatabase();

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
    delete process.env.CEREBRAS_API_KEY;
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
  assert(isRoseModel('rose-labs/rose-1-flash'), 'rose-labs/rose-1-flash');
  assert(isRoseModel('ROSE-LABS/ROSE-1-ULTRA'), 'case-insensitive');
  assert(!isRoseModel('anthropic/claude-sonnet-4.5'), 'non-rose');
  assert(!isRoseModel(null), 'null');
  assert(!isRoseModel(''), 'empty');
}

async function testPool_forModelFuzzy() {
  assertEqual(poolForModel('rose-labs/rose-local'), 'rose-local', 'local');
  assertEqual(poolForModel('rose-labs/rose-1-flash'), 'rose-1-flash', 'flash');
  assertEqual(poolForModel('rose-labs/rose-1-lite'), 'rose-1-flash', 'legacy lite alias');
  assertEqual(poolForModel('rose-1-lite'), 'rose-1-flash', 'bare legacy lite alias');
  assertEqual(poolForModel('rose-labs/rose-1-ultra'), 'rose-1-ultra', 'ultra');
  assertEqual(poolForModel('rose-labs/rose-1-browser-use'), 'rose-1-browser-use', 'browser-use');
  assertEqual(poolForModel('rose-labs/rose-1-mini'), 'rose-1-mini', 'mini');
  assertEqual(poolForModel('rose'), 'rose-1-flash', 'rose alias');
  assertEqual(poolForModel('rose-flash'), 'rose-1-flash', 'rose-flash alias');
  assertEqual(poolForModel('rose-fast'), 'rose-1-flash', 'rose-fast alias');
  assertEqual(poolForModel('rose-ultra'), 'rose-1-ultra', 'rose-ultra alias');
  assertEqual(poolForModel('rose-mini'), 'rose-1-mini', 'rose-mini alias');
  // Strict resolution: unknown rose-labs/* identifiers fall through to null so
  // the caller rejects them explicitly (e.g. a typo or unreleased rose-labs/rose-2
  // must not silently route to rose-1-flash).
  assertEqual(poolForModel('rose-labs/something-ultra-new'), null, 'unknown rose-labs/*');
  assertEqual(poolForModel('rose-labs/rose-2'), null, 'future rose-labs model');
  assertEqual(poolForModel('openai/gpt-4'), null, 'non-rose');
  assertEqual(poolForModel(''), null, 'empty');
}

async function testRoseLocalOnlyCallsLoopback() {
  const originalFetch = global.fetch;
  const priorBase = process.env.ROSE_LOCAL_BASE_URL;
  const priorModel = process.env.ROSE_LOCAL_MODEL;
  const seen: string[] = [];
  try {
    process.env.ROSE_LOCAL_BASE_URL = 'http://127.0.0.1:8080/v1';
    process.env.ROSE_LOCAL_MODEL = 'test-local-model';
    global.fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      assertEqual(url, 'http://127.0.0.1:8080/v1/chat/completions', 'loopback URL');
      const sse =
        'data: {"choices":[{"index":0,"delta":{"content":"local ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const chunks: CompletionChunk[] = [];
    for await (const chunk of await createStreamingCompletion({
      model: 'rose-labs/rose-local',
      messages: [{ role: 'user', content: 'hello' }],
    }))
      chunks.push(chunk);
    assertEqual(seen.length, 1, 'one local request');
    assert(
      chunks.some((c) => c.choices[0]?.delta.content === 'local ok'),
      'local output'
    );
    assert(
      chunks.every((c) => c.pool_name === 'rose-local'),
      'local provenance'
    );
    process.env.ROSE_LOCAL_BASE_URL = 'https://openrouter.ai/api/v1';
    let rejected = false;
    try {
      for await (const chunk of await createStreamingCompletion({
        model: 'rose-labs/rose-local',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        assert(!chunk, 'unexpected streamed output');
      }
    } catch {
      rejected = true;
    }
    assert(rejected, 'remote URL rejected');
    assertEqual(seen.length, 1, 'no remote request');
  } finally {
    global.fetch = originalFetch;
    if (priorBase === undefined) delete process.env.ROSE_LOCAL_BASE_URL;
    else process.env.ROSE_LOCAL_BASE_URL = priorBase;
    if (priorModel === undefined) delete process.env.ROSE_LOCAL_MODEL;
    else process.env.ROSE_LOCAL_MODEL = priorModel;
  }
}

async function testPool_getPoolRegistryShape() {
  const lite = getPool('rose-1-flash');
  const ultra = getPool('rose-1-ultra');
  const browserUse = getPool('rose-1-browser-use');
  assertEqual(lite.name, 'rose-1-flash', 'flash.name');
  assert(lite.claudeAuthModel.startsWith('claude-'), 'flash claudeAuthModel');
  assertEqual(lite.gptAuthModel, 'gpt-5.6-luna', 'flash.gptAuthModel');
  assertEqual(lite.waterfallReasoningEffort, 'medium', 'flash waterfall effort');
  assertEqual(getPool('rose-1-mini').waterfallReasoningEffort, 'low', 'mini waterfall effort');
  assertEqual(ultra.waterfallReasoningEffort, undefined, 'ultra waterfall keeps caller effort');
  assertEqual(lite.directAuthEnabled, false, 'flash skips Claude/GPT auth');
  assertEqual(lite.cerebrasModel, 'qwen-3.8-27b', 'flash Cerebras primary');
  assertEqual(lite.cerebrasReasoningEffort, 'high', 'flash Cerebras effort');
  assertEqual(
    lite.waterfall.join(','),
    'qwen/qwen3.8-27b,google/gemini-3.8-flash',
    'flash OpenRouter waterfall'
  );
  assertEqual(ultra.name, 'rose-1-ultra', 'ultra.name');
  assertEqual(ultra.claudeAuthModel, 'claude-opus-5-5', 'ultra claudeAuthModel');
  assertEqual(ultra.gptAuthModel, 'gpt-6.1-sol', 'ultra.gptAuthModel');
  // Anthropic dropped from ultra: opus-4.8 was the priciest layer while scoring
  // below sol on every AA index. Sol leads, kimi-k3 backs it from a different vendor.
  assertEqual(
    ultra.waterfall.join(','),
    'openai/gpt-6.1-sol,moonshotai/kimi-k3',
    'ultra OpenRouter waterfall'
  );
  assertEqual(browserUse.name, 'rose-1-browser-use', 'browserUse.name');
  assertEqual(browserUse.claudeAuthModel, 'claude-sonnet-5', 'browserUse.claudeAuthModel');
  assertEqual(browserUse.gptAuthModel, 'gpt-5.6-luna', 'browserUse.gptAuthModel');
  assertEqual(browserUse.directAuthEnabled, false, 'browser skips Claude/GPT auth');
  assertEqual(browserUse.cerebrasModel, 'qwen-3.8-27b', 'browser Cerebras primary');
  assertEqual(
    browserUse.waterfall.join(','),
    'qwen/qwen3.8-27b,google/gemini-3.8-flash',
    'browserUse OpenRouter waterfall'
  );
  assert(
    !ultra.waterfall.some((m) => m.startsWith('anthropic/')),
    'ultra waterfall has no anthropic layer'
  );
  assert(
    !browserUse.waterfall.some((m) => m.startsWith('anthropic/')),
    'browserUse waterfall has no anthropic layer'
  );
  assert(lite.waterfall !== ultra.waterfall, 'lite.waterfall !== ultra.waterfall');
  assertEqual(Object.keys(POOL_REGISTRY).length, 5, 'registry has 5 pools');
  assert(Boolean(POOL_REGISTRY['rose-1-mini']), 'rose-1-mini registered');
  assert(Boolean(POOL_REGISTRY['rose-local']), 'rose-local registered');
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
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'test-token',
    });
    const chunks = await collect(stream);

    assertEqual(anthropicCalls, 1, 'anthropic call count');
    assertEqual(openrouterCalls, 0, 'openrouter call count');
    assert(chunks.length > 0, 'chunks emitted');
    const first = chunks[0];
    assertEqual(first.requested_model, 'rose-labs/rose-1-ultra', 'requested_model');
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
      model: 'rose-labs/rose-1-ultra',
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
    assertEqual(capturedBody?.model, getPool('rose-1-ultra').gptAuthModel, 'codex model');
    assertEqual(capturedBody?.stream, true, 'stream true');
    assertEqual(capturedBody?.store, false, 'store false');
    assert(!('max_tokens' in (capturedBody ?? {})), 'max_tokens omitted');
    assert(!('max_output_tokens' in (capturedBody ?? {})), 'max_output_tokens omitted');
    assert(!('temperature' in (capturedBody ?? {})), 'temperature omitted for Codex backend');
    assertEqual(
      (capturedBody?.reasoning as Record<string, unknown>)?.effort,
      'xhigh',
      'default reasoning effort'
    );
    assert(
      typeof capturedBody?.prompt_cache_key === 'string' &&
        capturedBody.prompt_cache_key.startsWith('rose:'),
      'stable prompt cache key present'
    );
    const samePromptDifferentRequest = buildCodexResponsesBody({
      poolSpec: getPool('rose-1-ultra'),
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
      poolSpec: getPool('rose-1-flash'),
      messages: [{ role: 'user', content: 'hi' }],
      requestId: 'no-system',
    });
    assertEqual(
      noSystemBody.instructions,
      'You are a helpful assistant.',
      'Codex instructions default present'
    );
    const splitSystemBody = buildCodexResponsesBody({
      poolSpec: getPool('rose-1-flash'),
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
      poolSpec: getPool('rose-1-flash'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'max',
      requestId: 'max-effort',
    });
    assertEqual(
      (maxEffortBody.reasoning as Record<string, unknown>).effort,
      'xhigh',
      'max effort normalized'
    );
    const invalidEffortBody = buildCodexResponsesBody({
      poolSpec: getPool('rose-1-flash'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'unsupported-provider-value',
      requestId: 'invalid-effort',
    });
    assertEqual(
      (invalidEffortBody.reasoning as Record<string, unknown>).effort,
      'xhigh',
      'unsupported effort falls back to xhigh'
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

async function testGptAuth_codex404FallsThroughToWaterfall() {
  // Codex Cloudflare/edge 404 (empty body — same for garbage tokens) must NOT
  // fail the whole createStreamingCompletion() call. It must raise
  // RoseServerError (isFallThroughError) so the client walks openai-api-key /
  // OpenRouter waterfall. Regression: bare RoseError on 404 aborted
  // spawn-subagents smoke with `RoseError: Codex 404:` and never fell through.
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  delete process.env.GPT_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let codexCalls = 0;
  let openAiCalls = 0;
  let openrouterCalls = 0;
  installFetchStub((url) => {
    if (url === CODEX_API_URL) {
      codexCalls++;
      return errorResponse(404, '');
    }
    if (url === OPENAI_RESPONSES_API_URL) {
      openAiCalls++;
      return errorResponse(500, 'openai key must not be required for this regression');
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'hi' }],
      gpt_token: 'blocked-codex-token',
      gpt_account_id: 'acct_404',
    });
    const chunks = await collect(stream);

    assert(codexCalls >= 1, 'Codex route must be attempted');
    assertEqual(openAiCalls, 0, 'openai api-key tier must not be required for this regression');
    assertEqual(openrouterCalls, 1, 'OpenRouter waterfall must serve after Codex 404');
    assert(chunks.length > 0, 'chunks emitted from waterfall after Codex 404');
    const first = chunks[0];
    assert(
      !String(first.actual_model ?? '').endsWith('-codex') &&
        !String(first.actual_model ?? '').endsWith('-openai'),
      `actual_model should be waterfall (not codex/openai), got ${first.actual_model}`
    );
  } finally {
    restoreFetch();
  }
}

async function testGptAuth_buildBodyPreservesToolHistoryAndMultimodal() {
  const body = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-flash'),
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
    poolSpec: getPool('rose-1-flash'),
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
    poolSpec: getPool('rose-1-flash'),
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
    poolSpec: getPool('rose-1-flash'),
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
  const originalSchema = JSON.stringify(SUPERVISOR_RESPONSE_SCHEMA);
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

  const send = extracted.tools.find((tool) => tool.name === 'send_user_message');
  const sendArgs = send?.input_schema as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const replyTarget = sendArgs.properties.reply_to_message_id;
  assertEqual(replyTarget.type, 'string', 'native reply target remains a string');
  assert(
    !(sendArgs.required ?? []).includes('reply_to_message_id'),
    'native reply target must be optional after all nullable wrappers collapse'
  );
  assert((sendArgs.required ?? []).includes('message'), 'native message must stay required');
  assert(
    typeof replyTarget.description === 'string' && replyTarget.description.length > 0,
    'reply target description must survive nullable normalization'
  );

  // Collapsing the union must not drop the model-facing field documentation.
  const startAgent = extracted.tools.find((tool) => tool.name === 'start_new_agent');
  // Parameters are flat, as in every Python tool model: the `arguments`
  // wrapper of the response envelope must not reach the native tool schema.
  const startAgentArgs = startAgent?.input_schema as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  assert(!('arguments' in startAgentArgs.properties), 'native tool parameters must be flat');
  const budget = startAgentArgs.properties;
  assert(
    typeof budget.budget_dollars.description === 'string' &&
      budget.budget_dollars.description.length > 0,
    'budget_dollars description must survive the Anthropic transform'
  );
  assertEqual(
    JSON.stringify(budget.start_phase?.enum),
    '["plan","execute"]',
    'start_phase enum must survive the Anthropic transform'
  );
  assert(
    (startAgentArgs.required ?? []).includes('start_phase'),
    'start_phase must stay required so the native tool path always chooses a phase'
  );
  assertEqual(
    JSON.stringify(SUPERVISOR_RESPONSE_SCHEMA),
    originalSchema,
    'OpenAI strict schema is not mutated'
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
    // The Responses dialect names the identifier `call_id`. Chat-dialect tool
    // results are matched by `id`, so a call carrying only `call_id` must be
    // mapped, not passed through unidentified.
    {
      label: 'responses-style call_id only',
      toolCall: { call_id: 'z', name: 'h', arguments: '{}' },
    },
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
      build: (messages) => buildOpenRouterFastChatBody({ messages }, 'req-tool-shape'),
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
      assert(
        typeof sent?.id === 'string' && (sent.id as string).length > 0,
        `${builderLabel} must carry a chat-dialect id for a ${shapeLabel} tool_call (got ${JSON.stringify(sent)})`
      );
    }
  }
}

/**
 * The Anthropic union relaxation collapses `T | null` to `T` and drops the key
 * from `required`, because Anthropic expresses optionality through `required`
 * and rejects a body carrying more than 16 union-typed parameters.
 *
 * That is a deliberate contract change for one provider dialect: a
 * required-nullable field becomes an absent-or-`T` field, and consumers read
 * absence as null (`supervisorTools.ts` defaults `budget_dollars` to $1). Pin
 * both halves so neither the collapse nor the consumer default drifts.
 */
interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode;
  required?: string[];
}

async function testClaudeAuth_haikuOmitsUnsupportedControls() {
  // Captured Anthropic response from the spawn-sub-agents smoke:
  // HTTP 400 "This model does not support the effort parameter."
  const poolSpec = getPool('rose-1-mini');
  const messages: CompletionMessage[] = [{ role: 'user', content: 'Summarize the source.' }];
  const plain = buildAnthropicBody({ poolSpec, messages });
  assertEqual(plain.model, 'claude-haiku-4-5', 'mini Claude model');
  assert(!('thinking' in plain), 'Haiku 4.5 must not receive adaptive thinking');
  assert(
    !('effort' in ((plain.output_config as Record<string, unknown> | undefined) ?? {})),
    'Haiku 4.5 must not receive output_config.effort'
  );

  const structured = buildAnthropicBody({
    poolSpec,
    messages,
    responseFormat: SUPERVISOR_RESPONSE_SCHEMA,
    effort: 'low',
  });
  assertEqual(
    (structured.tool_choice as Record<string, unknown>).type,
    'any',
    'structured Haiku response keeps forced tool choice'
  );
  assert(!('thinking' in structured), 'structured Haiku call omits adaptive thinking');
  assert(
    !('effort' in ((structured.output_config as Record<string, unknown> | undefined) ?? {})),
    'explicit effort is also omitted for Haiku 4.5'
  );
}

async function testAnthropic_nullableRelaxationPreservesNonNullableRequired() {
  const extracted = extractToolsFromResponseFormat({
    type: 'json_schema',
    json_schema: {
      name: 'probe',
      schema: {
        type: 'object',
        properties: {
          tool_calls: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    tool: { const: 'probe' },
                    arguments: {
                      type: 'object',
                      properties: {
                        goal: { type: 'string' },
                        budget_dollars: {
                          anyOf: [
                            { oneOf: [{ type: 'number' }, { type: 'null' }] },
                            { type: 'null' },
                          ],
                        },
                        tags: {
                          type: 'array',
                          items: {
                            oneOf: [
                              { anyOf: [{ type: 'string' }, { type: 'null' }] },
                              { type: 'null' },
                            ],
                          },
                        },
                        choice: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                        meta: {
                          type: 'object',
                          additionalProperties: {
                            anyOf: [
                              { anyOf: [{ type: 'string' }, { type: 'null' }] },
                              { type: 'null' },
                            ],
                          },
                        },
                      },
                      required: ['goal', 'budget_dollars', 'meta', 'tags', 'choice'],
                    },
                  },
                  required: ['tool', 'arguments'],
                },
              ],
            },
          },
        },
        required: ['tool_calls'],
      },
    },
  } as Parameters<typeof extractToolsFromResponseFormat>[0]);
  assert(extracted !== null, 'probe envelope must lift to a native tool');

  // `{ tool, arguments }` variants lift to flat native parameters.
  const schema = extracted.tools[0].input_schema as JsonSchemaNode;
  assert(!('arguments' in (schema.properties ?? {})), 'arguments wrapper must be flattened');
  assertEqual(
    JSON.stringify(schema.properties?.budget_dollars),
    '{"type":"number"}',
    'nullable union must collapse to its value branch'
  );
  assert(
    !(schema.required ?? []).includes('budget_dollars'),
    'collapsed nullable must leave required so absence can encode null'
  );
  assert(
    (schema.required ?? []).includes('goal'),
    'a non-nullable required field must stay required'
  );
  assertEqual(
    JSON.stringify(schema.properties?.meta?.additionalProperties),
    '{"type":"string"}',
    'typed map values must be relaxed too, or they keep counting against the cap'
  );
  assertEqual(
    JSON.stringify(schema.properties?.tags?.items),
    '{"type":"string"}',
    'nested nullable array items collapse'
  );
  assertEqual(
    JSON.stringify(schema.properties?.choice),
    '{"anyOf":[{"type":"string"},{"type":"number"}]}',
    'genuine non-null unions remain intact'
  );
}

/** Anthropic caps a request at four `cache_control` blocks. */
async function testClaudeAuth_bodyStaysWithinCacheBlockBudget() {
  const system = ['universal static', 'stable user block', 'third section', 'fourth section'].join(
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY
  );
  const body = buildAnthropicBody({
    poolSpec: getPool('rose-1-flash'),
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

const SPAWN_AGENT_TOOL = [
  {
    name: 'spawn_agent',
    description: 'spawn',
    input_schema: { type: 'object', properties: {} },
  },
];

async function testClaudeAuth_fable51DowngradesForcedToolChoice() {
  const named = buildAnthropicBody({
    poolSpec: getPool('rose-1-ultra'),
    messages: [{ role: 'user', content: 'fill params' }],
    tools: SPAWN_AGENT_TOOL,
    toolChoice: { type: 'tool', name: 'spawn_agent' },
  });
  assertEqual(named.model, 'claude-opus-5-5', 'ultra claudeAuth model');
  assertEqual(
    JSON.stringify(named.tool_choice),
    JSON.stringify({ type: 'auto', disable_parallel_tool_use: true }),
    'named tool_choice becomes auto + single-call'
  );

  const anyChoice = buildAnthropicBody({
    poolSpec: getPool('rose-1-browser-use'),
    messages: [{ role: 'user', content: 'fill params' }],
    tools: SPAWN_AGENT_TOOL,
    toolChoice: 'any',
  });
  assertEqual(anyChoice.model, 'claude-sonnet-5', 'browser-use claudeAuth model');
  assertEqual(
    JSON.stringify(anyChoice.tool_choice),
    JSON.stringify({ type: 'auto' }),
    'any → auto'
  );

  const structured = buildAnthropicBody({
    poolSpec: getPool('rose-1-ultra'),
    messages: [{ role: 'user', content: 'hi' }],
    responseFormat: SUPERVISOR_RESPONSE_SCHEMA,
  });
  assertEqual(
    (structured.tool_choice as Record<string, unknown>).type,
    'auto',
    'structured output also auto on 5.1'
  );
  assert('thinking' in structured, '5.1 keeps always-on thinking');

  const sonnet = buildAnthropicBody({
    poolSpec: getPool('rose-1-flash'),
    messages: [{ role: 'user', content: 'fill params' }],
    tools: SPAWN_AGENT_TOOL,
    toolChoice: { type: 'tool', name: 'spawn_agent' },
  });
  // Lite still enables thinking, so forced named choice already downgrades to
  // auto — confirm we did not attach the fable-5.1 single-call flag.
  assertEqual(
    JSON.stringify(sonnet.tool_choice),
    JSON.stringify({ type: 'auto' }),
    'sonnet thinking path stays auto without fable-5.1 parallel lock'
  );

  const legacy = buildAnthropicBody({
    poolSpec: {
      name: 'rose-1-ultra',
      claudeAuthModel: 'claude-fable-5',
      gptAuthModel: 'gpt-5.6-sol',
      waterfall: [],
    },
    messages: [{ role: 'user', content: 'fill params' }],
    tools: SPAWN_AGENT_TOOL,
    toolChoice: { type: 'tool', name: 'spawn_agent' },
  });
  // Legacy Fable 5 + thinking also downgrades forced choice to auto, but must
  // not match the 5.1 detector (no disable_parallel_tool_use).
  assertEqual(legacy.model, 'claude-fable-5', 'legacy fable-5 model id');
  assertEqual(
    JSON.stringify(legacy.tool_choice),
    JSON.stringify({ type: 'auto' }),
    'legacy fable-5 is not treated as 5.1'
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

async function testStreaming_inBandCreditExhaustionIsPaymentRequired() {
  let raised = false;
  try {
    await collect(
      parseResponsesSSE(
        sseResponse([
          'event: error',
          'data: {"type":"error","error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining"}}',
          '',
          'data: [DONE]',
          '',
        ]).body!,
        { actualModel: 'gpt-6-sol-openai', poolName: 'openai-api-key', requestId: 'r-credit-event' }
      )
    );
  } catch (err) {
    raised = err instanceof RosePaymentRequiredError;
  }
  assert(raised, 'in-band credit exhaustion triggers the shared API-key cooldown');
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
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'test-token',
    });
    const chunks = await collect(stream);

    assertEqual(anthropicCalls, 1, 'anthropic attempted exactly once (401 is terminal, no retry)');
    assertEqual(openrouterCalls, 1, 'fell through to openrouter');
    assert(chunks.length > 0, 'chunks emitted from waterfall');
    const first = chunks[0];
    assertEqual(first.pool_name, 'rose-1-ultra', 'pool_name from waterfall (not claude-token)');
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-ultra',
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

/**
 * Regression: a terminal Anthropic 429 must carry the reset Anthropic reported.
 *
 * Prod 2026-07-28 (user 1f85ff25): the Python agent path read
 * `anthropic-ratelimit-unified-7d-reset` and correctly backed the user's
 * claude_code token off until 2026-07-30T22:00:00Z at 16:54:51. Fifteen seconds
 * later this TS path 429'd on the SAME limit, but `RoseRateLimitError` carried
 * only `(message, status)` — every reset header was dropped — so
 * `markComputeTokenUnavailable` fell back to a synthetic +5m and overwrote the
 * real window. The exhausted token was then re-served every 5 minutes, and while
 * it was flagged the Claude Code path found no credential, fell through to the
 * unfunded shared ANTHROPIC_API_KEY, and returned 500 "No Claude Code
 * credentials available" / "Your credit balance is too low".
 *
 * `grep -rni anthropic-ratelimit back-end/src` returned ZERO hits before this fix.
 */
async function testClaudeAuth_429CarriesProviderResetWindow() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  delete process.env.ANTHROPIC_API_KEY;
  // A 7-day usage window, far enough out that in-place retries cannot clear it.
  const resetAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  let anthropicCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-ratelimit-unified-7d-reset': resetAt,
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    let captured: unknown = null;
    try {
      await collect(
        claudeAuthComplete({
          poolSpec: getPool('rose-1-flash'),
          messages: [{ role: 'user', content: 'hi' }],
          auth: { mode: 'oauth', token: 'test-token' },
          requestId: 'test-429-reset',
        })
      );
    } catch (err) {
      captured = err;
    }

    assert(
      captured instanceof RoseRateLimitError,
      `expected RoseRateLimitError, got ${String(captured)}`
    );
    const rateLimitError = captured as RoseRateLimitError;
    assert(
      rateLimitError.rateLimitedUntil !== undefined,
      'RoseRateLimitError dropped the provider reset — the caller will invent a short ' +
        'cooldown and can clobber a real multi-day usage window (prod 2026-07-28)'
    );
    assertEqual(
      new Date(rateLimitError.rateLimitedUntil!).getTime(),
      new Date(resetAt).getTime(),
      'rateLimitedUntil matches anthropic-ratelimit-unified-7d-reset'
    );
    // A far-future usage window is not clearable by retrying in place, so we must
    // surface it immediately instead of burning the full in-place retry budget.
    assertEqual(anthropicCalls, 1, 'far-future usage window rotates without in-place retries');
  } finally {
    restoreFetch();
  }
}

/**
 * Regression (CodeRabbit): a `retry-after` longer than the sleep cap must ROTATE,
 * not sleep short and retry.
 *
 * `BACKOFF_CAP_MS` is 5s. Previously the retry decision used only
 * `resetIsFarFuture` (60s threshold), so a `retry-after: 30` still took the
 * in-place retry path — and then `backoffFor429` clipped the sleep to 5s. The
 * retry fired 25s before the window closed, hit a guaranteed second 429, and
 * burned an attempt. Now anything we cannot honor within the cap surfaces
 * immediately so the caller rotates credentials.
 */
async function testClaudeAuth_retryAfterBeyondCapRotatesInsteadOfClipping() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  delete process.env.ANTHROPIC_API_KEY;
  let anthropicCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'retry-after': '30' },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    let captured: unknown = null;
    try {
      await collect(
        claudeAuthComplete({
          poolSpec: getPool('rose-1-flash'),
          messages: [{ role: 'user', content: 'hi' }],
          auth: { mode: 'oauth', token: 'test-token' },
          requestId: 'test-retry-after-cap',
        })
      );
    } catch (err) {
      captured = err;
    }

    assert(
      captured instanceof RoseRateLimitError,
      `expected RoseRateLimitError, got ${String(captured)}`
    );
    assertEqual(
      anthropicCalls,
      1,
      'retry-after beyond the sleep cap must rotate immediately, not burn a clipped in-place retry'
    );
    const until = (captured as RoseRateLimitError).rateLimitedUntil;
    assert(until !== undefined, 'retry-after must still be surfaced as rateLimitedUntil');
    const deltaMs = new Date(until!).getTime() - Date.now();
    assert(
      deltaMs > 25_000 && deltaMs <= 31_000,
      `rateLimitedUntil should reflect the 30s retry-after, got ${deltaMs}ms`
    );
  } finally {
    restoreFetch();
  }
}

/** A short retry-after (inside the cap) must still retry in place. */
async function testClaudeAuth_retryAfterWithinCapStillRetriesInPlace() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  let anthropicCalls = 0;
  installFetchStub((url) => {
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      if (anthropicCalls === 1) {
        return new Response(JSON.stringify({ error: { message: 'burst' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'retry-after': '1' },
        });
      }
      return sseResponse(ANTHROPIC_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const chunks = await collect(
      claudeAuthComplete({
        poolSpec: getPool('rose-1-flash'),
        messages: [{ role: 'user', content: 'hi' }],
        auth: { mode: 'oauth', token: 'test-token' },
        requestId: 'test-retry-after-within-cap',
      })
    );
    assertEqual(anthropicCalls, 2, 'a 1s retry-after fits the cap and must retry in place');
    assert(chunks.length > 0, 'chunks emitted after in-place retry');
  } finally {
    restoreFetch();
  }
}

/** Unit coverage for every extraction branch, mirroring claude_auth.py. */
async function testRateLimitReset_extractionBranches() {
  const now = Date.now();
  const futureResetMs = Math.floor(now / 1000) * 1000 + 7 * 24 * 60 * 60 * 1000;
  const iso = new Date(futureResetMs).toISOString();
  const h = (init: Record<string, string>): Headers => new Headers(init);

  assertEqual(
    extractRateLimitedUntil(h({ 'anthropic-ratelimit-unified-reset': iso }), ''),
    iso,
    'unified reset header'
  );
  assertEqual(
    extractRateLimitedUntil(h({ 'anthropic-ratelimit-unified-7d-reset': iso }), ''),
    iso,
    '7d reset header'
  );

  // Epoch seconds and milliseconds both normalize to the same instant.
  const epochS = Math.floor(new Date(iso).getTime() / 1000);
  assertEqual(
    extractRateLimitedUntil(h({ 'x-ratelimit-reset': String(epochS) }), ''),
    iso,
    'epoch-seconds header'
  );
  assertEqual(
    extractRateLimitedUntil(h({ 'ratelimit-reset': String(epochS * 1000) }), ''),
    iso,
    'epoch-millis header'
  );

  // No headers → scrape the body.
  assertEqual(
    extractRateLimitedUntil(h({}), `{"error":{"message":"limit reached, resets ${iso}"}}`),
    iso,
    'ISO timestamp scraped from body'
  );

  const fromDuration = extractRateLimitedUntil(h({}), 'please try again in 30 minutes');
  assert(fromDuration !== null, 'duration phrase parsed from body');
  const durationDeltaMs = new Date(fromDuration!).getTime() - Date.now();
  assert(
    durationDeltaMs > 29 * 60 * 1000 && durationDeltaMs <= 30 * 60 * 1000 + 5000,
    `"in 30 minutes" → ~30min, got ${durationDeltaMs}ms`
  );

  // retry-after is the LAST resort, not the first.
  const fromRetryAfter = extractRateLimitedUntil(h({ 'retry-after': '60' }), '');
  assert(fromRetryAfter !== null, 'retry-after delta-seconds parsed');
  const retryDeltaMs = new Date(fromRetryAfter!).getTime() - Date.now();
  assert(
    retryDeltaMs > 55_000 && retryDeltaMs <= 65_000,
    `retry-after 60 → ~60s, got ${retryDeltaMs}ms`
  );
  // With both signals present the credential must stay ineligible until the
  // LATER of them. Here the 7d reset outlasts a 60s retry-after.
  assertEqual(
    extractRateLimitedUntil(
      h({ 'anthropic-ratelimit-unified-reset': iso, 'retry-after': '60' }),
      ''
    ),
    iso,
    'reset header wins when it is the later deadline'
  );

  // Regression: the inverse pairing. A near reset (T+2s) with `retry-after: 30`
  // must persist ~T+30s, not T+2s. Persisting the earlier one frees the
  // credential 28s before the provider allows it — a guaranteed second 429,
  // because providerRequiredWaitMs() reads retry-after first and waits 30s.
  const nearReset = new Date(Date.now() + 2_000).toISOString();
  const bothHeaders = extractRateLimitedUntil(
    h({ 'anthropic-ratelimit-unified-reset': nearReset, 'retry-after': '30' }),
    ''
  );
  assert(bothHeaders !== null, 'reset + retry-after parsed');
  const bothDeltaMs = new Date(bothHeaders!).getTime() - Date.now();
  assert(
    bothDeltaMs > 25_000 && bothDeltaMs <= 35_000,
    `near reset + retry-after 30 → ~30s (the later), got ${bothDeltaMs}ms`
  );

  // Retry eligibility uses Retry-After before the longer credential reset. HTTP-date is a valid
  // Retry-After form and must not be skipped merely because rateLimitedUntil was precomputed.
  const retryAt = new Date(Date.now() + 4_000);
  retryAt.setMilliseconds(0);
  const httpDateWaitMs = providerRequiredWaitMs(
    h({ 'retry-after': retryAt.toUTCString(), 'anthropic-ratelimit-unified-reset': iso }),
    '',
    iso
  );
  assert(httpDateWaitMs !== null, 'HTTP-date retry-after produces a required wait');
  assert(
    httpDateWaitMs! > 2_000 && httpDateWaitMs! <= 4_000,
    `HTTP-date retry-after wins over multi-day reset, got ${httpDateWaitMs}ms`
  );

  assertEqual(
    boundedRateLimitBackoffMs(0, 4_000, 5_000, () => 0),
    4_000,
    'provider wait is the minimum in-place retry delay'
  );
  assertEqual(
    boundedRateLimitBackoffMs(0, null, 5_000, () => 0),
    1_000,
    'missing provider timing uses exponential fallback'
  );

  // Nothing supplied → null, so the caller knowingly uses a synthetic cooldown.
  assertEqual(extractRateLimitedUntil(h({}), 'rate limited'), null, 'no timing → null');
  assertEqual(extractRateLimitedUntil(null, ''), null, 'no headers at all → null');
  // Garbage must not become a bogus far-future lockout.
  assertEqual(
    extractRateLimitedUntil(h({ 'retry-after': 'soon' }), ''),
    null,
    'unparseable → null'
  );
  assertEqual(
    extractRateLimitedUntil(h({ 'x-ratelimit-reset': '42' }), ''),
    null,
    'sub-epoch → null'
  );
  assertEqual(
    extractRateLimitedUntil(h({ 'x-ratelimit-reset': '17000000000000' }), ''),
    null,
    'oversized epoch remains invalid after millisecond conversion'
  );

  assert(resetIsFarFuture(iso), 'multi-day reset is a usage window');
  assert(
    !resetIsFarFuture(new Date(Date.now() + 5_000).toISOString()),
    '5s reset is a burst limit, not a usage window'
  );
  assert(!resetIsFarFuture(null), 'null reset is not far-future');
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
      model: 'rose-labs/rose-1-flash',
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

async function testFlash_skipsAuthAndHitsCerebrasQwen() {
  process.env.CEREBRAS_API_KEY = 'csk-test';
  process.env.OPENROUTER_API_KEY = 'or-must-not-run';
  let cerebrasCalls = 0;
  let anthropicCalls = 0;
  let openrouterCalls = 0;
  let capturedBody: Record<string, unknown> | undefined;
  installFetchStub((url, init) => {
    if (url === CEREBRAS_API_URL) {
      cerebrasCalls++;
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return sseResponse(OPENROUTER_OK_SSE);
    }
    if (url === ANTHROPIC_API_URL) {
      anthropicCalls++;
      return errorResponse(500, 'auth must be skipped');
    }
    if (url === OPENROUTER_API_URL) {
      openrouterCalls++;
      return errorResponse(500, 'waterfall must not run');
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'claude-oauth-must-not-run',
      gpt_token: 'gpt-oauth-must-not-run',
    });
    const chunks = await collect(stream);
    assertEqual(cerebrasCalls, 1, 'direct Cerebras hop');
    assertEqual(anthropicCalls, 0, 'flash skips Claude auth');
    assertEqual(openrouterCalls, 0, 'waterfall not reached');
    assertEqual(capturedBody?.model, 'qwen-3.8-27b', 'Cerebras inventory id');
    assertEqual(capturedBody?.reasoning_effort, 'high', 'Cerebras effort');
    assertEqual(chunks[0]?.pool_name, 'cerebras-direct', 'pool provenance');
    assertEqual(chunks[0]?.actual_model, 'qwen-3.8-27b', 'actual model');
  } finally {
    restoreFetch();
    delete process.env.CEREBRAS_API_KEY;
  }
}

async function testFlash_cerebrasFailureFallsToOpenRouterQwen() {
  process.env.CEREBRAS_API_KEY = 'csk-test';
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  let cerebrasCalls = 0;
  const openrouterModels: string[] = [];
  installFetchStub((url, init) => {
    if (url === CEREBRAS_API_URL) {
      cerebrasCalls++;
      return errorResponse(503, 'cerebras down');
    }
    if (url === OPENROUTER_API_URL) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      openrouterModels.push(body.model ?? '');
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      claude_token: 'claude-oauth-must-not-run',
    });
    const chunks = await collect(stream);
    assertEqual(cerebrasCalls, 1, 'Cerebras attempted');
    assertEqual(openrouterModels[0], 'qwen/qwen3.8-27b', 'first OpenRouter fallback');
    assert(chunks.length > 0, 'waterfall served after Cerebras failure');
    assertEqual(chunks[0]?.actual_model, 'qwen/qwen3.8-27b', 'actual model');
  } finally {
    restoreFetch();
    delete process.env.CEREBRAS_API_KEY;
  }
}

async function testOpenAiApiKey_servesBeforeAnthropicAndOpenRouter() {
  await __resetGptApiKeyCooldown();
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
        model: 'rose-labs/rose-1-ultra',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    assertEqual(openAiCalls, 1, 'served by OpenAI API-key path');
    assertEqual(anthropicCalls, 0, 'did NOT fall through to Anthropic');
    assertEqual(openrouterCalls, 0, 'did NOT fall through to OpenRouter');
    assertEqual(capturedHeaders.Authorization, 'Bearer sk-proj-test-key', 'sent OpenAI bearer');
    assertEqual(capturedBody?.model, 'gpt-6.1-sol', 'uses Rose Ultra GPT model');
    assertEqual(capturedBody?.service_tier, undefined, 'absent speed stays standard');
    assert(chunks[0].actual_model.endsWith('-openai'), 'actual_model marks OpenAI key path');
  } finally {
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    restoreFetch();
    await __resetGptApiKeyCooldown();
  }
}

async function testOpenAiApiKey_failureFallsThroughToAnthropicBeforeOpenRouter() {
  await __resetGptApiKeyCooldown();
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
        model: 'rose-labs/rose-1-ultra',
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
    await __resetGptApiKeyCooldown();
    restoreFetch();
  }
}

async function testGptApiKey_insufficientQuotaCoolsLaterRequestsBeforeFoundry() {
  await __resetGptApiKeyCooldown();
  process.env.GPT_API_KEY = 'sk-proj-test-key';
  process.env.ANTHROPIC_API_KEY = '';
  // Region 1 only: a developer .env may configure AZURE_FOUNDRY_*_2.._9.
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-foundry-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol';
  const seen = { openai: 0, foundry: 0, openrouter: 0 };
  installFetchStub((url) => {
    if (url === OPENAI_RESPONSES_API_URL) {
      seen.openai++;
      return errorResponse(
        429,
        JSON.stringify({ error: { code: 'credit_balance_exhausted', type: 'insufficient_quota' } })
      );
    }
    if (url === 'https://a-4989-resource.openai.azure.com/openai/v1/responses') {
      seen.foundry++;
      return sseResponse(RESPONSES_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) seen.openrouter++;
    throw new Error(`Unexpected provider URL: ${url}`);
  });
  try {
    for (let i = 0; i < 2; i++) {
      const chunks = await collect(
        await createStreamingCompletion({
          model: 'rose-labs/rose-1-ultra',
          messages: [{ role: 'user', content: 'hi' }],
        })
      );
      assert(chunks[0].actual_model.endsWith('-foundry'), 'Foundry served completion');
    }
    assertEqual(seen.openai, 1, 'exhausted GPT key only attempted once');
    assertEqual(seen.foundry, 2, 'Foundry served both requests');
    assertEqual(seen.openrouter, 0, 'OpenRouter not reached');
  } finally {
    restoreFetch();
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
    await __resetGptApiKeyCooldown();
  }
}

/**
 * GPT-5.6+ caches only at breakpoints (measured on Azure 2026-10-12): without them the
 * latest message is the only write point and a growing prompt is billed as 1.25x writes.
 * Rose maps the caller's ordinary cache_control markers to prompt_cache_breakpoint on
 * routes that honor them, as the Python client does. Prompts do not change.
 */
function testGpt56CacheMarkers_becomeResponsesBreakpoints() {
  const marker = { type: 'ephemeral' };
  const messages = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: [{ type: 'text', text: 'unit one', cache_control: marker }] },
    { role: 'user', content: [{ type: 'text', text: 'unit two', cache_control: marker }] },
    { role: 'user', content: 'this call only' },
  ] as unknown as CompletionMessage[];
  const marks = (body: Record<string, unknown>) =>
    (body.input as Array<{ content?: Array<Record<string, unknown>> }>).flatMap((item) =>
      (item.content ?? []).map((part) => part.prompt_cache_breakpoint ?? null)
    );
  const build = (modelOverride: string, cacheBreakpoints?: boolean) =>
    buildCodexResponsesBody({
      poolSpec: getPool('rose-1-ultra'),
      modelOverride,
      messages,
      requestId: 'r',
      cacheBreakpoints,
    });
  const sol = build('gpt-6.1-sol', true);
  assertEqual(
    JSON.stringify(marks(sol)),
    JSON.stringify([{ mode: 'explicit' }, { mode: 'explicit' }, null]),
    'each marked block becomes a breakpoint'
  );
  assert(!('prompt_cache_options' in sol), 'implicit mode keeps the latest-message cache');
  assert(!JSON.stringify(sol.input).includes('cache_control'), 'no Anthropic marker on the wire');
  assertEqual(
    JSON.stringify(marks(build('gpt-5.5', true))),
    '[null,null,null]',
    'earlier models reject the field'
  );
  assertEqual(JSON.stringify(marks(build('gpt-6.1-sol'))), '[null,null,null]', 'routes opt in');
  const many = Array.from({ length: 60 }, (_, i) => ({
    role: 'user',
    content: [{ type: 'text', text: `unit ${i}`, cache_control: marker }],
  })) as unknown as CompletionMessage[];
  const capped = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-ultra'),
    modelOverride: 'gpt-6-sol',
    messages: many,
    requestId: 'r',
    cacheBreakpoints: true,
  });
  assertEqual(
    JSON.stringify(marks(capped).map((mark) => mark !== null)),
    JSON.stringify([...Array(10).fill(false), ...Array(50).fill(true)]),
    'reads consider the latest 50 breakpoints'
  );
  assertEqual(
    JSON.stringify(
      [
        'gpt-5.5',
        'gpt-5',
        'gpt-5.6-luna',
        'gpt-6-sol',
        'gpt-6.1-sol',
        'claude-opus-5-5',
        undefined,
      ].map(supportsPromptCacheBreakpoints)
    ),
    JSON.stringify([false, false, true, true, true, false, false]),
    'GPT-5.6 and later only'
  );
}

/**
 * Replaying 911 real agent calls (2026-10-12) through the measured GPT-5.6+ cache rule:
 * implicit mode plus a breakpoint after every user message before the final item cost
 * 0.51x of no caching (0.55x implicit only; explicit mode 0.61x). Rose applies it for
 * every caller, marked or not; assistant and tool items and the final item stay unmarked.
 */
function testResponsesBody_marksEveryCompletedUserMessage() {
  const messages = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'stable context' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'result' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'part a' },
        { type: 'text', text: 'part b' },
      ],
    },
    { role: 'user', content: 'this call only' },
  ] as unknown as CompletionMessage[];
  const shape = (body: Record<string, unknown>) =>
    (body.input as Array<Record<string, unknown>>).map((item) =>
      Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>).map(
            (part) => part.prompt_cache_breakpoint ?? null
          )
        : item.type
    );
  const body = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-ultra'),
    modelOverride: 'gpt-6-sol',
    messages,
    tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    requestId: 'r',
    cacheBreakpoints: true,
  });
  assertEqual(
    JSON.stringify(shape(body)),
    JSON.stringify([
      [{ mode: 'explicit' }],
      'function_call',
      'function_call_output',
      [null, { mode: 'explicit' }],
      [null],
    ]),
    'every completed user message ends at a breakpoint'
  );
  const plain = buildCodexResponsesBody({
    poolSpec: getPool('rose-1-ultra'),
    modelOverride: 'gpt-6-sol',
    messages,
    requestId: 'r',
  });
  assert(
    !JSON.stringify(plain).includes('prompt_cache_breakpoint'),
    'routes without support unchanged'
  );
}

async function testFoundry_sendsBreakpointsAndKeepsReportedZeroCacheWrites() {
  process.env.ANTHROPIC_API_KEY = '';
  process.env.GPT_API_KEY = '';
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-foundry-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol';
  const bodies: Array<Record<string, unknown>> = [];
  const usages = [
    '{"input_tokens":1000,"output_tokens":1,"total_tokens":1001,"input_tokens_details":{"cached_tokens":900,"cache_write_tokens":0}}',
    '{"input_tokens":1000,"output_tokens":1,"total_tokens":1001,"input_tokens_details":{"cached_tokens":0}}',
  ];
  installFetchStub((url, init) => {
    if (url === 'https://a-4989-resource.openai.azure.com/openai/v1/responses') {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        '',
        `data: {"type":"response.completed","response":{"usage":${usages[bodies.length - 1]}}}`,
        '',
        'data: [DONE]',
        '',
      ]);
    }
    throw new Error(`Unexpected provider URL: ${url}`);
  });
  try {
    const written: Array<number | undefined> = [];
    for (let i = 0; i < 2; i++) {
      const chunks = await collect(
        await createStreamingCompletion({
          model: 'rose-labs/rose-1-ultra',
          messages: [
            { role: 'system', content: 'policy' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } },
              ],
            },
            { role: 'user', content: 'this call only' },
          ] as unknown as CompletionMessage[],
        })
      );
      written.push(chunks[chunks.length - 1].usage?.cache_creation_input_tokens);
    }
    assertEqual(bodies.length, 2, 'Foundry served both requests');
    const parts = (bodies[0].input as Array<{ content: Array<Record<string, unknown>> }>).flatMap(
      (item) => item.content
    );
    assertEqual(
      JSON.stringify(parts.map((part) => part.prompt_cache_breakpoint ?? null)),
      JSON.stringify([{ mode: 'explicit' }, null]),
      'Foundry request carries the caller breakpoint'
    );
    assertEqual(written[0], 0, 'a reported zero cache write stays zero');
    assertEqual(written[1], 1000, 'an unreported write keeps the inclusive fallback');
  } finally {
    restoreFetch();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GPT_API_KEY;
    delete process.env.AZURE_FOUNDRY_ENDPOINT;
    delete process.env.AZURE_FOUNDRY_API_KEY;
    delete process.env.AZURE_FOUNDRY_DEPLOYMENTS;
  }
}

async function testSharedOpenAiPriorityRoute_isExclusiveAndPreservesRouterConfig() {
  await __resetGptApiKeyCooldown();
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
      model: 'rose-labs/rose-1-flash',
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
      speed: 'fast',
    });
    const chunks = await collect(stream);

    assertEqual(calls, 1, 'exactly one shared OpenAI request');
    assertEqual(capturedBody.model, 'gpt-5.6-luna', 'router provider model');
    assertEqual(capturedBody.service_tier, 'priority', 'priority service tier');
    assertEqual(capturedBody.instructions, 'router-system-prompt', 'system prompt');
    assertEqual(
      JSON.stringify(capturedBody.reasoning),
      JSON.stringify({ effort: 'xhigh', summary: 'auto' }),
      'reasoning config'
    );
    const text = capturedBody.text as { format?: { name?: string; strict?: boolean } };
    assertEqual(text.format?.name, 'router_decision', 'response schema name');
    assertEqual(text.format?.strict, true, 'response schema strictness');
    assertEqual(chunks[0]?.actual_model, 'gpt-5.6-luna-openai', 'actual model provenance');
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
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'route this request' }],
      claude_token: 'claude-oauth-must-not-run',
      gpt_token: 'gpt-oauth-must-not-run',
      provider_route: 'shared-openai-priority',
      speed: 'fast',
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
  await __resetGptApiKeyCooldown();
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
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'route this request' }],
      claude_token: 'claude-oauth-must-not-run',
      gpt_token: 'gpt-oauth-must-not-run',
      provider_route: 'shared-openai-priority',
      speed: 'fast',
    });
    let thrown: unknown;
    try {
      await collect(stream);
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Error, 'invalid key should throw');
    assertEqual((thrown as Error).message, 'OpenAI 401', 'safe OpenAI auth error');
    assertEqual(JSON.stringify(calledUrls), JSON.stringify([OPENAI_RESPONSES_API_URL]), 'calls');
  } finally {
    restoreFetch();
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await __resetGptApiKeyCooldown();
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-ultra',
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
        model: 'rose-labs/rose-1-ultra',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    assertEqual(anthropicCalls, 1, 'api-key attempted once');
    assertEqual(openrouterCalls, 1, 'fell through to waterfall after 402');

    // Second call: breaker is open → api-key tier skipped, straight to waterfall.
    await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-flash',
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
    // Read the registry rather than hardcoding: this asserted 'google/gemini-3.5-flash' and
    // would silently pin a model rose-1-flash no longer races the moment the pool moves.
    assertEqual(
      payload.config.actual_model,
      POOL_REGISTRY['rose-1-flash'].waterfall[0],
      'actual model dumped'
    );
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

async function testWaterfall_bodyBuildersAlwaysStampEffortXhigh() {
  // EVERY Rose LLM body builder must stamp effort on the wire:
  //   Anthropic → output_config.effort (default xhigh)
  //   OpenAI/Codex Responses → reasoning.effort (default xhigh)
  //   OpenRouter waterfall → reasoning.effort (default xhigh)
  //   OpenRouter fast chat → reasoning.effort (default xhigh)
  //   Cerebras direct → reasoning_effort: 'low' (rose-fast Qwen stall budget)
  //   OpenRouter→Cerebras → reasoning.effort: 'low' (same Qwen stall budget)
  const messages: CompletionMessage[] = [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hi' },
  ];
  const pool = getPool('rose-1-flash');

  const anthropic = buildAnthropicBody({ poolSpec: pool, messages });
  assertEqual(
    (anthropic.output_config as Record<string, unknown>).effort,
    'xhigh',
    'anthropic default effort'
  );

  const anthropicMax = buildAnthropicBody({ poolSpec: pool, messages, effort: 'max' });
  assertEqual(
    (anthropicMax.output_config as Record<string, unknown>).effort,
    'xhigh',
    'anthropic max → xhigh'
  );

  const anthropicMed = buildAnthropicBody({
    poolSpec: pool,
    messages,
    effort: 'medium',
  });
  assertEqual(
    (anthropicMed.output_config as Record<string, unknown>).effort,
    'medium',
    'anthropic explicit medium'
  );

  const anthropicMinimal = buildAnthropicBody({
    poolSpec: pool,
    messages,
    effort: 'minimal',
  });
  assertEqual(
    (anthropicMinimal.output_config as Record<string, unknown>).effort,
    'low',
    'anthropic minimal → low'
  );

  const codex = buildCodexResponsesBody({
    poolSpec: pool,
    messages,
    requestId: 'effort-default',
  });
  assertEqual((codex.reasoning as Record<string, unknown>).effort, 'xhigh', 'codex default effort');

  const openrouter = buildOpenRouterBody({
    model: 'openai/gpt-5.6-sol',
    messages,
  });
  assertEqual(
    (openrouter.reasoning as Record<string, unknown>).effort,
    'xhigh',
    'openrouter default effort'
  );

  const openrouterHigh = buildOpenRouterBody({
    model: 'openai/gpt-5.6-sol',
    messages,
    reasoningEffort: 'high',
  });
  assertEqual(
    (openrouterHigh.reasoning as Record<string, unknown>).effort,
    'high',
    'openrouter explicit high'
  );

  const openrouterMinimal = buildOpenRouterBody({
    model: 'openai/gpt-5.6-sol',
    messages,
    reasoningEffort: 'minimal',
  });
  assertEqual(
    (openrouterMinimal.reasoning as Record<string, unknown>).effort,
    'low',
    'openrouter minimal → low'
  );

  // Every waterfall step for the browser-use pool must stamp effort.
  const browserPool = getPool('rose-1-browser-use');
  for (const model of browserPool.waterfall) {
    const stepBody = buildOpenRouterBody({ model, messages });
    assert(
      typeof (stepBody.reasoning as Record<string, unknown> | undefined)?.effort === 'string',
      `effort present on ${model}`
    );
    assertEqual(
      (stepBody.reasoning as Record<string, unknown>).effort,
      'xhigh',
      `effort=xhigh on ${model}`
    );
  }

  // Latency chat routes: effort still ALWAYS set (low for Cerebras/Qwen; xhigh default for OR-fast).
  const cerebras = buildCerebrasChatBody({ messages });
  assertEqual(cerebras.reasoning_effort, 'low', 'cerebras stamps reasoning_effort=low');
  const cerebrasCached = buildCerebrasChatBody({
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'you are helpful',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: 'hi' },
    ] as CompletionMessage[],
  });
  assert(
    !JSON.stringify(cerebrasCached).includes('cache_control'),
    'Cerebras body strips cache_control (live qwen-3.8-27b 400s it)'
  );

  const orCerebras = buildOpenRouterCerebrasBody({ messages });
  assertEqual(
    (orCerebras.reasoning as Record<string, unknown>).effort,
    'low',
    'openrouter→cerebras stamps reasoning.effort=low'
  );

  const orFast = buildOpenRouterFastChatBody({ messages }, 'req-effort');
  assertEqual(
    (orFast.reasoning as Record<string, unknown>).effort,
    'xhigh',
    'openrouter-fast default effort=xhigh'
  );
  const orFastMinimal = buildOpenRouterFastChatBody(
    { messages, effort: 'minimal' },
    'req-effort-minimal'
  );
  assertEqual(
    (orFastMinimal.reasoning as Record<string, unknown>).effort,
    'low',
    'openrouter-fast minimal → low'
  );

  // Inventory: every exported body builder in this suite stamps a non-empty effort.
  const inventory: Array<{ label: string; effort: unknown }> = [
    { label: 'anthropic', effort: (anthropic.output_config as Record<string, unknown>).effort },
    { label: 'codex', effort: (codex.reasoning as Record<string, unknown>).effort },
    { label: 'openrouter', effort: (openrouter.reasoning as Record<string, unknown>).effort },
    { label: 'cerebras', effort: cerebras.reasoning_effort },
    {
      label: 'openrouter-cerebras',
      effort: (orCerebras.reasoning as Record<string, unknown>).effort,
    },
    { label: 'openrouter-fast', effort: (orFast.reasoning as Record<string, unknown>).effort },
  ];
  for (const { label, effort } of inventory) {
    assert(
      typeof effort === 'string' && effort.length > 0,
      `${label} must stamp non-empty effort (got ${JSON.stringify(effort)})`
    );
  }
}

async function testClaudeAuth_omitsEffortForHaiku() {
  // rose-1-mini claudeAuth is claude-haiku-4-5, which 400s on
  // output_config.effort. Mirror agents rose.blackbox (spawn-sub-agents
  // timeout e6b39a7f — summarize_web_fetch burned 90s TTFT after invalid_request).
  const messages: CompletionMessage[] = [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hi' },
  ];
  const mini = buildAnthropicBody({
    poolSpec: getPool('rose-1-mini'),
    messages,
    effort: 'xhigh',
  });
  assertEqual(mini.model, 'claude-haiku-4-5', 'mini model');
  const miniOc = mini.output_config as Record<string, unknown> | undefined;
  assert(
    miniOc === undefined || miniOc.effort === undefined,
    'haiku must not receive output_config.effort'
  );
  assert(mini.thinking === undefined, 'haiku must not receive thinking.type=adaptive');

  const flash = buildAnthropicBody({
    poolSpec: getPool('rose-1-flash'),
    messages,
  });
  assertEqual(
    (flash.output_config as Record<string, unknown>).effort,
    'xhigh',
    'non-haiku still stamps xhigh'
  );
  assertEqual(
    (flash.thinking as Record<string, unknown> | undefined)?.type,
    'adaptive',
    'non-haiku still stamps adaptive thinking'
  );
}

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
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const chunks = await collect(stream);
    assertEqual(orCallCount, 2, 'two openrouter attempts');
    const pool = getPool('rose-1-flash');
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
      model: 'rose-labs/rose-1-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    let raised: unknown = null;
    try {
      await collect(stream);
    } catch (err) {
      raised = err;
    }
    assert(raised instanceof RoseAllFailed, `expected RoseAllFailed, got ${raised}`);
    const pool = getPool('rose-1-flash');
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
      poolName: 'rose-1-flash',
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
      poolName: 'rose-1-flash',
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
      poolName: 'rose-1-flash',
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
      poolName: 'rose-1-flash',
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
        poolName: 'rose-1-flash',
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
        poolName: 'rose-1-flash',
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
        poolName: 'rose-1-flash',
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
        poolName: 'rose-1-flash',
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
      poolName: 'rose-1-flash',
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-flash',
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
        model: 'rose-labs/rose-1-ultra',
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
        model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-flash',
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
      model: 'rose-labs/rose-1-flash',
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
      model: 'rose-labs/rose-1-ultra',
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
    const pool = getPool('rose-1-ultra');
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
    (threw as Error).message.includes('rose-labs/rose-1-flash'),
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-ultra',
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
  // the claudeAuth path. claudeAuth.ts also pins output_config.effort='xhigh'
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
      model: 'rose-labs/rose-1-ultra',
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
    assertEqual(oc!.effort, 'xhigh', 'effort=xhigh pinned');
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
      model: 'rose-labs/rose-1-ultra',
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
      model: 'rose-labs/rose-1-ultra',
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

// ==================== SUBSCRIPTION-FIRST ORDER ====================
//
// Andy (2026-10-28): every Claude/Codex subscription is tried before any funded
// credential (OpenAI key, Anthropic key, Foundry), and the OpenRouter waterfall
// comes last. The fake lease source below stands in for the compute-token pool.

const SUB_FOUNDRY_URL = 'https://a-4989-resource.openai.azure.com/openai/v1/responses';

type ProviderLeg = 'ok' | 'limited' | 'revoked' | 'credits' | 'down';

function limitedResponse(): Response {
  return new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
    status: 429,
    // A five-hour usage window: too long to wait in place, so the leg rotates.
    headers: { 'Content-Type': 'application/json', 'retry-after': '18000' },
  });
}

function providerLegResponse(leg: ProviderLeg, okLines: string[]): Response {
  if (leg === 'ok') return sseResponse(okLines);
  if (leg === 'limited') return limitedResponse();
  if (leg === 'credits') return errorResponse(402, '{"error":{"type":"billing_error"}}');
  if (leg === 'down') return errorResponse(500, '{"error":{"type":"server_error"}}');
  return errorResponse(401, '{"error":{"type":"authentication_error"}}');
}

function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[name] ?? '';
}

/** Routes every provider by URL + credential and records the order it was called in. */
function installSubscriptionOrderStub(legs: {
  claude?: Record<string, ProviderLeg>;
  codex?: Record<string, ProviderLeg>;
  openAiKey?: ProviderLeg;
  anthropicKey?: ProviderLeg;
  foundry?: ProviderLeg;
}): string[] {
  const calls: string[] = [];
  installFetchStub((url, init) => {
    const bearer = headerOf(init, 'Authorization').replace(/^Bearer /, '');
    if (url === ANTHROPIC_API_URL && headerOf(init, 'x-api-key') !== '') {
      calls.push('anthropic-key');
      return providerLegResponse(legs.anthropicKey ?? 'limited', ANTHROPIC_OK_SSE);
    }
    if (url === ANTHROPIC_API_URL) {
      calls.push(`claude:${bearer}`);
      return providerLegResponse(legs.claude?.[bearer] ?? 'limited', ANTHROPIC_OK_SSE);
    }
    if (url === CODEX_API_URL) {
      calls.push(`codex:${bearer}`);
      return providerLegResponse(legs.codex?.[bearer] ?? 'limited', RESPONSES_OK_SSE);
    }
    if (url === OPENAI_RESPONSES_API_URL) {
      calls.push('openai-key');
      return providerLegResponse(legs.openAiKey ?? 'credits', RESPONSES_OK_SSE);
    }
    if (url === SUB_FOUNDRY_URL) {
      calls.push('foundry');
      return providerLegResponse(legs.foundry ?? 'down', RESPONSES_OK_SSE);
    }
    if (url === OPENROUTER_API_URL) {
      calls.push('openrouter');
      return sseResponse(OPENROUTER_OK_SSE);
    }
    throw new Error(`Unexpected provider URL: ${url}`);
  });
  return calls;
}

function fakeSubscriptionLeases(available: SubscriptionCredential[]) {
  const requests: Array<SubscriptionLeaseFailure | null> = [];
  const source: SubscriptionLeases = {
    async next(failure) {
      requests.push(failure);
      return available.shift() ?? null;
    },
  };
  return { source, requests };
}

async function withFundedCredentials(fn: () => Promise<void>): Promise<void> {
  await __resetGptApiKeyCooldown();
  await __resetAnthropicApiKeyCooldown();
  process.env.GPT_API_KEY = 'sk-proj-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test';
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://a-4989-resource.openai.azure.com';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-foundry-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-sol';
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  try {
    await fn();
  } finally {
    restoreFetch();
    delete process.env.GPT_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
    await __resetGptApiKeyCooldown();
    await __resetAnthropicApiKeyCooldown();
  }
}

async function ultraCompletion(options: Partial<Parameters<typeof createStreamingCompletion>[0]>) {
  return collect(
    await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'hi' }],
      ...options,
    })
  );
}

async function testSubscriptionFirst_healthyLeaseNeedsNoLeaseLookup() {
  await withFundedCredentials(async () => {
    const calls = installSubscriptionOrderStub({ claude: { 'claude-a': 'ok' } });
    const leases = fakeSubscriptionLeases([{ type: 'gpt', accessToken: 'codex-b' }]);
    const chunks = await ultraCompletion({
      claude_token: 'claude-a',
      subscription_leases: leases.source,
    });
    assertEqual(chunks[0].actual_model, 'claude-opus-5-5-claude', 'Claude lease served Opus');
    assertEqual(chunks[0].pool_name, 'claude-token', 'subscription route');
    assertEqual(JSON.stringify(calls), '["claude:claude-a"]', 'only the leased token was called');
    assertEqual(leases.requests.length, 0, 'success path makes no lease lookup');
  });
}

async function testSubscriptionFirst_limitedLeaseRotatesToFreeSubscriptionBeforePaidKeys() {
  await withFundedCredentials(async () => {
    const calls = installSubscriptionOrderStub({
      claude: { 'claude-a': 'limited' },
      codex: { 'codex-b': 'ok' },
      openAiKey: 'ok',
      anthropicKey: 'ok',
      foundry: 'ok',
    });
    const leases = fakeSubscriptionLeases([
      { type: 'gpt', accessToken: 'codex-b', accountId: 'acct-b' },
    ]);
    const chunks = await ultraCompletion({
      claude_token: 'claude-a',
      subscription_leases: leases.source,
    });
    assertEqual(chunks[0].actual_model, 'gpt-6.1-sol-gpt', 'second subscription served GPT-6 Sol');
    assertEqual(chunks[0].pool_name, 'gpt-token', 'subscription route');
    assertEqual(
      JSON.stringify(calls),
      '["claude:claude-a","codex:codex-b"]',
      'no funded key or waterfall was called'
    );
    assertEqual(leases.requests.length, 1, 'one rotation lookup');
    const failure = leases.requests[0];
    assertEqual(failure?.credential.accessToken, 'claude-a', 'failed lease reported');
    assertEqual(failure?.reason, 'rate_limit', 'usage limit classified');
    assert(
      failure?.rateLimitedUntil !== undefined &&
        Date.parse(failure.rateLimitedUntil) > Date.now() + 4 * 60 * 60 * 1000,
      "provider's own reset time reaches the mark"
    );
  });
}

async function testSubscriptionFirst_everySubscriptionBeforeEachPaidTier() {
  // All subscriptions limited: OpenAI key, then Anthropic key, then Foundry,
  // then the waterfall, each only after the one before it fails.
  const cases: Array<{
    legs: Parameters<typeof installSubscriptionOrderStub>[0];
    model: string;
    route: string;
    tail: string[];
  }> = [
    {
      legs: { openAiKey: 'ok' },
      model: 'gpt-6.1-sol-openai',
      route: 'openai-api-key',
      tail: ['openai-key'],
    },
    {
      legs: { openAiKey: 'credits', anthropicKey: 'ok' },
      model: 'claude-opus-5-5-anthropic',
      route: 'anthropic-apikey',
      tail: ['openai-key', 'anthropic-key'],
    },
    {
      legs: { openAiKey: 'credits', anthropicKey: 'credits', foundry: 'ok' },
      model: 'gpt-6-sol-foundry',
      route: 'foundry',
      tail: ['openai-key', 'anthropic-key', 'foundry'],
    },
    {
      // A Foundry 429 would stamp the shared deployment cooldown row; 500 falls through cleanly.
      legs: { openAiKey: 'credits', anthropicKey: 'credits', foundry: 'down' },
      model: 'openai/gpt-6.1-sol',
      route: 'rose-1-ultra',
      tail: ['openai-key', 'anthropic-key', 'foundry', 'openrouter'],
    },
  ];
  for (const testCase of cases) {
    await withFundedCredentials(async () => {
      const calls = installSubscriptionOrderStub({
        ...testCase.legs,
        claude: { 'claude-a': 'limited', 'claude-c': 'credits' },
        codex: { 'codex-b': 'limited' },
      });
      const leases = fakeSubscriptionLeases([
        { type: 'gpt', accessToken: 'codex-b' },
        { type: 'claude', accessToken: 'claude-c' },
      ]);
      const chunks = await ultraCompletion({
        claude_token: 'claude-a',
        subscription_leases: leases.source,
      });
      const served = chunks.find((chunk) => chunk.actual_model)?.actual_model;
      assert(served?.startsWith(testCase.model) === true, `${testCase.model} served (${served})`);
      assertEqual(chunks[0].pool_name, testCase.route, 'serving route');
      assertEqual(
        JSON.stringify(calls.slice(0, 3)),
        '["claude:claude-a","codex:codex-b","claude:claude-c"]',
        'all three subscriptions precede funded credentials'
      );
      // OpenRouter may try more than one waterfall model; the first is enough here.
      assertEqual(
        JSON.stringify(calls.slice(3, 3 + testCase.tail.length)),
        JSON.stringify(testCase.tail),
        'funded tiers in order'
      );
      assertEqual(leases.requests.length, 3, 'lookups stop when no lease remains');
      assertEqual(leases.requests[2]?.reason, 'rate_limit', 'out of credits rotates');
    });
  }
}

async function testSubscriptionFirst_revokedLeaseIsMarkedAndSkipped() {
  await withFundedCredentials(async () => {
    const calls = installSubscriptionOrderStub({
      claude: { 'claude-a': 'revoked', 'claude-c': 'ok' },
      openAiKey: 'ok',
    });
    const leases = fakeSubscriptionLeases([{ type: 'claude', accessToken: 'claude-c' }]);
    const chunks = await ultraCompletion({
      claude_token: 'claude-a',
      subscription_leases: leases.source,
    });
    assertEqual(chunks[0].actual_model, 'claude-opus-5-5-claude', 'next lease served');
    assertEqual(chunks[0].pool_name, 'claude-token', 'subscription route');
    assertEqual(leases.requests[0]?.reason, 'auth_error', 'revoked lease marked as auth_error');
    assertEqual(
      JSON.stringify(calls),
      '["claude:claude-a","claude:claude-c"]',
      'revoked lease skipped'
    );
  });
}

async function testSubscriptionFirst_tokenlessCallerLeasesOnceAndAbortStopsRotation() {
  await withFundedCredentials(async () => {
    const calls = installSubscriptionOrderStub({ codex: { 'codex-b': 'ok' } });
    const leases = fakeSubscriptionLeases([{ type: 'gpt', accessToken: 'codex-b' }]);
    const chunks = await ultraCompletion({ subscription_leases: leases.source });
    assertEqual(chunks[0].actual_model, 'gpt-6.1-sol-gpt', 'lazily leased subscription served');
    assertEqual(chunks[0].pool_name, 'gpt-token', 'subscription route');
    assertEqual(JSON.stringify(leases.requests), '[null]', 'exactly one first-lease lookup');
    assertEqual(JSON.stringify(calls), '["codex:codex-b"]', 'no funded key');
  });
  await withFundedCredentials(async () => {
    // The caller's deadline passes during the first leg: no rotation lookup follows.
    const calls = installSubscriptionOrderStub({
      claude: { 'claude-a': 'limited' },
      openAiKey: 'ok',
    });
    const controller = new AbortController();
    const routed = global.fetch;
    global.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      controller.abort();
      return routed(input, init);
    }) as typeof fetch;
    const leases = fakeSubscriptionLeases([{ type: 'gpt', accessToken: 'codex-b' }]);
    await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-ultra',
        messages: [{ role: 'user', content: 'hi' }],
        claude_token: 'claude-a',
        subscription_leases: leases.source,
        abort_signal: controller.signal,
      })
    ).catch(() => []);
    assertEqual(leases.requests.length, 0, 'no lease lookup after the deadline');
    assert(!calls.includes('codex:codex-b'), 'no subscription attempted after the deadline');
  });
}

async function testSubscriptionFirst_poolWithoutSubscriptionLegsNeverLeases() {
  await withFundedCredentials(async () => {
    installSubscriptionOrderStub({ foundry: 'ok' });
    const leases = fakeSubscriptionLeases([{ type: 'claude', accessToken: 'claude-a' }]);
    await collect(
      await createStreamingCompletion({
        model: 'rose-labs/rose-1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        subscription_leases: leases.source,
      })
    ).catch(() => []);
    assertEqual(leases.requests.length, 0, 'flash pool never consults the lease source');
  });
}

async function main(): Promise<void> {
  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'pool / isRoseModel variants', fn: testPool_isRoseModelVariants },
    { name: 'pool / poolForModel fuzzy', fn: testPool_forModelFuzzy },
    { name: 'local / loopback only', fn: testRoseLocalOnlyCallsLoopback },
    { name: 'pool / POOL_REGISTRY shape', fn: testPool_getPoolRegistryShape },
    { name: 'pool / unknown model throws', fn: testPool_unknownModelThrows },
    { name: 'claudeAuth / happy path', fn: testClaudeAuth_happyPath },
    {
      name: 'gptAuth / happy path uses Codex Responses',
      fn: testGptAuth_happyPathUsesCodexResponses,
    },
    {
      name: 'gptAuth / Codex 404 falls through to waterfall',
      fn: testGptAuth_codex404FallsThroughToWaterfall,
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
      name: 'claudeAuth / fable 5.1 downgrades forced tool_choice to auto',
      fn: testClaudeAuth_fable51DowngradesForcedToolChoice,
    },
    {
      name: 'claudeAuth / Haiku omits unsupported controls',
      fn: testClaudeAuth_haikuOmitsUnsupportedControls,
    },
    {
      name: 'claudeAuth / nullable relaxation keeps non-nullable fields required',
      fn: testAnthropic_nullableRelaxationPreservesNonNullableRequired,
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
      name: 'streaming / in-band credit exhaustion is payment required',
      fn: testStreaming_inBandCreditExhaustionIsPaymentRequired,
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
      name: 'claudeAuth / 429 carries provider reset window',
      fn: testClaudeAuth_429CarriesProviderResetWindow,
    },
    {
      name: 'claudeAuth / retry-after beyond cap rotates',
      fn: testClaudeAuth_retryAfterBeyondCapRotatesInsteadOfClipping,
    },
    {
      name: 'claudeAuth / retry-after within cap retries in place',
      fn: testClaudeAuth_retryAfterWithinCapStillRetriesInPlace,
    },
    {
      name: 'rateLimitReset / extraction branches',
      fn: testRateLimitReset_extractionBranches,
    },
    {
      name: 'claudeAuth / no token goes direct to waterfall',
      fn: testClaudeAuth_noTokenGoesDirectToWaterfall,
    },
    {
      name: 'flash / skips auth and hits Cerebras Qwen',
      fn: testFlash_skipsAuthAndHitsCerebrasQwen,
    },
    {
      name: 'flash / Cerebras failure falls to OpenRouter Qwen',
      fn: testFlash_cerebrasFailureFallsToOpenRouterQwen,
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
      name: 'openai api-key / insufficient quota cools later requests before Foundry',
      fn: testGptApiKey_insufficientQuotaCoolsLaterRequestsBeforeFoundry,
    },
    {
      name: 'responses / GPT-5.6+ cache markers become breakpoints',
      fn: testGpt56CacheMarkers_becomeResponsesBreakpoints,
    },
    {
      name: 'foundry / sends breakpoints and keeps reported zero cache writes',
      fn: testFoundry_sendsBreakpointsAndKeepsReportedZeroCacheWrites,
    },
    {
      name: 'responses / every completed user message is a breakpoint',
      fn: testResponsesBody_marksEveryCompletedUserMessage,
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
    {
      name: 'waterfall / body builders always stamp effort=xhigh',
      fn: testWaterfall_bodyBuildersAlwaysStampEffortXhigh,
    },
    {
      name: 'claudeAuth / omits effort for haiku (rose-1-mini)',
      fn: testClaudeAuth_omitsEffortForHaiku,
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
      name: 'client / response_format → output_config (effort=xhigh)',
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
    {
      name: 'subscription-first / healthy lease needs no lease lookup',
      fn: testSubscriptionFirst_healthyLeaseNeedsNoLeaseLookup,
    },
    {
      name: 'subscription-first / limited lease rotates to a free subscription before paid keys',
      fn: testSubscriptionFirst_limitedLeaseRotatesToFreeSubscriptionBeforePaidKeys,
    },
    {
      name: 'subscription-first / every subscription before OpenAI key, Anthropic key, Foundry, waterfall',
      fn: testSubscriptionFirst_everySubscriptionBeforeEachPaidTier,
    },
    {
      name: 'subscription-first / revoked lease is marked and skipped',
      fn: testSubscriptionFirst_revokedLeaseIsMarkedAndSkipped,
    },
    {
      name: 'subscription-first / tokenless caller leases once; deadline stops rotation',
      fn: testSubscriptionFirst_tokenlessCallerLeasesOnceAndAbortStopsRotation,
    },
    {
      name: 'subscription-first / pool without subscription legs never leases',
      fn: testSubscriptionFirst_poolWithoutSubscriptionLegsNeverLeases,
    },
  ];

  const nameFilter = process.env.ROSE_BLACKBOX_TEST_FILTER;
  const selectedTests = nameFilter
    ? tests.filter((test) => new RegExp(nameFilter).test(test.name))
    : tests;
  if (selectedTests.length === 0) throw new Error('No rose blackbox tests match the name filter');
  const results: TestResult[] = [];
  // Run sequentially — tests share process.env + global.fetch state.
  await withIsolatedFundedKeyCooldowns(async () => {
    for (const t of selectedTests) {
      const r = await runTest(t.name, t.fn);
      results.push(r);
      console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name} (${r.duration}ms)`);
      if (!r.passed) console.log(`    ${r.error}`);
    }
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('rose.blackbox runner crashed:', err);
  process.exit(1);
});
