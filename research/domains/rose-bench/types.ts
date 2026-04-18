/**
 * Rose-Bench Types
 *
 * Domain-specific type definitions for the benchmark runner.
 * Types layer: imports nothing domain-specific.
 */

export interface BenchmarkQuestion {
  id: string;
  question: string;
  options: string[];
  correctAnswer: string;
}

export interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  seed?: number;
  cotSteps?: number;
}

export interface QuestionResult {
  questionId: string;
  modelResponse: string;
  extractedAnswer: string;
  isCorrect: boolean;
  costCents: number;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export interface BenchmarkResult {
  benchmarkName: string;
  totalQuestions: number;
  sampledQuestions: number;
  correctAnswers: number;
  accuracy: number;
  totalCostCents: number;
  totalDurationSeconds: number;
  results: QuestionResult[];
  isSampled: boolean;
  modelConfig: ModelConfig;
}

export interface FullBenchmarkResult {
  totalDurationSeconds: number;
  totalCostCents: number;
  benchmarks: BenchmarkResult[];
  aggregateAccuracy: number;
}

export interface BenchmarkRequest {
  url: string;
  headers?: Record<string, string>;
  modelConfig: ModelConfig;
  benchmark: string;
  seed?: number;
}

/**
 * Minimal Supabase client shape used by this domain.
 * Mirrors the surface consumed by repo.ts so the repo layer can be unit tested
 * with a fake client.
 */
export interface SupabaseClientLike {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

export type CreateSupabaseClientFn = (
  url: string,
  serviceKey: string,
) => SupabaseClientLike;
