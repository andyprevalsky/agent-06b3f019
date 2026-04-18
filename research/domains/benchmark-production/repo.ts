/**
 * Data access for the benchmark-production domain.
 *
 * - Invokes the Rose `/rose/bench` HTTP endpoint.
 * - Persists aggregated results to the local filesystem.
 *
 * Layer rules: may import own types, own config, providers/*. Framework-agnostic.
 * All boundary calls (fetch, filesystem) are reached through injected deps so
 * tests can stub them without live network or disk access.
 */

import { BENCHMARK_SEED, RESULTS_DIR, RESULTS_FILE } from './config.ts';
import type { BenchmarkProductionDeps, BenchmarkRunParams, BenchmarkRunResult } from './types.ts';

/**
 * POST to the Rose `/rose/bench` endpoint and return the parsed result.
 *
 * Throws if the response is not OK.
 */
export async function postBenchmark(
  deps: Pick<BenchmarkProductionDeps, 'fetch'>,
  params: BenchmarkRunParams,
): Promise<BenchmarkRunResult> {
  const { baseUrl, apiKey, benchmark, model, cotSteps, samples } = params;

  const response = await deps.fetch(`${baseUrl}/rose/bench`, {
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
export async function saveResults(
  deps: Pick<BenchmarkProductionDeps, 'mkdir' | 'writeTextFile'>,
  results: BenchmarkRunResult[],
): Promise<void> {
  await deps.mkdir(RESULTS_DIR, { recursive: true });
  await deps.writeTextFile(RESULTS_FILE, JSON.stringify(results, null, 2));
}
