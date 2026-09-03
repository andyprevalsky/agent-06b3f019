import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { createLogger } from '../../providers/logger';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS_CODES,
} from './config';
import { ExternalHttpRequestFailedError, InvalidExternalHttpRequestError } from './errors';
import type { ExternalHttpRequestBody, ExternalHttpResponseBody, HttpMethod } from './types';
import {
  assertFetchableExternalUrl,
  isBlockedExternalAddress,
  normalizeExternalHttpRequest,
} from './validate';

const log = createLogger('ExternalHttp');

const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'HEAD']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendQueryParams(url: string, query?: ExternalHttpRequestBody['query']): string {
  if (query === undefined || query === null) {
    return url;
  }

  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_DELAY_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), MAX_RETRY_DELAY_MS));
  }
  return null;
}

function retryDelayMs(response: Response | null, attempt: number): number {
  if (response !== null) {
    const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
    if (retryAfter !== null) {
      return retryAfter;
    }
  }
  const exponential = INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, MAX_RETRY_DELAY_MS);
}

function shouldRetryResponse(response: Response): boolean {
  return RETRYABLE_STATUS_CODES.has(response.status);
}

function hasIdempotencyKey(headers?: Record<string, string>): boolean {
  if (headers === undefined) {
    return false;
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === 'idempotency-key');
}

function canRetryMethod(method: HttpMethod, headers?: Record<string, string>): boolean {
  return IDEMPOTENT_METHODS.has(method) || hasIdempotencyKey(headers);
}

async function assertUrlResolvesToPublicAddress(url: string): Promise<void> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    if (isBlockedExternalAddress(host)) {
      throw new InvalidExternalHttpRequestError(
        `api_request cannot fetch ${JSON.stringify(url)}: ${host} is a non-public address. Pass an absolute http(s) URL.`
      );
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidExternalHttpRequestError(
      `api_request cannot fetch ${JSON.stringify(url)}: DNS lookup failed for ${host} (${message}). Pass an absolute http(s) URL.`
    );
  }

  if (addresses.length === 0) {
    throw new InvalidExternalHttpRequestError(
      `api_request cannot fetch ${JSON.stringify(url)}: ${host} did not resolve to any address. Pass an absolute http(s) URL.`
    );
  }

  for (const { address } of addresses) {
    if (isBlockedExternalAddress(address)) {
      throw new InvalidExternalHttpRequestError(
        `api_request cannot fetch ${JSON.stringify(url)}: ${host} resolves to non-public address ${address}. Pass an absolute http(s) URL.`
      );
    }
  }
}

async function readBoundedResponseBuffer(response: Response): Promise<Buffer> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null && contentLengthHeader.trim() !== '') {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExternalHttpRequestFailedError(
        `External HTTP response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`,
        response.status,
        null
      );
    }
  }

  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExternalHttpRequestFailedError(
        `External HTTP response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`,
        response.status,
        null
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function readResponseBody(response: Response): Promise<{
  body: unknown;
  body_encoding: ExternalHttpResponseBody['body_encoding'];
  content_type: string | null;
}> {
  const contentType = response.headers.get('content-type');
  const buffer = await readBoundedResponseBuffer(response);

  if (buffer.length === 0) {
    return { body: '', body_encoding: 'text', content_type: contentType };
  }

  const normalizedType = (contentType ?? '').toLowerCase();
  const text = buffer.toString('utf8');

  if (
    normalizedType.includes('application/json') ||
    normalizedType.includes('+json') ||
    text.trimStart().startsWith('{') ||
    text.trimStart().startsWith('[')
  ) {
    try {
      return { body: JSON.parse(text), body_encoding: 'json', content_type: contentType };
    } catch {
      return { body: text, body_encoding: 'text', content_type: contentType };
    }
  }

  if (
    normalizedType.startsWith('text/') ||
    normalizedType.includes('xml') ||
    normalizedType.includes('javascript')
  ) {
    return { body: text, body_encoding: 'text', content_type: contentType };
  }

  return {
    body: buffer.toString('base64'),
    body_encoding: 'base64',
    content_type: contentType,
  };
}

function buildFetchInit(request: ExternalHttpRequestBody): RequestInit {
  const headers = new Headers(request.headers ?? {});
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };

  if (request.method === 'GET' || request.method === 'HEAD') {
    return init;
  }

  if (request.body === undefined || request.body === null) {
    return init;
  }

  if (typeof request.body === 'string') {
    init.body = request.body;
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain; charset=utf-8');
    }
    return init;
  }

  init.body = JSON.stringify(request.body);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return init;
}

async function fetchWithValidatedRedirects(
  startUrl: string,
  init: RequestInit
): Promise<Response> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertFetchableExternalUrl(currentUrl);
    await assertUrlResolvesToPublicAddress(currentUrl);

    const response = await fetch(currentUrl, init);
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return response;
    }

    const location = response.headers.get('location');
    if (location === null || location.trim() === '') {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new ExternalHttpRequestFailedError(
    `External HTTP request exceeded ${MAX_REDIRECTS} redirects`
  );
}

export async function executeExternalHttpRequest(
  rawRequest: ExternalHttpRequestBody
): Promise<ExternalHttpResponseBody> {
  const request = normalizeExternalHttpRequest(rawRequest);
  const finalUrl = appendQueryParams(request.url, request.query);
  const init = buildFetchInit(request);
  const retriesAllowed = canRetryMethod(request.method, request.headers);
  const maxAttempts = retriesAllowed ? MAX_ATTEMPTS : 1;

  let lastError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetchWithValidatedRedirects(finalUrl, init);
      lastResponse = response;

      if (retriesAllowed && shouldRetryResponse(response) && attempt < maxAttempts) {
        const delay = retryDelayMs(response, attempt);
        log.warn('Retrying external HTTP request after retryable status', {
          url: finalUrl,
          status: response.status,
          attempt,
          delay_ms: delay,
        });
        await response.body?.cancel().catch(() => undefined);
        await sleep(delay);
        continue;
      }

      const parsed = await readResponseBody(response);
      const elapsedMs = Date.now() - started;

      return {
        ok: response.ok,
        status: response.status,
        status_text: response.statusText,
        url: response.url || finalUrl,
        headers: headersToRecord(response.headers),
        body: parsed.body,
        body_encoding: parsed.body_encoding,
        content_type: parsed.content_type,
        elapsed_ms: elapsedMs,
        attempts: attempt,
      };
    } catch (error) {
      if (error instanceof InvalidExternalHttpRequestError) {
        throw error;
      }
      if (error instanceof ExternalHttpRequestFailedError) {
        throw error;
      }
      lastError = error;
      if (!retriesAllowed || attempt >= maxAttempts) {
        break;
      }
      const delay = retryDelayMs(lastResponse, attempt);
      log.warn('Retrying external HTTP request after transport error', {
        url: finalUrl,
        attempt,
        delay_ms: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }

  if (lastResponse !== null) {
    let parsedBody: unknown = null;
    try {
      const parsed = await readResponseBody(lastResponse);
      parsedBody = parsed.body;
    } catch {
      parsedBody = null;
    }
    throw new ExternalHttpRequestFailedError(
      `External HTTP request failed with status ${lastResponse.status}`,
      lastResponse.status,
      parsedBody
    );
  }

  throw new ExternalHttpRequestFailedError(
    `External HTTP request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
