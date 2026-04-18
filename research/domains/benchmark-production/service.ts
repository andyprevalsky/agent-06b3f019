/**
 * Business logic for the benchmark-production domain.
 *
 * Orchestrates the full production benchmark sweep: for each
 * (model × benchmark × cot-steps) combination, invoke the Rose bench
 * endpoint via the repo layer, log human-readable progress, accumulate
 * results, and persist them.
 *
 * Layer rules: imports own repo, own types, own config only.
 *
 * Sequential execution by design — the Rose bench endpoint enforces rate
 * limits, so concurrent requests would be rejected.
 */

// deno-lint-ignore-file no-console -- CLI progress output is a first-class concern for this domain.

import { postBenchmark, saveResults } from './repo.ts';
import { RESULTS_FILE } from './config.ts';
import type { BenchmarkRunResult, BenchmarkSuiteOptions } from './types.ts';

/** Render a visual trend indicator based on industry comparison position. */
function positionIcon(position: string): string {
  if (position === 'above-leader') return '★';
  if (position === 'above-average') return '↑';
  return '↓';
}

/** Log the full suite configuration banner. */
function logSuiteHeader(options: BenchmarkSuiteOptions): void {
  const separator = '='.repeat(80);
  console.log(separator);
  console.log('ROSE MODEL BENCHMARK SUITE');
  console.log(separator);
  console.log(`Models: ${options.models.join(', ')}`);
  console.log(`Benchmarks: ${options.benchmarks.join(', ')}`);
  console.log(`CoT Steps: ${options.cotSteps.join(', ')}`);
  console.log(`Samples: ${options.samples}`);
  console.log(separator);
}

/** Log a single benchmark result in compact, human-readable form. */
function logResult(result: BenchmarkRunResult): void {
  const icon = positionIcon(result.industryComparison.position);
  const costDollars = (result.totalCostCents / 100).toFixed(2);
  console.log(
    `${icon} ${result.accuracy.toFixed(1)}% (${result.durationSeconds}s, $${costDollars})`,
  );
}

/**
 * Execute a single benchmark run and log its result.
 * Returns the result on success, or null on failure (error is logged).
 */
async function runOne(
  options: BenchmarkSuiteOptions,
  model: string,
  benchmark: string,
  cotSteps: number,
): Promise<BenchmarkRunResult | null> {
  console.log(`\n▶ Running ${benchmark} on ${model} (CoT=${cotSteps}, n=${options.samples})...`);
  try {
    const result = await postBenchmark({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      benchmark,
      model,
      cotSteps,
      samples: options.samples,
    });
    logResult(result);
    return result;
  } catch (error) {
    console.error(`✗ Failed:`, error);
    return null;
  }
}

/**
 * Run the full production benchmark suite and persist results.
 */
export async function runBenchmarkSuite(options: BenchmarkSuiteOptions): Promise<void> {
  logSuiteHeader(options);

  const results: BenchmarkRunResult[] = [];

  for (const model of options.models) {
    for (const benchmark of options.benchmarks) {
      for (const cotSteps of options.cotSteps) {
        // deno-lint-ignore no-await-in-loop -- Sequential execution is required by rate limits.
        const result = await runOne(options, model, benchmark, cotSteps);
        if (result !== null) {
          results.push(result);
        }
      }
    }
  }

  await saveResults(results);

  console.log('\n' + '='.repeat(80));
  console.log(`✓ Results saved to ${RESULTS_FILE}`);
}
