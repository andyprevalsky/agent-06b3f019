/**
 * Fetch Capture + Replay — test-only global fetch interceptor with fast-forward caching.
 *
 * When active (BLACKBOX_TEST_CAPTURE_OUTBOUND=1), wraps the global `fetch` to:
 * 1. Record every outbound HTTP call (URL, method, headers, body, response) for test assertions
 * 2. Cache responses via @with-logic/fast-forward FileSystemCache so subsequent runs
 *    replay from cache instead of hitting real third-party APIs
 *
 * First run:  real outbound calls are made, responses cached to .context/fast-forward-cache/
 * Later runs: cached responses are returned instantly — no real API calls.
 * Tests always see capture entries regardless of cache hit/miss.
 *
 * REST endpoints (mounted at /api/test/captures):
 *   GET    /               — list captured calls (with ?after=N filtering)
 *   DELETE /               — clear capture log (resets in-memory list, not cache)
 *   DELETE /cache          — clear fast-forward cache (forces re-record on next run)
 *
 * Activation: BLACKBOX_TEST_CAPTURE_OUTBOUND=1 before server boot.
 * Only intended for isolated blackbox test backends — never in production.
 */

import { Router, Request, Response } from 'express';
import { resolve } from 'path';
import { fastForward as ff, FileSystemCache } from '@with-logic/fast-forward';

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

let captures: CapturedCall[] = [];
let nextId = 1;
let fsCache: FileSystemCache | null = null;

/**
 * Install the global fetch wrapper with fast-forward replay cache.
 * Call once at server startup. Returns the Express router for capture endpoints.
 */
export function installFetchCapture(): Router {
  const originalFetch = globalThis.fetch;

  // Set up fast-forward with persistent filesystem cache
  const cacheDir = resolve(__dirname, '../../../.context/fast-forward-cache');
  fsCache = new FileSystemCache({ cacheDir, namespace: 'outbound-fetch' });

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

    const id = nextId++;
    const start = Date.now();
    const method = init?.method ?? 'GET';

    // Serialize request body
    let requestBody: string | null = null;
    if (init?.body !== undefined && init?.body !== null) {
      if (typeof init.body === 'string') {
        requestBody = init.body;
      } else if (init.body instanceof URLSearchParams) {
        requestBody = init.body.toString();
      } else {
        requestBody = '[non-string body]';
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
    };

    try {
      const headersJson = JSON.stringify(fullHeaders);

      // Check if fast-forward has a cached response (pre-flight check)
      const cacheKey = JSON.stringify({ method: 'call', args: [url, method, requestBody] });
      const wasCached = fsCache ? await fsCache.has(cacheKey) : false;

      // Call through fast-forward — cache hit returns instantly, miss makes real call
      const serialized: SerializedResponse = await cachedClient.call(
        url,
        method,
        headersJson,
        requestBody
      );

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

  // GET / — return all or filtered captures
  router.get('/', (req: Request, res: Response) => {
    const afterId = req.query.after ? Number(req.query.after) : 0;
    const filtered = afterId > 0 ? captures.filter((c) => c.id > afterId) : captures;
    res.json({ captures: filtered, nextId });
  });

  // DELETE / — clear capture log (not cache)
  router.delete('/', (_req: Request, res: Response) => {
    captures = [];
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
