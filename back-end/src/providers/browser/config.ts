import { BROWSER_PROVIDERS, type BrowserProviderName } from './types';

export function selectedBrowserProvider(): BrowserProviderName {
  const configured = (process.env.BROWSER_PROVIDER ?? 'kernel').trim().toLowerCase();
  if (BROWSER_PROVIDERS.includes(configured as BrowserProviderName)) {
    if (configured === 'steel' && !process.env.STEEL_API_KEY?.trim()) {
      throw new Error('STEEL_API_KEY is required when BROWSER_PROVIDER=steel');
    }
    return configured as BrowserProviderName;
  }
  throw new Error(
    `Unsupported BROWSER_PROVIDER=${JSON.stringify(configured)}; expected ${BROWSER_PROVIDERS.join(' or ')}`
  );
}

export function browserProviderEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw.trim().toLowerCase());
}
