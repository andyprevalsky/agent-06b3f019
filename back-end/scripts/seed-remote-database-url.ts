type SeedEnvironment = Record<string, string | undefined>;

/**
 * Runtime seed jobs only read production data, so they should use the pooled
 * endpoint. The direct endpoint is reserved for schema and migration work and
 * is only a compatibility fallback when an environment has no pooled URL.
 */
export function selectRemoteDatabaseUrl(env: SeedEnvironment): string | undefined {
  return env.DATABASE_URL || env.DIRECT_DATABASE_URL;
}
