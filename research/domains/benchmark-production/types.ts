/**
 * Types for the benchmark-production domain.
 *
 * Layer rules: imports nothing domain-specific (external packages only).
 */

/**
 * Shape of a single benchmark run result returned by the Rose bench endpoint.
 */
export interface BenchmarkRunResult {
  accuracy: number;
  durationSeconds: number;
  totalCostCents: number;
  industryComparison: { position: string };
}

/**
 * Parameters for a single benchmark run.
 */
export interface BenchmarkRunParams {
  baseUrl: string;
  apiKey: string;
  benchmark: string;
  model: string;
  cotSteps: number;
  samples: number;
}

/**
 * Parsed CLI options driving the production benchmark suite.
 */
export interface BenchmarkSuiteOptions {
  baseUrl: string;
  apiKey: string;
  models: string[];
  benchmarks: string[];
  cotSteps: number[];
  samples: number;
}
