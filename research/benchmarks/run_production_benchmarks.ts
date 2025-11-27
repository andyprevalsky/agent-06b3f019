#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Run full production benchmarks against Rose models
 * 
 * Usage:
 *   deno run --allow-all run_production_benchmarks.ts
 *   deno run --allow-all run_production_benchmarks.ts --models rose-1-fast --cot 1,3,5
 */

import { parse } from "https://deno.land/std/flags/mod.ts";

async function runBenchmark(
  baseUrl: string,
  apiKey: string,
  benchmark: string,
  model: string,
  cotSteps: number,
  samples: number
) {
  console.log(`\n▶ Running ${benchmark} on ${model} (CoT=${cotSteps}, n=${samples})...`);
  
  const response = await fetch(`${baseUrl}/rose/bench`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({
      benchmark,
      model,
      cotSteps,
      samples,
      seed: 42
    })
  });
  
  if (!response.ok) {
    throw new Error(`Benchmark failed: ${response.status}`);
  }
  
  return await response.json();
}

async function main() {
  const flags = parse(Deno.args, {
    string: ['models', 'benchmarks', 'cot', 'samples'],
    default: {
      models: 'rose-labs/rose-1-fast,rose-labs/rose-1-ultra',
      benchmarks: 'mmlu-pro,terminal-bench',
      cot: '1,3,5',
      samples: '100'
    }
  });
  
  const baseUrl = Deno.env.get('BASE_URL') || 'http://localhost:3000';
  const apiKey = Deno.env.get('ROSE_API_KEY');
  
  if (!apiKey) {
    console.error('❌ Error: ROSE_API_KEY required');
    Deno.exit(1);
  }
  
  const models = flags.models.split(',');
  const benchmarks = flags.benchmarks.split(',');
  const cotSteps = flags.cot.split(',').map(Number);
  const samples = parseInt(flags.samples);
  
  console.log('='.repeat(80));
  console.log('ROSE MODEL BENCHMARK SUITE');
  console.log('='.repeat(80));
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Benchmarks: ${benchmarks.join(', ')}`);
  console.log(`CoT Steps: ${cotSteps.join(', ')}`);
  console.log(`Samples: ${samples}`);
  console.log('='.repeat(80));
  
  const results = [];
  
  for (const model of models) {
    for (const benchmark of benchmarks) {
      for (const steps of cotSteps) {
        try {
          const result = await runBenchmark(baseUrl, apiKey, benchmark, model, steps, samples);
          results.push(result);
          
          const icon = result.industryComparison.position === 'above-leader' ? '★' :
                      result.industryComparison.position === 'above-average' ? '↑' : '↓';
          
          console.log(`${icon} ${result.accuracy.toFixed(1)}% (${result.durationSeconds}s, $${(result.totalCostCents / 100).toFixed(2)})`);
        } catch (error) {
          console.error(`✗ Failed:`, error);
        }
      }
    }
  }
  
  // Save results
  await Deno.mkdir('./results', { recursive: true });
  await Deno.writeTextFile(
    './results/benchmark_results.json',
    JSON.stringify(results, null, 2)
  );
  
  console.log('\n' + '='.repeat(80));
  console.log('✓ Results saved to ./results/benchmark_results.json');
}

if (import.meta.main) {
  main();
}







