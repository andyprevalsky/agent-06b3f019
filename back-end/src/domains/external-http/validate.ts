import { isIP } from 'node:net';
import { isBlockedExternalAddress } from '../../providers/publicAddress';

import { InvalidExternalHttpRequestError } from './errors';
import type { ExternalHttpRequestBody, HttpMethod } from './types';

const ALLOWED_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

export function assertExternalHttpMethod(method: string): HttpMethod {
  const normalized = method.toUpperCase();
  if (!ALLOWED_METHODS.has(normalized as HttpMethod)) {
    throw new InvalidExternalHttpRequestError(
      `Unsupported HTTP method ${JSON.stringify(method)}. Allowed: GET, POST, PUT, PATCH, DELETE, HEAD.`
    );
  }
  return normalized as HttpMethod;
}

export { isBlockedExternalAddress };

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function rejectBlockedHostnameReason(host: string): string | null {
  const normalized = normalizeHostname(host);
  if (normalized === '') {
    return 'it has no hostname';
  }

  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.intranet')
  ) {
    return `${host} is a local/internal hostname`;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4 || ipVersion === 6) {
    if (isBlockedExternalAddress(normalized)) {
      return `${host} is a non-public address`;
    }
    return null;
  }

  if (!normalized.includes('.')) {
    return `${host} is not a resolvable public hostname`;
  }

  return null;
}

function rejectFetchableUrlReason(url: string): string | null {
  const candidate = url.trim();
  if (candidate === '') {
    return 'no URL was provided';
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `it is not a parseable URL (${message})`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `scheme ${parsed.protocol || '(none)'} is not fetchable — api_request only accepts http:// or https:// URLs`;
  }

  const hostReason = rejectBlockedHostnameReason(parsed.hostname);
  if (hostReason !== null) {
    return hostReason;
  }

  return null;
}

export function assertFetchableExternalUrl(url: string): string {
  const reason = rejectFetchableUrlReason(url);
  if (reason !== null) {
    throw new InvalidExternalHttpRequestError(
      `api_request cannot fetch ${JSON.stringify(url)}: ${reason}. Pass an absolute http(s) URL.`
    );
  }
  return url.trim();
}

export function normalizeExternalHttpRequest(
  raw: ExternalHttpRequestBody
): ExternalHttpRequestBody {
  if (raw === null || typeof raw !== 'object') {
    throw new InvalidExternalHttpRequestError('Request body must be an object');
  }

  const method = assertExternalHttpMethod(String(raw.method ?? ''));
  const url = assertFetchableExternalUrl(String(raw.url ?? ''));

  const query =
    raw.query !== undefined && raw.query !== null && typeof raw.query === 'object'
      ? (raw.query as Record<string, string | number | boolean | null | undefined>)
      : undefined;

  const headers =
    raw.headers !== undefined && raw.headers !== null && typeof raw.headers === 'object'
      ? Object.fromEntries(
          Object.entries(raw.headers as Record<string, unknown>)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => [String(key), String(value)])
        )
      : undefined;

  return {
    method,
    url,
    query,
    body: raw.body,
    headers,
  };
}
