/**
 * Chat domain service.
 *
 * Business logic for the OpenAI-compatible /chat/completions proxy:
 *   1. Short-circuit CORS preflight.
 *   2. Strip the /chat prefix and reject unknown subpaths with a 404.
 *   3. Forward every other request to the completions edge function,
 *      preserving method, headers and body.
 *   4. Surface upstream transport failures as a 500 error shape.
 *
 * The service is framework-agnostic: it accepts a {@link ChatProxyRequest}
 * and returns a {@link Response}. The runtime layer is the sole caller.
 */

import { ALLOWED_SUBPATHS, CHAT_PATH_PREFIX, CORS_HEADERS, getCompletionsUrl } from './config.ts';
import type { ChatProxyRequest } from './types.ts';

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json',
};

/** Build a JSON error response with CORS headers attached. */
function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

/** Entry point for the chat proxy. */
export async function handleChatRequest(req: ChatProxyRequest): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const subpath = req.pathname.replace(CHAT_PATH_PREFIX, '');
  if (!ALLOWED_SUBPATHS.has(subpath)) {
    return jsonError('Not found', 404);
  }

  try {
    const body = await req.readBody();
    const upstream = await fetch(getCompletionsUrl(), {
      method: req.method,
      headers: req.headers,
      body: body.length > 0 ? body : undefined,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (error) {
    // deno-lint-ignore no-console -- Edge function error logging (Deno has no other logging API)
    console.error('Error proxying to completions:', error);
    return jsonError('Internal server error', 500);
  }
}
