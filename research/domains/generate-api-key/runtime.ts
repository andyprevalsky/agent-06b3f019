/**
 * Runtime (HTTP handler) for the generate-api-key domain.
 *
 * Thin controller: parse request, extract auth, call the service, format the
 * response. No data access, no business logic, no inline schemas.
 */

import { corsHeaders, jsonResponseHeaders } from './config.ts';
import { buildSupabaseClient, generateApiKey } from './service.ts';
import type {
  CreateClientFn,
  GenerateApiKeyRequestBody,
  GenerateApiKeyResponseBody,
} from './types.ts';
import { GenerateApiKeyError } from './types.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: jsonResponseHeaders, status });
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  return token.length > 0 ? token : null;
}

async function parseBodyName(req: Request): Promise<string | null | undefined> {
  // Preserves original destructuring semantics:
  //   - body is {}         → name is undefined
  //   - body is {name:"x"} → name is "x"
  //   - req.json() throws  → name is null
  const body = await req.json().catch(() => ({ name: null as string | null }));
  return (body as GenerateApiKeyRequestBody).name;
}

export function createHandler(
  createClient: CreateClientFn,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const token = extractBearerToken(req);
      if (!token) {
        return jsonResponse(401, { error: 'Missing or invalid authorization header' });
      }

      const supabase = buildSupabaseClient(createClient);
      const name = await parseBodyName(req);

      const result: GenerateApiKeyResponseBody = await generateApiKey({
        supabase,
        token,
        name,
      });

      return jsonResponse(200, result);
    } catch (error) {
      if (error instanceof GenerateApiKeyError) {
        return jsonResponse(error.status, {
          error: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
      }
      const details = error instanceof Error ? error.message : 'Unknown error';
      return jsonResponse(500, { error: 'Internal server error', details });
    }
  };
}
