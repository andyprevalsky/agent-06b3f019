// Shared type definitions for the Rose benchmarking suite

export interface ModelWeights {
  [modelId: string]: number;  // Probability weight (should sum to 1.0)
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelConfig {
  temperature: number;
  maxTokens: number;
  cotSteps: number;
}

export interface CostBreakdown {
  promptTokens: number;
  completionTokens: number;
  promptCostCents: number;
  completionCostCents: number;
  totalCostCents: number;
}

// Re-export benchmark types
export type {
  BenchmarkQuestion,
  BenchmarkResult,
  BenchmarkConfig,
  BenchmarkSummary,
  IBenchmarkHarness
} from '../benchmarks/harnesses/base.ts';










