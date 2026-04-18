/**
 * Config for the benchmark-production domain.
 *
 * Layer rules: may import from own types only.
 */

/** Default Rose models to benchmark. */
export const DEFAULT_MODELS = 'rose-labs/rose-1-lite,rose-labs/rose-1-ultra';

/** Default benchmarks to run. */
export const DEFAULT_BENCHMARKS = 'mmlu-pro,terminal-bench';

/** Default chain-of-thought step counts. */
export const DEFAULT_COT_STEPS = '1,3,5';

/** Default samples per (model, benchmark, cot) combo. */
export const DEFAULT_SAMPLES = '100';

/** Default base URL if BASE_URL env is unset. */
export const DEFAULT_BASE_URL = 'http://localhost:3000';

/** Rose API base URL; falls back to DEFAULT_BASE_URL when unset. */
export function getBaseUrl(): string {
  return Deno.env.get('BASE_URL') ?? DEFAULT_BASE_URL;
}

/** Rose API key; empty string when unset (caller should exit). */
export function getRoseApiKey(): string {
  return Deno.env.get('ROSE_API_KEY') ?? '';
}

/** Deterministic seed for benchmark sampling. */
export const BENCHMARK_SEED = 42;

/** Relative path where benchmark results are written. */
export const RESULTS_DIR = './results';

/** Relative file path (inside RESULTS_DIR) for the aggregated JSON output. */
export const RESULTS_FILE = './results/benchmark_results.json';
