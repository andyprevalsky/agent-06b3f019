import { createLogger } from '../../providers/logger';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS_CODES,
} from './config';
import { ExternalHttpRequestFailedError } from './errors';
import type { ExternalHttpRequestBody, ExternalHttpResponseBody } from './types';
import { normalizeExternalHttpRequest } from './validate';

const log = createLogger('ExternalHttp');

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

async function readResponseBody(response: Response): Promise<{
  body: unknown;
  body_encoding: ExternalHttpResponseBody['body_encoding'];
  content_type: string | null;
}> {
  const contentType = response.headers.get('content-type');
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length === 0) {
    return { body: '', body_encoding: 'text', content_type: contentType };
  }

  const normalizedType = (contentType ?? '').toLowerCase();
  const text = buffer.toString('utf8');

  if (
    normalizedType.includes('application/json') ||
    normalizedType.includes('+json') ||
    (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))
  ) {
    try {
      return { body: JSON.parse(text), body_encoding: 'json', content_type: contentType };
    } catch {
      return { body: text, body_encoding: 'text', content_type: contentType };
    }
  }

  if (normalizedType.startsWith('text/') || normalizedType.includes('xml') || normalizedType.includes('javascript')) {
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
    redirect: 'follow',
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

export async function executeExternalHttpRequest(
  rawRequest: ExternalHttpRequestBody
): Promise<ExternalHttpResponseBody> {
  const request = normalizeExternalHttpRequest(rawRequest);
  const finalUrl = appendQueryParams(request.url, request.query);
  const init = buildFetchInit(request);

  let lastError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(finalUrl, init);
      lastResponse = response;

      if (shouldRetryResponse(response) && attempt < MAX_ATTEMPTS) {
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
        url: response.url,
        headers: headersToRecord(response.headers),
        body: parsed.body,
        body_encoding: parsed.body_encoding,
        content_type: parsed.content_type,
        elapsed_ms: elapsedMs,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ATTEMPTS) {
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
    const parsed = await readResponseBody(lastResponse);
    throw new ExternalHttpRequestFailedError(
      `External HTTP request failed with status ${lastResponse.status}`,
      lastResponse.status,
      parsed.body
    );
  }

  throw new ExternalHttpRequestFailedError(
    `External HTTP request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
