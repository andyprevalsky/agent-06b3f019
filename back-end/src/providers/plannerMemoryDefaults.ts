const ENABLED_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** True only for a dedicated benchmark stack, never for the shared production process. */
export function isBenchmarkRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    ENABLED_ENV_VALUES.has((env.BENCHMARK_MODE ?? '').trim().toLowerCase()) ||
    ENABLED_ENV_VALUES.has((env.BENCHMARK_ISOLATED_RUN ?? '').trim().toLowerCase())
  );
}

/** Production defaults on; request-marked and isolated benchmark runs default off. */
export function plannerMemoryEnabledByDefault(isBenchmarkRequest = false): boolean {
  return !isBenchmarkRequest && !isBenchmarkRuntime();
}
