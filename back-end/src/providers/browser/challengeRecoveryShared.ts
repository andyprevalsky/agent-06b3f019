/**
 * Shared helpers for challenge-recovery URL matching and session→config keys.
 * Kept outside challengeRecovery.ts to stay under the max-lines budget.
 */

function registrableHost(hostname: string | null | undefined): string {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** Same-site settled URL for follow-up probe / resume navigations. */
export function sameSiteNavigationUrl(
  targetUrl: string,
  settledUrl: string | null | undefined
): string | null {
  const settled = String(settledUrl || '').trim();
  if (!settled.startsWith('http://') && !settled.startsWith('https://')) return null;
  let targetHost = '';
  let settledHost = '';
  try {
    targetHost = registrableHost(new URL(targetUrl).hostname);
    settledHost = registrableHost(new URL(settled).hostname);
  } catch {
    return null;
  }
  if (!targetHost || !settledHost || targetHost !== settledHost) return null;
  return settled;
}

/** Map a live session's provider + proxyTier back to a recovery candidate key. */
export function recoveryConfigKeyForSession(
  provider: string | null | undefined,
  proxyTier: string | null | undefined
): string | undefined {
  const tier = (proxyTier || '').trim().toLowerCase();
  if ((provider || '').toLowerCase() === 'browser-use') {
    return tier === '' || tier.startsWith('residential')
      ? 'browser_use_residential_country'
      : undefined;
  }
  if ((provider || '').toLowerCase() === 'tilion') {
    if (tier === 'direct') return 'tilion_direct';
    if (tier.startsWith('mobile')) return 'tilion_mobile';
    if (tier === '' || tier.startsWith('residential')) return 'tilion_residential';
    return undefined;
  }
  if ((provider || '').toLowerCase() === 'steel') {
    if (tier === 'fixed') return 'steel_fixed';
    if (tier === 'managed' || tier === '') return 'steel_managed';
    return undefined;
  }
  if ((provider || '').toLowerCase() === 'kernel') {
    if (tier === 'none') return 'kernel_direct';
    if (tier.startsWith('isp')) return 'kernel_isp';
    if (tier.startsWith('mobile')) return 'kernel_mobile';
    if (tier.includes('residential_state') || tier === 'residential_state') {
      return 'kernel_residential_state';
    }
    if (tier.includes('residential_city') || tier === 'residential_city') {
      return 'kernel_residential_city';
    }
    if (tier.includes('residential_country') || tier === 'residential_country') {
      return 'kernel_residential_country';
    }
    if (tier.startsWith('residential')) return 'kernel_residential_city';
  }
  return undefined;
}

/** Reject promptly when a sibling lane claims the winner mid-probe. */
export async function raceProbeAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new Error('lane_aborted');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('lane_aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
