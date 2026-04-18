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
 * plus injected {@link ChatServiceDeps} and returns a {@link Response}. The
 * runtime layer is the sole caller.
 */

import { slog } from '../../providers/logger.ts';
import { ALLOWED_SUBPATHS, CHAT_PATH_PREFIX, CORS_HEADERS, getCompletionsUrl } from './config.ts';
import type { ChatProxyRequest, ChatServiceDeps } from './types.ts';

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

/** Default production dependencies for the chat proxy service. */
export const DEFAULT_CHAT_DEPS: ChatServiceDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  getCompletionsUrl,
};

/**
 * Entry point for the chat proxy.
 *
 * Accepts optional `deps` so tests can inject a stub fetch and URL resolver.
 * Production call sites rely on {@link DEFAULT_CHAT_DEPS}.
 */
export async function handleChatRequest(
  req: ChatProxyRequest,
  deps: ChatServiceDeps = DEFAULT_CHAT_DEPS,
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const subpath = req.pathname.replace(CHAT_PATH_PREFIX, '');
  if (!ALLOWED_SUBPATHS.has(subpath)) {
    return jsonError('Not found', 404);
  }

  try {
    const body = await req.readBody();
    const upstream = await deps.fetch(deps.getCompletionsUrl(), {
      method: req.method,
      headers: req.headers,
      body: body.length > 0 ? body : undefined,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (error) {
    slog('error', 'Error proxying to completions', { data: error });
    return jsonError('Internal server error', 500);
  }
}
