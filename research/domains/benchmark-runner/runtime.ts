// deno-lint-ignore-file no-console -- CLI runtime: console is the output channel
/**
 * Runtime layer — benchmark-runner CLI entry point.
 *
 * Layer boundaries (import rules):
 *   - May import from own service, own config, own types.
 *   - Thin wrapper: parse env/args, call the service, exit.
 */

import type { TestConfig } from './types.ts';
import { runBenchmarkSuite } from './service.ts';
import { DEFAULT_COT_STEPS, DEFAULT_SEED, readApiKeyEnv, readModelUrlEnv } from './config.ts';

const DEFAULT_CLI_SAMPLE_SIZE = 10; // Small sample for smoke testing

function buildCliConfig(): TestConfig {
  return {
    modelUrl: readModelUrlEnv(),
    authHeaders: {
      'x-api-key': readApiKeyEnv(),
    },
    benchmarks: ['MMLU-Pro'],
    sampleSize: DEFAULT_CLI_SAMPLE_SIZE,
    seed: DEFAULT_SEED,
    cotSteps: DEFAULT_COT_STEPS,
  };
}

if (import.meta.main) {
  const config = buildCliConfig();

  if (!config.authHeaders['x-api-key']) {
    console.error('Error: API_KEY environment variable not set');
    console.error(
      'Usage: API_KEY=<your-key> MODEL_URL=<url> deno run --allow-net --allow-env runtime.ts',
    );
    Deno.exit(1);
  }

  await runBenchmarkSuite(config);
}
