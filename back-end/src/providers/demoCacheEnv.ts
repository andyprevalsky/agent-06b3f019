/**
 * DEMO cache environment variables.
 *
 * `DEMO_CACHE_<NAME>` is the current spelling. The legacy `FAST_MODE_CACHE_<NAME>` /
 * `FAST_CACHE_<NAME>` spelling is still honoured, and wins while it is present, so
 * existing prod, Fly, Render and benchmark environments keep their exact behaviour
 * without env writes. Mirror of agents/providers/demo_cache/env.py.
 */

export const DEMO_CACHE_ENV_ALIASES = {
  DEMO_CACHE_DATABASE_URL: 'FAST_MODE_CACHE_DATABASE_URL',
  DEMO_CACHE_USE_LOCAL: 'FAST_MODE_CACHE_USE_LOCAL',
  DEMO_CACHE_DISABLE_WRITE_THROUGH: 'FAST_MODE_CACHE_DISABLE_WRITE_THROUGH',
  DEMO_CACHE_RECORD_DEMO: 'FAST_MODE_CACHE_RECORD_DEMO',
  DEMO_CACHE_DB_POOL: 'FAST_CACHE_DB_POOL',
  DEMO_CACHE_MEMORY_TTL_MS: 'FAST_CACHE_MEMORY_TTL_MS',
  DEMO_CACHE_MEMORY_MAX_ENTRIES: 'FAST_CACHE_MEMORY_MAX_ENTRIES',
} as const;

export type DemoCacheEnvName = keyof typeof DEMO_CACHE_ENV_ALIASES;

export function demoCacheEnv(
  name: DemoCacheEnvName,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const legacy = DEMO_CACHE_ENV_ALIASES[name];
  if (env[legacy] !== undefined) return env[legacy];
  return env[name];
}
