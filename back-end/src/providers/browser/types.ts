import type { Browser } from 'playwright';
import type { ProxyGeoLocation } from '../geoip';

export const BROWSER_PROVIDERS = ['steel', 'kernel', 'browser-use', 'tilion'] as const;

export type BrowserProviderName = (typeof BROWSER_PROVIDERS)[number];

export function storedBrowserProvider(value: string): BrowserProviderName {
  // BrowserSession.provider has no database constraint. Preserve the previous
  // legacy fallback while recognizing Browser Use and Tilion explicitly.
  return value === 'kernel' || value === 'browser-use' || value === 'tilion' ? value : 'steel';
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
  validationBrowser?: Browser;
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

/**
 * The provider refused a REST drive call because a CDP client holds the
 * session (Tilion: 409 `session_driven_by_client`, or 502 `file_fetch_failed`
 * with cause `ExternalControlBusy`). Retryable once the client detaches; while
 * the agent is attached it must use its own CDP connection instead.
 */
export class BrowserSessionDrivenByClientError extends Error {
  readonly provider: BrowserProviderName;
  readonly operation: string;
  readonly retryable = true;

  constructor(provider: BrowserProviderName, operation: string, message?: string) {
    super(message ?? `${provider} session is driven by another CDP client; ${operation} refused`);
    this.name = 'BrowserSessionDrivenByClientError';
    this.provider = provider;
    this.operation = operation;
  }
}
