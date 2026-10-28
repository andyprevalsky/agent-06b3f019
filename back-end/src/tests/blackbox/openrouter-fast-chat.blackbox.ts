#!/usr/bin/env tsx
/**
 * Black-box tests for the GLM failover branch of synchronous chat
 * (`openrouterFastRoute.ts`) and the direct-Cerebras route that arms it.
 *
 * The e8f2279b recurrence
 * (docs/rca/cases/2026-09-30-chat-router-finaltext-killed-create-on-empty-failover.md)
 * left a live miss with no record: the router's attempt bound aborted the GLM
 * request before any SSE event, so no branch-failure log fired and no host was
 * reported. Every failover request now ends with one `openrouter_fast_chat.end`
 * record. These cases pin what that record says for each way a request ends,
 * and that a caller abort stops the route instead of starting the waterfall it
 * abandoned.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/openrouter-fast-chat.blackbox.ts
 */

import assert from 'node:assert/strict';

import { DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS } from '../../providers/chat/routerCompletionDeadline';
import {
  createStreamingCompletion,
  RoseStallError,
  type CompletionChunk,
} from '../../providers/rose';
import { OPENROUTER_CEREBRAS_MODEL } from '../../providers/rose/openrouterCerebrasRoute';
import {
  buildOpenRouterFastChatBody,
  exclusiveOpenRouterFastChatCompletion,
  OPENROUTER_FAST_CHAT_MODEL,
} from '../../providers/rose/openrouterFastRoute';
import { parseOpenAISSE } from '../../providers/rose/streaming';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import type { CompletionOptions } from '../../providers/rose/types';

const ROUTER_DEADLINE_MESSAGE = `Chat router completion exceeded ${DEFAULT_CHAT_ROUTER_COMPLETION_TIMEOUT_MS}ms`;

const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'CEREBRAS_API_KEY',
  'GPT_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CEREBRAS_CHAT_IDLE_TIMEOUT_MS',
  'CEREBRAS_CHAT_HEDGE_MS',
  'OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS',
] as const;

type LogRecord = Record<string, unknown> & { message: string };

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const PRETTY_LINE = /^\[[^\]]+\] \w+ \[[^\]]+\] (\S+)(.*)$/;

function parseLogValue(raw: string): unknown {
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

/** Reads both logger formats: JSON in production, `key=value` in dev. */
function parseLogLine(line: string): LogRecord | null {
  const text = line.replace(ANSI_PATTERN, '').trim();
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text) as LogRecord;
    } catch {
      return null;
    }
  }
  const match = PRETTY_LINE.exec(text);
  if (!match) return null;
  const record: LogRecord = { message: match[1] };
  for (const pair of match[2].trim().split(/ (?=[a-z_]+=)/)) {
    const separator = pair.indexOf('=');
    if (separator > 0) record[pair.slice(0, separator)] = parseLogValue(pair.slice(separator + 1));
  }
  return record;
}

async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: LogRecord[] }> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    return { result, logs: captured.split('\n').flatMap((line) => parseLogLine(line) ?? []) };
  } finally {
    process.stdout.write = original;
  }
}

function endRecord(logs: LogRecord[], requestId: string): LogRecord {
  const records = logs.filter(
    (record) => record.message === 'openrouter_fast_chat.end' && record.request_id === requestId
  );
  assert.equal(
    records.length,
    1,
    `expected one end record for ${requestId}, got ${records.length}`
  );
  return records[0];
}

function errorOnAbort(
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal?: AbortSignal | null
) {
  if (!signal) return;
  if (signal.aborted) controller.error(signal.reason);
  else signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
}

/** Headers arrive at once; the body never emits and fails only on abort. */
function silentStream(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({ start: (c) => errorOnAbort(c, signal) });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** The provider never answers: the fetch settles only when its signal aborts. */
function headersNeverArrive(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

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

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(requestUrl(input), init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ROUTER_OPTIONS: CompletionOptions = {
  messages: [
    { role: 'system', content: 'route this turn' },
    { role: 'user', content: 'wrong address, its the 88 harlow one' },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'router_decision', strict: true, schema: { type: 'object' } },
  },
};

/** Drain the GLM route with a caller signal that aborts after `abortAfterMs`. */
async function runFastChat(requestId: string, abortAfterMs?: number): Promise<unknown> {
  const caller = new AbortController();
  const timer =
    abortAfterMs === undefined
      ? undefined
      : setTimeout(() => caller.abort(new Error(ROUTER_DEADLINE_MESSAGE)), abortAfterMs);
  try {
    for await (const chunk of exclusiveOpenRouterFastChatCompletion({
      options: { ...ROUTER_OPTIONS, abort_signal: caller.signal },
      openrouterKey: 'blackbox-openrouter-key',
      requestId,
      callSite: 'router',
    })) {
      void chunk;
    }
    return null;
  } catch (error) {
    return error;
  } finally {
    clearTimeout(timer);
  }
}

async function testRoutesEachRequestByLiveLatency(): Promise<void> {
  const body = buildOpenRouterFastChatBody(ROUTER_OPTIONS, 'req-attempt-1');
  const regenerate = buildOpenRouterFastChatBody(ROUTER_OPTIONS, 'req-attempt-2');
  assert.ok(
    typeof body.session_id === 'string' && body.session_id.length > 0,
    'failover must name its own OpenRouter session instead of the conversation-derived one'
  );
  assert.notEqual(
    body.session_id,
    regenerate.session_id,
    'a router regenerate must not reuse the session of the attempt it replaces'
  );
  const provider = body.provider as Record<string, unknown> | undefined;
  assert.equal(
    provider?.sort,
    'latency',
    'Cerebras-stall failover must not ride price-weighted routing to the slowest GLM hosts'
  );
  assert.deepEqual(
    provider?.preferred_min_throughput,
    { p50: 80 },
    'latency ranking must still prefer hosts fast enough to stream the structured reply'
  );
  assert.deepEqual(
    provider?.ignore,
    ['friendli', 'inference-net'],
    'hosts that missed the live router completion bound or emit strict-schema keys out of declared order (deciding the router action last) must be excluded'
  );
  assert.equal(
    provider?.require_parameters,
    true,
    'failover must only reach GLM hosts that honor response_format'
  );
  assert.ok(
    provider?.order === undefined && provider?.only === undefined,
    'failover must follow the live latency ranking, not a fixed GLM host list'
  );
  assert.notEqual(
    provider?.allow_fallbacks,
    false,
    'failover must still reach another GLM host when the fastest errors'
  );
}

async function testParserReportsUpstreamProviderOnce(): Promise<void> {
  const lines = [
    'data: {"provider":"InferenceNet","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
    '',
    'data: {"provider":"InferenceNet","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ];
  const providers: string[] = [];
  const body = sseResponse(lines).body;
  assert.ok(body);
  for await (const chunk of parseOpenAISSE(body, {
    actualModel: 'or-test',
    poolName: 'openrouter-fast-chat',
    requestId: 'r-or-provider',
    onUpstreamProvider: (provider) => providers.push(provider),
  })) {
    void chunk;
  }
  assert.deepEqual(providers, ['InferenceNet'], 'the serving host is reported once per stream');
}

async function testCallerAbortBeforeHeadersIsRecorded(): Promise<void> {
  const { result: error, logs } = await withFetch(
    (_url, init) => headersNeverArrive(init?.signal),
    {},
    () => captureLogs(() => runFastChat('req-no-headers', 60))
  );
  assert.ok(error, 'a caller abort must surface to the caller');
  const end = endRecord(logs, 'req-no-headers');
  assert.equal(end.end, 'caller_aborted');
  assert.equal(end.status, undefined, 'no HTTP status arrived');
  assert.equal(end.headers_ms, undefined, 'no response headers arrived');
  assert.equal(end.first_event_ms, undefined);
  assert.ok(
    String(end.abort_reason).includes(ROUTER_DEADLINE_MESSAGE),
    `the record must name the bound that aborted it: ${JSON.stringify(end)}`
  );
}

async function testCallerAbortAfterHeadersWithNoEventIsRecorded(): Promise<void> {
  const { result: error, logs } = await withFetch(
    (_url, init) => silentStream(init?.signal),
    {},
    () => captureLogs(() => runFastChat('req-no-event', 80))
  );
  assert.ok(error, 'a caller abort must surface to the caller');
  const end = endRecord(logs, 'req-no-event');
  assert.equal(end.end, 'caller_aborted');
  assert.equal(end.status, 200);
  assert.equal(
    typeof end.headers_ms,
    'number',
    `headers time must be recorded: ${JSON.stringify(end)}`
  );
  assert.equal(end.provider, undefined, 'OpenRouter names the host only on an SSE event');
  assert.equal(end.first_event_ms, undefined);
  assert.equal(end.first_content_ms, undefined);
  const headers = logs.find(
    (record) => record.message === 'openrouter.headers' && record.request_id === 'req-no-event'
  );
  assert.equal(headers?.status, 200, 'the transport must log when headers arrived');
}

async function testServedStreamRecordsHostAndTiming(): Promise<void> {
  const lines = [
    'data: {"provider":"Parasail","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
    '',
    'data: {"provider":"Parasail","choices":[{"index":0,"delta":{"reasoning":"address fix"}}]}',
    '',
    'data: {"provider":"Parasail","choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ];
  const { result: error, logs } = await withFetch(
    () => sseResponse(lines),
    {},
    () => captureLogs(() => runFastChat('req-served'))
  );
  assert.equal(error, null, `a served stream must not throw: ${String(error)}`);
  const end = endRecord(logs, 'req-served');
  assert.equal(end.end, 'completed');
  assert.equal(end.status, 200);
  assert.equal(end.provider, 'Parasail');
  const firstEvent = Number(end.first_event_ms);
  const firstOutput = Number(end.first_output_ms);
  const firstContent = Number(end.first_content_ms);
  assert.ok(
    firstEvent <= firstOutput && firstOutput <= firstContent,
    `event, output and content timings must be ordered: ${JSON.stringify(end)}`
  );
  assert.equal(end.abort_reason, undefined);
}

async function testOwnGuardRecordsNoOutputTimeout(): Promise<void> {
  const { result: error, logs } = await withFetch(
    (_url, init) => silentStream(init?.signal),
    { OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS: '100' },
    () => captureLogs(() => runFastChat('req-guard'))
  );
  assert.ok(error instanceof RoseStallError, `the GLM guard must raise a stall: ${String(error)}`);
  const end = endRecord(logs, 'req-guard');
  assert.equal(end.end, 'no_output_timeout');
  assert.equal(end.status, 200);
  assert.equal(end.abort_reason, undefined, 'the caller did not abort');
}

/**
 * The 07:06 live-miss shape: direct Cerebras stalls, the Qwen spill and GLM
 * both answer 200 and then send nothing, and the router's attempt bound aborts
 * the turn. The route must stop there; the GLM end record must say why.
 */
async function testCallerAbortStopsTheChatRouteBeforeTheWaterfall(): Promise<void> {
  const openRouter: Array<{ model: string; atMs: number }> = [];
  const caller = new AbortController();
  let startedAt = 0;
  let abortedAtMs = Number.POSITIVE_INFINITY;
  const abortAfterMs = 400;

  const { result: error, logs } = await withFetch(
    (url, init) => {
      if (url === CEREBRAS_API_URL) return silentStream(init?.signal);
      if (url !== OPENROUTER_API_URL) throw new Error(`chat route leaked to ${url}`);
      const model = String((JSON.parse(String(init?.body)) as { model?: string }).model);
      openRouter.push({ model, atMs: Date.now() - startedAt });
      return silentStream(init?.signal);
    },
    {
      OPENROUTER_API_KEY: 'blackbox-openrouter-key',
      CEREBRAS_API_KEY: 'blackbox-cerebras-key',
      CEREBRAS_CHAT_IDLE_TIMEOUT_MS: '150',
      CEREBRAS_CHAT_HEDGE_MS: '50',
    },
    () =>
      captureLogs(async () => {
        startedAt = Date.now();
        const timer = setTimeout(() => {
          abortedAtMs = Date.now() - startedAt;
          caller.abort(new Error(ROUTER_DEADLINE_MESSAGE));
        }, abortAfterMs);
        try {
          const stream = await createStreamingCompletion({
            model: 'rose-labs/rose-1-flash',
            messages: ROUTER_OPTIONS.messages,
            response_format: ROUTER_OPTIONS.response_format,
            provider_route: 'direct-cerebras',
            abort_signal: caller.signal,
          });
          for await (const chunk of stream as AsyncIterable<CompletionChunk>) void chunk;
          return null;
        } catch (thrown) {
          return thrown;
        } finally {
          clearTimeout(timer);
        }
      })
  );

  assert.ok(error, 'an aborted turn must surface to the router, not return silence as success');
  const models = openRouter.map((request) => request.model);
  assert.ok(models.includes(OPENROUTER_FAST_CHAT_MODEL), `GLM must have raced: ${models}`);
  assert.ok(
    models.includes(OPENROUTER_CEREBRAS_MODEL),
    `the Qwen spill must have raced: ${models}`
  );
  const afterAbort = openRouter.filter((request) => request.atMs >= abortedAtMs);
  assert.deepEqual(
    afterAbort,
    [],
    'no provider request may start after the caller aborted (the abandoned waterfall)'
  );
  assert.equal(
    logs.some((record) => record.message === 'cerebras_chat.pre_content_failover_to_waterfall'),
    false,
    'an aborted turn must not log a failover to the waterfall'
  );
  const glmEnds = logs.filter((record) => record.message === 'openrouter_fast_chat.end');
  assert.equal(glmEnds.length, 1, `one GLM request, one end record: ${JSON.stringify(glmEnds)}`);
  assert.equal(glmEnds[0].end, 'caller_aborted');
  assert.equal(glmEnds[0].status, 200);
  assert.equal(glmEnds[0].first_event_ms, undefined);
  assert.ok(String(glmEnds[0].abort_reason).includes(ROUTER_DEADLINE_MESSAGE));
}

const CASES: Array<[string, () => Promise<void>]> = [
  [
    'routes each request by live latency to response_format hosts',
    testRoutesEachRequestByLiveLatency,
  ],
  ['the SSE parser reports the serving host once', testParserReportsUpstreamProviderOnce],
  ['records a caller abort before response headers', testCallerAbortBeforeHeadersIsRecorded],
  [
    'records a caller abort after headers with no SSE event',
    testCallerAbortAfterHeadersWithNoEventIsRecorded,
  ],
  [
    'records the serving host and first event/output/content timing',
    testServedStreamRecordsHostAndTiming,
  ],
  ['records its own no-output guard', testOwnGuardRecordsNoOutputTimeout],
  [
    'a caller abort stops the chat route before the waterfall',
    testCallerAbortStopsTheChatRouteBeforeTheWaterfall,
  ],
];

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, run] of CASES) {
    const started = Date.now();
    try {
      await run();
      process.stdout.write(`PASS  ${name} (${Date.now() - started}ms)\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `FAIL  ${name}\n  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
    }
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed}/${CASES.length} openrouter-fast-chat cases failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\nPASS openrouter-fast-chat (${CASES.length} cases)\n`);
}

void main();
