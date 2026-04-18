/**
 * Runtime layer — benchmark-runner CLI entry point.
 *
 * Layer boundaries (import rules):
 *   - May import from own service, own config, own types.
 *   - Thin wrapper: parse env/args, call the service, exit.
 */

import type { BenchmarkSuiteResults, TestConfig } from './types.ts';
import { type BenchmarkSuiteDeps, runBenchmarkSuite } from './service.ts';
import {
  DEFAULT_COT_STEPS,
  DEFAULT_MODEL_URL,
  DEFAULT_SEED,
  getEnv as defaultGetEnv,
} from './config.ts';

const DEFAULT_CLI_SAMPLE_SIZE = 10; // Small sample for smoke testing

/** Dependencies the runtime needs to execute the CLI. */
export interface RuntimeDeps extends BenchmarkSuiteDeps {
  /** Env reader — defaults to config.getEnv. */
  getEnv?: (key: string) => string | undefined;
  /** Console sink — defaults to globalThis.console. */
  logger?: { error: (...args: unknown[]) => void };
  /** Process exit — defaults to Deno.exit (never returns in prod). */
  exit?: (code: number) => never;
}

export function buildCliConfig(
  getEnv: (key: string) => string | undefined = defaultGetEnv,
): TestConfig {
  return {
    modelUrl: getEnv('MODEL_URL') ?? DEFAULT_MODEL_URL,
    authHeaders: {
      'x-api-key': getEnv('API_KEY') ?? '',
    },
    benchmarks: ['MMLU-Pro'],
    sampleSize: DEFAULT_CLI_SAMPLE_SIZE,
    seed: DEFAULT_SEED,
    cotSteps: DEFAULT_COT_STEPS,
  };
}

export type RuntimeHandler = () => Promise<BenchmarkSuiteResults | undefined>;

/**
 * Create the CLI handler for the benchmark-runner domain.
 *
 * Returns an async function that:
 *   1. Builds the CLI config from env.
 *   2. Validates that an API key is set (calls `exit(1)` if missing).
 *   3. Invokes `runBenchmarkSuite` with the provided dependencies.
 *
 * All external I/O (env reads, logging, process exit, HTTP model calls) is
 * injected so tests can stub every boundary.
 */
export function createHandler(deps: RuntimeDeps = {}): RuntimeHandler {
  const getEnv = deps.getEnv ?? defaultGetEnv;
  const logger = deps.logger ?? console;
  const exit = deps.exit ?? Deno.exit;

  return async () => {
    const config = buildCliConfig(getEnv);

    if (!config.authHeaders['x-api-key']) {
      logger.error('Error: API_KEY environment variable not set');
      logger.error(
        'Usage: API_KEY=<your-key> MODEL_URL=<url> deno run --allow-net --allow-env runtime.ts',
      );
      exit(1);
      return undefined;
    }

    return await runBenchmarkSuite(config, { callModelFn: deps.callModelFn });
  };
}

if (import.meta.main) {
  await createHandler()();
}
