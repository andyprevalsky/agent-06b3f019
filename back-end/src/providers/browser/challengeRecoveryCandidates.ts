import type { ProxyGeoLocation } from '../geoip';
import type { KernelRecoveryProxySpecificity } from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { BrowserProviderName } from './types';

export interface BrowserRecoveryConfig {
  key: string;
  provider: BrowserProviderName;
  proxyMode: string;
  kernelProxyType?: KernelProxyType;
  kernelSpecificity?: KernelRecoveryProxySpecificity;
  /** Create the Kernel session without a managed/shared proxy exit. */
  omitManagedProxy?: boolean;
  steelProxyMode?: 'managed' | 'fixed';
}

export function bestSpecificity(location: ProxyGeoLocation): KernelRecoveryProxySpecificity {
  if (location.city) return 'city';
  if (location.state) return 'state';
  return 'country';
}

/** Hosts Kernel's shared proxy is known to hard-blacklist (502 provider_blacklisted). */
const KERNEL_PROVIDER_BLACKLISTED_HOST_SUFFIXES = [
  'checkout.stripe.com',
  'pay.stripe.com',
] as const;

/**
 * Prefer Steel candidates first when the target host is on Kernel's hard
 * blacklist. Rotating Kernel residential/ISP exits cannot clear a domain
 * denylist — probing Kernel first only burns recovery budget.
 */
export function shouldPreferSteelForChallengeTarget(targetUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return KERNEL_PROVIDER_BLACKLISTED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

/**
 * Payment-CDN hard-filter recoveries only need Stripe-capable exits. Live Eventim
 * matrices show Kernel clears CF but never loads Stripe.js; probing them under
 * sticky requirePaymentCdn burns parallel provider slots and CF-thrashes Steel
 * at k=4. Focus Steel first; expand only if Steel finds no paymentCdnOk winner.
 */
export function paymentCdnFocusedCandidates(
  configs: BrowserRecoveryConfig[]
): BrowserRecoveryConfig[] {
  return configs.filter((config) => config.provider === 'steel');
}

/**
 * Build ordered search phases. When requirePaymentCdn is set, never apply
 * avoidConfigKey: the avoided exit is usually the only Stripe-capable survivor
 * that hit a transient CF, and avoid only wastes rank among empty Kernel sets.
 */
export function recoverySearchPlan(options: {
  configs: BrowserRecoveryConfig[];
  requirePaymentCdn: boolean;
  avoidConfigKey?: string;
}): Array<{ configs: BrowserRecoveryConfig[]; avoidConfigKey?: string; label: string }> {
  if (!options.requirePaymentCdn) {
    return [
      {
        configs: options.configs,
        avoidConfigKey: options.avoidConfigKey,
        label: 'full',
      },
    ];
  }
  const focused = paymentCdnFocusedCandidates(options.configs);
  // No Steel candidates ⇒ Kernel-only cannot clear Stripe.js. Fail fast rather
  // than burning the full parallel probe budget on a guaranteed empty set.
  if (focused.length === 0) {
    return [];
  }
  const triedKeys = new Set(focused.map((config) => config.key));
  const remaining = options.configs.filter((config) => !triedKeys.has(config.key));
  const phases: Array<{
    configs: BrowserRecoveryConfig[];
    avoidConfigKey?: string;
    label: string;
  }> = [
    {
      configs: focused,
      avoidConfigKey: undefined,
      label: 'payment_cdn_steel',
    },
  ];
  if (remaining.length > 0) {
    phases.push({
      configs: remaining,
      avoidConfigKey: undefined,
      label: 'payment_cdn_full',
    });
  }
  return phases;
}

/** The six independent browser/IP configurations searched after cookie isolation. */
export function browserRecoveryCandidates(
  location: ProxyGeoLocation,
  options?: { preferSteel?: boolean }
): BrowserRecoveryConfig[] {
  const fallbackSpecificity = bestSpecificity(location);
  const candidates: BrowserRecoveryConfig[] = [];
  if (location.city) {
    candidates.push({
      key: 'kernel_residential_city',
      provider: 'kernel',
      proxyMode: 'residential_city',
      kernelProxyType: 'residential',
      kernelSpecificity: 'city',
    });
  }
  if (location.state) {
    candidates.push({
      key: 'kernel_residential_state',
      provider: 'kernel',
      proxyMode: 'residential_state',
      kernelProxyType: 'residential',
      kernelSpecificity: 'state',
    });
  }
  if (!location.city && !location.state) {
    candidates.push({
      key: 'kernel_residential_country',
      provider: 'kernel',
      proxyMode: 'residential_country',
      kernelProxyType: 'residential',
      kernelSpecificity: 'country',
    });
  }
  candidates.push(
    {
      key: 'kernel_mobile',
      provider: 'kernel',
      proxyMode: `mobile_${fallbackSpecificity}`,
      kernelProxyType: 'mobile',
      kernelSpecificity: fallbackSpecificity,
    },
    {
      key: 'kernel_isp',
      provider: 'kernel',
      proxyMode: `isp_${fallbackSpecificity}`,
      kernelProxyType: 'isp',
      kernelSpecificity: fallbackSpecificity,
    },
    {
      key: 'steel_managed',
      provider: 'steel',
      proxyMode: 'managed',
      steelProxyMode: 'managed',
    },
    {
      key: 'steel_fixed',
      provider: 'steel',
      proxyMode: 'fixed',
      steelProxyMode: 'fixed',
    }
  );
  if (!options?.preferSteel) return candidates;
  // Kernel's managed proxy hard-blacklists Stripe Checkout. Prefer a direct
  // (no managed proxy) Kernel session first, then Steel — never burn budget on
  // residential/ISP/mobile Kernel exits that cannot reach the host. Probes run
  // concurrently, so reordering alone does not skip managed Kernel; filter them.
  const directKernel: BrowserRecoveryConfig = {
    key: 'kernel_direct',
    provider: 'kernel',
    proxyMode: 'none',
    omitManagedProxy: true,
  };
  return [directKernel, ...candidates.filter((candidate) => candidate.provider === 'steel')];
}
