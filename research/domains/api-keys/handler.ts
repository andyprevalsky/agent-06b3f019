/**
 * API Keys Domain — Runtime (HTTP handler)
 *
 * Thin controller: parses the request, extracts the bearer token,
 * dispatches to the service, and maps results to HTTP responses.
 */

import { CORS_HEADERS, JSON_HEADERS, readSupabaseEnv } from './config.ts';
import { listApiKeysForToken } from './service.ts';
import type { CreateClientFn } from './types.ts';

export type { CreateClientFn, SupabaseClient } from './types.ts';
export { CORS_HEADERS as corsHeaders } from './config.ts';

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS, status });
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

export function createHandler(
  createClient: CreateClientFn,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      const token = extractBearerToken(req);
      if (!token) {
        return jsonResponse(
          { error: 'Missing or invalid authorization header' },
          401,
        );
      }

      const env = readSupabaseEnv();
      if (!env) {
        return jsonResponse(
          { error: 'Server misconfiguration: missing Supabase credentials' },
          500,
        );
      }

      const supabase = createClient(env.url, env.serviceKey);
      const result = await listApiKeysForToken(supabase, token);

      if (result.kind === 'error') {
        const body: Record<string, unknown> = { error: result.error };
        if (result.details !== undefined) body.details = result.details;
        return jsonResponse(body, result.status);
      }

      return jsonResponse({ keys: result.keys }, 200);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return jsonResponse(
        { error: 'Internal server error', details: errorMessage },
        500,
      );
    }
  };
}
