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
  /** Set when the created provider differs from the one first requested (visible fallback). */
  providerSelection?: BrowserProviderSelection;
  /** Requested vs applied exit placement, when the provider reports it (Tilion: country only). */
  geoTargeting?: BrowserGeoTargeting;
}

export interface BrowserGeoTargeting {
  requested: string;
  applied: string;
  requestedLocation: ProxyGeoLocation;
  geoApplied: boolean | null;
  geoUnsupported: string[];
}

export interface BrowserProviderSelection {
  requestedProvider: BrowserProviderName;
  /** e.g. `preferred_config_create_failed: <error>`, `tilion_kill_switch`. */
  fallbackReason: string;
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
  /**
   * Present only when the exit rotated inside the SAME live browser (Tilion `rotate-ip`). The
   * worker keeps that session's only CDP socket, so no validation client exists and none is
   * needed: cookies, storage and tabs never left the browser.
   */
  ipRotation?: { rotated: boolean; freshAllocation: boolean; region: string | null };
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
 * Every remote session one create allocated failed CDP validation and none was
 * bound to the task. Each was released, or its release was unconfirmed and its
 * id was logged at allocation for exact cleanup. The outcome is known, so the
 * caller may run a fresh create.
 */
export class BrowserSessionValidationError extends AggregateError {
  readonly provider: BrowserProviderName;
  readonly sessionIds: readonly string[];

  constructor(
    provider: BrowserProviderName,
    sessionIds: readonly string[],
    errors: unknown[],
    message: string
  ) {
    super(errors, message);
    this.name = 'BrowserSessionValidationError';
    this.provider = provider;
    this.sessionIds = sessionIds;
  }
}
