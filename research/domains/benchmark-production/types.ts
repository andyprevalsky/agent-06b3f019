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

/**
 * Injectable boundary dependencies for the benchmark-production domain.
 *
 * Every external boundary (HTTP, filesystem, stdout/stderr) is reached through
 * this interface so unit tests can supply stubs without live network or disk
 * access. Env reads live in config.ts (the canonical location for Deno.env)
 * and are driven via `Deno.env.set(...)` / `Deno.env.delete(...)` in tests.
 */
export interface BenchmarkProductionDeps {
  /** HTTP client used to POST to the Rose `/rose/bench` endpoint. */
  fetch: typeof fetch;
  /** Filesystem: create the results directory. */
  mkdir: (path: string, options: { recursive: boolean }) => Promise<void>;
  /** Filesystem: write the aggregated results file. */
  writeTextFile: (path: string, data: string) => Promise<void>;
  /** Stdout sink for human-readable progress. */
  log: (...args: unknown[]) => void;
  /** Stderr sink for error messages. */
  error: (...args: unknown[]) => void;
}
