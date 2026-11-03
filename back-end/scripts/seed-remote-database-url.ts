type SeedEnvironment = Record<string, string | undefined>;

/**
 * Runtime seed jobs only read production data, so they should use the pooled
 * endpoint. The direct endpoint is reserved for schema and migration work and
 * is only a compatibility fallback when an environment has no pooled URL.
 */
export function selectRemoteDatabaseUrl(env: SeedEnvironment): string | undefined {
  const routedEndpoint = env.SEED_REMOTE_DATABASE_URL?.trim();
  if (routedEndpoint) {
    return routedEndpoint;
  }
  const implicit = env.DATABASE_URL || env.DIRECT_DATABASE_URL;
  if (implicit) {
    const host = new URL(implicit).hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      host === '::1' ||
      host.startsWith('127.') ||
      host === '0.0.0.0'
    ) {
      throw new Error(
        'Implicit credential READ source is loopback. Preserve the complete authoritative backend .env; use SEED_REMOTE_DATABASE_URL explicitly for an intentional local restore or tunnel.'
      );
    }
  }
  return implicit;
}
