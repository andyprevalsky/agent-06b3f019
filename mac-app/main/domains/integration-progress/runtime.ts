/**
 * integration-progress — runtime layer
 *
 * Public surface consumed by other domains (browser-state-sync) and the
 * blackbox tests via the `main/services/integrationProgress` shim. Thin:
 * delegates to the service layer, which owns grouping and the HTTP boundary.
 */

import {
  cookieAccountId,
  countCookiesByProfile,
  reportCookieProfilesSynced,
  reportCookieProfilesSyncing,
} from './service';
import type { CookieProfileCount, ProgressPostResult } from './types';

export type { CookieProfileCount, ProgressPostResult };

/** Cookie shape the reader produces (only the profile tag is read here). */
interface ProfiledCookie {
  browserProfile?: string;
}

export class IntegrationProgress {
  /** Wire account id for one (browser, profile): `<browser>:<profile>` / `default`. */
  static cookieAccountId(browser: string, profile: string): string {
    return cookieAccountId(browser, profile);
  }

  /** Group read cookies into per-profile totals. */
  static countCookiesByProfile(cookies: ProfiledCookie[]): CookieProfileCount[] {
    return countCookiesByProfile(cookies);
  }

  /** Open every profile of a browser at `syncing` (done 0 of total). */
  static reportCookieProfilesSyncing(
    browser: string,
    cookies: ProfiledCookie[],
    accessToken: string,
    runId: string
  ): Promise<ProgressPostResult[]> {
    return reportCookieProfilesSyncing(browser, cookies, accessToken, runId);
  }

  /** Close every profile of a browser at `synced` (done = total). */
  static reportCookieProfilesSynced(
    browser: string,
    cookies: ProfiledCookie[],
    accessToken: string,
    runId: string
  ): Promise<ProgressPostResult[]> {
    return reportCookieProfilesSynced(browser, cookies, accessToken, runId);
  }
}
