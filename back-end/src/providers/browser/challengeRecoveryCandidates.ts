import type { ProxyGeoLocation } from '../geoip';
import type { KernelRecoveryProxySpecificity } from './kernel';
import type { KernelProxyType } from './kernelProxy';
import type { BrowserProviderName } from './types';
import { createLogger } from '../logger';
import { browserProviderEnabled, browserUseEnabled } from './config';
import { recoverySameProviderOnly, tilionMobileEnabled } from './rotation';

const log = createLogger('BrowserChallengeRecovery');

export interface BrowserRecoveryConfig {
  key: string;
  provider: BrowserProviderName;
  proxyMode: string;
  kernelProxyType?: KernelProxyType;
  kernelSpecificity?: KernelRecoveryProxySpecificity;
  /** Create the Kernel session without a managed/shared proxy exit. */
  omitManagedProxy?: boolean;
  steelProxyMode?: 'managed' | 'fixed';
  /** Tilion paid exit type requested on create (`proxy_type`). */
  tilionProxyType?: TilionRecoveryProxyType;
}

/** `direct` is Tilion's own datacenter egress (no residential/mobile proxy). */
export type TilionRecoveryProxyType = 'residential' | 'mobile' | 'direct';

/** A transport failure can affect a provider's whole proxy fleet, so try the
 * other provider's exits before spending time on more tiers of the same one.
 * Keep every candidate as a fallback, and keep each provider's original order.
 */
export function alternateProviderFirst(
  configs: BrowserRecoveryConfig[],
  failedProvider: BrowserProviderName
): BrowserRecoveryConfig[] {
  return [
    ...configs.filter((config) => config.provider !== failedProvider),
    ...configs.filter((config) => config.provider === failedProvider),
  ];
}

/**
 * Candidate order after a proxy-transport failure (tunnel refusal) on
 * `failedProvider`. Tilion's residential/mobile egress refuses CONNECT to some
 * third-party hosts (live 2026-10-21: Stripe/PayPal/anti-fraud CDNs with
 * net::ERR_TUNNEL_CONNECTION_FAILED) while its direct egress reaches them, so a
 * Tilion session that is not already direct tries `tilion_direct` first: same
 * provider and state, another egress. The candidate probe and classifier still
 * decide; sites that challenge datacenter IPs fall through to other providers.
 * The trigger is the observed transport failure, never a host list.
 */
export function transportFailureOrder(
  configs: BrowserRecoveryConfig[],
  failedProvider: BrowserProviderName,
  failedConfigKey?: string
): BrowserRecoveryConfig[] {
  const ordered = alternateProviderFirst(configs, failedProvider);
  if (failedProvider !== 'tilion' || failedConfigKey === 'tilion_direct') return ordered;
  const direct = ordered.filter((config) => config.key === 'tilion_direct');
  return [...direct, ...ordered.filter((config) => config.key !== 'tilion_direct')];
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

/** Independent browser/IP configs searched after cookie isolation.
 *
 * Probe order (sequential within each cookie lane):
 *   steel_fixed → kernel_mobile → kernel residential → steel_managed → kernel_isp
 *   → tilion_residential → tilion_mobile (only with TILION_MOBILE_ENABLED) → tilion_direct
 *
 * Residential is one geo tier: city and state when available, else country.
 * Prefer-Steel (payment CDN) keeps this relative order among Steel entries only.
 */
export function browserRecoveryCandidates(
  location: ProxyGeoLocation,
  options?: { preferSteel?: boolean }
): BrowserRecoveryConfig[] {
  const fallbackSpecificity = bestSpecificity(location);
  const residential: BrowserRecoveryConfig[] = [];
  if (location.city) {
    residential.push({
      key: 'kernel_residential_city',
      provider: 'kernel',
      proxyMode: 'residential_city',
      kernelProxyType: 'residential',
      kernelSpecificity: 'city',
    });
  }
  if (location.state) {
    residential.push({
      key: 'kernel_residential_state',
      provider: 'kernel',
      proxyMode: 'residential_state',
      kernelProxyType: 'residential',
      kernelSpecificity: 'state',
    });
  }
  if (!location.city && !location.state) {
    residential.push({
      key: 'kernel_residential_country',
      provider: 'kernel',
      proxyMode: 'residential_country',
      kernelProxyType: 'residential',
      kernelSpecificity: 'country',
    });
  }
  const candidates: BrowserRecoveryConfig[] = [
    {
      key: 'steel_fixed',
      provider: 'steel',
      proxyMode: 'fixed',
      steelProxyMode: 'fixed',
    },
    {
      key: 'kernel_mobile',
      provider: 'kernel',
      proxyMode: `mobile_${fallbackSpecificity}`,
      kernelProxyType: 'mobile',
      kernelSpecificity: fallbackSpecificity,
    },
    ...residential,
    {
      key: 'steel_managed',
      provider: 'steel',
      proxyMode: 'managed',
      steelProxyMode: 'managed',
    },
    {
      key: 'browser_use_residential_country',
      provider: 'browser-use',
      proxyMode: 'residential_country',
    },
    {
      key: 'kernel_isp',
      provider: 'kernel',
      proxyMode: `isp_${fallbackSpecificity}`,
      kernelProxyType: 'isp',
      kernelSpecificity: fallbackSpecificity,
    },
    // Tilion places a residential/mobile exit from the full geo target and
    // reports what landed, so one candidate per exit type covers every tier.
    {
      key: 'tilion_residential',
      provider: 'tilion',
      proxyMode: `residential_${fallbackSpecificity}`,
      tilionProxyType: 'residential',
    },
    {
      key: 'tilion_mobile',
      provider: 'tilion',
      proxyMode: `mobile_${fallbackSpecificity}`,
      tilionProxyType: 'mobile',
    },
    {
      key: 'tilion_direct',
      provider: 'tilion',
      proxyMode: 'direct',
      tilionProxyType: 'direct',
    },
  ];
  if (!options?.preferSteel) return candidates;
  // Kernel hard-blacklists Stripe Checkout on managed proxies AND on
  // omitManagedProxy/stealth exits (prod: text:provider_blacklisted ~93s per
  // probe). Parallel Promise.allSettled waits for every candidate, so including
  // kernel_direct delayed promoting a clean steel_managed winner by ~85s each
  // recovery cycle and burned agent-payment-production-purchase's 900s budget.
  // Steel-only for these hosts (order preserved: fixed then managed).
  return candidates.filter((candidate) => candidate.provider === 'steel');
}

/** Tilion kill switch plus credential: off or unkeyed means no new Tilion recovery session. */
export function tilionRecoveryAvailable(): boolean {
  return (
    browserProviderEnabled('BROWSER_AGENT_TILION_ENABLED', true) &&
    Boolean(process.env.TILION_API_KEY?.trim())
  );
}

/**
 * BROWSER_RECOVERY_SAME_PROVIDER_ONLY (experiment knob, default off): keep only
 * the session's current provider's candidates, so other providers' sessions are
 * never created or probed. Logs one line naming the knob and what it skipped.
 */
export function lockCandidatesToProvider(
  configs: BrowserRecoveryConfig[],
  currentProvider: string,
  context: { taskId: string; phase: string }
): BrowserRecoveryConfig[] {
  if (!recoverySameProviderOnly()) return configs;
  const kept = configs.filter((config) => config.provider === currentProvider);
  const skipped = configs.filter((config) => config.provider !== currentProvider).map((c) => c.key);
  log.info(
    `recovery provider-locked (BROWSER_RECOVERY_SAME_PROVIDER_ONLY): kept ${
      kept.map((config) => config.key).join(', ') || 'none'
    }; skipped ${skipped.join(', ') || 'none'}`,
    { taskId: context.taskId, phase: context.phase, currentProvider }
  );
  return kept;
}

/** Do not spend a recovery lane on a provider that cannot be provisioned. */
export function availableBrowserRecoveryCandidates(
  location: ProxyGeoLocation,
  options?: { preferSteel?: boolean }
): BrowserRecoveryConfig[] {
  const browserUseReady = browserUseEnabled() && Boolean(process.env.BROWSER_USE_API_KEY?.trim());
  const tilionReady = tilionRecoveryAvailable();
  return browserRecoveryCandidates(location, options).filter(
    (candidate) =>
      (candidate.provider !== 'browser-use' || browserUseReady) &&
      (candidate.provider !== 'tilion' || tilionReady) &&
      // Tilion mobile is not served on our account (409 proxy_type_unavailable).
      (candidate.key !== 'tilion_mobile' || tilionMobileEnabled())
  );
}
