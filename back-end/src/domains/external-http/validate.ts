import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

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

// parseCIDR is typed as [IPv4 | IPv6, number]; narrow literals so .match() accepts them.
const BENCHMARK_V4 = ipaddr.parseCIDR('198.18.0.0/15') as [ipaddr.IPv4, number];
const GLOBAL_V6_UNICAST = ipaddr.parseCIDR('2000::/3') as [ipaddr.IPv6, number];
const GLOBAL_NAT64_V6 = ipaddr.parseCIDR('64:ff9b::/96') as [ipaddr.IPv6, number];
const IETF_PROTOCOL_V6 = ipaddr.parseCIDR('2001::/23') as [ipaddr.IPv6, number];
const GLOBAL_IETF_V6_EXCEPTIONS = [
  ipaddr.parseCIDR('2001:1::1/128') as [ipaddr.IPv6, number],
  ipaddr.parseCIDR('2001:1::2/128') as [ipaddr.IPv6, number],
  ipaddr.parseCIDR('2001:1::3/128') as [ipaddr.IPv6, number],
  ipaddr.parseCIDR('2001:3::/32') as [ipaddr.IPv6, number],
  ipaddr.parseCIDR('2001:4:112::/48') as [ipaddr.IPv6, number],
  ipaddr.parseCIDR('2001:20::/28') as [ipaddr.IPv6, number],
  ipaddr.parseCIDR('2001:30::/28') as [ipaddr.IPv6, number],
] as const;
const DOCUMENTATION_V6 = ipaddr.parseCIDR('3fff::/20') as [ipaddr.IPv6, number];

function isBlockedV4(address: ipaddr.IPv4): boolean {
  const normalized = address.toString();
  // These two protocol anycast addresses are the only globally reachable
  // exceptions inside ipaddr.js's otherwise-reserved 192.0.0.0/24 range.
  if (normalized === '192.0.0.9' || normalized === '192.0.0.10') return false;
  if (address.match(BENCHMARK_V4)) return true;
  return address.range() !== 'unicast';
}

function isBlockedV6(address: ipaddr.IPv6): boolean {
  // IPv4-mapped literals must be classified by their effective destination.
  if (address.isIPv4MappedAddress()) return isBlockedV4(address.toIPv4Address());

  // The globally reachable NAT64 prefix is safe only when its embedded IPv4
  // destination is itself globally reachable.
  if (address.match(GLOBAL_NAT64_V6)) {
    const bytes = address.toByteArray();
    return isBlockedV4(ipaddr.fromByteArray(bytes.slice(-4)) as ipaddr.IPv4);
  }

  // Current globally routed IPv6 unicast space. Fail closed on unallocated
  // ranges rather than allowing a future special-use prefix by default.
  if (!address.match(GLOBAL_V6_UNICAST)) return true;
  if (address.match(DOCUMENTATION_V6)) return true;

  // 2001::/23 is non-global unless IANA assigns a narrower global exception.
  if (address.match(IETF_PROTOCOL_V6)) {
    return !GLOBAL_IETF_V6_EXCEPTIONS.some((range) => address.match(range));
  }

  return address.range() !== 'unicast';
}

/** True when the address must not be reached by api_request (SSRF guard). */
export function isBlockedExternalAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv4') return isBlockedV4(parsed as ipaddr.IPv4);
  return isBlockedV6(parsed as ipaddr.IPv6);
}

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
