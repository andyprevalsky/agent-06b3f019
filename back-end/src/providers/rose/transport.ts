/**
 * HTTP transport for direct provider calls — Anthropic + OpenRouter.
 *
 * Mirrors agents/providers/rose/transport.py. Returns the raw streaming
 * Response so the SSE parsers can iterate. No retry, no rotation — those
 * live in claudeAuth.ts and waterfall.ts.
 */

import { createLogger } from '../logger';

const log = createLogger('RoseTransport');

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * The combination of `claude-code-20250219` + `oauth-2025-04-20` is what
 * unlocks the Claude Max OAuth token path; the other betas are feature
 * flags the agent stack relies on.
 */
export const ANTHROPIC_BETA_HEADER = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
].join(',');

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_X_APP = 'cli';
const ANTHROPIC_USER_AGENT = 'claude-cli/2.1.81 (external, sdk-ts, agent-sdk/0.2.75)';

export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

export interface StreamResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  errorBody?: string;
}

function anthropicHeaders(claudeToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${claudeToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': ANTHROPIC_BETA_HEADER,
    'x-app': ANTHROPIC_X_APP,
    'User-Agent': ANTHROPIC_USER_AGENT,
    'Content-Type': 'application/json',
  };
}

function openrouterHeaders(openrouterKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${openrouterKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://roselabs.ai',
    'X-Title': 'Rose Chat',
  };
}

interface PostOptions {
  body: Record<string, unknown>;
  requestId: string;
  callSite?: string;
  connectTimeoutMs?: number;
}

async function withTimeout(
  signal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<Response>
): Promise<Response> {
  const controller = new AbortController();
  const upstream = signal;
  const onAbort = () => controller.abort(upstream.reason);
  upstream.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`connect timeout ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    upstream.removeEventListener('abort', onAbort);
  }
}

export async function postAnthropicStream(
  options: PostOptions & { claudeToken: string; abortSignal?: AbortSignal }
): Promise<StreamResponse> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const upstream = options.abortSignal ?? new AbortController().signal;
  log.info('anthropic.start', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
  });
  const response = await withTimeout(upstream, timeoutMs, (signal) =>
    fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: anthropicHeaders(options.claudeToken),
      body: JSON.stringify(options.body),
      signal,
    })
  );

  let errorBody: string | undefined;
  if (!response.ok) {
    errorBody = await response.text();
    log.warn('anthropic.error', {
      request_id: options.requestId,
      status: response.status,
      body: errorBody.substring(0, 500),
    });
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: response.body,
    errorBody,
  };
}

export async function postOpenRouterStream(
  options: PostOptions & { openrouterKey: string; abortSignal?: AbortSignal }
): Promise<StreamResponse> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const upstream = options.abortSignal ?? new AbortController().signal;
  log.info('openrouter.start', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
  });
  const response = await withTimeout(upstream, timeoutMs, (signal) =>
    fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: openrouterHeaders(options.openrouterKey),
      body: JSON.stringify(options.body),
      signal,
    })
  );

  let errorBody: string | undefined;
  if (!response.ok) {
    errorBody = await response.text();
    log.warn('openrouter.error', {
      request_id: options.requestId,
      status: response.status,
      body: errorBody.substring(0, 500),
    });
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: response.body,
    errorBody,
  };
}
