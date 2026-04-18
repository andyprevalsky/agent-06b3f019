/**
 * Rose-Bench Service
 *
 * Business logic orchestration for the benchmark runner.
 * - URL validation (allowlist + scheme)
 * - Question sampling (deterministic when seeded)
 * - Running a single benchmark or the full suite
 * - Logging runs to Supabase (best-effort)
 *
 * Service rules: typed args in, typed results out. Calls repo for data access.
 */

import type {
  BenchmarkQuestion,
  BenchmarkResult,
  CreateSupabaseClientFn,
  FetchFn,
  FullBenchmarkResult,
  ModelConfig,
  QuestionResult,
} from './types.ts';
import {
  ALLOWED_HOSTNAMES,
  BENCHMARKS,
  FULL_BENCHMARK_KEY,
  getMaxSamplesPerBench,
  SAMPLE_QUESTIONS,
} from './config.ts';
import { callModelEndpoint, insertBenchmarkRun } from './repo.ts';

export class BenchmarkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkValidationError';
  }
}

/**
 * Validate that a user-provided URL is https (or localhost) and on the
 * hostname allowlist. Returns the normalised URL string.
 */
export function validateBenchmarkUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BenchmarkValidationError('Invalid URL');
  }
  const isLocalhost = parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new BenchmarkValidationError('Only HTTPS URLs are allowed');
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    throw new BenchmarkValidationError(
      `Hostname not allowed: ${parsed.hostname}`,
    );
  }
  return parsed.toString();
}

export function isKnownBenchmark(benchmark: string): boolean {
  return Object.prototype.hasOwnProperty.call(BENCHMARKS, benchmark);
}

export function isFullBenchmark(benchmark: string): boolean {
  return benchmark === FULL_BENCHMARK_KEY;
}

export function listBenchmarkKeys(): string[] {
  return Object.keys(BENCHMARKS);
}

/** Seeded PRNG (sinusoidal) matching the pre-refactor behaviour. */
function seededRandom(seed: number): () => number {
  let x = Math.sin(seed++) * 10000;
  return (): number => {
    x = Math.sin(x) * 10000;
    return x - Math.floor(x);
  };
}

export function sampleQuestions(
  questions: BenchmarkQuestion[],
  sampleSize: number,
  seed?: number,
): BenchmarkQuestion[] {
  const shuffled = [...questions];
  let currentIndex = shuffled.length;

  const random = seed !== undefined ? seededRandom(seed) : Math.random;

  while (currentIndex !== 0) {
    const randomIndex = Math.floor(random() * currentIndex);
    currentIndex--;
    [shuffled[currentIndex], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[currentIndex],
    ];
  }

  return shuffled.slice(0, sampleSize);
}

function formatQuestion(q: BenchmarkQuestion): string {
  return `${q.question}\n\n${q.options.join('\n')}\n\nAnswer with only the letter (A, B, C, or D):`;
}

function extractAnswer(response: string): string {
  const match = response.match(/\b([A-D])\b/i);
  return match ? match[1].toUpperCase() : '';
}

export interface RunSingleBenchmarkArgs {
  url: string;
  headers: Record<string, string>;
  modelConfig: ModelConfig;
  benchmarkName: string;
  seed?: number;
  /** Injectable fetch; defaults to global fetch in production. */
  fetchFn?: FetchFn;
}

export async function runSingleBenchmark(
  args: RunSingleBenchmarkArgs,
  logError: (message: string, err: unknown) => void,
): Promise<BenchmarkResult> {
  const maxSamples = getMaxSamplesPerBench();
  const questions = sampleQuestions(
    SAMPLE_QUESTIONS,
    Math.min(maxSamples, SAMPLE_QUESTIONS.length),
    args.seed,
  );

  const results: QuestionResult[] = [];
  const startTime = Date.now();

  for (const question of questions) {
    const questionStart = Date.now();

    try {
      // deno-lint-ignore no-await-in-loop -- benchmark questions must run sequentially to preserve ordering + per-question timing
      const { content: modelResponse } = await callModelEndpoint({
        url: args.url,
        headers: args.headers,
        modelConfig: args.modelConfig,
        prompt: formatQuestion(question),
        fetchFn: args.fetchFn,
      });
      const extractedAnswer = extractAnswer(modelResponse);
      const isCorrect = extractedAnswer === question.correctAnswer;

      results.push({
        questionId: question.id,
        modelResponse,
        extractedAnswer,
        isCorrect,
        costCents: 0, // Cost tracked separately in logs
        durationMs: Date.now() - questionStart,
        metadata: {
          question: question.question,
          correctAnswer: question.correctAnswer,
        },
      });
    } catch (error) {
      logError(`Error on question ${question.id}:`, error);
      results.push({
        questionId: question.id,
        modelResponse: '',
        extractedAnswer: '',
        isCorrect: false,
        costCents: 0,
        durationMs: Date.now() - questionStart,
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  const correctAnswers = results.filter((r) => r.isCorrect).length;
  const totalDurationSeconds = (Date.now() - startTime) / 1000;

  return {
    benchmarkName: args.benchmarkName,
    totalQuestions: SAMPLE_QUESTIONS.length,
    sampledQuestions: questions.length,
    correctAnswers,
    accuracy: results.length > 0 ? (correctAnswers / results.length) * 100 : 0,
    totalCostCents: 0, // Cost tracked in logs
    totalDurationSeconds,
    results,
    isSampled: questions.length < SAMPLE_QUESTIONS.length,
    modelConfig: args.modelConfig,
  };
}

export interface RunFullBenchmarkArgs {
  url: string;
  headers: Record<string, string>;
  modelConfig: ModelConfig;
  seed?: number;
  /** Injectable fetch; defaults to global fetch in production. */
  fetchFn?: FetchFn;
}

export async function runFullBenchmark(
  args: RunFullBenchmarkArgs,
  logError: (message: string, err: unknown) => void,
): Promise<FullBenchmarkResult> {
  const allBenchmarks = Object.keys(BENCHMARKS).filter(
    (b) => b !== FULL_BENCHMARK_KEY,
  );
  const benchmarkResults: BenchmarkResult[] = [];
  const overallStartTime = Date.now();
  let totalCost = 0;

  for (const benchmarkType of allBenchmarks) {
    try {
      // deno-lint-ignore no-await-in-loop -- sub-benchmarks must run sequentially to keep totals deterministic + bounded load on the model endpoint
      const result = await runSingleBenchmark({
        url: args.url,
        headers: args.headers,
        modelConfig: args.modelConfig,
        benchmarkName: benchmarkType,
        seed: args.seed,
        fetchFn: args.fetchFn,
      }, logError);
      benchmarkResults.push(result);
      totalCost += result.totalCostCents;
    } catch (error) {
      logError(`Error running ${benchmarkType}:`, error);
    }
  }

  const totalDuration = (Date.now() - overallStartTime) / 1000;
  const totalQuestions = benchmarkResults.reduce(
    (sum, b) => sum + b.sampledQuestions,
    0,
  );
  const totalCorrect = benchmarkResults.reduce(
    (sum, b) => sum + b.correctAnswers,
    0,
  );
  const aggregateAccuracy = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;

  return {
    totalDurationSeconds: totalDuration,
    totalCostCents: totalCost,
    benchmarks: benchmarkResults,
    aggregateAccuracy,
  };
}

/**
 * Best-effort persist of a single-benchmark run. Swallows failures and
 * returns a status string so the runtime layer can log without throwing.
 */
export async function logBenchmarkRun(
  createClient: CreateSupabaseClientFn,
  modelConfig: ModelConfig,
  result: BenchmarkResult,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    return await insertBenchmarkRun(createClient, {
      benchmarkName: result.benchmarkName,
      modelConfig,
      results: result.results,
      aggregateScore: result.accuracy,
      totalCostCents: result.totalCostCents,
      sampledQuestions: result.sampledQuestions,
      durationSeconds: Math.round(result.totalDurationSeconds),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown-error';
    return { ok: false, reason: message };
  }
}
