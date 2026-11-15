/**
 * Public-address classification shared by every outbound guard that reaches
 * user-supplied URLs (api_request, user MCP servers): true for any address that
 * is not globally routable unicast.
 */
import ipaddr from 'ipaddr.js';

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

/** True when the address must not be reached by an outbound user-URL fetch (SSRF guard). */
export function isBlockedExternalAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv4') return isBlockedV4(parsed as ipaddr.IPv4);
  return isBlockedV6(parsed as ipaddr.IPv6);
}
