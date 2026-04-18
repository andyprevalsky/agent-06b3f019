/**
 * Chat domain runtime entry.
 *
 * Thin HTTP adapter: converts a Fetch `Request` into the framework-agnostic
 * `ChatProxyRequest` shape consumed by the service layer. The edge-function
 * wiring at `research/supabase/functions/chat/index.ts` imports
 * {@link handleChatHttpRequest} and hands it straight to `Deno.serve`.
 */

import { handleChatRequest } from './service.ts';

/** Adapt a Fetch `Request` into the service layer's framework-agnostic shape. */
export function handleChatHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  return handleChatRequest({
    method: req.method,
    pathname: url.pathname,
    headers: req.headers,
    readBody: () => req.text(),
  });
}
