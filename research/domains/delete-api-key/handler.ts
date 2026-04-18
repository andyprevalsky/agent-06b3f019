/**
 * Runtime layer for the delete-api-key domain.
 *
 * Thin HTTP handler: parses the request, invokes the service, maps typed
 * errors to HTTP responses. No DB or business logic lives here.
 */

import {
  BEARER_PREFIX,
  corsHeaders,
  ENV_SUPABASE_SERVICE_ROLE_KEY,
  ENV_SUPABASE_URL,
  jsonContentTypeHeaders,
} from './config.ts';
import { deleteApiKeyForCaller } from './service.ts';
import { type CreateClientFn, DeleteApiKeyError } from './types.ts';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: jsonContentTypeHeaders,
    status,
  });
}

function mapDomainErrorToResponse(err: DeleteApiKeyError): Response {
  switch (err.code) {
    case 'unauthorized':
      return jsonResponse({ error: err.message }, 401);
    case 'missing_key_id':
      return jsonResponse({ error: err.message }, 400);
    case 'db_error':
      return jsonResponse(
        { error: err.message, ...(err.details ? { details: err.details } : {}) },
        500,
      );
  }
}

async function readKeyIdFromBody(req: Request): Promise<string | null> {
  const body = await req.json().catch(() => null) as { keyId?: unknown } | null;
  const keyId = body?.keyId;
  return typeof keyId === 'string' && keyId.length > 0 ? keyId : null;
}

export function createHandler(
  createClient: CreateClientFn,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const authHeader = req.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
        return jsonResponse(
          { error: 'Missing or invalid authorization header' },
          401,
        );
      }
      const token = authHeader.substring(BEARER_PREFIX.length);

      const supabaseUrl = Deno.env.get(ENV_SUPABASE_URL);
      const supabaseServiceKey = Deno.env.get(ENV_SUPABASE_SERVICE_ROLE_KEY);
      if (!supabaseUrl || !supabaseServiceKey) {
        return jsonResponse(
          { error: 'Server misconfiguration: missing Supabase credentials' },
          500,
        );
      }
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      const keyId = await readKeyIdFromBody(req);
      if (!keyId) {
        return jsonResponse({ error: 'Missing required field: keyId' }, 400);
      }

      const result = await deleteApiKeyForCaller({ supabase, token, keyId });
      return jsonResponse(result, 200);
    } catch (error) {
      if (error instanceof DeleteApiKeyError) {
        return mapDomainErrorToResponse(error);
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return jsonResponse(
        { error: 'Internal server error', details: errorMessage },
        500,
      );
    }
  };
}
