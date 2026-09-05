/* eslint-disable max-lines -- request validation, retry, redirect, and bounded response handling form one security boundary */
import { lookup as lookupAtConnection } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

import { createLogger } from '../../providers/logger';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_REDIRECTS,
  MAX_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS_CODES,
} from './config';
import { ExternalHttpRequestFailedError, InvalidExternalHttpRequestError } from './errors';
import { readResponseBody } from './responseBody';
import type { ExternalHttpRequestBody, ExternalHttpResponseBody, HttpMethod } from './types';
import {
  assertFetchableExternalUrl,
  isBlockedExternalAddress,
  normalizeExternalHttpRequest,
} from './validate';

const log = createLogger('ExternalHttp');

const IDEMPOTENT_METHODS = new Set<HttpMethod>(['GET', 'HEAD']);
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-length', 'content-type'];

/**
 * Undici invokes this resolver while it opens the socket. Revalidating every
 * returned address here closes the DNS-rebinding gap between the friendly
 * validation error above and the connection that actually leaves the process.
 */
const lookupPublicAddressAtConnection: LookupFunction = (hostname, options, callback) => {
  lookupAtConnection(
    hostname,
    { all: true, verbatim: true, family: options.family },
    (error, addresses) => {
      const fail = (lookupError: NodeJS.ErrnoException | Error) => {
        if (options.all === true) callback(lookupError, []);
        else callback(lookupError, '', 0);
      };

      if (error) {
        fail(error);
        return;
      }
      try {
        assertPublicResolvedAddresses(hostname, addresses);
      } catch (addressError) {
        fail(addressError as Error);
        return;
      }

      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0];
      callback(null, first.address, first.family);
    }
  );
};

const publicAddressDispatcher = new Agent({
  connect: { lookup: lookupPublicAddressAtConnection },
});

export function assertPublicResolvedAddresses(
  hostname: string,
  addresses: Array<{ address: string }>
): void {
  if (addresses.length === 0) {
    throw new InvalidExternalHttpRequestError(
      `api_request cannot fetch ${hostname}: DNS lookup returned no addresses`
    );
  }
  const blocked = addresses.find(({ address }) => isBlockedExternalAddress(address));
  if (blocked !== undefined) {
    throw new InvalidExternalHttpRequestError(
      `api_request cannot fetch ${hostname}: it resolves to non-public address ${blocked.address}`
    );
  }
}

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

  assertPublicResolvedAddresses(host, addresses);
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

async function fetchWithValidatedRedirects(startUrl: string, init: RequestInit): Promise<Response> {
  let currentUrl = startUrl;
  let currentInit: RequestInit = { ...init, headers: new Headers(init.headers) };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertFetchableExternalUrl(currentUrl);
    await assertUrlResolvesToPublicAddress(currentUrl);

    const response = await fetch(currentUrl, {
      ...currentInit,
      // `dispatcher` is Undici's Node fetch extension. The URL keeps its
      // original hostname for Host/SNI while the connection uses only an
      // address approved by the socket-time resolver above.
      dispatcher: publicAddressDispatcher,
    } as unknown as RequestInit);
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) {
      return response;
    }

    const location = response.headers.get('location');
    if (location === null || location.trim() === '') {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    const nextUrl = new URL(location, currentUrl);
    const previousUrl = new URL(currentUrl);
    if (nextUrl.origin !== previousUrl.origin) {
      throw new InvalidExternalHttpRequestError(
        'api_request refuses cross-origin redirects so credentials and request bodies cannot be forwarded to another host'
      );
    }

    const nextHeaders = new Headers(currentInit.headers);
    const method = String(currentInit.method ?? 'GET').toUpperCase();
    if (
      (response.status === 303 && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      currentInit = { ...currentInit, method: 'GET', body: undefined, headers: nextHeaders };
      for (const header of BODY_HEADERS) nextHeaders.delete(header);
    } else {
      currentInit = { ...currentInit, headers: nextHeaders };
    }
    currentUrl = nextUrl.toString();
  }

  throw new ExternalHttpRequestFailedError(
    `External HTTP request exceeded ${MAX_REDIRECTS} redirects`
  );
}

export function redactExternalUrlForLogs(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(invalid external URL)';
  }
}

function findKnownExternalHttpError(
  error: unknown
): InvalidExternalHttpRequestError | ExternalHttpRequestFailedError | null {
  const visited = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    if (
      current instanceof InvalidExternalHttpRequestError ||
      current instanceof ExternalHttpRequestFailedError
    ) {
      return current;
    }
    visited.add(current);
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

export async function executeExternalHttpRequest(
  rawRequest: ExternalHttpRequestBody
): Promise<ExternalHttpResponseBody> {
  const request = normalizeExternalHttpRequest(rawRequest);
  const finalUrl = appendQueryParams(request.url, request.query);
  const logUrl = redactExternalUrlForLogs(finalUrl);
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
          url: logUrl,
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
      const knownError = findKnownExternalHttpError(error);
      if (knownError !== null) throw knownError;
      lastError = error;
      if (!retriesAllowed || attempt >= maxAttempts) {
        break;
      }
      const delay = retryDelayMs(lastResponse, attempt);
      log.warn('Retrying external HTTP request after transport error', {
        url: logUrl,
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
