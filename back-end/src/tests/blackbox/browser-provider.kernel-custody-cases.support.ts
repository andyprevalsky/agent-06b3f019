import { assertKernelStaleCacheRecovery } from './browser-provider.kernel-stale-cache.support';
import { assertLiveProxyReuseCustody } from './browser-provider.proxy-reuse-custody.support';
import { assertKernelProxyHealthFallback } from './browser-provider.kernel-health.support';

export const kernelCustodyCases: Array<[string, () => Promise<void>]> = [
  [
    'Kernel stale cache refreshes exact geo and reuses existing provider proxies first',
    assertKernelStaleCacheRecovery,
  ],
  ['Live proxy parity never allocates or deletes shared proxies', assertLiveProxyReuseCustody],
  [
    'Kernel proxy health errors preserve bounded geo fallback and cache custody',
    assertKernelProxyHealthFallback,
  ],
];
