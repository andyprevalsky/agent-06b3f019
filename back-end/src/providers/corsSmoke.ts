import { PRODUCTION_WEB_ORIGINS } from './corsConfig';

export const AUTH_CORS_PATHS = ['/api/auth/anonymous', '/api/auth/send-otp'] as const;

export type FetchForCorsProbe = (url: string, init: RequestInit) => Promise<Response>;

export interface CorsPreflightResult {
  origin: string;
  path: (typeof AUTH_CORS_PATHS)[number];
  status: number | null;
  ok: boolean;
  error?: string;
}

function commaSeparatedHeaderIncludes(value: string | null, expected: string): boolean {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes(expected.toLowerCase());
}

async function runCorsPreflight(
  baseUrl: string,
  origin: string,
  path: (typeof AUTH_CORS_PATHS)[number],
  fetchForProbe: FetchForCorsProbe,
  timeoutMs: number
): Promise<CorsPreflightResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`CORS preflight timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    const response = await fetchForProbe(`${baseUrl}${path}`, {
      method: 'OPTIONS',
      signal: controller.signal,
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const failures: string[] = [];
    if (response.status !== 204) failures.push(`expected status 204, received ${response.status}`);
    const allowedOrigin = response.headers.get('Access-Control-Allow-Origin');
    if (allowedOrigin !== origin) {
      failures.push(`expected allow-origin ${origin}, received ${allowedOrigin ?? '<missing>'}`);
    }
    if (
      !commaSeparatedHeaderIncludes(response.headers.get('Access-Control-Allow-Methods'), 'POST')
    ) {
      failures.push('allow-methods is missing POST');
    }
    if (
      !commaSeparatedHeaderIncludes(
        response.headers.get('Access-Control-Allow-Headers'),
        'content-type'
      )
    ) {
      failures.push('allow-headers is missing content-type');
    }
    return {
      origin,
      path,
      status: response.status,
      ok: failures.length === 0,
      ...(failures.length > 0 ? { error: failures.join('; ') } : {}),
    };
  } catch (error) {
    return {
      origin,
      path,
      status: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAuthCorsPreflights(
  baseUrl: string,
  fetchForProbe: FetchForCorsProbe = fetch,
  timeoutMs = 15_000
): Promise<CorsPreflightResult[]> {
  return Promise.all(
    PRODUCTION_WEB_ORIGINS.flatMap((origin) =>
      AUTH_CORS_PATHS.map((path) =>
        runCorsPreflight(baseUrl, origin, path, fetchForProbe, timeoutMs)
      )
    )
  );
}
