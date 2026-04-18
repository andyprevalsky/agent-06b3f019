/**
 * Types layer for the benchmark-runner domain.
 *
 * Layer boundaries (import rules):
 *   - This file imports NOTHING from the project source tree.
 *   - External packages and provider types only.
 */

export interface BenchmarkQuestion {
  id: string;
  question: string;
  options?: string[]; // For MCQ
  correctAnswer: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkResult {
  questionId: string;
  modelResponse: string;
  extractedAnswer: string;
  isCorrect: boolean;
  costCents: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkConfig {
  modelUrl: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  repeats?: number;
  cotSteps?: number;
  sampleSize?: number; // Default: 100
  seed?: number; // Default: 42
}

export interface BenchmarkSummary {
  benchmarkName: string;
  totalQuestions: number; // Full dataset size
  sampledQuestions: number; // Actually evaluated
  correctAnswers: number;
  accuracy: number; // 0-100
  totalCostCents: number;
  totalDurationSeconds: number;
  results: BenchmarkResult[];
  isSampled: boolean;
}

/** Result of a single model call (repo layer returns this). */
export interface ModelCallResult {
  response: string;
  cost: number;
}

// Base interface that all harnesses implement
export interface IBenchmarkHarness {
  // Metadata
  readonly name: string;
  readonly description: string;
  readonly questionCount: number;
  readonly defaultRepeats: number;

  // Core methods
  loadDataset(): Promise<BenchmarkQuestion[]>;
  formatPrompt(question: BenchmarkQuestion): string;
  extractAnswer(modelResponse: string): string;
  evaluateAnswer(extracted: string, correct: string): Promise<boolean>;

  // Main execution
  runBenchmark(config: BenchmarkConfig): Promise<BenchmarkSummary>;
}

export interface RepetitionAnalysis {
  isRepeating: boolean;
  maxConsecutiveSimilar: number;
  avgSimilarity: number;
  similarityScores: number[];
}

export interface TestConfig {
  modelUrl: string;
  authHeaders: Record<string, string>;
  benchmarks: string[]; // e.g., ["MMLU-Pro", "GPQA-Diamond"]
  sampleSize?: number; // Default: 100
  seed?: number; // Default: 42
  cotSteps?: number; // Default: 1
  temperature?: number;
  maxTokens?: number;
}

export type BenchmarkSuiteResults = Record<
  string,
  BenchmarkSummary | { error: string }
>;
