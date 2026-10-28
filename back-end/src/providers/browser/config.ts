import { BROWSER_PROVIDERS, type BrowserProviderName } from './types';

/** Deployment default for NEW browser sessions; existing rows keep their stored provider. */
export const DEFAULT_BROWSER_PROVIDER: BrowserProviderName = 'tilion';

/** Tilion is the default, so a missing key must fail loudly rather than downgrade silently. */
export class TilionApiKeyMissingError extends Error {
  constructor() {
    super(
      'TILION_API_KEY is required when BROWSER_PROVIDER=tilion (the default); ' +
        'set BROWSER_AGENT_TILION_ENABLED=false to route new work to Kernel'
    );
    this.name = 'TilionApiKeyMissingError';
  }
}

export function selectedBrowserProvider(): BrowserProviderName {
  const configured = (process.env.BROWSER_PROVIDER ?? DEFAULT_BROWSER_PROVIDER)
    .trim()
    .toLowerCase();
  if (BROWSER_PROVIDERS.includes(configured as BrowserProviderName)) {
    // The rollout switches must remain usable kill switches even when their
    // provider was configured as the deployment default. New work returns to Kernel.
    if (configured === 'browser-use' && !browserUseEnabled()) return 'kernel';
    if (configured === 'tilion' && !tilionEnabled()) return 'kernel';
    if (configured === 'steel' && !process.env.STEEL_API_KEY?.trim()) {
      throw new Error('STEEL_API_KEY is required when BROWSER_PROVIDER=steel');
    }
    if (configured === 'browser-use' && !process.env.BROWSER_USE_API_KEY?.trim()) {
      throw new Error('BROWSER_USE_API_KEY is required when BROWSER_PROVIDER=browser-use');
    }
    if (configured === 'tilion' && !process.env.TILION_API_KEY?.trim()) {
      throw new TilionApiKeyMissingError();
    }
    return configured as BrowserProviderName;
  }
  throw new Error(
    `Unsupported BROWSER_PROVIDER=${JSON.stringify(configured)}; expected ${BROWSER_PROVIDERS.join(' or ')}`
  );
}

/** Rollout switch for new Browser Use sessions, including recovery and proxy rotation. */
export function browserUseEnabled(): boolean {
  const value = process.env.BROWSER_AGENT_BROWSER_USE_ENABLED?.trim().toLowerCase();
  return value !== undefined && ['1', 'true', 'yes', 'on', 'enabled'].includes(value);
}

/**
 * Kill switch for new Tilion sessions (default on). When off, new work,
 * rotation and resume of Tilion rows go to Kernel; close/release of existing
 * Tilion sessions still reaches Tilion so nothing leaks.
 */
export function tilionEnabled(): boolean {
  return browserProviderEnabled('BROWSER_AGENT_TILION_ENABLED', true);
}

export function browserProviderEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw.trim().toLowerCase());
}
