/**
 * Public entry point for browser-cookie-reader. External callers
 * (handlers/registry, browser-state-sync service, blackbox test mocks) use
 * `BrowserCookieReader.*` — the class shape is preserved for backward
 * compatibility with the legacy `main/services/browserCookieReader.ts`
 * import surface.
 *
 * The runtime layer is intentionally thin: it delegates the full flow to
 * the service layer. All decryption, I/O, and logging live behind the
 * service / repo split.
 */

import { findBrowserConfig, listInstalledBrowsers, readBrowserCookies } from './service';
import type {
  BrowserConfig,
  BrowserInfo,
  BrowserType,
  CookieData,
  ReadCookiesConfig,
} from './types';

export type { BrowserConfig, BrowserInfo, BrowserType, ReadCookiesConfig };

/**
 * BrowserCookieReader provides multi-browser cookie reading support.
 *
 * Supported Chromium-based browsers (automatic keychain access):
 *   Chrome, Edge, Brave, Arc, Opera, Vivaldi, Chromium
 *
 * Browsers requiring a manual keychain password (Data Protection keychain):
 *   Atlas (ChatGPT Desktop)
 */
export class BrowserCookieReader {
  /** List installed browsers on this machine, with resolved cookie paths. */
  static getInstalledBrowsers(): BrowserInfo[] {
    return listInstalledBrowsers();
  }

  /** Fetch the static per-browser config, or null if the type is unknown. */
  static getBrowserConfig(browserType: BrowserType): BrowserConfig | null {
    return findBrowserConfig(browserType);
  }

  /**
   * Read + decrypt cookies from a specific browser.
   *
   * @param browserType - Chromium-family browser identifier.
   * @param config      - Required for Atlas (keychainPassword); optional otherwise.
   */
  static async readCookies(
    browserType: BrowserType,
    config?: ReadCookiesConfig
  ): Promise<CookieData[]> {
    return readBrowserCookies(browserType, config);
  }
}
