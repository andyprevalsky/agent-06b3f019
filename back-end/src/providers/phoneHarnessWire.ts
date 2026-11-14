import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { PhoneHarnessError, type PhoneHarnessSession } from './phoneHarnessTypes';

export const NOT_FOUND = Symbol('phone-harness-not-found');
export const JSON_LIMIT = 1024 * 1024;
export const FRAME_LIMIT = 8 * 1024 * 1024;
export function invalid(code = 'malformed_response'): never {
  throw new PhoneHarnessError(
    code === 'invalid_argument'
      ? 'Invalid Phone Harness argument'
      : 'Invalid Phone Harness response',
    null,
    code,
    'rejected'
  );
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) invalid();
  return value;
}
function seconds(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid();
  return value;
}
export function trustedUrl(value: string, origin?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('unsafe_url');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.port !== '' && url.port !== '443') ||
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    !host.includes('.') ||
    /\.(localhost|local|localdomain|internal|lan|home|test|invalid)$/.test(host) ||
    (isIP(host) !== 0 && ipaddr.parse(host).range() !== 'unicast') ||
    (origin !== undefined && url.origin !== origin)
  )
    invalid('unsafe_url');
  return url;
}
export function session(value: unknown, origin: string): PhoneHarnessSession {
  const data = record(value);
  const platform = data.platform === undefined ? null : string(data.platform);
  const kind = data.kind === undefined ? null : string(data.kind);
  if ((platform !== null && platform !== 'ios') || (kind !== null && kind !== 'device'))
    invalid('wrong_platform');
  const grant = data.control === undefined || data.control === null ? null : record(data.control);
  const control =
    grant === null
      ? null
      : {
          url: trustedUrl(string(grant.url), origin).toString().replace(/\/$/, ''),
          token: string(grant.token),
          expiresAt: seconds(grant.expires_at),
        };
  if (data.cleanup_complete !== undefined && typeof data.cleanup_complete !== 'boolean') invalid();
  if (
    data.close_requested !== undefined &&
    data.close_requested !== null &&
    typeof data.close_requested !== 'number' &&
    typeof data.close_requested !== 'boolean'
  )
    invalid();
  return {
    id: string(data.id),
    state: string(data.state),
    platform,
    kind,
    expiresAt: seconds(data.expires_at),
    control,
    requestKey:
      data.request_key === undefined || data.request_key === null ? null : string(data.request_key),
    cleanupComplete: data.cleanup_complete === true || data.cleanup_status === 'complete',
    closeRequested:
      data.close_requested !== undefined &&
      data.close_requested !== null &&
      data.close_requested !== false,
  };
}
const SAFE_CODES = new Set([
  'session_limit',
  'idempotency_conflict',
  'create_request_completed',
  'create_request_recorded',
  'phones_busy',
  'beta_access_required',
  'install_unknown',
  'profile_running',
  'device_unavailable',
  'unsupported',
  'phone_locked',
  'session_expired',
  'grant_expired',
  'not_found',
  'unauthorized',
  'forbidden',
  'invalid_request',
]);
function providerError(status: number, data: unknown, mutation: boolean): PhoneHarnessError {
  const body = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const unsupported = body.unsupported === true || body.code === 'unsupported';
  const code =
    typeof body.code === 'string' && SAFE_CODES.has(body.code)
      ? body.code
      : unsupported
        ? 'unsupported'
        : 'provider_error';
  const locked =
    code === 'phone_locked' ||
    (typeof body.error === 'string' &&
      /\b(?:phone|device|screen|iphone) (?:is )?locked\b/i.test(body.error));
  const message = locked
    ? 'Phone is locked'
    : unsupported
      ? 'Phone operation is unsupported'
      : `Phone Harness request failed (HTTP ${status})`;
  return new PhoneHarnessError(
    message,
    status,
    code,
    mutation && (status >= 500 || body.outcome === 'unknown') ? 'unknown' : 'rejected',
    unsupported
  );
}
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => undefined);
    invalid('response_too_large');
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        invalid('response_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export interface WireRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  token: string;
  body?: unknown;
  requestKey?: string;
  timeoutMs?: number;
  png?: boolean;
  allowNotFound?: boolean;
  allowEmptySuccess?: boolean;
}
/** One bounded HTTP exchange. No retry, redirect, recovery or command replay. */
export async function exchange(
  fetchImpl: typeof fetch,
  url: string,
  options: WireRequest
): Promise<unknown> {
  const method = options.method ?? 'GET';
  const mutation = method !== 'GET';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 60_000);
  let status: number | null = null;
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: options.png === true ? 'image/png' : 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.requestKey !== undefined ? { 'Idempotency-Key': options.requestKey } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    status = response.status;
    if (options.allowNotFound === true && status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return NOT_FOUND;
    }
    if (options.allowNotFound === true && status === 204) return {};
    const bytes = await boundedBytes(
      response,
      options.png === true && response.ok ? FRAME_LIMIT : JSON_LIMIT
    );
    if (options.allowEmptySuccess === true && response.ok && bytes.length === 0) return {};
    if (options.png === true && response.ok) {
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'image/png')
        invalid('invalid_png');
      validatePng(bytes);
      return bytes;
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      if (!response.ok) throw providerError(status, null, mutation);
      return invalid();
    }
    if (!response.ok) throw providerError(status, data, mutation);
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      invalid();
    return data;
  } catch (error) {
    if (error instanceof PhoneHarnessError) {
      throw new PhoneHarnessError(
        error.message,
        error.status ?? status,
        error.code,
        mutation && error.outcome === 'rejected' && error.status === null
          ? 'unknown'
          : error.outcome,
        error.unsupported
      );
    }
    throw new PhoneHarnessError(
      'Phone Harness transport failed',
      status,
      'transport_error',
      mutation ? 'unknown' : 'rejected'
    );
  } finally {
    clearTimeout(timer);
  }
}

function validatePng(bytes: Uint8Array): void {
  if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    invalid('invalid_png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) invalid('invalid_png');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) invalid('invalid_png');
      const width = view.getUint32(16),
        height = view.getUint32(20);
      if (
        width === 0 ||
        height === 0 ||
        width > 8192 ||
        height > 8192 ||
        width * height > 32_000_000
      )
        invalid('invalid_png');
    } else if (type === 'IHDR') invalid('invalid_png');
    if (type === 'IDAT' && length > 0) imageData = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || !imageData || offset !== bytes.length) invalid('invalid_png');
      return;
    }
  }
  invalid('invalid_png');
}

export function segment(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\r\n]/.test(value) ||
    value === '.' ||
    value === '..'
  )
    invalid('invalid_argument');
  return encodeURIComponent(value);
}
