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
 *
 * Tests call `createHandler(deps)` directly with stub dependencies so no live
 * network, filesystem, or env access is required.
 */

import { parse } from 'https://deno.land/std/flags/mod.ts';

import {
  DEFAULT_BENCHMARKS,
  DEFAULT_COT_STEPS,
  DEFAULT_MODELS,
  DEFAULT_SAMPLES,
  getBaseUrl,
  getRoseApiKey,
} from './config.ts';
import { runBenchmarkSuite } from './service.ts';
import type { BenchmarkProductionDeps, BenchmarkSuiteOptions } from './types.ts';

/** Exit code returned when ROSE_API_KEY is missing from the environment. */
export const MISSING_API_KEY_EXIT_CODE = 1;

/**
 * Parse CLI flags and environment into strongly-typed suite options.
 * Returns null when required configuration is missing (caller exits).
 */
export function parseOptions(args: string[]): BenchmarkSuiteOptions | null {
  const flags = parse(args, {
    string: ['models', 'benchmarks', 'cot', 'samples'],
    default: {
      models: DEFAULT_MODELS,
      benchmarks: DEFAULT_BENCHMARKS,
      cot: DEFAULT_COT_STEPS,
      samples: DEFAULT_SAMPLES,
    },
  });

  const baseUrl = getBaseUrl();
  const apiKey = getRoseApiKey();

  if (apiKey === '') return null;

  return {
    baseUrl,
    apiKey,
    models: String(flags.models).split(','),
    benchmarks: String(flags.benchmarks).split(','),
    cotSteps: String(flags.cot).split(',').map(Number),
    samples: parseInt(String(flags.samples), 10),
  };
}

/**
 * Build the CLI handler with injected boundary dependencies.
 *
 * Returns a function that accepts `Deno.args` (or equivalent) and resolves
 * to the process exit code (0 on success, 1 on failure).
 */
export function createHandler(
  deps: BenchmarkProductionDeps,
): (args: string[]) => Promise<number> {
  return async (args: string[]): Promise<number> => {
    const options = parseOptions(args);
    if (options === null) {
      deps.error('❌ Error: ROSE_API_KEY required');
      return MISSING_API_KEY_EXIT_CODE;
    }
    try {
      await runBenchmarkSuite(deps, options);
      return 0;
    } catch (error) {
      deps.error('Fatal error:', error);
      return 1;
    }
  };
}

/** Real Deno-backed dependency bundle used by the CLI entry point. */
function defaultDeps(): BenchmarkProductionDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    mkdir: (path, options) => Deno.mkdir(path, options),
    writeTextFile: (path, data) => Deno.writeTextFile(path, data),
    // deno-lint-ignore no-console -- CLI runner; stdout is the output channel.
    log: (...args) => console.log(...args),
    // deno-lint-ignore no-console -- CLI runner; stderr reporting is part of the contract.
    error: (...args) => console.error(...args),
  };
}

if (import.meta.main) {
  const handler = createHandler(defaultDeps());
  const code = await handler(Deno.args);
  if (code !== 0) Deno.exit(code);
}
