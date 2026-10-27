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
 *   PUT    /cache          — seed one replay entry in memory and on disk
 *   DELETE /cache          — clear fast-forward cache (forces re-record on next run)
 *
 * Activation: BLACKBOX_TEST_CAPTURE_OUTBOUND=1 before server boot. Replay is a
 * separate opt-in via BLACKBOX_TEST_REPLAY_OUTBOUND=1.
 * Only intended for isolated blackbox test backends — never in production.
 *
 * Binary responses (`image/*`, `application/pdf`, …) are stored as base64 so
 * capture/replay does not UTF-8-corrupt attachment bytes used by E2B uploads.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { isPhoneHarnessExchange, credentialMetadataUrl } from './fetchCapturePrivacy';
import { responseFromSerialized, type SerializedResponse } from './fetchCaptureResponse';
import { resolve } from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { fastForward as ff } from '@with-logic/fast-forward';
import { NonBlockingFileCache } from './nonBlockingFetchCache';
import {
  markMessagingFetchFakesInstalled,
  mockAgentPhoneMessageId,
  buildMockSurgeFetchResponse,
} from './smsTransportMock';

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

/**
 * Content types whose bodies must not pass through `response.text()` — that path
 * UTF-8-decodes with U+FFFD replacement and permanently corrupts JPEGs/PDFs/etc.
 * Benchmark stacks enable capture by default (`BLACKBOX_TEST_CAPTURE_OUTBOUND=1`),
 * so this boundary sits on the real attachment → E2B upload path.
 *
 * Prefer an allowlist for *text* decoding: missing/unknown content-types are
 * treated as binary. Supabase Storage occasionally omits Content-Type on
 * signed-URL downloads; treating those as text reintroduced the 207364→369851
 * JPEG corruption on fleet after the image/* fix landed.
 */
export function isBinaryContentType(contentType: string | null | undefined): boolean {
  return !isTextContentType(contentType);
}

/** Only these content-types may safely go through `response.text()`. */
export function isTextContentType(contentType: string | null | undefined): boolean {
  if (contentType === null || contentType === undefined || contentType === '') return false;
  const ct = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (ct.startsWith('text/')) return true;
  if (ct === 'application/json') return true;
  if (ct === 'application/ld+json') return true;
  if (ct === 'application/xml' || ct === 'text/xml' || ct.endsWith('+xml')) return true;
  if (ct === 'application/javascript' || ct === 'application/x-javascript') return true;
  if (ct === 'application/xhtml+xml') return true;
  if (ct === 'application/graphql' || ct === 'application/graphql+json') return true;
  if (ct === 'application/x-www-form-urlencoded') return true;
  if (ct === 'application/problem+json') return true;
  return false;
}

/**
 * Detect the classic fetchCapture `response.text()` JPEG corruption signature:
 * UTF-8 replacement sequences (EF BF BD) dominating a buffer that should be
 * binary (no JPEG/PNG SOI). Used as a last-line guard before E2B upload.
 *
 * PDF magic alone is not enough to skip the scan — a `%PDF` prefix can survive
 * UTF-8 replacement while the rest of the stream is corrupted.
 */
export function looksLikeUtf8ReplacementCorruption(buf: Buffer): boolean {
  if (buf.length < 16) return false;
  // Intact image magic → not this failure mode.
  if (buf[0] === 0xff && buf[1] === 0xd8) return false; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return false; // PNG
  const fffd = Buffer.from([0xef, 0xbf, 0xbd]);
  let count = 0;
  for (let i = 0; i <= buf.length - 3; i++) {
    if (buf[i] === fffd[0] && buf[i + 1] === fffd[1] && buf[i + 2] === fffd[2]) {
      count += 1;
      i += 2;
    }
  }
  // Classic rs.jpeg case: 82673 / 369851 ≈ 22% of bytes are the 3-byte sequence.
  return count >= 100 && count * 3 >= Math.floor(buf.length * 0.15);
}

export function isRetryableOutboundResponseStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function outboundReplayCacheKey(url: string, method: string, body: string | null): string {
  if (isCredentialExchange(url)) {
    return `call:${JSON.stringify([credentialMetadataUrl(url), method, null])}`;
  }
  return `call:${JSON.stringify([url, method, body])}`;
}

function isCredentialExchange(url: string): boolean {
  try {
    if (isPhoneHarnessExchange(url)) return true;
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return (
      path === '/oauth/token' ||
      path === '/v1/oauth/token' ||
      /^\/api\/integrations\/(lantern-people|claude-code|gpt-code|compute-code)\/credentials\/(token|upload)$/.test(
        path
      )
    );
  } catch {
    return false;
  }
}

class NonReplayableResponseError extends Error {
  constructor(readonly response: SerializedResponse) {
    super(`Outbound response ${response.status} must not be replayed`);
    this.name = 'NonReplayableResponseError';
  }
}

/**
 * Thin adapter around real fetch — fast-forward wraps this to cache `call()` results.
 */
class FetchReplayClient {
  private originalFetch: typeof globalThis.fetch;

  constructor(original: typeof globalThis.fetch) {
    this.originalFetch = original;
  }

  private async request(
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

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    const contentType =
      responseHeaders['content-type'] ??
      responseHeaders['Content-Type'] ??
      response.headers.get('content-type');

    // Binary / unknown content-types must round-trip as raw bytes. `response.text()`
    // UTF-8-decodes with replacement characters (U+FFFD), expanding a 207KB JPEG
    // into ~370KB of corrupted text — the files-in-sub-agents / Claude Code
    // attachment failure mode. Only known text types use `.text()`.
    if (!isTextContentType(contentType)) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        statusText: response.statusText,
        body: bytes.toString('base64'),
        headers: responseHeaders,
        bodyEncoding: 'base64',
      };
    }

    const responseBody = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      body: responseBody,
      headers: responseHeaders,
    };
  }

  async call(
    url: string,
    method: string,
    headers: string,
    body: string | null
  ): Promise<SerializedResponse> {
    const response = await this.request(url, method, headers, body);
    if (isRetryableOutboundResponseStatus(response.status)) {
      // fast-forward persists fulfilled return values. Throwing keeps transient
      // provider failures out of the replay cache; the wrapper below converts
      // this sentinel back into normal fetch Response semantics.
      throw new NonReplayableResponseError(response);
    }
    return response;
  }

  callUncached(
    url: string,
    method: string,
    headers: string,
    body: string | null
  ): Promise<SerializedResponse> {
    return this.request(url, method, headers, body);
  }
}

const captures: CapturedCall[] = [];
let nextId = 1;
let nextRequestId = 1;
let fsCache: NonBlockingFileCache | null = null;

// Cursor IDs follow publication, so an earlier slow request cannot appear
// behind a cursor that already observed a later, faster request.
function publishCapture(entry: Omit<CapturedCall, 'id'>): void {
  captures.push({ ...entry, id: nextId++ });
}

/** Tilion's API host, including a TILION_BASE_URL override (staging, local fake). */
function isTilionHost(hostname: string): boolean {
  if (hostname === 'back.tilion.dev') return true;
  const configured = process.env.TILION_BASE_URL?.trim();
  if (!configured) return false;
  try {
    return new URL(configured).hostname.toLowerCase() === hostname;
  } catch {
    return false;
  }
}

/** Control-plane calls create mutable remote resources and must never be replayed. */
export function shouldBypassOutboundReplay(url: string): boolean {
  if (isCredentialExchange(url)) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'e2b.app' ||
      hostname.endsWith('.e2b.app') ||
      hostname === 'api.onkernel.com' ||
      hostname === 'api.browser-use.com' ||
      isTilionHost(hostname) ||
      hostname === 'amplitude.com' ||
      hostname === 'analytics.eu.amplitude.com'
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

  markMessagingFetchFakesInstalled();
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
    const credentialExchange = isCredentialExchange(url);
    if (!isOutbound && !credentialExchange) {
      return originalFetch(input, init);
    }

    const resolveMethod = (): string => {
      const raw =
        init?.method ??
        (typeof globalThis.Request === 'function' && input instanceof globalThis.Request
          ? input.method
          : 'GET');
      const trimmed = String(raw || 'GET').trim();
      const upper = trimmed.toUpperCase();
      // Fetch canonicalizes the standard method tokens; preserve custom methods.
      const standard = new Set('GET HEAD POST PUT DELETE CONNECT OPTIONS TRACE PATCH'.split(' '));
      return standard.has(upper) ? upper : trimmed || 'GET';
    };

    // Mutable control-plane calls bypass replay. E2B also uses Request objects
    // with streaming bodies that cannot round-trip through the string cache.
    // Captures are still recorded for outbound boundary assertions.
    const id = nextRequestId++;
    if (shouldBypassOutboundReplay(url)) {
      const captureStart = Date.now();
      const entry: Omit<CapturedCall, 'id'> = {
        timestamp: new Date().toISOString(),
        url: credentialExchange ? credentialMetadataUrl(url) : url,
        method: resolveMethod(),
        requestHeaders: {},
        requestBody: null,
        responseStatus: null,
        responseBody: null,
        durationMs: 0,
        error: null,
        cached: false,
        captureToken: captureTokenStore.getStore() ?? null,
      };
      try {
        const response = await originalFetch(input, init);
        entry.responseStatus = response.status;
        return response;
      } catch (err) {
        entry.error = credentialExchange
          ? 'Credential exchange failed'
          : err instanceof Error
            ? err.message
            : String(err);
        throw err;
      } finally {
        entry.durationMs = Date.now() - captureStart;
        publishCapture(entry);
      }
    }

    const start = Date.now();
    const method = resolveMethod();

    // Serialize request body (init.body, else Request body for fake markers).
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
    } else if (
      typeof globalThis.Request === 'function' &&
      input instanceof globalThis.Request &&
      method.toUpperCase() !== 'GET' &&
      method.toUpperCase() !== 'HEAD'
    ) {
      try {
        requestBody = await input.clone().text();
      } catch {
        requestBody = null;
        bodySerializable = false;
      }
    }

    // Non-serializable bodies (FormData, Blob, ArrayBuffer — e.g. multipart
    // STT uploads) cannot round-trip through the string-based cache layer.
    // Replaying them would send the literal string "[non-string body]" to the
    // real API. Pass the original request through untouched and record a
    // capture entry so boundary assertions still see the outbound call.
    if (!bodySerializable) {
      const passthroughEntry: Omit<CapturedCall, 'id'> = {
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
        publishCapture(passthroughEntry);
        return response;
      } catch (err) {
        passthroughEntry.durationMs = Date.now() - start;
        passthroughEntry.error = err instanceof Error ? err.message : String(err);
        publishCapture(passthroughEntry);
        throw err;
      }
    }

    // Collect full headers for the real call. Request headers come first so
    // absent/partial init.headers still preserve Authorization/Content-Type on
    // replay; init then overrides on conflict.
    const fullHeaders: Record<string, string> = {};
    if (typeof globalThis.Request === 'function' && input instanceof globalThis.Request) {
      assignHeadersInto(fullHeaders, input.headers);
    }
    assignHeadersInto(fullHeaders, init?.headers);

    // Redacted headers for the capture log (visible to tests)
    const redactedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(fullHeaders)) {
      redactedHeaders[k] = redactHeader(k, v);
    }

    const entry: Omit<CapturedCall, 'id'> = {
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
      const response = buildMockSurgeFetchResponse(requestBody);
      entry.durationMs = Date.now() - start;
      entry.responseStatus = response.status;
      entry.responseBody = await response.clone().text();
      publishCapture(entry);
      return response;
    }

    if (
      process.env.BLACKBOX_TEST_FAKE_WHATSAPP === '1' &&
      new URL(url).hostname === 'graph.facebook.com' &&
      new URL(url).pathname.endsWith('/messages') &&
      method.toUpperCase() === 'POST'
    ) {
      const unavailable = requestBody?.includes('__BLACKBOX_WHATSAPP_503__') === true;
      const status = unavailable ? 503 : 200;
      const body = unavailable
        ? JSON.stringify({ error: { message: 'blackbox fake WhatsApp unavailable' } })
        : JSON.stringify({ messages: [{ id: `blackbox-whatsapp-message-${String(id)}` }] });
      entry.durationMs = Date.now() - start;
      entry.responseStatus = status;
      entry.responseBody = body;
      publishCapture(entry);

      return new globalThis.Response(body, {
        status,
        statusText: unavailable ? 'Service Unavailable' : 'OK',
        headers: { 'content-type': 'application/json' },
      });
    }

    if (
      process.env.BLACKBOX_TEST_FAKE_SLACK === '1' &&
      new URL(url).hostname === 'slack.com' &&
      new URL(url).pathname.startsWith('/api/') &&
      method.toUpperCase() === 'POST'
    ) {
      // Slack Web API writes (chat.postMessage, reactions.add) answer like Slack:
      // HTTP 200 with `ok`, plus a message handle for posts. Tests assert the
      // captured request bodies; no call leaves the machine.
      let channel = 'C0BLACKBOX0';
      try {
        const parsed: unknown = JSON.parse(requestBody ?? '{}');
        if (parsed !== null && typeof parsed === 'object' && 'channel' in parsed) {
          channel = String((parsed as { channel: unknown }).channel);
        }
      } catch {
        // Non-JSON bodies keep the placeholder channel.
      }
      const body = JSON.stringify({
        ok: true,
        channel,
        ts: `1800000000.${String(id % 1_000_000).padStart(6, '0')}`,
      });
      entry.durationMs = Date.now() - start;
      entry.responseStatus = 200;
      entry.responseBody = body;
      publishCapture(entry);
      return new globalThis.Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    }

    const agentPhoneHost = new URL(url).hostname;
    if (
      process.env.BLACKBOX_TEST_FAKE_AGENTPHONE === '1' &&
      (agentPhoneHost === 'agentphone.ai' ||
        agentPhoneHost === 'api.agentphone.ai' ||
        agentPhoneHost.endsWith('.agentphone.ai')) &&
      new URL(url).pathname.endsWith('/messages') &&
      method.toUpperCase() === 'POST'
    ) {
      let parsedBody: Record<string, unknown> = {};
      if (requestBody) {
        try {
          const parsed: unknown = JSON.parse(requestBody);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedBody = parsed as Record<string, unknown>;
          }
        } catch {
          parsedBody = {};
        }
      }
      const toNumber =
        typeof parsedBody.to_number === 'string' ? parsedBody.to_number : '+10000000000';
      const fromNumber =
        typeof parsedBody.from_number === 'string' ? parsedBody.from_number : '+10000000001';
      const messageId = mockAgentPhoneMessageId(`capture:${requestBody ?? ''}`);
      const body = JSON.stringify({
        id: messageId,
        status: 'sent',
        channel: 'sms',
        from_number: fromNumber,
        to_number: toNumber,
        conversation_id: `conv_${messageId.slice(-8)}`,
      });
      entry.durationMs = Date.now() - start;
      entry.responseStatus = 200;
      entry.responseBody = body;
      publishCapture(entry);

      return new globalThis.Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    }

    // Twilio Verify sends a real OTP SMS. Seeded replay fixtures keep their
    // exact provider shape; anything unseeded gets a pending verification.
    if (
      process.env.BLACKBOX_TEST_FAKE_TWILIO === '1' &&
      new URL(url).hostname === 'verify.twilio.com' &&
      new URL(url).pathname.endsWith('/Verifications') &&
      method.toUpperCase() === 'POST' &&
      !(
        replayEnabled &&
        fsCache !== null &&
        (await fsCache.has(outboundReplayCacheKey(url, method, requestBody)))
      )
    ) {
      const to = new URLSearchParams(requestBody ?? '').get('To') ?? '';
      const body = JSON.stringify({
        sid: `VE${createHash('sha256')
          .update(`capture:${requestBody ?? ''}`)
          .digest('hex')
          .slice(0, 32)}`,
        status: 'pending',
        to,
        channel: 'sms',
        valid: false,
      });
      entry.durationMs = Date.now() - start;
      entry.responseStatus = 201;
      entry.responseBody = body;
      publishCapture(entry);

      return new globalThis.Response(body, {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
      });
    }

    // AgentCard MCP is a stateful payment boundary. Replaying tools/call responses
    // (especially list_transfers) can hide a card issued seconds earlier and make
    // the benchmark exercise stale financial state. Preserve capture metadata but
    // always read the provider's current response.
    if (url.includes('agentcard.sh')) {
      try {
        const response = await originalFetch(input, init);
        entry.durationMs = Date.now() - start;
        entry.responseStatus = response.status;
        publishCapture(entry);
        return response;
      } catch (err) {
        entry.durationMs = Date.now() - start;
        entry.error = err instanceof Error ? err.message : String(err);
        publishCapture(entry);
        throw err;
      }
    }

    try {
      const headersJson = JSON.stringify(fullHeaders);

      // Real benchmarks capture pass-through traffic but must observe mutable
      // provider state. Only explicit blackbox runs opt into replay.
      const cacheKey = outboundReplayCacheKey(url, method, requestBody);
      const wasCached = replayEnabled && fsCache ? await fsCache.has(cacheKey) : false;

      let serialized: SerializedResponse;
      try {
        serialized = replayEnabled
          ? await cachedClient.call(url, method, headersJson, requestBody)
          : await rawClient.callUncached(url, method, headersJson, requestBody);
      } catch (error) {
        if (!(error instanceof NonReplayableResponseError)) throw error;
        serialized = error.response;
      }

      entry.durationMs = Date.now() - start;
      entry.responseStatus = serialized.status;
      entry.cached = wasCached;

      // Store response body in capture (truncated)
      entry.responseBody = serialized.body;
      if (entry.responseBody.length > 2000) {
        entry.responseBody = entry.responseBody.slice(0, 2000) + '...[truncated]';
      }

      publishCapture(entry);

      // Reconstruct a Response object from the serialized data (base64 for binary).
      return responseFromSerialized(serialized);
    } catch (err) {
      entry.durationMs = Date.now() - start;
      entry.error = err instanceof Error ? err.message : String(err);
      publishCapture(entry);
      throw err;
    }
  };

  // Build router for test endpoints
  const router = Router();

  // Existing-backend blackbox runners must be able to distinguish capture-only
  // benchmark stacks from fixture-replay stacks before they execute seeded
  // provider cases. Keep the capability explicit instead of making callers
  // infer replay support from the existence of the capture endpoint.
  router.get('/status', (_req: Request, res: Response) => {
    res.json({ captureEnabled: true, replayEnabled });
  });

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

  // PUT /cache — seed a deterministic fixture through the live cache instance.
  // Writing only the cache file is insufficient if this key was already read:
  // NonBlockingFileCache intentionally memoizes hits for the process lifetime.
  router.put('/cache', (req: Request, res: Response) => {
    const body = req.body as { key?: unknown; value?: unknown } | undefined;
    if (!replayEnabled || fsCache === null) {
      res.status(409).json({ error: 'Outbound replay is not enabled' });
      return;
    }
    if (typeof body?.key !== 'string' || body.key === '' || !('value' in body)) {
      res.status(400).json({ error: 'key must be a non-empty string and value is required' });
      return;
    }

    fsCache.set(body.key, body.value);
    res.json({ seeded: true });
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

function assignHeadersInto(target: Record<string, string>, rawHeaders: unknown): void {
  if (!rawHeaders) return;
  const apply = (key: string, value: string): void => {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(target)) {
      if (existing.toLowerCase() === lower) {
        delete target[existing];
      }
    }
    target[key] = value;
  };
  if (typeof Headers !== 'undefined' && rawHeaders instanceof Headers) {
    rawHeaders.forEach((v, k) => {
      apply(k, v);
    });
  } else if (Array.isArray(rawHeaders)) {
    for (const entry of rawHeaders) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      apply(String(entry[0]), String(entry[1]));
    }
  } else if (typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
      apply(k, v);
    }
  }
}

function redactHeader(key: string, value: string): string {
  const sensitive =
    'authorization apikey x-api-key x-supermemory-api-key x-perplexity-key cookie set-cookie'.split(
      ' '
    );
  return sensitive.includes(key.toLowerCase()) ? '[redacted]' : value;
}
