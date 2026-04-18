#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
/**
 * Runtime entry point for the benchmark-production domain.
 *
 * Usage:
 *   deno run --allow-all runtime.ts
 *   deno run --allow-all runtime.ts --models rose-1-lite --cot 1,3,5
 *
 * Layer rules: thin controller — parses CLI args / env, calls service, handles
 * exit codes. No data access, no business logic.
 */

// deno-lint-ignore-file no-console -- CLI runner; stderr reporting is part of the contract.

import { parse } from 'https://deno.land/std/flags/mod.ts';

import {
  DEFAULT_BASE_URL,
  DEFAULT_BENCHMARKS,
  DEFAULT_COT_STEPS,
  DEFAULT_MODELS,
  DEFAULT_SAMPLES,
} from './config.ts';
import { runBenchmarkSuite } from './service.ts';
import type { BenchmarkSuiteOptions } from './types.ts';

/**
 * Parse CLI flags and environment into strongly-typed suite options.
 * Exits the process when required configuration is missing.
 */
function parseOptions(): BenchmarkSuiteOptions {
  const flags = parse(Deno.args, {
    string: ['models', 'benchmarks', 'cot', 'samples'],
    default: {
      models: DEFAULT_MODELS,
      benchmarks: DEFAULT_BENCHMARKS,
      cot: DEFAULT_COT_STEPS,
      samples: DEFAULT_SAMPLES,
    },
  });

  const baseUrl = Deno.env.get('BASE_URL') ?? DEFAULT_BASE_URL;
  const apiKey = Deno.env.get('ROSE_API_KEY');

  if (apiKey === undefined || apiKey === '') {
    console.error('❌ Error: ROSE_API_KEY required');
    Deno.exit(1);
  }

  return {
    baseUrl,
    apiKey,
    models: String(flags.models).split(','),
    benchmarks: String(flags.benchmarks).split(','),
    cotSteps: String(flags.cot).split(',').map(Number),
    samples: parseInt(String(flags.samples), 10),
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  await runBenchmarkSuite(options);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('Fatal error:', error);
    Deno.exit(1);
  });
}
