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

/**
 * Prefer Steel first when a hard CDN re-verify filter is active.
 *
 * Previously this special-cased vendor checkout hosts (Kernel denylist). That
 * was endpoint-specific; the general rule is: when recovery must re-verify a
 * blocked third-party resource, focus Steel first (Kernel residential exits
 * often cannot fetch those CDNs). ``targetUrl`` is ignored.
 */
export function shouldPreferSteelForChallengeTarget(
  _targetUrl: string,
  options?: { requirePaymentCdn?: boolean }
): boolean {
  return Boolean(options?.requirePaymentCdn);
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
  // Kernel hard-blacklists Stripe Checkout on managed proxies AND on
  // omitManagedProxy/stealth exits (prod: text:provider_blacklisted ~93s per
  // probe). Parallel Promise.allSettled waits for every candidate, so including
  // kernel_direct delayed promoting a clean steel_managed winner by ~85s each
  // recovery cycle and burned agent-payment-production-purchase's 900s budget.
  // Steel-only for these hosts.
  return candidates.filter((candidate) => candidate.provider === 'steel');
}
