/**
 * Test Runner for Rose Benchmarks
 * 
 * Run any benchmark against any model URL with authentication
 */

import { MMLUProHarness } from './harnesses/mmlu-pro.ts';
import { TerminalBenchHarness } from './harnesses/terminal-bench.ts';
import type { BenchmarkConfig, IBenchmarkHarness } from './harnesses/base.ts';

// Registry of available benchmarks
const BENCHMARK_REGISTRY: Record<string, () => IBenchmarkHarness> = {
  'MMLU-Pro': () => new MMLUProHarness(),
  'Terminal-Bench': () => new TerminalBenchHarness(),
  // More benchmarks will be added here as they're implemented
};

export interface TestConfig {
  modelUrl: string;
  authHeaders: Record<string, string>;
  benchmarks: string[];  // e.g., ["MMLU-Pro", "GPQA-Diamond"]
  sampleSize?: number;   // Default: 100
  seed?: number;   // Default: 42
  cotSteps?: number;     // Default: 1
  temperature?: number;
  maxTokens?: number;
}

function createHarness(benchmarkName: string): IBenchmarkHarness {
  const factory = BENCHMARK_REGISTRY[benchmarkName];
  if (!factory) {
    throw new Error(`Unknown benchmark: ${benchmarkName}. Available: ${Object.keys(BENCHMARK_REGISTRY).join(', ')}`);
  }
  return factory();
}

export async function runBenchmarkSuite(config: TestConfig) {
  console.log('\n🚀 Rose Benchmark Suite');
  console.log('========================\n');
  console.log(`Model URL: ${config.modelUrl}`);
  console.log(`Benchmarks: ${config.benchmarks.join(', ')}`);
  console.log(`Sample size: ${config.sampleSize ?? 100}`);
  console.log(`CoT steps: ${config.cotSteps ?? 1}`);
  console.log(`Sample seed: ${config.seed ?? 42}\n`);
  
  const results: Record<string, any> = {};
  
  for (const benchmarkName of config.benchmarks) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 Running ${benchmarkName}...`);
    console.log('='.repeat(60));
    
    try {
      const harness = createHarness(benchmarkName);
      
      const benchmarkConfig: BenchmarkConfig = {
        modelUrl: config.modelUrl,
        apiKey: config.authHeaders['x-api-key'] || '',
        sampleSize: config.sampleSize,
        seed: config.seed,
        cotSteps: config.cotSteps,
        temperature: config.temperature,
        maxTokens: config.maxTokens
      };
      
      const summary = await harness.runBenchmark(benchmarkConfig);
      
      results[benchmarkName] = summary;
      
      console.log(`\n✅ ${benchmarkName} Complete:`);
      console.log(`   Accuracy: ${summary.accuracy.toFixed(2)}% (${summary.correctAnswers}/${summary.sampledQuestions * (benchmarkConfig.repeats || harness.defaultRepeats)})`);
      console.log(`   Cost: $${(summary.totalCostCents / 100).toFixed(2)}`);
      console.log(`   Duration: ${summary.totalDurationSeconds.toFixed(1)}s`);
      
    } catch (error) {
      console.error(`\n❌ ${benchmarkName} Failed:`);
      console.error(`   Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      results[benchmarkName] = {
        error: error instanceof Error ? error.message : 'Unknown error'
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
    if (result.error) {
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
  console.log('='.repeat(60)}\n');
  
  return results;
}

// Example usage (can be run from command line)
if (import.meta.main) {
  const config: TestConfig = {
    modelUrl: Deno.env.get('MODEL_URL') || "http://localhost:3001/v1/chat/completions",
    authHeaders: {
      "x-api-key": Deno.env.get('API_KEY') || ""
    },
    benchmarks: ["MMLU-Pro"],
    sampleSize: 10,  // Small sample for testing
    seed: 42,
    cotSteps: 1
  };
  
  if (!config.authHeaders["x-api-key"]) {
    console.error('Error: API_KEY environment variable not set');
    console.error('Usage: API_KEY=<your-key> MODEL_URL=<url> deno run --allow-net --allow-env test-runner.ts');
    Deno.exit(1);
  }
  
  await runBenchmarkSuite(config);
}

