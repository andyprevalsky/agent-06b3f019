// deno-lint-ignore-file no-console no-await-in-loop -- CLI benchmark runner; sequential execution is intentional (rate limits)
/**
 * Service layer — benchmark suite orchestration.
 *
 * Layer boundaries (import rules):
 *   - May import from own types, own config, and sibling service files within
 *     this domain.
 *   - Holds the registry of available benchmarks and the suite runner.
 */

import type {
  BenchmarkConfig,
  BenchmarkSuiteResults,
  IBenchmarkHarness,
  TestConfig,
} from './types.ts';
import { DEFAULT_COT_STEPS, DEFAULT_SAMPLE_SIZE, DEFAULT_SEED } from './config.ts';
import { MMLUProHarness } from './service-mmlu-pro.ts';
import { TerminalBenchHarness } from './service-terminal-bench.ts';

const BENCHMARK_REGISTRY: Record<string, () => IBenchmarkHarness> = {
  'MMLU-Pro': () => new MMLUProHarness(),
  'Terminal-Bench': () => new TerminalBenchHarness(),
};

export function createHarness(benchmarkName: string): IBenchmarkHarness {
  const factory = BENCHMARK_REGISTRY[benchmarkName];
  if (!factory) {
    throw new Error(
      `Unknown benchmark: ${benchmarkName}. Available: ${
        Object.keys(BENCHMARK_REGISTRY).join(', ')
      }`,
    );
  }
  return factory();
}

export async function runBenchmarkSuite(
  config: TestConfig,
): Promise<BenchmarkSuiteResults> {
  console.log('\n🚀 Rose Benchmark Suite');
  console.log('========================\n');
  console.log(`Model URL: ${config.modelUrl}`);
  console.log(`Benchmarks: ${config.benchmarks.join(', ')}`);
  console.log(`Sample size: ${config.sampleSize ?? DEFAULT_SAMPLE_SIZE}`);
  console.log(`CoT steps: ${config.cotSteps ?? DEFAULT_COT_STEPS}`);
  console.log(`Sample seed: ${config.seed ?? DEFAULT_SEED}\n`);

  const results: BenchmarkSuiteResults = {};

  for (const benchmarkName of config.benchmarks) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 Running ${benchmarkName}...`);
    console.log('='.repeat(60));

    try {
      const harness = createHarness(benchmarkName);

      const benchmarkConfig: BenchmarkConfig = {
        modelUrl: config.modelUrl,
        apiKey: config.authHeaders['x-api-key'] ?? '',
        sampleSize: config.sampleSize,
        seed: config.seed,
        cotSteps: config.cotSteps,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      };

      const summary = await harness.runBenchmark(benchmarkConfig);

      results[benchmarkName] = summary;

      console.log(`\n✅ ${benchmarkName} Complete:`);
      console.log(
        `   Accuracy: ${summary.accuracy.toFixed(2)}% (${summary.correctAnswers}/${
          summary.sampledQuestions * (benchmarkConfig.repeats ?? harness.defaultRepeats)
        })`,
      );
      console.log(`   Cost: $${(summary.totalCostCents / 100).toFixed(2)}`);
      console.log(`   Duration: ${summary.totalDurationSeconds.toFixed(1)}s`);
    } catch (error) {
      console.error(`\n❌ ${benchmarkName} Failed:`);
      console.error(`   Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      results[benchmarkName] = {
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('📈 BENCHMARK SUITE SUMMARY');
  console.log('='.repeat(60));

  let totalCost = 0;
  let totalQuestions = 0;

  for (const [name, result] of Object.entries(results)) {
    if ('error' in result) {
      console.log(`\n${name}: ERROR`);
    } else {
      console.log(`\n${name}:`);
      console.log(`  Accuracy: ${result.accuracy.toFixed(2)}%`);
      console.log(`  Questions: ${result.sampledQuestions}`);
      console.log(`  Cost: $${(result.totalCostCents / 100).toFixed(2)}`);

      totalCost += result.totalCostCents;
      totalQuestions += result.sampledQuestions;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total questions evaluated: ${totalQuestions}`);
  console.log(`Total cost: $${(totalCost / 100).toFixed(2)}`);
  console.log('='.repeat(60) + '\n');

  return results;
}
