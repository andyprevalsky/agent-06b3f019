/**
 * Chat domain runtime entry.
 *
 * Thin HTTP adapter: converts a Fetch `Request` into the framework-agnostic
 * `ChatProxyRequest` shape consumed by the service layer. The edge-function
 * wiring at `research/supabase/functions/chat/index.ts` imports
 * {@link handleChatHttpRequest} and hands it straight to `Deno.serve`.
 *
 * Dependency injection: {@link createHandler} builds a request handler bound
 * to explicit {@link ChatServiceDeps} so tests can inject stub implementations.
 * The default export {@link handleChatHttpRequest} wires production defaults.
 */

import { DEFAULT_CHAT_DEPS, handleChatRequest } from './service.ts';
import type { ChatServiceDeps } from './types.ts';

/**
 * Build a Fetch-compatible handler bound to the given dependencies.
 *
 * Production callers pass nothing and get {@link DEFAULT_CHAT_DEPS}. Tests
 * inject stub `fetch` and `getCompletionsUrl` implementations to assert on
 * outbound call shape without touching the network.
 */
export function createHandler(
  deps: ChatServiceDeps = DEFAULT_CHAT_DEPS,
): (req: Request) => Promise<Response> {
  return (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    return handleChatRequest(
      {
        method: req.method,
        pathname: url.pathname,
        headers: req.headers,
        readBody: () => req.text(),
      },
      deps,
    );
  };
}

/** Adapt a Fetch `Request` into the service layer's framework-agnostic shape. */
export const handleChatHttpRequest: (req: Request) => Promise<Response> = createHandler();
