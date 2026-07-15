/**
 * Fetch Capture + Replay — test-only global fetch interceptor with fast-forward caching.
 *
 * When active (BLACKBOX_TEST_CAPTURE_OUTBOUND=1), wraps the global `fetch` to:
 * 1. Record every outbound HTTP call (URL, method, headers, body, response) for test assertions
 * 2. Optionally cache responses when BLACKBOX_TEST_REPLAY_OUTBOUND=1 so explicit
 *    blackbox runs can replay stable third-party fixtures.
 *
 * With replay enabled, the first run caches real outbound responses under
 * .context/fast-forward-cache/ and later runs return those fixtures instantly.
 * Tests always see capture entries regardless of cache hit/miss.
 *
 * REST endpoints (mounted at /api/test/captures):
 *   GET    /               — list captured calls (with ?after=N filtering)
 *   DELETE /               — clear capture log (resets in-memory list, not cache)
 *   DELETE /cache          — clear fast-forward cache (forces re-record on next run)
 *
 * Activation: BLACKBOX_TEST_CAPTURE_OUTBOUND=1 before server boot. Replay is a
 * separate opt-in via BLACKBOX_TEST_REPLAY_OUTBOUND=1.
 * Only intended for isolated blackbox test backends — never in production.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { resolve } from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fastForward as ff } from '@with-logic/fast-forward';
import { NonBlockingFileCache } from './nonBlockingFetchCache';

/**
 * AsyncLocalStorage for propagating a capture token from inbound HTTP requests
 * to outbound fetch calls. This lets tests filter captures to only those
 * triggered by their own request, avoiding interference from concurrent domains.
 */
const captureTokenStore = new AsyncLocalStorage<string>();

/**
 * Express middleware: reads X-Capture-Token header and runs the request
 * inside an AsyncLocalStorage context so outbound captures are tagged.
 * Mount this BEFORE routes when capture is enabled.
 */
export function captureTokenMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token = req.headers['x-capture-token'] as string | undefined;
  if (token) {
    captureTokenStore.run(token, () => next());
  } else {
    next();
  }
}

export interface CapturedCall {
  id: number;
  timestamp: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
  cached: boolean;
  captureToken: string | null;
}

interface SerializedResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * Thin adapter around real fetch — fast-forward wraps this to cache `call()` results.
 */
class FetchReplayClient {
  private originalFetch: typeof globalThis.fetch;

  constructor(original: typeof globalThis.fetch) {
    this.originalFetch = original;
  }

  async call(
    url: string,
    method: string,
    headers: string,
    body: string | null
  ): Promise<SerializedResponse> {
    const parsedHeaders = JSON.parse(headers) as Record<string, string>;
    const response = await this.originalFetch(url, {
      method,
      headers: parsedHeaders,
      body: body ?? undefined,
    });

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      body: responseBody,
      headers: responseHeaders,
    };
  }
}

const captures: CapturedCall[] = [];
let nextId = 1;
let fsCache: NonBlockingFileCache | null = null;

/** Control-plane calls create mutable remote resources and must never be replayed. */
export function shouldBypassOutboundReplay(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'e2b.app' || hostname.endsWith('.e2b.app') || hostname === 'api.onkernel.com'
    );
  } catch {
    return false;
  }
}

/**
 * Install the global fetch wrapper with fast-forward replay cache.
 * Call once at server startup. Returns the Express router for capture endpoints.
 */
export function installFetchCapture(): Router {
  const originalFetch = globalThis.fetch;
  const replayEnabled = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND === '1';

  // Set up fast-forward with persistent filesystem cache
  const cacheDir = resolve(__dirname, '../../../.context/fast-forward-cache');
  fsCache = new NonBlockingFileCache({ cacheDir, namespace: 'outbound-fetch' });

  const rawClient = new FetchReplayClient(originalFetch);

  // Key transformer: strip headers from cache key so auth token rotation
  // doesn't invalidate cached responses. Cache is keyed by URL + method + body.
  const keyTransformer = (_method: string, args: unknown[]) => {
    const [url, httpMethod, , body] = args;
    return { method: _method, args: [url, httpMethod, body] };
  };

  const cachedClient = ff(rawClient, { cache: fsCache, key: keyTransformer });

  globalThis.fetch = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit
  ): Promise<globalThis.Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as globalThis.Request).url;

    // Only intercept outbound calls (skip localhost/test-internal calls)
    const isOutbound = !url.includes('localhost') && !url.includes('127.0.0.1');
    if (!isOutbound) {
      return originalFetch(input, init);
    }

    // Mutable control-plane calls bypass replay. E2B also uses Request objects
    // with streaming bodies that cannot round-trip through the string cache.
    // Captures are still recorded for outbound boundary assertions.
    if (shouldBypassOutboundReplay(url)) {
      const captureId = nextId++;
      const captureStart = Date.now();
      const captureMethod = init?.method ?? 'GET';
      try {
        const response = await originalFetch(input, init);
        const entry: CapturedCall = {
          id: captureId,
          timestamp: new Date().toISOString(),
          url,
          method: captureMethod,
          requestHeaders: {},
          requestBody: null,
          responseStatus: response.status,
          responseBody: null,
          durationMs: Date.now() - captureStart,
          error: null,
          cached: false,
          captureToken: captureTokenStore.getStore() ?? null,
        };
        captures.push(entry);
        return response;
      } catch (err) {
        const entry: CapturedCall = {
          id: captureId,
          timestamp: new Date().toISOString(),
          url,
          method: captureMethod,
          requestHeaders: {},
          requestBody: null,
          responseStatus: null,
          responseBody: null,
          durationMs: Date.now() - captureStart,
          error: err instanceof Error ? err.message : String(err),
          cached: false,
          captureToken: captureTokenStore.getStore() ?? null,
        };
        captures.push(entry);
        throw err;
      }
    }

    const id = nextId++;
    const start = Date.now();
    const method = init?.method ?? 'GET';

    // Serialize request body
    let requestBody: string | null = null;
    let bodySerializable = true;
    if (init?.body !== undefined && init?.body !== null) {
      if (typeof init.body === 'string') {
        requestBody = init.body;
      } else if (init.body instanceof URLSearchParams) {
        requestBody = init.body.toString();
      } else {
        requestBody = '[non-string body]';
        bodySerializable = false;
      }
    }

    // Non-serializable bodies (FormData, Blob, ArrayBuffer — e.g. multipart
    // STT uploads) cannot round-trip through the string-based cache layer.
    // Replaying them would send the literal string "[non-string body]" to the
    // real API. Pass the original request through untouched and record a
    // capture entry so boundary assertions still see the outbound call.
    if (!bodySerializable) {
      const passthroughEntry: CapturedCall = {
        id,
        timestamp: new Date().toISOString(),
        url,
        method,
        requestHeaders: {},
        requestBody,
        responseStatus: null,
        responseBody: null,
        durationMs: 0,
        error: null,
        cached: false,
        captureToken: captureTokenStore.getStore() ?? null,
      };
      try {
        const response = await originalFetch(input, init);
        passthroughEntry.durationMs = Date.now() - start;
        passthroughEntry.responseStatus = response.status;
        captures.push(passthroughEntry);
        return response;
      } catch (err) {
        passthroughEntry.durationMs = Date.now() - start;
        passthroughEntry.error = err instanceof Error ? err.message : String(err);
        captures.push(passthroughEntry);
        throw err;
      }
    }

    // Collect full headers for the real call
    const fullHeaders: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          fullHeaders[k] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) {
          fullHeaders[k] = v;
        }
      } else {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
          fullHeaders[k] = v;
        }
      }
    }

    // Redacted headers for the capture log (visible to tests)
    const redactedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(fullHeaders)) {
      redactedHeaders[k] = redactHeader(k, v);
    }

    const entry: CapturedCall = {
      id,
      timestamp: new Date().toISOString(),
      url,
      method,
      requestHeaders: redactedHeaders,
      requestBody,
      responseStatus: null,
      responseBody: null,
      durationMs: 0,
      error: null,
      cached: false,
      captureToken: captureTokenStore.getStore() ?? null,
    };

    if (
      process.env.BLACKBOX_TEST_FAKE_SURGE === '1' &&
      url.includes('api.surge.app') &&
      url.includes('/messages')
    ) {
      if (requestBody?.includes('__BLACKBOX_SURGE_THROW__')) {
        throw new Error('blackbox fake Surge network failure');
      }
      if (requestBody?.includes('__BLACKBOX_SURGE_502__')) {
        const body = 'blackbox fake Surge upstream unavailable';
        entry.durationMs = Date.now() - start;
        entry.responseStatus = 502;
        entry.responseBody = body;
        captures.push(entry);

        return new globalThis.Response(body, {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/plain' },
        });
      }
      const body = JSON.stringify({ id: `blackbox-surge-message-${id}` });
      entry.durationMs = Date.now() - start;
      entry.responseStatus = 200;
      entry.responseBody = body;
      captures.push(entry);

      return new globalThis.Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    }

    try {
      const headersJson = JSON.stringify(fullHeaders);

      // Real benchmarks capture pass-through traffic but must observe mutable
      // provider state. Only explicit blackbox runs opt into replay.
      const cacheKey = JSON.stringify({ method: 'call', args: [url, method, requestBody] });
      const wasCached = replayEnabled && fsCache ? await fsCache.has(cacheKey) : false;

      const serialized: SerializedResponse = replayEnabled
        ? await cachedClient.call(url, method, headersJson, requestBody)
        : await rawClient.call(url, method, headersJson, requestBody);

      entry.durationMs = Date.now() - start;
      entry.responseStatus = serialized.status;
      entry.cached = wasCached;

      // Store response body in capture (truncated)
      entry.responseBody = serialized.body;
      if (entry.responseBody.length > 2000) {
        entry.responseBody = entry.responseBody.slice(0, 2000) + '...[truncated]';
      }

      captures.push(entry);

      // Reconstruct a Response object from the serialized data
      return new globalThis.Response(serialized.body, {
        status: serialized.status,
        statusText: serialized.statusText,
        headers: serialized.headers,
      });
    } catch (err) {
      entry.durationMs = Date.now() - start;
      entry.error = err instanceof Error ? err.message : String(err);
      captures.push(entry);
      throw err;
    }
  };

  // Build router for test endpoints
  const router = Router();

  // Soft-clear baseline: DELETE sets this so GET (without ?after) only returns
  // captures recorded after the clear. Cursor-based reads (?after=N) ignore it,
  // making them immune to concurrent clears from other test domains.
  let clearedAfterId = 0;

  // GET / — return captures (respects soft-clear baseline or explicit cursor)
  // Optional ?token= filters to only captures tagged with that token (for domain isolation).
  router.get('/', (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    const afterId = req.query.after ? Number(req.query.after) : token ? 0 : clearedAfterId;
    let filtered = afterId > 0 ? captures.filter((c) => c.id > afterId) : captures;
    if (token) {
      filtered = filtered.filter((c) => c.captureToken === token);
    }
    res.json({ captures: filtered, nextId });
  });

  // DELETE / — soft-clear capture log (sets baseline, does NOT wipe entries)
  router.delete('/', (_req: Request, res: Response) => {
    clearedAfterId = nextId - 1;
    res.json({ cleared: true, nextId });
  });

  // DELETE /cache — clear fast-forward cache to force re-record
  router.delete('/cache', async (_req: Request, res: Response) => {
    if (fsCache) {
      await fsCache.clear();
    }
    res.json({ cleared: true });
  });

  return router;
}

function redactHeader(key: string, value: string): string {
  const lower = key.toLowerCase();
  if (lower === 'authorization' || lower === 'apikey' || lower === 'x-api-key') {
    if (value.length > 16) {
      return value.slice(0, 16) + '...[redacted]';
    }
    return '[redacted]';
  }
  return value;
}
