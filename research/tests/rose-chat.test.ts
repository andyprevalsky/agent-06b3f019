/**
 * Unit tests for the Chat Proxy Domain
 *
 * Covers the /chat/completions edge function, which strips the /chat prefix
 * and forwards every other request to the completions edge function.
 *
 * Tests call the extracted handler (`createHandler(deps)`) directly with a
 * stubbed fetch + URL resolver, so no running server or real Supabase is
 * needed. The fetch stub records every outbound call for boundary assertions.
 *
 * Boundary: outbound `fetch(COMPLETIONS_URL, init)`.
 *   - Stubbed via `createFetchStub()` which captures url/method/headers/body
 *   - Each test asserts on captured boundary calls (url, method, headers, body)
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import {
  ALLOWED_SUBPATHS,
  CHAT_PATH_PREFIX,
  CORS_HEADERS,
  getCompletionsUrl,
} from '../domains/chat/config.ts';
import { createHandler } from '../domains/chat/runtime.ts';
import type { ChatServiceDeps, FetchFn } from '../domains/chat/types.ts';

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

interface FetchCapture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  timestamp: string;
}

interface FetchStubConfig {
  /** Status of the fake upstream response. */
  status?: number;
  /** Body of the fake upstream response (string or null). */
  body?: string | null;
  /** Headers of the fake upstream response. */
  headers?: Record<string, string>;
  /** If set, the stub throws this error instead of returning a response. */
  throws?: Error;
  /** Captures populated by the stub on each call. */
  captures: FetchCapture[];
}

function createFetchStub(config: FetchStubConfig): FetchFn {
  return (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }

    const bodyValue = typeof init?.body === 'string' ? init.body : undefined;

    config.captures.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: bodyValue,
      timestamp: new Date().toISOString(),
    });

    if (config.throws) return Promise.reject(config.throws);

    return Promise.resolve(
      new Response(config.body ?? null, {
        status: config.status ?? 200,
        headers: config.headers ?? { 'Content-Type': 'application/json' },
      }),
    );
  };
}

const COMPLETIONS_URL = 'http://localhost:54321/functions/v1/completions';

function buildDeps(config: FetchStubConfig): ChatServiceDeps {
  return {
    fetch: createFetchStub(config),
    getCompletionsUrl: () => COMPLETIONS_URL,
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

// Supabase edge functions receive the path WITHOUT the /functions/v1/<name>
// prefix — `new URL(req.url).pathname` is e.g. `/chat/completions`. We mirror
// that shape here.
const BASE_URL = 'http://localhost:54321';

function makeRequest(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };

  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  return new Request(`${BASE_URL}${path}`, init);
}

async function parseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json();
}

// ============================================================================
// CORS preflight
// ============================================================================

Deno.test('chat: OPTIONS preflight returns 200 with CORS headers', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  const response = await handler(
    new Request(`${BASE_URL}/chat/completions`, { method: 'OPTIONS' }),
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  const allowed = response.headers.get('Access-Control-Allow-Headers') ?? '';
  assertStringIncludes(allowed, 'authorization');
  assertStringIncludes(allowed, 'x-api-key');
  assertStringIncludes(allowed, 'content-type');
  // CORS preflight must not reach the upstream.
  assertEquals(captures.length, 0);
});

Deno.test('chat: OPTIONS for empty /chat path still returns 200 CORS', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  const response = await handler(
    new Request(`${BASE_URL}/chat`, { method: 'OPTIONS' }),
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals(captures.length, 0);
});

// ============================================================================
// Path routing (404s)
// ============================================================================

Deno.test('chat: unknown subpath returns 404 JSON', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  const response = await handler(
    makeRequest('/chat/invalid-path', { method: 'GET' }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 404);
  assertEquals(data.error, 'Not found');
  assertEquals(response.headers.get('Content-Type'), 'application/json');
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  // 404 must not reach the upstream.
  assertEquals(captures.length, 0);
});

Deno.test('chat: deeply nested unknown path returns 404', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  const response = await handler(makeRequest('/chat/foo/bar'));
  const data = await parseJson(response);

  assertEquals(response.status, 404);
  assertEquals(data.error, 'Not found');
  assertEquals(captures.length, 0);
});

Deno.test('chat: POST to unknown subpath returns 404', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  const response = await handler(
    makeRequest('/chat/some-other-endpoint', { method: 'POST', body: {} }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 404);
  assertEquals(data.error, 'Not found');
  assertEquals(captures.length, 0);
});

// ============================================================================
// Happy path — forward to completions
// ============================================================================

Deno.test('chat: POST /chat/completions forwards body and headers to upstream', async () => {
  const captures: FetchCapture[] = [];
  const upstreamBody = JSON.stringify({
    id: 'cmpl-abc',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }],
  });
  const handler = createHandler(buildDeps({
    captures,
    status: 200,
    body: upstreamBody,
    headers: { 'Content-Type': 'application/json', 'x-upstream-trace': 'abc-123' },
  }));

  const payload = { model: 'rose-labs/rose-1-lite', messages: [{ role: 'user', content: 'hi' }] };
  const response = await handler(
    makeRequest('/chat/completions', {
      method: 'POST',
      headers: { 'x-api-key': 'my-test-key', 'x-request-id': 'req-42' },
      body: payload,
    }),
  );

  assertEquals(response.status, 200);
  // Upstream headers pass through.
  assertEquals(response.headers.get('x-upstream-trace'), 'abc-123');

  const data = await parseJson(response);
  assertEquals(data.id, 'cmpl-abc');
  assertEquals(data.object, 'chat.completion');

  // Exactly one upstream call, to completions URL, with forwarded body + auth.
  assertEquals(captures.length, 1);
  const capture = captures[0];
  assertEquals(capture.url, COMPLETIONS_URL);
  assertEquals(capture.method, 'POST');
  assertEquals(capture.headers['x-api-key'], 'my-test-key');
  assertEquals(capture.headers['x-request-id'], 'req-42');
  assertExists(capture.body);
  assertEquals(JSON.parse(capture.body!), payload);
});

Deno.test('chat: POST /chat (empty subpath) forwards to completions', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({
    captures,
    status: 200,
    body: JSON.stringify({ ok: true }),
  }));

  const response = await handler(
    makeRequest('/chat', {
      method: 'POST',
      headers: { 'x-api-key': 'key-123' },
      body: { model: 'rose-labs/rose-1-lite', messages: [] },
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(captures.length, 1);
  assertEquals(captures[0].url, COMPLETIONS_URL);
  assertEquals(captures[0].headers['x-api-key'], 'key-123');
});

Deno.test('chat: GET /chat/completions with no body does NOT send an upstream body', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({
    captures,
    status: 200,
    body: JSON.stringify({ ok: true }),
  }));

  await handler(makeRequest('/chat/completions', { method: 'GET' }));

  assertEquals(captures.length, 1);
  assertEquals(captures[0].method, 'GET');
  // Empty body → init.body is undefined → stub records undefined.
  assertEquals(captures[0].body, undefined);
});

Deno.test('chat: upstream 401 passthrough preserves status and body', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({
    captures,
    status: 401,
    body: JSON.stringify({ error: 'Missing API key' }),
  }));

  const response = await handler(
    makeRequest('/chat/completions', {
      method: 'POST',
      body: { model: 'rose-labs/rose-1-lite', messages: [] },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 401);
  assertEquals(data.error, 'Missing API key');
  assertEquals(captures.length, 1);
});

Deno.test('chat: upstream 400 validation error is passed through', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({
    captures,
    status: 400,
    body: JSON.stringify({ error: 'Missing required field: model' }),
  }));

  const response = await handler(
    makeRequest('/chat/completions', {
      method: 'POST',
      headers: { 'x-api-key': 'k' },
      body: { messages: [] },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 400);
  assertEquals(data.error, 'Missing required field: model');
  assertEquals(captures.length, 1);
});

Deno.test('chat: upstream 500 error is passed through verbatim', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({
    captures,
    status: 500,
    body: JSON.stringify({ error: 'Upstream on fire' }),
  }));

  const response = await handler(
    makeRequest('/chat/completions', {
      method: 'POST',
      body: { model: 'x', messages: [] },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 500);
  assertEquals(data.error, 'Upstream on fire');
});

// ============================================================================
// Transport failure — fetch throws
// ============================================================================

Deno.test('chat: upstream fetch throw surfaces as 500 { error: "Internal server error" }', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({
    captures,
    throws: new Error('ECONNREFUSED: upstream unreachable'),
  }));

  const response = await handler(
    makeRequest('/chat/completions', {
      method: 'POST',
      body: { model: 'x', messages: [] },
    }),
  );
  const data = await parseJson(response);

  assertEquals(response.status, 500);
  assertEquals(data.error, 'Internal server error');
  assertEquals(response.headers.get('Content-Type'), 'application/json');
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  // Fetch was attempted exactly once before throwing.
  assertEquals(captures.length, 1);
});

// ============================================================================
// Boundary call ordering + shape
// ============================================================================

Deno.test('chat: boundary - fetch is called exactly once for a valid request', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({
    captures,
    status: 200,
    body: JSON.stringify({ ok: true }),
  }));

  await handler(
    makeRequest('/chat/completions', {
      method: 'POST',
      body: { model: 'x', messages: [] },
    }),
  );

  assertEquals(captures.length, 1);
  assertEquals(captures[0].url, COMPLETIONS_URL);
});

Deno.test('chat: boundary - fetch target URL comes from injected getCompletionsUrl()', async () => {
  const captures: FetchCapture[] = [];
  const customUrl = 'https://alt.example/functions/v1/completions';
  const deps: ChatServiceDeps = {
    fetch: createFetchStub({ captures, status: 200, body: '{}' }),
    getCompletionsUrl: () => customUrl,
  };
  const handler = createHandler(deps);

  await handler(
    makeRequest('/chat/completions', {
      method: 'POST',
      body: { model: 'x', messages: [] },
    }),
  );

  assertEquals(captures.length, 1);
  assertEquals(captures[0].url, customUrl);
});

Deno.test('chat: boundary - no fetch happens on OPTIONS or 404 paths', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  await handler(new Request(`${BASE_URL}/chat/completions`, { method: 'OPTIONS' }));
  await handler(makeRequest('/chat/unknown'));
  await handler(makeRequest('/chat/foo/bar', { method: 'POST', body: {} }));

  assertEquals(captures.length, 0);
});

// ============================================================================
// Cross-cutting invariants
// ============================================================================

Deno.test('invariant: all error responses have { error: string } shape', async () => {
  const scenarios: { name: string; response: Response }[] = [];

  const h1 = createHandler(buildDeps({ captures: [] }));
  scenarios.push({
    name: 'unknown subpath 404',
    response: await h1(makeRequest('/chat/unknown')),
  });

  const h2 = createHandler(buildDeps({
    captures: [],
    throws: new Error('boom'),
  }));
  scenarios.push({
    name: 'upstream throw 500',
    response: await h2(
      makeRequest('/chat/completions', {
        method: 'POST',
        body: { model: 'x', messages: [] },
      }),
    ),
  });

  for (const { name, response } of scenarios) {
    const data = await parseJson(response);
    assertEquals(typeof data.error, 'string', `${name}: error field must be a string`);
  }
});

Deno.test('invariant: CORS header present on every response variant', async () => {
  const variants: Response[] = [];

  const h1 = createHandler(buildDeps({ captures: [] }));
  variants.push(
    await h1(new Request(`${BASE_URL}/chat/completions`, { method: 'OPTIONS' })),
  );
  variants.push(await h1(makeRequest('/chat/unknown')));

  const h2 = createHandler(buildDeps({
    captures: [],
    throws: new Error('boom'),
  }));
  variants.push(
    await h2(
      makeRequest('/chat/completions', {
        method: 'POST',
        body: { model: 'x', messages: [] },
      }),
    ),
  );

  for (const r of variants) {
    assertEquals(
      r.headers.get('Access-Control-Allow-Origin'),
      '*',
      `CORS missing on ${r.status} response`,
    );
  }
});

Deno.test('invariant: same input produces same output shape (pure routing)', async () => {
  const results: string[] = [];
  for (let i = 0; i < 3; i++) {
    const handler = createHandler(buildDeps({ captures: [] }));
    const response = await handler(makeRequest('/chat/bad-path'));
    results.push(await response.text());
  }
  assertEquals(results[0], results[1]);
  assertEquals(results[1], results[2]);
});

Deno.test('invariant: 404 errors produce zero upstream fetch calls', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  const paths = ['/chat/unknown', '/chat/foo/bar', '/chat/x/y/z', '/chat/not-found'];
  for (const p of paths) {
    await handler(makeRequest(p));
  }

  assertEquals(captures.length, 0, 'No upstream fetches should happen for 404 paths');
});

Deno.test('invariant: OPTIONS produces zero upstream fetch calls', async () => {
  const captures: FetchCapture[] = [];
  const handler = createHandler(buildDeps({ captures }));

  const paths = ['/chat/completions', '/chat', '/chat/anything'];
  for (const p of paths) {
    await handler(new Request(`${BASE_URL}${p}`, { method: 'OPTIONS' }));
  }

  assertEquals(captures.length, 0);
});

// ============================================================================
// Default deps wiring
// ============================================================================

Deno.test('createHandler(): returns a handler when called with no deps', async () => {
  // Should not throw when instantiated with defaults. We only exercise the
  // OPTIONS branch so we don't touch the real network.
  const handler = createHandler();
  const response = await handler(
    new Request(`${BASE_URL}/chat/completions`, { method: 'OPTIONS' }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
});

// ============================================================================
// Config module — pure values + env reads
// ============================================================================

Deno.test('config: CORS_HEADERS advertises all forwarded custom headers', () => {
  const allowed = CORS_HEADERS['Access-Control-Allow-Headers'];
  assertExists(allowed);
  for (const h of ['authorization', 'apikey', 'x-api-key', 'x-agent-id', 'x-request-id']) {
    assertStringIncludes(allowed, h);
  }
  assertEquals(CORS_HEADERS['Access-Control-Allow-Origin'], '*');
});

Deno.test('config: CHAT_PATH_PREFIX strips the leading /chat segment', () => {
  assertEquals('/chat/completions'.replace(CHAT_PATH_PREFIX, ''), '/completions');
  assertEquals('/chat'.replace(CHAT_PATH_PREFIX, ''), '');
  // Non-matching paths are left intact.
  assertEquals('/not-chat/completions'.replace(CHAT_PATH_PREFIX, ''), '/not-chat/completions');
});

Deno.test('config: ALLOWED_SUBPATHS admits only /completions and empty', () => {
  assertEquals(ALLOWED_SUBPATHS.has('/completions'), true);
  assertEquals(ALLOWED_SUBPATHS.has(''), true);
  assertEquals(ALLOWED_SUBPATHS.has('/unknown'), false);
  assertEquals(ALLOWED_SUBPATHS.has('/chat/completions'), false);
});

Deno.test('config: getCompletionsUrl() builds on SUPABASE_URL at call time', () => {
  const prior = Deno.env.get('SUPABASE_URL');
  try {
    Deno.env.set('SUPABASE_URL', 'https://proj-a.supabase.co');
    assertEquals(getCompletionsUrl(), 'https://proj-a.supabase.co/functions/v1/completions');

    Deno.env.set('SUPABASE_URL', 'https://proj-b.supabase.co');
    assertEquals(getCompletionsUrl(), 'https://proj-b.supabase.co/functions/v1/completions');

    // Missing env falls back to empty base.
    Deno.env.delete('SUPABASE_URL');
    assertEquals(getCompletionsUrl(), '/functions/v1/completions');
  } finally {
    if (prior === undefined) Deno.env.delete('SUPABASE_URL');
    else Deno.env.set('SUPABASE_URL', prior);
  }
});
