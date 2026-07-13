/**
 * Production CORS safety path:
 *
 * Render ALLOWED_ORIGINS -> resolveAllowedOrigins -> complete? -> Express CORS middleware
 *                                                   \-> incomplete -> abort startup
 *
 * The production smoke independently probes both public origins against both
 * login endpoints, so configuration and deployed behavior are both guarded.
 */
export const PRODUCTION_WEB_ORIGINS = ['https://www.roselabs.ai', 'https://roselabs.ai'] as const;

const DEVELOPMENT_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3002',
  'http://localhost:8081',
] as const;

interface CorsEnvironment {
  NODE_ENV?: string;
  ALLOWED_ORIGINS?: string;
}

function parseOrigins(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),
  ];
}

export function resolveAllowedOrigins(environment: CorsEnvironment): string[] {
  const configuredOrigins = parseOrigins(environment.ALLOWED_ORIGINS);
  if (environment.NODE_ENV !== 'production') {
    return configuredOrigins.length > 0 ? configuredOrigins : [...DEVELOPMENT_ORIGINS];
  }

  if (configuredOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS is required in production');
  }

  const missingOrigins = PRODUCTION_WEB_ORIGINS.filter(
    (origin) => !configuredOrigins.includes(origin)
  );
  if (missingOrigins.length > 0) {
    throw new Error(
      `ALLOWED_ORIGINS is missing required production origins: ${missingOrigins.join(', ')}`
    );
  }

  return configuredOrigins;
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  nodeEnv: string | undefined
): boolean {
  if (origin === undefined || origin === '') return true;
  if (allowedOrigins.includes(origin)) return true;
  if (nodeEnv === 'production') return false;

  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) || origin.endsWith('.vercel.app');
}
