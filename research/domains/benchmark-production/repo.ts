/**
 * Data access for the benchmark-production domain.
 *
 * - Invokes the Rose `/rose/bench` HTTP endpoint.
 * - Persists aggregated results to the local filesystem.
 *
 * Layer rules: may import own types, own config, providers/*. Framework-agnostic.
 */

import { BENCHMARK_SEED, RESULTS_DIR, RESULTS_FILE } from './config.ts';
import type { BenchmarkRunParams, BenchmarkRunResult } from './types.ts';

/**
 * POST to the Rose `/rose/bench` endpoint and return the parsed result.
 *
 * Throws if the response is not OK.
 */
export async function postBenchmark(params: BenchmarkRunParams): Promise<BenchmarkRunResult> {
  const { baseUrl, apiKey, benchmark, model, cotSteps, samples } = params;

  const response = await fetch(`${baseUrl}/rose/bench`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      benchmark,
      model,
      cotSteps,
      samples,
      seed: BENCHMARK_SEED,
    }),
  });

  if (!response.ok) {
    throw new Error(`Benchmark failed: ${response.status}`);
  }

  return await response.json() as BenchmarkRunResult;
}

/**
 * Persist the aggregated benchmark results to the configured output file.
 *
 * Creates the results directory if it does not exist.
 */
export async function saveResults(results: BenchmarkRunResult[]): Promise<void> {
  await Deno.mkdir(RESULTS_DIR, { recursive: true });
  await Deno.writeTextFile(RESULTS_FILE, JSON.stringify(results, null, 2));
}
