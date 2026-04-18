/**
 * Unit tests for the benchmark-runner domain.
 *
 * Covers four logical groupings:
 *   - MMLU-Pro harness (formatPrompt / extractAnswer / evaluateAnswer / runBenchmark)
 *   - Terminal-Bench harness (repetition loop detection + keyword eval)
 *   - Repetition service (pure functions)
 *   - Suite orchestration (service.runBenchmarkSuite + service.createHarness)
 *   - Runtime (createHandler, buildCliConfig, env validation)
 *   - Config + repo (env readers, callModel cost math, error propagation)
 *
 * Boundaries:
 *   - `callModelFn` is injected into every harness so no HTTP happens.
 *   - `repo.callModel` is tested with a stubbed `fetch` restored in finally.
 *   - The CLI runtime is tested via `createHandler(deps)` stubs
 *     (`getEnv`, `logger`, `exit`, `callModelFn`).
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';

import type { ModelCallParams } from '../domains/benchmark-runner/repo.ts';
import type {
  BenchmarkQuestion,
  BenchmarkSuiteResults,
  ModelCallResult,
  TestConfig,
} from '../domains/benchmark-runner/types.ts';
import { callModel } from '../domains/benchmark-runner/repo.ts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_URL,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_SEED,
  readApiKeyEnv,
  readMaxSamplesEnv,
  readModelUrlEnv,
} from '../domains/benchmark-runner/config.ts';
import {
  type CallModelFn,
  sampleQuestionsDeterministic,
} from '../domains/benchmark-runner/service-harness.ts';
import { MMLUProHarness } from '../domains/benchmark-runner/service-mmlu-pro.ts';
import { TerminalBenchHarness } from '../domains/benchmark-runner/service-terminal-bench.ts';
import {
  analyzeRepetition,
  checkRepetition,
  messageSimilarity,
  RepetitionChecker,
} from '../domains/benchmark-runner/service-repetition.ts';
import { createHarness, runBenchmarkSuite } from '../domains/benchmark-runner/service.ts';
import { buildCliConfig, createHandler } from '../domains/benchmark-runner/runtime.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CallCapture {
  params: ModelCallParams;
}

/** Build a stub `callModelFn` that returns fixed content and records calls. */
function makeStubCallModel(
  responder: (p: ModelCallParams) => ModelCallResult | Promise<ModelCallResult>,
): { fn: CallModelFn; captures: CallCapture[] } {
  const captures: CallCapture[] = [];
  const fn: CallModelFn = async (params) => {
    captures.push({ params });
    return await responder(params);
  };
  return { fn, captures };
}

function okResponse(content: string, cost = 0): ModelCallResult {
  return { response: content, cost };
}

/** Temporarily replace global fetch for a callback, then restore. */
async function withFetch<T>(
  impl: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Silence stdout/stderr during a callback. Keeps the test log clean. */
async function silentConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

// ============================================================================
// config.ts — env readers + constants
// ============================================================================

Deno.test('config: readModelUrlEnv returns MODEL_URL when set', () => {
  Deno.env.set('MODEL_URL', 'http://stub-model/completions');
  try {
    assertEquals(readModelUrlEnv(), 'http://stub-model/completions');
  } finally {
    Deno.env.delete('MODEL_URL');
  }
});

Deno.test('config: readModelUrlEnv falls back to DEFAULT_MODEL_URL', () => {
  Deno.env.delete('MODEL_URL');
  assertEquals(readModelUrlEnv(), DEFAULT_MODEL_URL);
});

Deno.test('config: readApiKeyEnv returns API_KEY when set', () => {
  Deno.env.set('API_KEY', 'stub-api-key');
  try {
    assertEquals(readApiKeyEnv(), 'stub-api-key');
  } finally {
    Deno.env.delete('API_KEY');
  }
});

Deno.test('config: readApiKeyEnv returns empty string when unset', () => {
  Deno.env.delete('API_KEY');
  assertEquals(readApiKeyEnv(), '');
});

Deno.test('config: readMaxSamplesEnv parses a valid integer', () => {
  Deno.env.set('MAX_SAMPLES_PER_BENCH', '7');
  try {
    assertEquals(readMaxSamplesEnv(), 7);
  } finally {
    Deno.env.delete('MAX_SAMPLES_PER_BENCH');
  }
});

Deno.test('config: readMaxSamplesEnv returns undefined when unset', () => {
  Deno.env.delete('MAX_SAMPLES_PER_BENCH');
  assertEquals(readMaxSamplesEnv(), undefined);
});

Deno.test('config: readMaxSamplesEnv rejects non-numeric values', () => {
  Deno.env.set('MAX_SAMPLES_PER_BENCH', 'not-a-number');
  try {
    assertEquals(readMaxSamplesEnv(), undefined);
  } finally {
    Deno.env.delete('MAX_SAMPLES_PER_BENCH');
  }
});

// ============================================================================
// repo.ts — callModel
// ============================================================================

Deno.test('repo.callModel: sends OpenAI-shaped body + x-api-key header', async () => {
  let capturedRequest: Request | undefined;
  await withFetch(
    (input, init) => {
      capturedRequest = new Request(input as string, init);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'answer!' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    },
    async () => {
      const result = await callModel({
        url: 'http://test/completions',
        apiKey: 'key-abc',
        prompt: 'hello',
      });
      assertEquals(result.response, 'answer!');
      // cost = ceil((10 * 0.00005 + 20 * 0.00015) * 100) = ceil(0.35) = 1 cent
      assertEquals(result.cost, 1);
    },
  );

  assertExists(capturedRequest);
  assertEquals(capturedRequest!.method, 'POST');
  assertEquals(capturedRequest!.headers.get('x-api-key'), 'key-abc');
  const body = await capturedRequest!.json();
  assertEquals(body.model, 'rose-labs/rose');
  assertEquals(body.messages[0].content, 'hello');
  assertEquals(body.max_tokens, DEFAULT_MAX_TOKENS);
  assertEquals(typeof body.cot_steps, 'number');
});

Deno.test('repo.callModel: uses overrides for temperature/max_tokens/cot_steps', async () => {
  let body: Record<string, unknown> | undefined;
  await withFetch(
    (_input, init) => {
      body = JSON.parse((init as RequestInit).body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '' } }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { status: 200 },
        ),
      );
    },
    async () => {
      await callModel({
        url: 'http://x',
        apiKey: 'k',
        prompt: 'p',
        temperature: 0.1,
        maxTokens: 42,
        cotSteps: 5,
      });
    },
  );
  assertEquals(body!.temperature, 0.1);
  assertEquals(body!.max_tokens, 42);
  assertEquals(body!.cot_steps, 5);
});

Deno.test('repo.callModel: throws on non-OK response', async () => {
  await withFetch(
    () => Promise.resolve(new Response('boom', { status: 500 })),
    async () => {
      await assertRejects(
        () => callModel({ url: 'http://x', apiKey: 'k', prompt: 'p' }),
        Error,
        'Model API error: 500',
      );
    },
  );
});

Deno.test('repo.callModel: handles missing content and usage fields gracefully', async () => {
  const result = await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({}), { status: 200 }),
      ),
    () => callModel({ url: 'http://x', apiKey: 'k', prompt: 'p' }),
  );
  assertEquals(result.response, '');
  assertEquals(result.cost, 0);
});

// ============================================================================
// service-repetition.ts — pure algorithms
// ============================================================================

Deno.test('repetition: checkRepetition returns false when too few messages', () => {
  assertEquals(checkRepetition([]), false);
  assertEquals(checkRepetition(['a', 'a', 'a']), false); // minRepetitions=3 → need 4+
});

Deno.test('repetition: checkRepetition detects identical repeats', async () => {
  await silentConsole(() => {
    const result = checkRepetition(['same words', 'same words', 'same words', 'same words']);
    assertEquals(result, true);
    return Promise.resolve();
  });
});

Deno.test('repetition: checkRepetition returns false for dissimilar messages', () => {
  const msgs = [
    'one two three four',
    'alpha beta gamma',
    'pink yellow blue',
    'cat dog pig',
    'sun moon star',
  ];
  assertEquals(checkRepetition(msgs), false);
});

Deno.test('repetition: messageSimilarity returns 0 for empty strings', () => {
  assertEquals(messageSimilarity('', ''), 0);
  assertEquals(messageSimilarity('hello', ''), 0);
});

Deno.test('repetition: messageSimilarity returns 1 for identical messages', () => {
  assertEquals(messageSimilarity('hello world', 'hello world'), 1);
});

Deno.test('repetition: analyzeRepetition handles short input', () => {
  const result = analyzeRepetition(['just one']);
  assertEquals(result.isRepeating, false);
  assertEquals(result.maxConsecutiveSimilar, 0);
  assertEquals(result.avgSimilarity, 0);
  assertEquals(result.similarityScores, []);
});

Deno.test('repetition: analyzeRepetition computes scores + max-consecutive', () => {
  const result = analyzeRepetition([
    'alpha beta',
    'alpha beta',
    'alpha beta',
    'alpha beta',
    'gamma delta',
  ]);
  assertEquals(result.similarityScores.length, 4);
  assert(result.maxConsecutiveSimilar >= 3);
  assertEquals(result.isRepeating, true);
  assert(result.avgSimilarity > 0);
});

Deno.test('repetition: RepetitionChecker accumulates messages within window', async () => {
  const checker = new RepetitionChecker(3, 0.99, 2);
  checker.addMessage('a');
  checker.addMessage('b');
  checker.addMessage('c');
  checker.addMessage('d'); // forces window drop
  const msgs = checker.getMessages();
  assertEquals(msgs.length, 3);
  assertEquals(msgs[0], 'b');
  assertEquals(await checker.isStuck(), false);
});

Deno.test('repetition: RepetitionChecker.isStuck detects loops', async () => {
  await silentConsole(async () => {
    const checker = new RepetitionChecker(5, 0.99, 3);
    const line = 'identical loop message';
    for (let i = 0; i < 5; i++) checker.addMessage(line);
    assertEquals(await checker.isStuck(), true);
  });
});

// ============================================================================
// service-harness.ts — deterministic sampling
// ============================================================================

Deno.test('harness: sampleQuestionsDeterministic returns full list when N >= length', () => {
  const qs: BenchmarkQuestion[] = [
    { id: '1', question: 'a', correctAnswer: 'x' },
    { id: '2', question: 'b', correctAnswer: 'y' },
  ];
  const sampled = sampleQuestionsDeterministic(qs, 5, 42);
  assertEquals(sampled.length, 2);
});

Deno.test('harness: sampleQuestionsDeterministic is reproducible with same seed', () => {
  const qs: BenchmarkQuestion[] = Array.from({ length: 20 }, (_, i) => ({
    id: `q${i}`,
    question: `Q${i}`,
    correctAnswer: 'A',
  }));
  const a = sampleQuestionsDeterministic(qs, 5, 42).map((q) => q.id);
  const b = sampleQuestionsDeterministic(qs, 5, 42).map((q) => q.id);
  assertEquals(a, b);
});

Deno.test('harness: sampleQuestionsDeterministic differs with different seeds', () => {
  const qs: BenchmarkQuestion[] = Array.from({ length: 50 }, (_, i) => ({
    id: `q${i}`,
    question: `Q${i}`,
    correctAnswer: 'A',
  }));
  const a = sampleQuestionsDeterministic(qs, 10, 1).map((q) => q.id).join(',');
  const b = sampleQuestionsDeterministic(qs, 10, 99).map((q) => q.id).join(',');
  assert(a !== b);
});

// ============================================================================
// MMLU-Pro harness
// ============================================================================

Deno.test('mmlu-pro: loadDataset returns sample questions', async () => {
  const harness = new MMLUProHarness();
  const qs = await silentConsole(() => harness.loadDataset());
  assert(qs.length >= 3);
  assertEquals(qs[0].correctAnswer, 'C');
});

Deno.test('mmlu-pro: metadata properties', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.name, 'MMLU-Pro');
  assertEquals(harness.defaultRepeats, 1);
  assert(harness.questionCount > 0);
  assertStringIncludes(harness.description, 'Multi-Task');
});

Deno.test('mmlu-pro: formatPrompt includes question + options', () => {
  const harness = new MMLUProHarness();
  const prompt = harness.formatPrompt({
    id: 'q1',
    question: 'What is 2+2?',
    options: ['A) 3', 'B) 4', 'C) 5'],
    correctAnswer: 'B',
  });
  assertStringIncludes(prompt, 'What is 2+2?');
  assertStringIncludes(prompt, 'A) 3');
  assertStringIncludes(prompt, 'B) 4');
});

Deno.test('mmlu-pro: formatPrompt works when options is undefined', () => {
  const harness = new MMLUProHarness();
  const prompt = harness.formatPrompt({
    id: 'q1',
    question: 'no options?',
    correctAnswer: 'A',
  });
  assertStringIncludes(prompt, 'no options?');
});

Deno.test('mmlu-pro: extractAnswer — single letter', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.extractAnswer('C'), 'C');
  assertEquals(harness.extractAnswer('the answer is B'), 'B');
});

Deno.test('mmlu-pro: extractAnswer — "Answer: X" form', () => {
  const harness = new MMLUProHarness();
  // Avoid first bare letter match; use text with no standalone A-J earlier.
  assertEquals(harness.extractAnswer('thinking...\nAnswer: C'), 'C');
});

Deno.test('mmlu-pro: extractAnswer — no match returns empty string', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.extractAnswer('???'), '');
});

Deno.test('mmlu-pro: evaluateAnswer compares case-insensitive', async () => {
  const harness = new MMLUProHarness();
  assertEquals(await harness.evaluateAnswer('a', 'A'), true);
  assertEquals(await harness.evaluateAnswer('A', 'B'), false);
});

Deno.test('mmlu-pro: runBenchmark happy path with DI stub', async () => {
  const { fn, captures } = makeStubCallModel(() => okResponse('The answer is C', 2));
  const harness = new MMLUProHarness(fn);

  const summary = await silentConsole(() =>
    harness.runBenchmark({
      modelUrl: 'http://stub',
      apiKey: 'k',
      sampleSize: 3,
    })
  );

  assertEquals(summary.benchmarkName, 'MMLU-Pro');
  assertEquals(summary.sampledQuestions, 3);
  // 3 questions * 1 repeat * 2 cost = 6
  assertEquals(summary.totalCostCents, 6);
  assertEquals(summary.results.length, 3);
  // Happy path: model says C; Q1 + Q3 have correctAnswer=C, Q2 has A → 2/3
  assertEquals(summary.correctAnswers, 2);
  assert(Math.abs(summary.accuracy - (2 / 3) * 100) < 0.01);
  assertEquals(captures.length, 3);
  assertEquals(captures[0].params.url, 'http://stub');
  assertEquals(captures[0].params.apiKey, 'k');
});

Deno.test('mmlu-pro: runBenchmark handles empty dataset gracefully', async () => {
  const { fn, captures } = makeStubCallModel(() => okResponse('A'));
  const harness = new MMLUProHarness(fn);
  // Override loadDataset with no questions
  harness.loadDataset = () => Promise.resolve([]);

  const summary = await silentConsole(() =>
    harness.runBenchmark({ modelUrl: 'http://x', apiKey: 'k' })
  );

  assertEquals(summary.sampledQuestions, 0);
  assertEquals(summary.results.length, 0);
  assertEquals(summary.correctAnswers, 0);
  assertEquals(summary.accuracy, 0);
  assertEquals(captures.length, 0);
});

Deno.test('mmlu-pro: runBenchmark captures LLM errors into results', async () => {
  const { fn } = makeStubCallModel(() => {
    throw new Error('model exploded');
  });
  const harness = new MMLUProHarness(fn);

  const summary = await silentConsole(() =>
    harness.runBenchmark({ modelUrl: 'http://x', apiKey: 'k', sampleSize: 2 })
  );

  assertEquals(summary.correctAnswers, 0);
  for (const r of summary.results) {
    assertStringIncludes(r.modelResponse, 'ERROR:');
    assertEquals(r.isCorrect, false);
    assertEquals(r.costCents, 0);
    assertEquals((r.metadata as Record<string, unknown>).error, true);
  }
});

Deno.test('mmlu-pro: runBenchmark samples when dataset > sampleSize', async () => {
  const { fn } = makeStubCallModel(() => okResponse('A'));
  const harness = new MMLUProHarness(fn);
  const bigDataset: BenchmarkQuestion[] = Array.from({ length: 50 }, (_, i) => ({
    id: `big-${i}`,
    question: `Q${i}`,
    options: ['A) x', 'B) y'],
    correctAnswer: 'A',
  }));
  harness.loadDataset = () => Promise.resolve(bigDataset);

  const summary = await silentConsole(() =>
    harness.runBenchmark({ modelUrl: 'http://x', apiKey: 'k', sampleSize: 5, seed: 7 })
  );

  assertEquals(summary.totalQuestions, 50);
  assertEquals(summary.sampledQuestions, 5);
  assertEquals(summary.isSampled, true);
});

Deno.test('mmlu-pro: runBenchmark honors repeats override', async () => {
  const { fn, captures } = makeStubCallModel(() => okResponse('C'));
  const harness = new MMLUProHarness(fn);
  harness.loadDataset = () =>
    Promise.resolve([
      { id: 'q1', question: '?', options: ['A', 'B', 'C'], correctAnswer: 'C' },
    ]);

  await silentConsole(() =>
    harness.runBenchmark({
      modelUrl: 'http://x',
      apiKey: 'k',
      repeats: 3,
    })
  );
  assertEquals(captures.length, 3);
});

// ============================================================================
// Terminal-Bench harness
// ============================================================================

Deno.test('terminal-bench: loadDataset returns sample tasks', async () => {
  const harness = new TerminalBenchHarness();
  const tasks = await silentConsole(() => harness.loadDataset());
  assert(tasks.length >= 3);
  assertExists(tasks[0].metadata);
});

Deno.test('terminal-bench: metadata', () => {
  const harness = new TerminalBenchHarness();
  assertEquals(harness.name, 'Terminal-Bench');
  assertEquals(harness.defaultRepeats, 3);
  assert(harness.questionCount > 0);
});

Deno.test('terminal-bench: formatPrompt mentions terminal + task', () => {
  const harness = new TerminalBenchHarness();
  const prompt = harness.formatPrompt({
    id: 't1',
    question: 'Install nginx.',
    correctAnswer: 'nginx_installed',
  });
  assertStringIncludes(prompt, 'terminal');
  assertStringIncludes(prompt, 'Install nginx.');
});

Deno.test('terminal-bench: extractAnswer truncates long responses', () => {
  const harness = new TerminalBenchHarness();
  const long = 'x'.repeat(2000);
  assertEquals(harness.extractAnswer(long).length, 500);
});

Deno.test('terminal-bench: evaluateAnswer — keyword coverage passes', async () => {
  const harness = new TerminalBenchHarness();
  const result = await silentConsole(() =>
    harness.evaluateAnswer(
      'I will run apt install nginx then configure it',
      'install_nginx',
    )
  );
  assertEquals(result, true);
});

Deno.test('terminal-bench: evaluateAnswer — insufficient keywords fails', async () => {
  const harness = new TerminalBenchHarness();
  const result = await silentConsole(() =>
    harness.evaluateAnswer(
      'totally unrelated response with nothing matching',
      'install_nginx_on_server',
    )
  );
  assertEquals(result, false);
});

Deno.test('terminal-bench: evaluateAnswer — repetition loop fails', async () => {
  const harness = new TerminalBenchHarness();
  const repetitive = Array.from({ length: 10 }, () => 'same exact line').join('\n');
  const result = await silentConsole(() => harness.evaluateAnswer(repetitive, 'same_exact_line'));
  assertEquals(result, false);
});

Deno.test('terminal-bench: runBenchmark happy path with DI stub', async () => {
  const { fn, captures } = makeStubCallModel(() =>
    okResponse('I will build linux kernel and add custom message', 1)
  );
  const harness = new TerminalBenchHarness(fn);

  const summary = await silentConsole(() =>
    harness.runBenchmark({
      modelUrl: 'http://stub',
      apiKey: 'k',
      sampleSize: 1,
      repeats: 1,
    })
  );

  assertEquals(summary.benchmarkName, 'Terminal-Bench');
  assertEquals(summary.sampledQuestions, 1);
  assertEquals(summary.results.length, 1);
  assertEquals(captures.length, 1);
});

Deno.test('terminal-bench: runBenchmark propagates fetch-layer error into result', async () => {
  const { fn } = makeStubCallModel(() => {
    throw new Error('network down');
  });
  const harness = new TerminalBenchHarness(fn);

  const summary = await silentConsole(() =>
    harness.runBenchmark({
      modelUrl: 'http://stub',
      apiKey: 'k',
      sampleSize: 1,
      repeats: 1,
    })
  );
  assertEquals(summary.results.length, 1);
  assertStringIncludes(summary.results[0].modelResponse, 'network down');
  assertEquals(summary.correctAnswers, 0);
});

// ============================================================================
// service.ts — suite orchestration + registry
// ============================================================================

Deno.test('service: createHarness returns correct harness by name', () => {
  assert(createHarness('MMLU-Pro') instanceof MMLUProHarness);
  assert(createHarness('Terminal-Bench') instanceof TerminalBenchHarness);
});

Deno.test('service: createHarness throws on unknown benchmark', () => {
  assertThrows(
    () => createHarness('Does-Not-Exist'),
    Error,
    'Unknown benchmark: Does-Not-Exist',
  );
});

Deno.test('service: createHarness injects callModelFn into harness', async () => {
  const { fn, captures } = makeStubCallModel(() => okResponse('C'));
  const harness = createHarness('MMLU-Pro', { callModelFn: fn });
  const summary = await silentConsole(() =>
    harness.runBenchmark({ modelUrl: 'http://x', apiKey: 'k', sampleSize: 1 })
  );
  assertEquals(summary.sampledQuestions, 1);
  assertEquals(captures.length, 1);
});

Deno.test('service: runBenchmarkSuite orchestrates multiple benchmarks', async () => {
  const { fn, captures } = makeStubCallModel(() => okResponse('C', 1));
  const config: TestConfig = {
    modelUrl: 'http://stub',
    authHeaders: { 'x-api-key': 'k' },
    benchmarks: ['MMLU-Pro', 'Terminal-Bench'],
    sampleSize: 1,
  };

  const results = await silentConsole(() => runBenchmarkSuite(config, { callModelFn: fn }));

  assertExists(results['MMLU-Pro']);
  assertExists(results['Terminal-Bench']);
  // MMLU-Pro uses 1 repeat, Terminal-Bench uses 3 by default → 1 + 3 = 4 calls.
  assertEquals(captures.length, 4);
});

Deno.test('service: runBenchmarkSuite records error for unknown benchmark', async () => {
  const results = await silentConsole(() =>
    runBenchmarkSuite({
      modelUrl: 'http://x',
      authHeaders: { 'x-api-key': 'k' },
      benchmarks: ['Does-Not-Exist'],
    })
  );
  const entry = results['Does-Not-Exist'] as { error: string };
  assertExists(entry.error);
  assertStringIncludes(entry.error, 'Unknown benchmark');
});

Deno.test('service: runBenchmarkSuite uses defaults when fields omitted', async () => {
  const { fn } = makeStubCallModel(() => okResponse('C'));
  const results: BenchmarkSuiteResults = await silentConsole(() =>
    runBenchmarkSuite(
      {
        modelUrl: 'http://x',
        authHeaders: {},
        benchmarks: ['MMLU-Pro'],
      },
      { callModelFn: fn },
    )
  );
  assertExists(results['MMLU-Pro']);
});

Deno.test('service: runBenchmarkSuite accepts empty benchmark list', async () => {
  const results = await silentConsole(() =>
    runBenchmarkSuite({
      modelUrl: 'http://x',
      authHeaders: { 'x-api-key': 'k' },
      benchmarks: [],
    })
  );
  assertEquals(Object.keys(results).length, 0);
});

// ============================================================================
// runtime.ts — CLI entry factory
// ============================================================================

Deno.test('runtime: buildCliConfig uses injected env reader', () => {
  const config = buildCliConfig((key) => {
    if (key === 'MODEL_URL') return 'http://custom';
    if (key === 'API_KEY') return 'custom-key';
    return undefined;
  });
  assertEquals(config.modelUrl, 'http://custom');
  assertEquals(config.authHeaders['x-api-key'], 'custom-key');
  assertEquals(config.benchmarks, ['MMLU-Pro']);
  assertEquals(config.seed, DEFAULT_SEED);
});

Deno.test('runtime: buildCliConfig defaults when env is empty', () => {
  const config = buildCliConfig(() => undefined);
  assertEquals(config.modelUrl, DEFAULT_MODEL_URL);
  assertEquals(config.authHeaders['x-api-key'], '');
});

Deno.test('runtime: buildCliConfig sample size is a small smoke value', () => {
  const config = buildCliConfig(() => 'set');
  assert(config.sampleSize !== undefined);
  assert(config.sampleSize! < DEFAULT_SAMPLE_SIZE);
});

Deno.test('runtime: createHandler exits when API_KEY missing', async () => {
  const errors: string[] = [];
  let exitCode: number | undefined;
  const handler = createHandler({
    getEnv: (key) => (key === 'MODEL_URL' ? 'http://x' : undefined),
    logger: { error: (...args) => errors.push(args.join(' ')) },
    exit: ((code: number) => {
      exitCode = code;
      // Don't actually exit — let the handler continue and return undefined.
      return undefined as unknown as never;
    }) as (code: number) => never,
  });

  const result = await handler();
  assertEquals(result, undefined);
  assertEquals(exitCode, 1);
  assert(errors.some((e) => e.includes('API_KEY')));
});

Deno.test('runtime: createHandler runs suite when API_KEY present', async () => {
  const { fn, captures } = makeStubCallModel(() => okResponse('C', 1));
  const handler = createHandler({
    getEnv: (key) => {
      if (key === 'API_KEY') return 'stub-key';
      if (key === 'MODEL_URL') return 'http://stub';
      return undefined;
    },
    logger: { error: () => {} },
    exit: ((_code: number) => undefined as unknown as never) as (code: number) => never,
    callModelFn: fn,
  });

  const result = await silentConsole(() => handler());
  assertExists(result);
  assertExists(result!['MMLU-Pro']);
  // MMLU-Pro sample dataset has 3 questions, and sampleSize=10 so no sampling.
  assertEquals(captures.length, 3);
});

Deno.test('runtime: createHandler with defaults does not throw at construction', () => {
  // Just construct; don't invoke (would try to read real env + hit network).
  const handler = createHandler();
  assertEquals(typeof handler, 'function');
});

// ============================================================================
// Invariants
// ============================================================================

Deno.test('invariant: no harness calls external fetch when stub is provided', async () => {
  // Swap fetch to a sentinel that throws if called — tests that DI is
  // actually used in every code path exercised by this file so far.
  const { fn } = makeStubCallModel(() => okResponse('C', 0));
  const harness = new MMLUProHarness(fn);
  const sentinelError = new Error('fetch should not be called under DI stub');
  await withFetch(
    () => {
      throw sentinelError;
    },
    async () => {
      await silentConsole(() =>
        harness.runBenchmark({
          modelUrl: 'http://x',
          apiKey: 'k',
          sampleSize: 1,
        })
      );
    },
  );
});

Deno.test('invariant: runBenchmark summary is self-consistent', async () => {
  const { fn } = makeStubCallModel(() => okResponse('C', 3));
  const harness = new MMLUProHarness(fn);
  const summary = await silentConsole(() =>
    harness.runBenchmark({
      modelUrl: 'http://x',
      apiKey: 'k',
      sampleSize: 3,
      repeats: 2,
    })
  );
  assertEquals(summary.sampledQuestions, 3);
  assertEquals(summary.results.length, 6);
  assertEquals(summary.totalCostCents, 18);
  const recomputed = summary.results.filter((r) => r.isCorrect).length;
  assertEquals(recomputed, summary.correctAnswers);
});
