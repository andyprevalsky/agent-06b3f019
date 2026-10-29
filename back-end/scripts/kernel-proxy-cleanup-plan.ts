/** Pure cleanup policy. A Rose name alone is insufficient proof of ownership. */
export interface CleanupProxy {
  id?: string;
  name?: string;
  type: string;
  config?: unknown;
  bypass_hosts?: string[];
  protocol?: string;
  status?: string;
}

export interface ProxyCleanupCandidate {
  id: string;
  name: string;
  group: string;
  keepIds: string[];
}

/** No proxy reference is normal for a browser created without a proxy. */
export function protectBrowserProxies(
  protectedIds: Set<string>,
  browsers: Iterable<{ proxy_id?: string | null }>
): void {
  for (const browser of browsers) {
    if (browser.proxy_id === undefined || browser.proxy_id === null) continue;
    if (typeof browser.proxy_id !== 'string' || !browser.proxy_id.trim()) {
      throw new Error('Malformed active browser proxy reference; cleanup stopped');
    }
    protectedIds.add(browser.proxy_id);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stable));
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, stable(v)])
      )
    );
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function roseProxyGroup(proxy: CleanupProxy): string | undefined {
  if (!proxy.id || !['residential', 'mobile', 'isp', 'datacenter'].includes(proxy.type)) return;
  if (!proxy.config || typeof proxy.config !== 'object' || Array.isArray(proxy.config)) return;
  const config = proxy.config as Record<string, unknown>;
  // Do not claim custom credentials, ASN overrides, or unknown future configurations.
  if (Object.keys(config).some((key) => !['country', 'state', 'city'].includes(key))) return;
  if (typeof config.country !== 'string' || !/^[a-z]{2}$/i.test(config.country)) return;
  if (
    config.state !== undefined &&
    (typeof config.state !== 'string' || !/^[a-z]{2}$/i.test(config.state))
  )
    return;
  if (
    config.city !== undefined &&
    (typeof config.city !== 'string' || !/^[a-z0-9_]+$/i.test(config.city))
  )
    return;
  const expected = `rose-${[proxy.type, config.country, config.state, config.city].filter(Boolean).join('-').toLowerCase()}`;
  if (proxy.name !== expected) return;
  return stable({
    name: proxy.name,
    type: proxy.type,
    config,
    bypass: [...(proxy.bypass_hosts ?? [])].sort(),
    protocol: proxy.protocol,
  });
}

export function planKernelProxyCleanup(
  proxies: readonly CleanupProxy[],
  protectedIds: ReadonlySet<string>,
  limit = 100
): ProxyCleanupCandidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('limit must be between 1 and 100');
  const groups = new Map<string, CleanupProxy[]>();
  const ids = new Set<string>();
  for (const proxy of proxies) {
    if (proxy.id && ids.has(proxy.id)) throw new Error('Duplicate proxy ID in inventory');
    if (proxy.id) ids.add(proxy.id);
    const group = roseProxyGroup(proxy);
    if (group) groups.set(group, [...(groups.get(group) ?? []), proxy]);
  }
  const candidates: Array<ProxyCleanupCandidate & { unavailable: boolean }> = [];
  for (const [group, members] of groups) {
    const healthy = members
      .filter((p) => p.status === 'available')
      .sort(
        (a, b) =>
          Number(protectedIds.has(b.id!)) - Number(protectedIds.has(a.id!)) ||
          a.id!.localeCompare(b.id!)
      );
    // Never remove the last working option. Prefer two independently addressable copies.
    if (!healthy.length) continue;
    const keepIds = healthy.slice(0, 2).map((p) => p.id!);
    for (const proxy of members) {
      if (protectedIds.has(proxy.id!) || keepIds.includes(proxy.id!)) continue;
      if (!['available', 'unavailable'].includes(proxy.status ?? '')) continue;
      candidates.push({
        id: proxy.id!,
        name: proxy.name!,
        group,
        keepIds,
        unavailable: proxy.status === 'unavailable',
      });
    }
  }
  return candidates
    .sort((a, b) => Number(b.unavailable) - Number(a.unavailable) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ unavailable: _unavailable, ...candidate }) => candidate);
}

export interface CleanupDependencies {
  protectedIds(): Promise<ReadonlySet<string>>;
  retrieve(id: string): Promise<CleanupProxy>;
  delete(id: string): Promise<void>;
}

function notFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

/** Revalidate immediately before each deletion; any unknown API/DB error aborts. */
export async function deletePlannedKernelProxy(
  candidate: ProxyCleanupCandidate,
  dependencies: CleanupDependencies
): Promise<'deleted' | 'protected' | 'changed' | 'already-absent'> {
  if (candidate.keepIds.length === 0 || candidate.keepIds.includes(candidate.id)) return 'changed';
  let current: CleanupProxy;
  try {
    current = await dependencies.retrieve(candidate.id);
  } catch (error) {
    if (notFound(error)) return 'already-absent';
    throw error;
  }
  if (roseProxyGroup(current) !== candidate.group) return 'changed';
  for (const id of candidate.keepIds) {
    const keep = await dependencies.retrieve(id);
    if (keep.status !== 'available' || roseProxyGroup(keep) !== candidate.group) return 'changed';
  }
  if ((await dependencies.protectedIds()).has(candidate.id)) return 'protected';
  await dependencies.delete(candidate.id);
  try {
    await dependencies.retrieve(candidate.id);
  } catch (error) {
    if (notFound(error)) return 'deleted';
    throw error;
  }
  throw new Error(`Deletion not confirmed for proxy ${candidate.id}`);
}
