/**
 * Unit tests for the benchmark-production domain.
 *
 * Covers:
 *   - Config env reads (BASE_URL, ROSE_API_KEY)
 *   - Repo boundary: postBenchmark (HTTP), saveResults (filesystem)
 *   - Service orchestration: runBenchmarkSuite iterates (model × benchmark × cot)
 *   - Runtime CLI handler: missing ROSE_API_KEY → exit 1, happy path → exit 0,
 *     fatal error → exit 1, CLI arg parsing
 *
 * The domain has no HTTP handler (CLI tool), so the equivalent of "CORS
 * preflight" here is the validation path (missing credentials / bad flags).
 * All boundary calls (fetch, filesystem, stdout/stderr) are stubbed via a
 * captured-deps bundle so tests complete in milliseconds with zero network
 * and zero disk access.
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.190.0/testing/asserts.ts';

import {
  BENCHMARK_SEED,
  DEFAULT_BASE_URL,
  DEFAULT_BENCHMARKS,
  DEFAULT_COT_STEPS,
  DEFAULT_MODELS,
  DEFAULT_SAMPLES,
  getBaseUrl,
  getRoseApiKey,
  RESULTS_DIR,
  RESULTS_FILE,
} from '../domains/benchmark-production/config.ts';
import { postBenchmark, saveResults } from '../domains/benchmark-production/repo.ts';
import { runBenchmarkSuite } from '../domains/benchmark-production/service.ts';
import {
  createHandler,
  MISSING_API_KEY_EXIT_CODE,
  parseOptions,
} from '../domains/benchmark-production/runtime.ts';
import type {
  BenchmarkProductionDeps,
  BenchmarkRunResult,
  BenchmarkSuiteOptions,
} from '../domains/benchmark-production/types.ts';

// ---------------------------------------------------------------------------
// Env hygiene helpers
//
// Tests below override BASE_URL / ROSE_API_KEY. Snapshot the originals at
// module import and register an unload listener so we restore host state on
// process exit. Tests use restoreEnv() in their finally blocks instead of
// Deno.env.delete() so a host-provided value survives mutation.
// ---------------------------------------------------------------------------

const ENV_KEYS_UNDER_TEST = ['BASE_URL', 'ROSE_API_KEY'] as const;
const ENV_ORIGINALS: Record<string, string | undefined> = {};
for (const key of ENV_KEYS_UNDER_TEST) {
  ENV_ORIGINALS[key] = Deno.env.get(key);
}

function restoreEnv(key: string): void {
  const prior = ENV_ORIGINALS[key];
  if (prior === undefined) Deno.env.delete(key);
  else Deno.env.set(key, prior);
}

globalThis.addEventListener('unload', () => {
  for (const key of ENV_KEYS_UNDER_TEST) restoreEnv(key);
});

// ---------------------------------------------------------------------------
// Boundary capture stub
// ---------------------------------------------------------------------------

type Capture =
  | { type: 'fetch'; url: string; method: string; headers: Record<string, string>; body: unknown }
  | { type: 'mkdir'; path: string; recursive: boolean }
  | { type: 'writeTextFile'; path: string; data: string }
  | { type: 'log'; args: unknown[] }
  | { type: 'error'; args: unknown[] };

interface StubConfig {
  /** Responses returned by fetch, in order. */
  fetchResponses?: Array<{ ok: boolean; status: number; body: unknown }>;
  /** If set, mkdir rejects with this error. */
  mkdirError?: Error;
  captures: Capture[];
}

function makeDeps(config: StubConfig): BenchmarkProductionDeps {
  const responses = config.fetchResponses ?? [];
  let fetchIdx = 0;
  // deno-lint-ignore no-explicit-any
  const fetchStub = (input: any, init: any): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const method = init?.method ?? 'GET';
    const headersObj: Record<string, string> = {};
    if (init?.headers) {
      const hdrs = new Headers(init.headers);
      hdrs.forEach((v: string, k: string) => {
        headersObj[k] = v;
      });
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    config.captures.push({ type: 'fetch', url, method, headers: headersObj, body });

    const next = responses[fetchIdx++] ?? { ok: false, status: 500, body: {} };
    const response = new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
    return Promise.resolve(response);
  };
  return {
    fetch: fetchStub as typeof fetch,
    mkdir: (path, options) => {
      config.captures.push({ type: 'mkdir', path, recursive: options.recursive });
      if (config.mkdirError) return Promise.reject(config.mkdirError);
      return Promise.resolve();
    },
    writeTextFile: (path, data) => {
      config.captures.push({ type: 'writeTextFile', path, data });
      return Promise.resolve();
    },
    log: (...args: unknown[]) => {
      config.captures.push({ type: 'log', args });
    },
    error: (...args: unknown[]) => {
      config.captures.push({ type: 'error', args });
    },
  };
}

function makeResult(
  overrides: Partial<BenchmarkRunResult> = {},
): BenchmarkRunResult {
  return {
    accuracy: 87.5,
    durationSeconds: 42,
    totalCostCents: 150,
    industryComparison: { position: 'above-average' },
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<BenchmarkSuiteOptions> = {},
): BenchmarkSuiteOptions {
  return {
    baseUrl: 'http://api.test',
    apiKey: 'test-key',
    models: ['rose-1-lite'],
    benchmarks: ['mmlu-pro'],
    cotSteps: [1],
    samples: 10,
    ...overrides,
  };
}

// ============================================================================
// config.ts
// ============================================================================

Deno.test('config: getBaseUrl returns BASE_URL env when set', () => {
  Deno.env.set('BASE_URL', 'https://custom.api');
  try {
    assertEquals(getBaseUrl(), 'https://custom.api');
  } finally {
    restoreEnv('BASE_URL');
  }
});

Deno.test('config: getBaseUrl falls back to DEFAULT_BASE_URL when unset', () => {
  restoreEnv('BASE_URL');
  assertEquals(getBaseUrl(), DEFAULT_BASE_URL);
});

Deno.test('config: getRoseApiKey returns ROSE_API_KEY env when set', () => {
  Deno.env.set('ROSE_API_KEY', 'secret-123');
  try {
    assertEquals(getRoseApiKey(), 'secret-123');
  } finally {
    restoreEnv('ROSE_API_KEY');
  }
});

Deno.test('config: getRoseApiKey returns empty string when unset', () => {
  restoreEnv('ROSE_API_KEY');
  assertEquals(getRoseApiKey(), '');
});

Deno.test('config: defaults are stable (smoke)', () => {
  assertEquals(DEFAULT_MODELS, 'rose-labs/rose-1-lite,rose-labs/rose-1-ultra');
  assertEquals(DEFAULT_BENCHMARKS, 'mmlu-pro,terminal-bench');
  assertEquals(DEFAULT_COT_STEPS, '1,3,5');
  assertEquals(DEFAULT_SAMPLES, '100');
  assertEquals(BENCHMARK_SEED, 42);
  assertEquals(RESULTS_DIR, './results');
  assertEquals(RESULTS_FILE, './results/benchmark_results.json');
});

// ============================================================================
// repo.ts — postBenchmark
// ============================================================================

Deno.test('postBenchmark: posts JSON payload with x-api-key header', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [{ ok: true, status: 200, body: makeResult() }],
    captures,
  });

  const result = await postBenchmark(deps, {
    baseUrl: 'http://api.test',
    apiKey: 'key-abc',
    benchmark: 'mmlu-pro',
    model: 'rose-1-lite',
    cotSteps: 3,
    samples: 50,
  });

  const fetchCapture = captures.find((c) => c.type === 'fetch');
  assertExists(fetchCapture);
  assertEquals(fetchCapture!.type, 'fetch');
  if (fetchCapture!.type !== 'fetch') throw new Error('unreachable');
  assertEquals(fetchCapture.url, 'http://api.test/rose/bench');
  assertEquals(fetchCapture.method, 'POST');
  assertEquals(fetchCapture.headers['content-type'], 'application/json');
  assertEquals(fetchCapture.headers['x-api-key'], 'key-abc');
  assertEquals(fetchCapture.body, {
    benchmark: 'mmlu-pro',
    model: 'rose-1-lite',
    cotSteps: 3,
    samples: 50,
    seed: BENCHMARK_SEED,
  });
  assertEquals(result.accuracy, 87.5);
});

Deno.test('postBenchmark: throws on non-OK response', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [{ ok: false, status: 429, body: { error: 'rate limit' } }],
    captures,
  });

  let caught: Error | null = null;
  try {
    await postBenchmark(deps, {
      baseUrl: 'http://api.test',
      apiKey: 'k',
      benchmark: 'mmlu-pro',
      model: 'rose-1-lite',
      cotSteps: 1,
      samples: 10,
    });
  } catch (err) {
    caught = err as Error;
  }
  assertExists(caught);
  assertEquals(caught!.message, 'Benchmark failed: 429');
});

// ============================================================================
// repo.ts — saveResults
// ============================================================================

Deno.test('saveResults: creates results dir then writes pretty-printed JSON', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({ captures });

  const results = [makeResult({ accuracy: 91.2 })];
  await saveResults(deps, results);

  assertEquals(captures.length, 2);
  assertEquals(captures[0].type, 'mkdir');
  if (captures[0].type !== 'mkdir') throw new Error('unreachable');
  assertEquals(captures[0].path, RESULTS_DIR);
  assertEquals(captures[0].recursive, true);

  assertEquals(captures[1].type, 'writeTextFile');
  if (captures[1].type !== 'writeTextFile') throw new Error('unreachable');
  assertEquals(captures[1].path, RESULTS_FILE);
  // Pretty printed with 2-space indent
  assertEquals(captures[1].data, JSON.stringify(results, null, 2));
});

Deno.test('saveResults: propagates mkdir errors', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    captures,
    mkdirError: new Error('EACCES'),
  });

  let caught: Error | null = null;
  try {
    await saveResults(deps, []);
  } catch (err) {
    caught = err as Error;
  }
  assertExists(caught);
  assertEquals(caught!.message, 'EACCES');
  // writeTextFile must NOT be called after mkdir fails
  assertEquals(captures.filter((c) => c.type === 'writeTextFile').length, 0);
});

// ============================================================================
// service.ts — runBenchmarkSuite
// ============================================================================

Deno.test('runBenchmarkSuite: happy path runs single combo and saves result', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [{ ok: true, status: 200, body: makeResult() }],
    captures,
  });

  await runBenchmarkSuite(deps, baseOptions());

  const fetches = captures.filter((c) => c.type === 'fetch');
  assertEquals(fetches.length, 1);

  const writes = captures.filter((c) => c.type === 'writeTextFile');
  assertEquals(writes.length, 1);
  if (writes[0].type !== 'writeTextFile') throw new Error('unreachable');
  const saved = JSON.parse(writes[0].data) as BenchmarkRunResult[];
  assertEquals(saved.length, 1);
  assertEquals(saved[0].accuracy, 87.5);
});

Deno.test('runBenchmarkSuite: iterates full cartesian product (2×2×2 = 8)', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: new Array(8).fill(0).map(() => ({
      ok: true,
      status: 200,
      body: makeResult(),
    })),
    captures,
  });

  await runBenchmarkSuite(
    deps,
    baseOptions({
      models: ['rose-1-lite', 'rose-1-ultra'],
      benchmarks: ['mmlu-pro', 'terminal-bench'],
      cotSteps: [1, 3],
      samples: 5,
    }),
  );

  const fetches = captures.filter((c) => c.type === 'fetch');
  assertEquals(fetches.length, 8);

  // Verify ordering: outermost loop is models, then benchmarks, then cotSteps
  const combos = fetches.map((c) => {
    if (c.type !== 'fetch') throw new Error('unreachable');
    const body = c.body as Record<string, unknown>;
    return `${body.model}|${body.benchmark}|${body.cotSteps}`;
  });
  assertEquals(combos, [
    'rose-1-lite|mmlu-pro|1',
    'rose-1-lite|mmlu-pro|3',
    'rose-1-lite|terminal-bench|1',
    'rose-1-lite|terminal-bench|3',
    'rose-1-ultra|mmlu-pro|1',
    'rose-1-ultra|mmlu-pro|3',
    'rose-1-ultra|terminal-bench|1',
    'rose-1-ultra|terminal-bench|3',
  ]);
});

Deno.test('runBenchmarkSuite: failures are skipped, suite continues', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [
      { ok: true, status: 200, body: makeResult({ accuracy: 10 }) },
      { ok: false, status: 500, body: {} },
      { ok: true, status: 200, body: makeResult({ accuracy: 30 }) },
    ],
    captures,
  });

  await runBenchmarkSuite(
    deps,
    baseOptions({ models: ['m1', 'm2', 'm3'] }),
  );

  // 3 fetches attempted
  assertEquals(captures.filter((c) => c.type === 'fetch').length, 3);

  // Only 2 successful results persisted
  const writes = captures.filter((c) => c.type === 'writeTextFile');
  assertEquals(writes.length, 1);
  if (writes[0].type !== 'writeTextFile') throw new Error('unreachable');
  const saved = JSON.parse(writes[0].data) as BenchmarkRunResult[];
  assertEquals(saved.length, 2);
  assertEquals(saved.map((r) => r.accuracy), [10, 30]);

  // Error was logged via deps.error (not deps.log)
  const errors = captures.filter((c) => c.type === 'error');
  assertEquals(errors.length, 1);
});

Deno.test('runBenchmarkSuite: save still happens when every run fails', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [{ ok: false, status: 500, body: {} }],
    captures,
  });

  await runBenchmarkSuite(deps, baseOptions());

  const writes = captures.filter((c) => c.type === 'writeTextFile');
  assertEquals(writes.length, 1);
  if (writes[0].type !== 'writeTextFile') throw new Error('unreachable');
  assertEquals(writes[0].data, '[]');
});

Deno.test('runBenchmarkSuite: logs header with options + final save line', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [{ ok: true, status: 200, body: makeResult() }],
    captures,
  });

  await runBenchmarkSuite(deps, baseOptions({ models: ['m1'], benchmarks: ['b1'] }));

  const logs = captures
    .filter((c) => c.type === 'log')
    .map((c) => (c.type === 'log' ? String(c.args[0] ?? '') : ''));

  // Header lines rendered
  const joined = logs.join('\n');
  assertEquals(joined.includes('ROSE MODEL BENCHMARK SUITE'), true);
  assertEquals(joined.includes('Models: m1'), true);
  assertEquals(joined.includes('Benchmarks: b1'), true);
  // Final save-confirmation line
  assertEquals(joined.includes(`✓ Results saved to ${RESULTS_FILE}`), true);
});

Deno.test('runBenchmarkSuite: position icon — above-leader renders as ★', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [
      {
        ok: true,
        status: 200,
        body: makeResult({ industryComparison: { position: 'above-leader' } }),
      },
    ],
    captures,
  });

  await runBenchmarkSuite(deps, baseOptions());

  const logged = captures.some((c) =>
    c.type === 'log' && typeof c.args[0] === 'string' && c.args[0].startsWith('★')
  );
  assertEquals(logged, true);
});

Deno.test('runBenchmarkSuite: position icon — above-average renders as ↑', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [
      {
        ok: true,
        status: 200,
        body: makeResult({ industryComparison: { position: 'above-average' } }),
      },
    ],
    captures,
  });

  await runBenchmarkSuite(deps, baseOptions());

  const logged = captures.some((c) =>
    c.type === 'log' && typeof c.args[0] === 'string' && c.args[0].startsWith('↑')
  );
  assertEquals(logged, true);
});

Deno.test('runBenchmarkSuite: position icon — other positions render as ↓', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [
      {
        ok: true,
        status: 200,
        body: makeResult({ industryComparison: { position: 'below-average' } }),
      },
    ],
    captures,
  });

  await runBenchmarkSuite(deps, baseOptions());

  const logged = captures.some((c) =>
    c.type === 'log' && typeof c.args[0] === 'string' && c.args[0].startsWith('↓')
  );
  assertEquals(logged, true);
});

Deno.test('runBenchmarkSuite: boundary ordering — all fetches precede mkdir+write', async () => {
  const captures: Capture[] = [];
  const deps = makeDeps({
    fetchResponses: [
      { ok: true, status: 200, body: makeResult() },
      { ok: true, status: 200, body: makeResult() },
    ],
    captures,
  });

  await runBenchmarkSuite(
    deps,
    baseOptions({ benchmarks: ['a', 'b'] }),
  );

  const types = captures
    .filter((c) => c.type === 'fetch' || c.type === 'mkdir' || c.type === 'writeTextFile')
    .map((c) => c.type);

  assertEquals(types, ['fetch', 'fetch', 'mkdir', 'writeTextFile']);
});

// ============================================================================
// runtime.ts — parseOptions
// ============================================================================

Deno.test('parseOptions: returns null when ROSE_API_KEY is missing', () => {
  restoreEnv('ROSE_API_KEY');
  assertEquals(parseOptions([]), null);
});

Deno.test('parseOptions: returns options with defaults when no flags passed', () => {
  Deno.env.set('ROSE_API_KEY', 'k');
  restoreEnv('BASE_URL');
  try {
    const opts = parseOptions([]);
    assertExists(opts);
    assertEquals(opts!.apiKey, 'k');
    assertEquals(opts!.baseUrl, DEFAULT_BASE_URL);
    assertEquals(opts!.models, DEFAULT_MODELS.split(','));
    assertEquals(opts!.benchmarks, DEFAULT_BENCHMARKS.split(','));
    assertEquals(opts!.cotSteps, [1, 3, 5]);
    assertEquals(opts!.samples, 100);
  } finally {
    restoreEnv('ROSE_API_KEY');
  }
});

Deno.test('parseOptions: CLI flags override defaults', () => {
  Deno.env.set('ROSE_API_KEY', 'k');
  Deno.env.set('BASE_URL', 'http://override.test');
  try {
    const opts = parseOptions([
      '--models',
      'm1,m2',
      '--benchmarks',
      'b1',
      '--cot',
      '2,4',
      '--samples',
      '25',
    ]);
    assertExists(opts);
    assertEquals(opts!.baseUrl, 'http://override.test');
    assertEquals(opts!.models, ['m1', 'm2']);
    assertEquals(opts!.benchmarks, ['b1']);
    assertEquals(opts!.cotSteps, [2, 4]);
    assertEquals(opts!.samples, 25);
  } finally {
    restoreEnv('ROSE_API_KEY');
    restoreEnv('BASE_URL');
  }
});

// ============================================================================
// runtime.ts — createHandler
// ============================================================================

Deno.test('createHandler: missing ROSE_API_KEY → exit code 1, error log, no fetch', async () => {
  restoreEnv('ROSE_API_KEY');
  const captures: Capture[] = [];
  const handler = createHandler(makeDeps({ captures }));

  const code = await handler([]);
  assertEquals(code, MISSING_API_KEY_EXIT_CODE);
  assertEquals(MISSING_API_KEY_EXIT_CODE, 1);

  // No boundary calls other than the error log
  assertEquals(captures.filter((c) => c.type === 'fetch').length, 0);
  assertEquals(captures.filter((c) => c.type === 'mkdir').length, 0);
  assertEquals(captures.filter((c) => c.type === 'writeTextFile').length, 0);
  const errors = captures.filter((c) => c.type === 'error');
  assertEquals(errors.length, 1);
  if (errors[0].type !== 'error') throw new Error('unreachable');
  assertEquals(errors[0].args[0], '❌ Error: ROSE_API_KEY required');
});

Deno.test('createHandler: happy path → exit code 0 and results saved', async () => {
  Deno.env.set('ROSE_API_KEY', 'k');
  Deno.env.set('BASE_URL', 'http://api.test');
  try {
    const captures: Capture[] = [];
    const handler = createHandler(
      makeDeps({
        fetchResponses: [{ ok: true, status: 200, body: makeResult() }],
        captures,
      }),
    );

    const code = await handler([
      '--models',
      'm1',
      '--benchmarks',
      'b1',
      '--cot',
      '1',
      '--samples',
      '5',
    ]);

    assertEquals(code, 0);
    const fetches = captures.filter((c) => c.type === 'fetch');
    assertEquals(fetches.length, 1);
    if (fetches[0].type !== 'fetch') throw new Error('unreachable');
    assertEquals(fetches[0].url, 'http://api.test/rose/bench');

    const writes = captures.filter((c) => c.type === 'writeTextFile');
    assertEquals(writes.length, 1);
  } finally {
    restoreEnv('ROSE_API_KEY');
    restoreEnv('BASE_URL');
  }
});

Deno.test('createHandler: fatal error (mkdir failure) → exit code 1 + error log', async () => {
  Deno.env.set('ROSE_API_KEY', 'k');
  try {
    const captures: Capture[] = [];
    const handler = createHandler(
      makeDeps({
        fetchResponses: [{ ok: true, status: 200, body: makeResult() }],
        mkdirError: new Error('ENOSPC'),
        captures,
      }),
    );

    const code = await handler(['--models', 'm1', '--benchmarks', 'b1', '--cot', '1']);
    assertEquals(code, 1);

    const errors = captures.filter((c) => c.type === 'error');
    // First entry is the "Fatal error:" log
    assertEquals(errors.length, 1);
    if (errors[0].type !== 'error') throw new Error('unreachable');
    assertEquals(errors[0].args[0], 'Fatal error:');
  } finally {
    restoreEnv('ROSE_API_KEY');
  }
});

// ============================================================================
// Invariants
// ============================================================================

Deno.test('invariant: every fetch sends seed=BENCHMARK_SEED', async () => {
  Deno.env.set('ROSE_API_KEY', 'k');
  try {
    const captures: Capture[] = [];
    const handler = createHandler(
      makeDeps({
        fetchResponses: [
          { ok: true, status: 200, body: makeResult() },
          { ok: true, status: 200, body: makeResult() },
        ],
        captures,
      }),
    );

    await handler([
      '--models',
      'm1',
      '--benchmarks',
      'b1,b2',
      '--cot',
      '1',
      '--samples',
      '3',
    ]);

    const fetches = captures.filter((c) => c.type === 'fetch');
    assertEquals(fetches.length, 2);
    for (const f of fetches) {
      if (f.type !== 'fetch') throw new Error('unreachable');
      const body = f.body as Record<string, unknown>;
      assertEquals(body.seed, BENCHMARK_SEED);
    }
  } finally {
    restoreEnv('ROSE_API_KEY');
  }
});

Deno.test('invariant: results JSON shape is preserved end-to-end', async () => {
  Deno.env.set('ROSE_API_KEY', 'k');
  try {
    const result = makeResult({
      accuracy: 65.4,
      durationSeconds: 120,
      totalCostCents: 999,
      industryComparison: { position: 'above-leader' },
    });
    const captures: Capture[] = [];
    const handler = createHandler(
      makeDeps({
        fetchResponses: [{ ok: true, status: 200, body: result }],
        captures,
      }),
    );

    await handler(['--models', 'm1', '--benchmarks', 'b1', '--cot', '1']);

    const write = captures.find((c) => c.type === 'writeTextFile');
    assertExists(write);
    if (write!.type !== 'writeTextFile') throw new Error('unreachable');
    const saved = JSON.parse(write!.data) as BenchmarkRunResult[];
    assertEquals(saved.length, 1);
    assertEquals(saved[0], result);
  } finally {
    restoreEnv('ROSE_API_KEY');
  }
});

Deno.test('invariant: boundary call-count scales linearly with combos', async () => {
  Deno.env.set('ROSE_API_KEY', 'k');
  try {
    const captures: Capture[] = [];
    const handler = createHandler(
      makeDeps({
        fetchResponses: new Array(6).fill(0).map(() => ({
          ok: true,
          status: 200,
          body: makeResult(),
        })),
        captures,
      }),
    );

    // 1 × 2 × 3 = 6 combos
    await handler([
      '--models',
      'm1',
      '--benchmarks',
      'b1,b2',
      '--cot',
      '1,2,3',
    ]);

    assertEquals(captures.filter((c) => c.type === 'fetch').length, 6);
    assertEquals(captures.filter((c) => c.type === 'mkdir').length, 1);
    assertEquals(captures.filter((c) => c.type === 'writeTextFile').length, 1);
  } finally {
    restoreEnv('ROSE_API_KEY');
  }
});
