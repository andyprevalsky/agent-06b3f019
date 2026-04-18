/**
 * Chat domain types.
 *
 * The chat edge function is an OpenAI-compatible /chat/completions proxy that
 * forwards to the completions edge function. These types describe the public
 * surface of the proxy service.
 */

/** Immutable CORS header map returned on OPTIONS and attached to error responses. */
export type CorsHeaders = Readonly<Record<string, string>>;

/** Input consumed by the chat proxy service. */
export interface ChatProxyRequest {
  /** HTTP method (GET, POST, OPTIONS, ...). */
  readonly method: string;
  /** Path relative to the edge function root, e.g. '/chat/completions'. */
  readonly pathname: string;
  /** Raw request headers forwarded verbatim to the completions endpoint. */
  readonly headers: Headers;
  /** Promise that resolves to the raw request body as a string. */
  readonly readBody: () => Promise<string>;
}
