/**
 * Tilion Cloud REST client (https://back.tilion.dev).
 *
 * caller ──tilionRequest──▶ attempt ──fetch (15 s default)──▶ Tilion
 *                              │  2xx → parsed body
 *                              │  429 rate_limited / 502 / 503 / 504 → bounded retry (Retry-After)
 *                              │  timeout → retry only when the call is idempotent
 *                              └─ otherwise → typed error (status, slug, retryable, X-Request-ID)
 *
 * Every call logs method, path, status, duration and X-Request-ID. The API key
 * travels only in the Authorization header; CDP/view tokens are redacted from
 * anything this module logs or puts into an error message.
 */
import { createLogger } from '../logger';
import { retryWithBackoff } from '../retry';
import { BrowserProviderRateLimitError } from './types';

const log = createLogger('Tilion');

export const TILION_DEFAULT_BASE_URL = 'https://back.tilion.dev';
export const TILION_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export function tilionBaseUrl(): string {
  return (process.env.TILION_BASE_URL?.trim() || TILION_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function tilionApiKey(): string {
  const key = process.env.TILION_API_KEY?.trim();
  if (!key) throw new Error('TILION_API_KEY is required for Tilion browser sessions');
  return key;
}

/** Strip `token` (and any key-looking) query values from a URL or a message containing URLs. */
export function redactTilionSecrets(text: string): string {
  return text
    .replace(/([?&](?:token|apiKey|api_key)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[REDACTED]')
    .replace(/\bph_(?:live|test)_[A-Za-z0-9_-]+/g, '[REDACTED]');
}

export interface TilionErrorInit {
  status: number;
  slug: string | null;
  message: string;
  retryable: boolean;
  requestId: string | null;
  retryAfterMs: number | null;
  detail: unknown;
  method: string;
  path: string;
}

export class TilionApiError extends Error {
  readonly status: number;
  readonly slug: string | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly detail: unknown;

  constructor(init: TilionErrorInit) {
    super(
      redactTilionSecrets(
        `Tilion HTTP ${init.status}${init.slug ? ` ${init.slug}` : ''} on ${init.method} ${init.path}: ${init.message}` +
          (init.requestId ? ` (X-Request-ID ${init.requestId})` : '')
      )
    );
    this.name = 'TilionApiError';
    this.status = init.status;
    this.slug = init.slug;
    this.retryable = init.retryable;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.detail = init.detail;
  }
}

/** 402: wallet, plan allowance or key spend limit exhausted. Never retried. */
export class TilionInsufficientCreditsError extends TilionApiError {
  constructor(init: TilionErrorInit) {
    super({ ...init, retryable: false });
    this.name = 'TilionInsufficientCreditsError';
  }
}

/**
 * A CDP client (normally the agent worker) holds the session. Live Tilion
 * refuses REST drive calls instead of queueing them: 409
 * `session_driven_by_client` (act, files/fetch) or 502 `file_fetch_failed` with
 * cause `ExternalControlBusy`. Retrying cannot help until that client detaches.
 */
export class TilionSessionBusyError extends TilionApiError {
  constructor(init: TilionErrorInit) {
    super({ ...init, retryable: false });
    this.name = 'TilionSessionBusyError';
  }
}

/** 429 throttle or concurrency cap, typed as the provider-neutral rate-limit error. */
export class TilionRateLimitError extends BrowserProviderRateLimitError {
  readonly status = 429;
  readonly slug: string | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly retryable = true;

  constructor(init: TilionErrorInit) {
    super('tilion', new TilionApiError(init).message);
    this.slug = init.slug;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** A request that did not answer within its client-side deadline. */
export class TilionTimeoutError extends Error {
  readonly retryable = true;
  constructor(method: string, path: string, timeoutMs: number) {
    super(`Tilion ${method} ${path} timed out after ${timeoutMs}ms`);
    this.name = 'TilionTimeoutError';
  }
}

/** The connection failed before Tilion answered. */
export class TilionNetworkError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'TilionNetworkError';
  }
}

export type TilionError = TilionApiError | TilionRateLimitError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read every documented error envelope: `detail` string, `detail` object with
 * `error`/`message`, the 422 `detail` list, and the top-level 500/504/413 shapes.
 */
export function parseTilionErrorBody(body: unknown): {
  slug: string | null;
  message: string;
  retryable: boolean | null;
  retryAfterSeconds: number | null;
} {
  if (!isRecord(body)) {
    return {
      slug: null,
      message: typeof body === 'string' && body !== '' ? body : 'no error body',
      retryable: null,
      retryAfterSeconds: null,
    };
  }
  const detail = body.detail;
  if (typeof detail === 'string') {
    return {
      slug: typeof body.error === 'string' ? body.error : null,
      message: detail,
      retryable: typeof body.retryable === 'boolean' ? body.retryable : null,
      retryAfterSeconds: null,
    };
  }
  if (Array.isArray(detail)) {
    const message = detail
      .map((entry) => {
        if (!isRecord(entry)) return String(entry);
        const loc = Array.isArray(entry.loc) ? entry.loc.map(String).join('.') : '';
        const msg = typeof entry.msg === 'string' ? entry.msg : JSON.stringify(entry);
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join('; ');
    return { slug: 'validation_error', message, retryable: false, retryAfterSeconds: null };
  }
  if (isRecord(detail)) {
    const slug = typeof detail.error === 'string' ? detail.error : null;
    const message =
      typeof detail.message === 'string'
        ? detail.message
        : typeof detail.reason === 'string'
          ? detail.reason
          : JSON.stringify(detail).slice(0, 500);
    const retryAfter = detail.retry_after_seconds;
    return {
      slug,
      message,
      retryable: typeof detail.retryable === 'boolean' ? detail.retryable : null,
      retryAfterSeconds: typeof retryAfter === 'number' ? retryAfter : null,
    };
  }
  return {
    slug: typeof body.error === 'string' ? body.error : null,
    message:
      typeof body.message === 'string'
        ? body.message
        : typeof body.status === 'string'
          ? body.status
          : 'unrecognized error body',
    retryable: typeof body.retryable === 'boolean' ? body.retryable : null,
    retryAfterSeconds: null,
  };
}

function retryAfterHeaderMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 500);
  }
}

export function tilionErrorFromResponse(
  status: number,
  body: unknown,
  meta: {
    requestId: string | null;
    retryAfterHeaderMs: number | null;
    method: string;
    path: string;
  }
): TilionError {
  const parsed = parseTilionErrorBody(body);
  const retryAfterMs =
    parsed.retryAfterSeconds !== null ? parsed.retryAfterSeconds * 1000 : meta.retryAfterHeaderMs;
  const init: TilionErrorInit = {
    status,
    slug: parsed.slug,
    message: parsed.message,
    retryable: parsed.retryable ?? RETRYABLE_STATUSES.has(status),
    requestId: meta.requestId,
    retryAfterMs,
    detail: isRecord(body) ? body.detail : body,
    method: meta.method,
    path: meta.path,
  };
  if (status === 429) return new TilionRateLimitError(init);
  if (status === 402) return new TilionInsufficientCreditsError(init);
  const cause = isRecord(body) && isRecord(body.detail) ? body.detail.cause : undefined;
  if (
    (status === 409 && parsed.slug === 'session_driven_by_client') ||
    (status === 502 && cause === 'ExternalControlBusy')
  ) {
    return new TilionSessionBusyError(init);
  }
  return new TilionApiError(init);
}

export interface TilionRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Retry a client-side timeout. Only safe for reads, DELETE and keyed creates. */
  retryOnTimeout?: boolean;
  /** Statuses returned as a result instead of thrown (e.g. 404/410 on DELETE). */
  acceptStatuses?: number[];
  /** Overrides the default 429/502/503/504 retry decision for this call. */
  shouldRetry?: (error: TilionError) => boolean;
}

export interface TilionResponse<T> {
  status: number;
  data: T;
  requestId: string | null;
}

function retryDelayMs(error: unknown, attempt: number): number {
  const hinted =
    error instanceof TilionApiError || error instanceof TilionRateLimitError
      ? error.retryAfterMs
      : null;
  const backoff = 250 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(MAX_RETRY_DELAY_MS, (hinted ?? backoff) + jitter);
}

function defaultShouldRetry(error: TilionError): boolean {
  if (error instanceof TilionRateLimitError) {
    // A concurrency cap does not clear within a request's retry budget, and a
    // long throttle window belongs to the caller, not to a blocked request.
    return (
      error.slug !== 'concurrency_limit' &&
      error.slug !== 'tab_limit' &&
      (error.retryAfterMs ?? 0) <= MAX_RETRY_DELAY_MS
    );
  }
  return RETRYABLE_STATUSES.has(error.status) && error.retryable;
}

/** Single Tilion REST call with typed errors and bounded retries. */
export async function tilionRequestWithMeta<T>(
  path: string,
  options: TilionRequestOptions = {}
): Promise<TilionResponse<T>> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? TILION_REQUEST_TIMEOUT_MS;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const loggedPath = redactTilionSecrets(path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tilionApiKey()}`,
    Accept: 'application/json',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let attempt = 0;
  const attemptOnce = async (): Promise<TilionResponse<T>> => {
    attempt += 1;
    const startedAt = Date.now();
    // The timeout signal also aborts the body stream, so a stalled body read is
    // typed (and retried) exactly like a request that never answered. The log
    // messages are exact-cleanup evidence (cloudbench-exact-session-cleanup.py
    // counts "Tilion request failed before a response" as a possible create).
    const transportFailure = (error: unknown, stage: 'network error' | 'body read failed') => {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const failure = timedOut
        ? new TilionTimeoutError(method, loggedPath, timeoutMs)
        : new TilionNetworkError(
            redactTilionSecrets(
              `Tilion ${method} ${loggedPath} ${stage}: ${error instanceof Error ? error.message : String(error)}`
            )
          );
      const message =
        stage === 'network error'
          ? 'Tilion request failed before a response'
          : 'Tilion response body read failed';
      log.warn(message, {
        method,
        path: loggedPath,
        attempt,
        durationMs: Date.now() - startedAt,
        error: failure.message,
      });
      return failure;
    };
    let response: Response;
    try {
      response = await fetch(`${tilionBaseUrl()}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw transportFailure(error, 'network error');
    }
    const requestId = response.headers.get('x-request-id');
    log.info('Tilion request', {
      method,
      path: loggedPath,
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestId,
      attempt,
    });
    let body: unknown;
    try {
      body = response.status === 204 ? null : await readBody(response);
    } catch (error) {
      throw transportFailure(error, 'body read failed');
    }
    if (response.ok || options.acceptStatuses?.includes(response.status)) {
      return { status: response.status, data: body as T, requestId };
    }
    throw tilionErrorFromResponse(response.status, body, {
      requestId,
      retryAfterHeaderMs: retryAfterHeaderMs(response),
      method,
      path: loggedPath,
    });
  };

  return retryWithBackoff(attemptOnce, {
    maxRetries: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    component: `Tilion ${method} ${loggedPath}`,
    getBackoffDelayMs: retryDelayMs,
    isRetryable: (error) => {
      // A lost reply on a non-idempotent call may already have acted; never repeat it.
      if (error instanceof TilionTimeoutError || error instanceof TilionNetworkError) {
        return options.retryOnTimeout === true;
      }
      if (error instanceof TilionApiError || error instanceof TilionRateLimitError) {
        return shouldRetry(error);
      }
      return false;
    },
  });
}

export async function tilionRequest<T>(
  path: string,
  options: TilionRequestOptions = {}
): Promise<T> {
  return (await tilionRequestWithMeta<T>(path, options)).data;
}

export function tilionSessionPath(sessionId: string, suffix = ''): string {
  return `/v1/session/${encodeURIComponent(sessionId)}${suffix}`;
}

/** Interactive live-view URL from a fresh view token (1800 s). */
export async function mintTilionLiveViewUrl(sessionId: string): Promise<string> {
  const minted = await tilionRequest<{ live_view_url: string }>(
    tilionSessionPath(sessionId, '/view-token'),
    { method: 'POST', retryOnTimeout: true }
  );
  if (!minted?.live_view_url) throw new Error('Tilion view-token response omitted live_view_url');
  return new URL(minted.live_view_url, `${tilionBaseUrl()}/`).toString();
}

/** Fresh raw-CDP URL for a live session (connect tokens last 1800 s). */
export async function mintTilionConnectUrl(sessionId: string): Promise<string> {
  const minted = await tilionRequest<{ connect_url: string | null }>(
    tilionSessionPath(sessionId, '/connect'),
    { retryOnTimeout: true }
  );
  if (!minted?.connect_url) throw new Error('Tilion /connect returned no CDP URL for this key');
  return minted.connect_url;
}
