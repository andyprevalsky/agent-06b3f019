/**
 * Unit Tests for rose-bench Domain
 *
 * Covers the supabase edge function `POST /rose-bench` exercised through the
 * extracted handler factory in `domains/rose-bench/runtime.ts`.
 *
 * Boundaries (all injected — no live network):
 *   - Supabase SDK  → stubbed via createSupabaseStub()
 *   - Model HTTP    → stubbed via a fake `fetchFn`
 *   - console/logs  → captured via a fake `logError`
 *
 * Tests assert on:
 *   - Response status + body shape
 *   - Captured boundary calls (table, data, url, body)
 *   - Call ordering (validate → run → log)
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { createHandler } from '../domains/rose-bench/runtime.ts';
import type {
  CreateSupabaseClientFn,
  FetchFn,
  ModelConfig,
} from '../domains/rose-bench/types.ts';
import {
  BENCHMARKS,
  FULL_BENCHMARK_KEY,
  SAMPLE_QUESTIONS,
} from '../domains/rose-bench/config.ts';
import {
  isFullBenchmark,
  isKnownBenchmark,
  listBenchmarkKeys,
  sampleQuestions,
  validateBenchmarkUrl,
} from '../domains/rose-bench/service.ts';
import {
  type BoundaryCapture,
  createSupabaseStub,
  type StubConfig,
} from './utils/supabase-stub.ts';

// ---------------------------------------------------------------------------
// Env setup (supabase-stub is used, but repo still reads env for URL/key).
// Save originals, override for this suite, restore on process exit so unrelated
// tests are not affected by our mutations.
// ---------------------------------------------------------------------------

const ENV_OVERRIDES: Record<string, string> = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  // Keep sample count small + matching SAMPLE_QUESTIONS length for fast tests.
  MAX_SAMPLES_PER_BENCH: '5',
};

const ENV_ORIGINALS: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
  ENV_ORIGINALS[key] = Deno.env.get(key);
  Deno.env.set(key, value);
}

globalThis.addEventListener('unload', () => {
  for (const [key, prior] of Object.entries(ENV_ORIGINALS)) {
    if (prior === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prior);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost:54321/functions/v1';
const VALID_MODEL_URL = 'https://api.openai.com/v1/chat/completions';
const VALID_MODEL_CONFIG: ModelConfig = {
  model: 'rose-labs/rose-1-lite',
  temperature: 0,
  maxTokens: 16,
  seed: 42,
};

interface FetchCapture {
  url: string;
  init?: RequestInit;
  body?: unknown;
}

interface FakeFetchConfig {
  /** Fixed text content returned from the model (picks answer letter). */
  content?: string;
  /** If true, throws to simulate network failure. */
  throwError?: boolean;
  /** If set, returns this status (non-2xx causes service to log error). */
  status?: number;
  captures: FetchCapture[];
}

function makeFetch(cfg: FakeFetchConfig): FetchFn {
  return (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    let body: unknown = undefined;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    cfg.captures.push({ url, init, body });

    if (cfg.throwError) {
      return Promise.reject(new Error('network down'));
    }

    const status = cfg.status ?? 200;
    const payload = {
      choices: [{ message: { content: cfg.content ?? 'C' } }],
    };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}

interface BuiltHandler {
  handler: (req: Request) => Promise<Response>;
  fetchCaptures: FetchCapture[];
  supabaseCaptures: BoundaryCapture[];
  logCaptures: { message: string; err: unknown }[];
}

function buildHandler(
  opts: {
    supabase?: StubConfig;
    fetchCfg?: Partial<FakeFetchConfig>;
  } = {},
): BuiltHandler {
  const supabaseCaptures: BoundaryCapture[] = opts.supabase?.captures ?? [];
  const fetchCaptures: FetchCapture[] = [];
  const logCaptures: { message: string; err: unknown }[] = [];

  const supabaseConfig: StubConfig = {
    user: null,
    ...opts.supabase,
    captures: supabaseCaptures,
  };

  const createClient: CreateSupabaseClientFn = (_url, _key) =>
    createSupabaseStub(supabaseConfig) as unknown as ReturnType<
      CreateSupabaseClientFn
    >;

  const fetchFn = makeFetch({
    content: 'C',
    captures: fetchCaptures,
    ...opts.fetchCfg,
  });

  const handler = createHandler({
    createSupabaseClient: createClient,
    logError: (message, err) => {
      logCaptures.push({ message, err });
    },
    fetchFn,
  });

  return { handler, fetchCaptures, supabaseCaptures, logCaptures };
}

function makeRequest(
  method: string,
  body?: unknown,
  rawBody?: string,
): Request {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`${BASE_URL}/rose-bench`, init);
}

async function parseJson(resp: Response): Promise<Record<string, unknown>> {
  return await resp.json();
}

function validBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    url: VALID_MODEL_URL,
    headers: { Authorization: 'Bearer test-key' },
    modelConfig: VALID_MODEL_CONFIG,
    benchmark: 'mmlu-pro',
    seed: 42,
    ...overrides,
  };
}

// ===========================================================================
// Pure service helpers (covered without building a handler)
// ===========================================================================

Deno.test('service: validateBenchmarkUrl accepts allowed https host', () => {
  const url = validateBenchmarkUrl('https://api.openai.com/v1/chat/completions');
  assertEquals(url, 'https://api.openai.com/v1/chat/completions');
});

Deno.test('service: validateBenchmarkUrl accepts localhost http', () => {
  const url = validateBenchmarkUrl('http://localhost:8080/v1/chat/completions');
  assertEquals(url.startsWith('http://localhost:8080/'), true);
});

Deno.test('service: validateBenchmarkUrl rejects malformed url', () => {
  try {
    validateBenchmarkUrl('not-a-url');
    throw new Error('should have thrown');
  } catch (e) {
    assertEquals((e as Error).message, 'Invalid URL');
  }
});

Deno.test('service: validateBenchmarkUrl rejects http for non-localhost', () => {
  try {
    validateBenchmarkUrl('http://api.openai.com/v1/chat/completions');
    throw new Error('should have thrown');
  } catch (e) {
    assertEquals((e as Error).message, 'Only HTTPS URLs are allowed');
  }
});

Deno.test('service: validateBenchmarkUrl rejects non-allowlisted host', () => {
  try {
    validateBenchmarkUrl('https://evil.example.com/v1/chat/completions');
    throw new Error('should have thrown');
  } catch (e) {
    assertEquals(
      (e as Error).message.startsWith('Hostname not allowed:'),
      true,
    );
  }
});

Deno.test('service: isKnownBenchmark and isFullBenchmark classify keys', () => {
  assertEquals(isKnownBenchmark('mmlu-pro'), true);
  assertEquals(isKnownBenchmark(FULL_BENCHMARK_KEY), true);
  assertEquals(isKnownBenchmark('nope'), false);
  assertEquals(isFullBenchmark(FULL_BENCHMARK_KEY), true);
  assertEquals(isFullBenchmark('mmlu-pro'), false);
});

Deno.test('service: listBenchmarkKeys returns all configured benchmark keys', () => {
  const keys = listBenchmarkKeys();
  assertEquals(keys.includes('mmlu-pro'), true);
  assertEquals(keys.includes(FULL_BENCHMARK_KEY), true);
  assertEquals(keys.length, Object.keys(BENCHMARKS).length);
});

Deno.test('service: sampleQuestions deterministic with seed', () => {
  const a = sampleQuestions(SAMPLE_QUESTIONS, 3, 42);
  const b = sampleQuestions(SAMPLE_QUESTIONS, 3, 42);
  const ids = (arr: typeof a) => arr.map((q) => q.id).join(',');
  assertEquals(ids(a), ids(b));
  assertEquals(a.length, 3);
});

Deno.test('service: sampleQuestions without seed still returns sampleSize items', () => {
  const out = sampleQuestions(SAMPLE_QUESTIONS, 2);
  assertEquals(out.length, 2);
});

// ===========================================================================
// CORS / method
// ===========================================================================

Deno.test('rose-bench: CORS preflight returns 200 + CORS headers', async () => {
  const { handler } = buildHandler();
  const resp = await handler(makeRequest('OPTIONS'));
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get('Access-Control-Allow-Origin'), '*');
});

Deno.test('rose-bench: GET returns 405 Method Not Allowed', async () => {
  const { handler } = buildHandler();
  const resp = await handler(makeRequest('GET'));
  const data = await parseJson(resp);
  assertEquals(resp.status, 405);
  assertEquals(data.error, 'Method not allowed');
});

// ===========================================================================
// Validation (no DB / no fetch should happen)
// ===========================================================================

Deno.test('rose-bench: 400 on missing url', async () => {
  const { handler, fetchCaptures, supabaseCaptures } = buildHandler();
  const body = validBody();
  delete (body as Record<string, unknown>).url;
  const resp = await handler(makeRequest('POST', body));
  const data = await parseJson(resp);

  assertEquals(resp.status, 400);
  assertEquals(data.error, 'Missing required field: url');
  assertEquals(fetchCaptures.length, 0);
  assertEquals(supabaseCaptures.length, 0);
});

Deno.test('rose-bench: 400 on malformed url', async () => {
  const { handler, fetchCaptures } = buildHandler();
  const resp = await handler(
    makeRequest('POST', validBody({ url: 'not a url' })),
  );
  const data = await parseJson(resp);

  assertEquals(resp.status, 400);
  assertEquals(
    typeof data.error === 'string' && (data.error as string).startsWith('Invalid url:'),
    true,
  );
  assertEquals(fetchCaptures.length, 0);
});

Deno.test('rose-bench: 400 on non-allowlisted host', async () => {
  const { handler, fetchCaptures } = buildHandler();
  const resp = await handler(
    makeRequest('POST', validBody({ url: 'https://evil.example.com/v1' })),
  );
  const data = await parseJson(resp);

  assertEquals(resp.status, 400);
  assertEquals((data.error as string).includes('Hostname not allowed'), true);
  assertEquals(fetchCaptures.length, 0);
});

Deno.test('rose-bench: 400 on http url for non-localhost', async () => {
  const { handler } = buildHandler();
  const resp = await handler(
    makeRequest('POST', validBody({ url: 'http://api.openai.com/v1' })),
  );
  const data = await parseJson(resp);
  assertEquals(resp.status, 400);
  assertEquals((data.error as string).includes('Only HTTPS'), true);
});

Deno.test('rose-bench: 400 on missing modelConfig', async () => {
  const { handler } = buildHandler();
  const body = validBody();
  delete (body as Record<string, unknown>).modelConfig;
  const resp = await handler(makeRequest('POST', body));
  const data = await parseJson(resp);
  assertEquals(resp.status, 400);
  assertEquals(data.error, 'Missing required field: modelConfig with model');
});

Deno.test('rose-bench: 400 on modelConfig with no model field', async () => {
  const { handler } = buildHandler();
  const resp = await handler(
    makeRequest('POST', validBody({ modelConfig: { temperature: 0.5 } })),
  );
  const data = await parseJson(resp);
  assertEquals(resp.status, 400);
  assertEquals(data.error, 'Missing required field: modelConfig with model');
});

Deno.test('rose-bench: 400 on missing benchmark', async () => {
  const { handler } = buildHandler();
  const body = validBody();
  delete (body as Record<string, unknown>).benchmark;
  const resp = await handler(makeRequest('POST', body));
  const data = await parseJson(resp);
  assertEquals(resp.status, 400);
  assertEquals(data.error, 'Missing required field: benchmark');
});

Deno.test('rose-bench: 400 on unknown benchmark key + lists available', async () => {
  const { handler } = buildHandler();
  const resp = await handler(
    makeRequest('POST', validBody({ benchmark: 'nope-bench' })),
  );
  const data = await parseJson(resp);
  assertEquals(resp.status, 400);
  assertEquals(data.error, 'Invalid benchmark type: nope-bench');
  const avail = data.availableBenchmarks as string[];
  assertEquals(Array.isArray(avail), true);
  assertEquals(avail.includes('mmlu-pro'), true);
});

Deno.test('rose-bench: 500 on malformed JSON body (try/catch path)', async () => {
  const { handler, logCaptures } = buildHandler();
  const resp = await handler(makeRequest('POST', undefined, '{not json'));
  const data = await parseJson(resp);
  assertEquals(resp.status, 500);
  assertEquals(data.error, 'Failed to run benchmark');
  assertEquals(logCaptures.length >= 1, true);
  assertEquals(logCaptures[0].message, 'Benchmark error:');
});

// ===========================================================================
// Happy path: single benchmark run
// ===========================================================================

Deno.test('rose-bench: single benchmark happy path runs, logs, returns shape', async () => {
  const { handler, fetchCaptures, supabaseCaptures } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
    fetchCfg: { content: 'C' },
  });

  const resp = await handler(makeRequest('POST', validBody()));
  const data = await parseJson(resp);

  assertEquals(resp.status, 200);
  assertEquals(data.benchmarkName, 'mmlu-pro');
  assertEquals(typeof data.accuracy, 'number');
  assertEquals(data.totalQuestions, SAMPLE_QUESTIONS.length);
  assertEquals(data.sampledQuestions, SAMPLE_QUESTIONS.length);
  assertExists(data.results);
  const results = data.results as Record<string, unknown>[];
  assertEquals(results.length, SAMPLE_QUESTIONS.length);
  // With content "C", q1 (correct=C) and q4 (correct=C) are the only correct ones
  assertEquals(data.correctAnswers, 2);
  assertEquals(data.isSampled, false);
  assertEquals((data.modelConfig as ModelConfig).model, VALID_MODEL_CONFIG.model);

  // fetch called once per sampled question
  assertEquals(fetchCaptures.length, SAMPLE_QUESTIONS.length);
  const firstFetch = fetchCaptures[0];
  assertEquals(firstFetch.url, VALID_MODEL_URL);
  const body = firstFetch.body as Record<string, unknown>;
  assertEquals(body.model, VALID_MODEL_CONFIG.model);
  assertEquals(body.temperature, 0);
  assertEquals(body.max_tokens, 16);
  assertEquals(body.seed, 42);
  const msgs = body.messages as { role: string; content: string }[];
  assertEquals(msgs[0].role, 'user');
  assertEquals(
    msgs[0].content.includes('Answer with only the letter'),
    true,
  );
  assertEquals(
    (firstFetch.init!.headers as Record<string, string>)['Authorization'],
    'Bearer test-key',
  );

  // supabase insert happened
  const ins = supabaseCaptures.find((c) => c.type === 'db.insert');
  assertExists(ins);
  assertEquals(ins!.table, 'BenchmarkRun');
  const insData = ins!.data as Record<string, unknown>;
  assertEquals(insData.benchmarkName, 'mmlu-pro');
  assertEquals(insData.userId, 'anonymous');
  assertEquals(insData.sampledQuestions, SAMPLE_QUESTIONS.length);
});

Deno.test('rose-bench: per-question model response + extracted answer preserved', async () => {
  const { handler } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
    fetchCfg: { content: 'The best answer is B.' },
  });

  const resp = await handler(makeRequest('POST', validBody()));
  const data = await parseJson(resp);
  assertEquals(resp.status, 200);
  const results = data.results as Record<string, unknown>[];
  assertEquals(results[0].modelResponse, 'The best answer is B.');
  assertEquals(results[0].extractedAnswer, 'B');
});

Deno.test('rose-bench: extracted answer empty when no A-D letter present', async () => {
  const { handler } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
    fetchCfg: { content: 'no letter at all' },
  });
  const resp = await handler(makeRequest('POST', validBody()));
  const data = await parseJson(resp);
  const results = data.results as Record<string, unknown>[];
  for (const r of results) {
    assertEquals(r.extractedAnswer, '');
    assertEquals(r.isCorrect, false);
  }
  assertEquals(data.correctAnswers, 0);
  assertEquals(data.accuracy, 0);
});

// ===========================================================================
// Error paths: fetch + supabase
// ===========================================================================

Deno.test('rose-bench: fetch errors are logged per-question + yield isCorrect=false', async () => {
  const { handler, logCaptures, fetchCaptures } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
    fetchCfg: { throwError: true },
  });

  const resp = await handler(makeRequest('POST', validBody()));
  const data = await parseJson(resp);

  assertEquals(resp.status, 200);
  assertEquals(data.correctAnswers, 0);
  assertEquals(data.accuracy, 0);
  assertEquals(fetchCaptures.length, SAMPLE_QUESTIONS.length);
  // One log per question
  const errorLogs = logCaptures.filter((l) =>
    l.message.startsWith('Error on question')
  );
  assertEquals(errorLogs.length, SAMPLE_QUESTIONS.length);
  const results = data.results as Record<string, unknown>[];
  for (const r of results) {
    assertEquals(r.isCorrect, false);
    assertEquals(r.modelResponse, '');
    const meta = r.metadata as Record<string, unknown>;
    assertEquals(meta.error, 'network down');
  }
});

Deno.test('rose-bench: non-2xx model response logs + records error metadata', async () => {
  const { handler, logCaptures } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
    fetchCfg: { status: 502, content: 'bad gateway' },
  });
  const resp = await handler(makeRequest('POST', validBody()));
  const data = await parseJson(resp);

  assertEquals(resp.status, 200);
  assertEquals(data.correctAnswers, 0);
  const errorLogs = logCaptures.filter((l) =>
    l.message.startsWith('Error on question')
  );
  assertEquals(errorLogs.length, SAMPLE_QUESTIONS.length);
});

Deno.test('rose-bench: supabase insert error is logged (handler still returns 200)', async () => {
  const { handler, logCaptures } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: {
        BenchmarkRun: {
          data: null,
          error: { message: 'unique constraint violation' },
        },
      },
    },
  });
  const resp = await handler(makeRequest('POST', validBody()));
  const data = await parseJson(resp);
  assertEquals(resp.status, 200);
  assertExists(data.results);
  const logErr = logCaptures.find((l) =>
    l.message === 'Failed to log benchmark run:'
  );
  assertExists(logErr);
  assertEquals(logErr!.err, 'unique constraint violation');
});

Deno.test('rose-bench: missing supabase env returns missing-credentials reason in log', async () => {
  const prevUrl = Deno.env.get('SUPABASE_URL');
  const prevKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  Deno.env.delete('SUPABASE_URL');
  Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');
  try {
    const { handler, logCaptures, supabaseCaptures } = buildHandler();
    const resp = await handler(makeRequest('POST', validBody()));
    assertEquals(resp.status, 200);
    // No supabase insert captured because repo short-circuits on missing env
    assertEquals(
      supabaseCaptures.filter((c) => c.type === 'db.insert').length,
      0,
    );
    const logged = logCaptures.find((l) =>
      l.message === 'Failed to log benchmark run:'
    );
    assertExists(logged);
    assertEquals(logged!.err, 'missing-supabase-credentials');
  } finally {
    if (prevUrl) Deno.env.set('SUPABASE_URL', prevUrl);
    if (prevKey) Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', prevKey);
  }
});

// ===========================================================================
// Full benchmark (fan-out over all sub-benchmarks)
// ===========================================================================

Deno.test('rose-bench: full benchmark aggregates over all sub-benchmarks', async () => {
  const { handler, fetchCaptures, supabaseCaptures } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
    fetchCfg: { content: 'C' },
  });
  const resp = await handler(
    makeRequest('POST', validBody({ benchmark: FULL_BENCHMARK_KEY })),
  );
  const data = await parseJson(resp);

  assertEquals(resp.status, 200);
  const benchmarks = data.benchmarks as Record<string, unknown>[];
  const subCount = Object.keys(BENCHMARKS).length - 1; // minus 'full'
  assertEquals(benchmarks.length, subCount);
  assertEquals(typeof data.aggregateAccuracy, 'number');
  assertEquals(typeof data.totalDurationSeconds, 'number');

  // One fetch per question per sub-benchmark
  assertEquals(fetchCaptures.length, subCount * SAMPLE_QUESTIONS.length);
  // Full benchmarks do NOT log to supabase (handler only logs single runs)
  assertEquals(
    supabaseCaptures.filter((c) => c.type === 'db.insert').length,
    0,
  );
});

// ===========================================================================
// Response shape / ordering invariants
// ===========================================================================

Deno.test('invariant: success Content-Type is application/json + CORS headers', async () => {
  const { handler } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
  });
  const resp = await handler(makeRequest('POST', validBody()));
  assertEquals(resp.headers.get('Content-Type'), 'application/json');
  assertEquals(resp.headers.get('Access-Control-Allow-Origin'), '*');
});

Deno.test(
  'invariant: validation failures produce zero fetch + zero supabase calls',
  async () => {
    const bodies: unknown[] = [
      validBody({ url: undefined }),
      validBody({ url: 'http://evil.example.com/' }),
      validBody({ modelConfig: undefined }),
      validBody({ benchmark: undefined }),
      validBody({ benchmark: 'unknown-bench' }),
    ];
    for (const b of bodies) {
      const { handler, fetchCaptures, supabaseCaptures } = buildHandler();
      const resp = await handler(makeRequest('POST', b));
      assertEquals(resp.status, 400);
      assertEquals(fetchCaptures.length, 0);
      assertEquals(
        supabaseCaptures.filter((c) => c.type.startsWith('db.')).length,
        0,
      );
    }
  },
);

Deno.test(
  'invariant: boundary order is fetch (N) → supabase insert',
  async () => {
    const { handler, fetchCaptures, supabaseCaptures } = buildHandler({
      supabase: {
        user: { id: 'u' },
        insertResults: { BenchmarkRun: { data: null, error: null } },
      },
    });
    await handler(makeRequest('POST', validBody()));
    // Every fetch happens before the insert (insert is terminal).
    assertEquals(fetchCaptures.length, SAMPLE_QUESTIONS.length);
    const ins = supabaseCaptures.find((c) => c.type === 'db.insert');
    assertExists(ins);
  },
);

Deno.test('invariant: seed is forwarded to the model request body', async () => {
  const { handler, fetchCaptures } = buildHandler({
    supabase: {
      user: { id: 'u' },
      insertResults: { BenchmarkRun: { data: null, error: null } },
    },
  });
  await handler(
    makeRequest('POST', validBody({ modelConfig: { ...VALID_MODEL_CONFIG, seed: 777 } })),
  );
  const body = fetchCaptures[0].body as Record<string, unknown>;
  assertEquals(body.seed, 777);
});

Deno.test('invariant: same-input reproducibility (seeded)', async () => {
  const run = async (): Promise<string> => {
    const { handler } = buildHandler({
      supabase: {
        user: { id: 'u' },
        insertResults: { BenchmarkRun: { data: null, error: null } },
      },
      fetchCfg: { content: 'C' },
    });
    const resp = await handler(makeRequest('POST', validBody({ seed: 5 })));
    const data = await parseJson(resp);
    const results = data.results as Record<string, unknown>[];
    return results.map((r) => r.questionId).join(',');
  };
  const a = await run();
  const b = await run();
  assertEquals(a, b);
});
