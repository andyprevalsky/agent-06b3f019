import type { Browser } from 'playwright';
import type { ProxyGeoLocation } from '../geoip';

export const BROWSER_PROVIDERS = ['steel', 'kernel', 'browser-use'] as const;

export type BrowserProviderName = (typeof BROWSER_PROVIDERS)[number];

export function storedBrowserProvider(value: string): BrowserProviderName {
  if (BROWSER_PROVIDERS.includes(value as BrowserProviderName)) return value as BrowserProviderName;
  throw new Error(`Unsupported stored browser provider: ${value}`);
}

export interface BrowserProviderSession {
  provider: BrowserProviderName | 'local';
  sessionId: string;
  debugUrl: string;
  taskId: string;
  wsUrl: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: string | null;
  profileSource: string;
  validationBrowser: Browser | null;
}

export interface BrowserProviderResumeSession {
  provider: BrowserProviderName | 'local';
  debugUrl: string;
  sessionId: string;
  wsUrl: string;
  savedUrl?: string;
  proxySource: string;
  proxyLocation: ProxyGeoLocation;
  profileId: string | null;
  profileSource: string;
}

export interface BrowserSessionHealth {
  provider: BrowserProviderName | 'local';
  sessionId: string;
  status: string | null;
  createdAt: string | null;
  timeoutMs: number | null;
  expiresAt: string | null;
  ttlMs: number | null;
  profileId: string | null;
  uptimeMs?: number | null;
}

export interface BrowserFileInfo {
  path: string;
  size: number;
  lastModified?: string;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserViewportResizeResult {
  provider: BrowserProviderName;
  supported: boolean;
  resized: boolean;
  viewport: BrowserViewport;
}

export class BrowserProviderRateLimitError extends Error {
  readonly provider: BrowserProviderName;

  constructor(provider: BrowserProviderName, message: string) {
    super(message);
    this.name = 'BrowserProviderRateLimitError';
    this.provider = provider;
  }
}
