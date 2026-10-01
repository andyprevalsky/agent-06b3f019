import { BROWSER_PROVIDERS, type BrowserProviderName } from './types';

export function selectedBrowserProvider(): BrowserProviderName {
  const configured = (process.env.BROWSER_PROVIDER ?? 'kernel').trim().toLowerCase();
  if (BROWSER_PROVIDERS.includes(configured as BrowserProviderName)) {
    // The rollout switch must remain a usable kill switch even when Browser Use
    // was configured as the deployment default. New work returns to Kernel.
    if (configured === 'browser-use' && !browserUseEnabled()) return 'kernel';
    if (configured === 'steel' && !process.env.STEEL_API_KEY?.trim()) {
      throw new Error('STEEL_API_KEY is required when BROWSER_PROVIDER=steel');
    }
    if (configured === 'browser-use' && !process.env.BROWSER_USE_API_KEY?.trim()) {
      throw new Error('BROWSER_USE_API_KEY is required when BROWSER_PROVIDER=browser-use');
    }
    return configured as BrowserProviderName;
  }
  throw new Error(
    `Unsupported BROWSER_PROVIDER=${JSON.stringify(configured)}; expected ${BROWSER_PROVIDERS.join(' or ')}`
  );
}

/** Rollout switch for new Browser Use sessions, including recovery and proxy rotation. */
export function browserUseEnabled(): boolean {
  return browserProviderEnabled('BROWSER_AGENT_BROWSER_USE_ENABLED', false);
}

export function browserProviderEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw.trim().toLowerCase());
}
