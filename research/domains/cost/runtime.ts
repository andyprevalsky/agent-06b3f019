/**
 * Cost domain runtime: thin HTTP handler.
 *
 * Layer: runtime
 * May import from: own service, own config, own types.
 */

import { CORS_HEADERS } from './config.ts';
import { computeCost, CostError, parseModelName } from './service.ts';
import type { CostResponse } from './types.ts';

/** Build a JSON error response with CORS headers. */
function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, status },
  );
}

/** Build a JSON success response with CORS headers. */
function jsonOk(body: CostResponse): Response {
  return new Response(
    JSON.stringify(body),
    { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, status: 200 },
  );
}

/** Convert an unknown thrown value to a 500 Response with CORS + details. */
function internalError(error: unknown): Response {
  // deno-lint-ignore no-console
  console.error('Cost calculation error:', error);
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  return new Response(
    JSON.stringify({ error: 'Failed to calculate cost', details: errorMessage }),
    { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, status: 500 },
  );
}

/** HTTP handler for GET /cost. Exported as the runtime entry point. */
export async function handleCostRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const modelName = parseModelName(new URL(req.url));
    if (!modelName) {
      return jsonError('Missing required query parameter: model', 400);
    }

    const result = await computeCost(modelName);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof CostError) {
      return jsonError(error.message, error.status);
    }
    return internalError(error);
  }
}
