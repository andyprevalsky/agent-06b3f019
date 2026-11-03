export const FAST_MODE_ANTHROPIC_UPSTREAM =
  process.env.FAST_MODE_ANTHROPIC_UPSTREAM ?? 'https://api.anthropic.com';

export const DEMO_CACHE_DATABASE_URL =
  // Legacy FAST_MODE_CACHE_DATABASE_URL wins while present (see providers/demoCacheEnv.ts).
  process.env.FAST_MODE_CACHE_DATABASE_URL ??
  process.env.DEMO_CACHE_DATABASE_URL ??
  (process.env.NODE_ENV === 'production' ? (process.env.DATABASE_URL ?? '') : '');

export const FAST_MODE_ANTHROPIC_PROXY_URL = process.env.FAST_MODE_ANTHROPIC_PROXY_URL;
export const FAST_MODE_NODE_ENV = process.env.NODE_ENV;
