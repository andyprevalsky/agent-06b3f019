/**
 * integration-progress — runtime layer
 *
 * Public surface consumed by other domains (browser-state-sync) and the
 * blackbox tests via the `main/services/integrationProgress` shim. Thin:
 * delegates to the service layer, which owns grouping and the HTTP boundary.
 */

import { postProgress } from './repo';
import {
  cookieAccountId,
  countCookiesByProfile,
  reportCookieProfilesSynced,
  reportCookieProfilesSyncing,
} from './service';
import type { CookieProfileCount, ProgressPostResult, ProgressWriteBody } from './types';

export type { CookieProfileCount, ProgressPostResult, ProgressWriteBody };

/** Cookie shape the reader produces (only the profile tag is read here). */
interface ProfiledCookie {
  browserProfile?: string;
}

export class IntegrationProgress {
  /**
   * One best-effort progress write for any provider account (never throws).
   * Callers that stream progress honour a 202's `retryAfterMs` before resending.
   */
  static post(
    provider: string,
    accountId: string,
    body: ProgressWriteBody,
    accessToken: string
  ): Promise<ProgressPostResult> {
    return postProgress(provider, accountId, body, accessToken);
  }

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
