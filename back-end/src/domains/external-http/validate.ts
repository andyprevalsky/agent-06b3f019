import { isIP } from 'node:net';

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

function extractMappedIPv4(addr: string): string | null {
  const lower = addr.toLowerCase();
  if (lower.includes('.')) {
    const lastColon = lower.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = lower.slice(lastColon + 1);
    return isIP(v4) === 4 ? v4 : null;
  }

  const marker = lower.indexOf(':ffff:');
  if (marker === -1) return null;
  const rest = lower.slice(marker + ':ffff:'.length);
  const groups = rest.split(':').filter((part) => part.length > 0);
  if (groups.length !== 2) return null;
  const hi = Number.parseInt(groups[0]!, 16);
  const lo = Number.parseInt(groups[1]!, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a, b] = parts;
  if (
    parts.length !== 4 ||
    a === undefined ||
    b === undefined ||
    parts.some((n) => Number.isNaN(n))
  ) {
    return true;
  }

  // 0.0.0.0/8
  if (a === 0) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 100.64.0.0/10 CGNAT / shared address space
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedV6(address: string): boolean {
  const lower = address.toLowerCase();

  if (lower === '::' || lower === '::1') return true;

  const mappedV4 = extractMappedIPv4(lower);
  if (mappedV4 !== null) {
    return isBlockedV4(mappedV4);
  }

  // fc00::/7 unique local
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }

  const firstHextet = lower.split(':')[0];
  if (
    firstHextet &&
    firstHextet.length === 4 &&
    firstHextet >= 'fe80' &&
    firstHextet <= 'febf'
  ) {
    return true;
  }

  return false;
}

/** True when the address must not be reached by api_request (SSRF guard). */
export function isBlockedExternalAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedV4(address);
  if (version === 6) return isBlockedV6(address);
  return true;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
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
