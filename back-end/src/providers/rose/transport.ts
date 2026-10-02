/**
 * HTTP transport for direct provider calls — Cerebras, Anthropic, OpenAI,
 * and OpenRouter.
 *
 * Mirrors agents/providers/rose/transport.py. Returns the raw streaming
 * Response so the SSE parsers can iterate. No retry, no rotation — those
 * live in claudeAuth.ts and waterfall.ts.
 */

import { createLogger } from '../logger';

const log = createLogger('RoseTransport');

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';

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
const ANTHROPIC_FAST_MODE_BETA = 'fast-mode-2026-02-01';

/**
 * Beta header for the direct Anthropic API-key path. Identical to the OAuth set
 * minus the two claude-code/OAuth-only flags (`claude-code-20250219`,
 * `oauth-2025-04-20`), which a plain `sk-ant-api03` key neither needs nor
 * accepts. The feature betas (thinking/caching/tool-use/effort) work with a
 * standard key, so the same request body streams unchanged.
 */
export const ANTHROPIC_BETA_HEADER_API_KEY = [
  'interleaved-thinking-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
].join(',');

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_X_APP = 'cli';
const ANTHROPIC_USER_AGENT = 'claude-cli/2.1.251 (external, sdk-ts, agent-sdk/0.2.75)';

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

function anthropicApiKeyHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': ANTHROPIC_BETA_HEADER_API_KEY,
    'Content-Type': 'application/json',
  };
}

function withFastModeBeta(
  headers: Record<string, string>,
  body: Record<string, unknown>
): Record<string, string> {
  if (body.speed !== 'fast') return headers;
  const betas = headers['anthropic-beta']
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!betas.includes(ANTHROPIC_FAST_MODE_BETA)) betas.push(ANTHROPIC_FAST_MODE_BETA);
  return { ...headers, 'anthropic-beta': betas.join(',') };
}

function openrouterHeaders(openrouterKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${openrouterKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://roselabs.ai',
    'X-Title': 'Rose Chat',
  };
}

function openAiHeaders(openAiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${openAiKey}`,
    'Content-Type': 'application/json',
  };
}

function cerebrasHeaders(cerebrasKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${cerebrasKey}`,
    'Content-Type': 'application/json',
    // Validate against the stricter schema/tool behavior before it becomes
    // the default Cerebras API version on 2026-07-21.
    'X-Cerebras-Version-Patch': '2',
  };
}

function codexHeaders(gptToken: string, accountId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${gptToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.0.0 (Rose Chat)',
    originator: 'codex_cli_rs',
    ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
  };
}

function codexExtraHeadersFromBody(body: Record<string, unknown>): Record<string, string> {
  const cacheScope = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key.trim() : '';
  return cacheScope ? { session_id: cacheScope, 'x-client-request-id': cacheScope } : {};
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
  const onAbort = (): void => controller.abort(upstream.reason);
  // Honor already-aborted signals before starting fetch — otherwise the
  // listener never fires and the provider request runs despite cancellation.
  if (upstream.aborted) {
    controller.abort(upstream.reason);
  } else {
    upstream.addEventListener('abort', onAbort, { once: true });
  }
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

async function withStreamingConnectTimeout(
  upstream: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<Response>
): Promise<{ response: Response; cleanup: () => void }> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(upstream.reason);
  if (upstream.aborted) controller.abort(upstream.reason);
  else upstream.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error(`connect timeout ${timeoutMs}ms`)),
    timeoutMs
  );
  const cleanup = (): void => {
    clearTimeout(timer);
    upstream.removeEventListener('abort', onAbort);
  };

  try {
    const response = await fn(controller.signal);
    clearTimeout(timer);
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function keepAbortConnectedToBody(
  body: ReadableStream<Uint8Array>,
  cleanup: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason);
    },
  });
}

export async function postOpenAIResponsesStream(
  options: PostOptions & { openAiKey: string; abortSignal?: AbortSignal }
): Promise<StreamResponse> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const upstream = options.abortSignal ?? new AbortController().signal;
  log.info('openai.start', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
  });
  const { response, cleanup } = await withStreamingConnectTimeout(upstream, timeoutMs, (signal) =>
    fetch(OPENAI_RESPONSES_API_URL, {
      method: 'POST',
      headers: openAiHeaders(options.openAiKey),
      body: JSON.stringify(options.body),
      signal,
    })
  );

  let errorBody: string | undefined;
  if (!response.ok) {
    try {
      errorBody = await response.text();
    } finally {
      cleanup();
    }
    log.warn('openai.error', {
      request_id: options.requestId,
      status: response.status,
      error_body_len: errorBody.length,
    });
  }

  const body =
    response.ok && response.body ? keepAbortConnectedToBody(response.body, cleanup) : null;
  if (!body) cleanup();

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body,
    errorBody,
  };
}

/** Microsoft Foundry's Responses endpoint uses the same SSE contract as OpenAI. */
export async function postFoundryResponsesStream(
  options: PostOptions & { endpoint: string; apiKey: string; abortSignal?: AbortSignal }
): Promise<StreamResponse> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const upstream = options.abortSignal ?? new AbortController().signal;
  const root = options.endpoint.replace(/\/+$/, '').replace(/\/openai\/v1$/, '');
  if (!root.startsWith('https://')) throw new Error('AZURE_FOUNDRY_ENDPOINT must be HTTPS');
  const { response, cleanup } = await withStreamingConnectTimeout(upstream, timeoutMs, (signal) =>
    fetch(`${root}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'api-key': options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body),
      redirect: 'manual',
      signal,
    })
  );
  let errorBody: string | undefined;
  if (!response.ok) {
    try {
      errorBody = await response.text();
    } finally {
      cleanup();
    }
    log.warn('foundry.error', { request_id: options.requestId, status: response.status });
  }
  const body =
    response.ok && response.body ? keepAbortConnectedToBody(response.body, cleanup) : null;
  if (!body) cleanup();
  return { status: response.status, ok: response.ok, headers: response.headers, body, errorBody };
}

export async function postCerebrasStream(
  options: PostOptions & { cerebrasKey: string; abortSignal?: AbortSignal }
): Promise<StreamResponse> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const upstream = options.abortSignal ?? new AbortController().signal;
  log.info('cerebras.start', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
  });
  const { response, cleanup } = await withStreamingConnectTimeout(upstream, timeoutMs, (signal) =>
    fetch(CEREBRAS_API_URL, {
      method: 'POST',
      headers: cerebrasHeaders(options.cerebrasKey),
      body: JSON.stringify(options.body),
      signal,
    })
  );

  let errorBody: string | undefined;
  if (!response.ok) {
    try {
      errorBody = await response.text();
    } finally {
      cleanup();
    }
    log.warn('cerebras.error', {
      request_id: options.requestId,
      status: response.status,
      error_body_len: errorBody.length,
    });
  }

  const body =
    response.ok && response.body ? keepAbortConnectedToBody(response.body, cleanup) : null;
  if (!body) cleanup();

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body,
    errorBody,
  };
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
      headers: withFastModeBeta(anthropicHeaders(options.claudeToken), options.body),
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
      error_body_len: errorBody.length,
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

export async function postAnthropicApiKeyStream(
  options: PostOptions & { apiKey: string; abortSignal?: AbortSignal }
): Promise<StreamResponse> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const upstream = options.abortSignal ?? new AbortController().signal;
  log.info('anthropic_apikey.start', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
  });
  const response = await withTimeout(upstream, timeoutMs, (signal) =>
    fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: withFastModeBeta(anthropicApiKeyHeaders(options.apiKey), options.body),
      body: JSON.stringify(options.body),
      signal,
    })
  );

  let errorBody: string | undefined;
  if (!response.ok) {
    errorBody = await response.text();
    log.warn('anthropic_apikey.error', {
      request_id: options.requestId,
      status: response.status,
      error_body_len: errorBody.length,
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
  const startedAt = Date.now();
  log.info('openrouter.start', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
  });
  const { response, cleanup } = await withStreamingConnectTimeout(upstream, timeoutMs, (signal) =>
    fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: openrouterHeaders(options.openrouterKey),
      body: JSON.stringify(options.body),
      signal,
    })
  );
  log.info('openrouter.headers', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
    status: response.status,
    headers_ms: Date.now() - startedAt,
  });

  let errorBody: string | undefined;
  if (!response.ok) {
    try {
      errorBody = await response.text();
    } finally {
      cleanup();
    }
    log.warn('openrouter.error', {
      request_id: options.requestId,
      status: response.status,
      error_body_len: errorBody.length,
    });
  }

  const body =
    response.ok && response.body ? keepAbortConnectedToBody(response.body, cleanup) : null;
  if (!body) cleanup();

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body,
    errorBody,
  };
}

export async function postCodexStream(
  options: PostOptions & {
    gptToken: string;
    accountId?: string;
    abortSignal?: AbortSignal;
  }
): Promise<StreamResponse> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const upstream = options.abortSignal ?? new AbortController().signal;
  log.info('codex.start', {
    request_id: options.requestId,
    call_site: options.callSite,
    model: options.body.model,
  });
  const response = await withTimeout(upstream, timeoutMs, (signal) =>
    fetch(CODEX_API_URL, {
      method: 'POST',
      headers: {
        ...codexHeaders(options.gptToken, options.accountId),
        ...codexExtraHeadersFromBody(options.body),
      },
      body: JSON.stringify(options.body),
      signal,
    })
  );

  let errorBody: string | undefined;
  if (!response.ok) {
    errorBody = await response.text();
    log.warn('codex.error', {
      request_id: options.requestId,
      status: response.status,
      error_body_len: errorBody.length,
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
