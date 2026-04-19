#!/usr/bin/env tsx
/* eslint-disable no-console */
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

import {
  createStreamingCompletion,
  getPool,
  isRoseModel,
  POOL_REGISTRY,
  poolForModel,
  RoseAllFailed,
  type CompletionChunk,
} from '../../providers/rose';
import { transformSchemaForAnthropic } from '../../providers/rose/transforms';
import { ANTHROPIC_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';

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
  assert(lite.waterfall.length >= 1, 'lite.waterfall length');
  assertEqual(ultra.name, 'rose-1-ultra', 'ultra.name');
  assert(ultra.claudeAuthModel.startsWith('claude-'), 'ultra claudeAuthModel');
  assertEqual(browserUse.name, 'rose-1-browser-use', 'browserUse.name');
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

async function testClaudeAuth_noTokenGoesDirectToWaterfall() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
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
  const out = transformSchemaForAnthropic(input);
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
  const out = transformSchemaForAnthropic(input);
  assert(!('minimum' in out.anyOf[0]), 'anyOf[0].minimum stripped');
  assert(!('minLength' in out.anyOf[1]), 'anyOf[1].minLength stripped');
  assert(!('multipleOf' in out.oneOf[0]), 'oneOf[0].multipleOf stripped');
  assert(!('minItems' in out.allOf[0]), 'allOf[0].minItems stripped');
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
      name: 'claudeAuth / 401 falls through to waterfall',
      fn: testClaudeAuth_401FallsThroughToWaterfall,
    },
    {
      name: 'claudeAuth / 400 falls through (no retry)',
      fn: testClaudeAuth_400FallsThroughNoRetry,
    },
    {
      name: 'claudeAuth / no token goes direct to waterfall',
      fn: testClaudeAuth_noTokenGoesDirectToWaterfall,
    },
    { name: 'waterfall / first 500 → second succeeds', fn: testWaterfall_firstFailsSecondSucceeds },
    { name: 'waterfall / all fail → RoseAllFailed', fn: testWaterfall_allFailRaisesRoseAllFailed },
    {
      name: 'transforms / strip unsupported schema keywords',
      fn: testTransforms_stripUnsupportedSchemaKeywords,
    },
    { name: 'transforms / anyOf/oneOf/allOf recursed', fn: testTransforms_anyOfOneOfAllOfRecursed },
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
