/**
 * integration-progress — service layer
 *
 * Reports per-browser-profile cookie sync progress while a sync runs. Each
 * (browser, profile) is one account at `<browser>:<profile>` (the legacy empty
 * profile maps to `default`), exactly mirroring the backend account id
 * (back-end/src/domains/integrations/syncAccountsContract.ts). The sync reads
 * every profile's cookie count up front (the known total), then marks each
 * profile `syncing` (done 0 of total) before the upload and `synced`
 * (done = total) once the upload confirms — so `done` rises from 0 to the real
 * row count, never a fabricated percentage.
 *
 * Every write is best-effort: a failed or stale (409) progress POST never fails
 * the underlying sync. One write per profile per phase keeps writes O(1) per
 * batch and within the backend's per-account coalescing budget.
 *
 * Layer rule: service imports own repo/types/config and shared providers only.
 */

import { COOKIE_PROGRESS_UNIT, DEFAULT_ACCOUNT_ID } from './config';
import { postProgress } from './repo';
import type { CookieProfileCount, ProgressPostResult, SyncState } from './types';

/** Cookie shape the reader produces (only the profile tag is read here). */
interface ProfiledCookie {
  browserProfile?: string;
}

/**
 * Wire account id for one browser profile. Matches the backend's
 * `cookieAccountStorageId` → `toWireAccountId`: the empty profile is `default`,
 * every real profile is `<browser>:<profile>`.
 */
export function cookieAccountId(browser: string, profile: string): string {
  return profile === '' ? DEFAULT_ACCOUNT_ID : `${browser}:${profile}`;
}

/** Group a browser's read cookies into per-profile totals (stable order). */
export function countCookiesByProfile(cookies: ProfiledCookie[]): CookieProfileCount[] {
  const totals = new Map<string, number>();
  for (const cookie of cookies) {
    const profile = cookie.browserProfile ?? '';
    totals.set(profile, (totals.get(profile) ?? 0) + 1);
  }
  return [...totals.entries()].map(([profile, total]) => ({ profile, total }));
}

async function reportProfiles(
  browser: string,
  profiles: CookieProfileCount[],
  accessToken: string,
  runId: string,
  state: SyncState
): Promise<ProgressPostResult[]> {
  return Promise.all(
    profiles.map((entry) =>
      postProgress(
        browser,
        cookieAccountId(browser, entry.profile),
        {
          runId,
          state,
          unit: COOKIE_PROGRESS_UNIT,
          total: entry.total,
          // syncing opens the profile at 0; synced closes it at its full count.
          done: state === 'synced' ? entry.total : 0,
        },
        accessToken
      )
    )
  );
}

/**
 * Mark every profile of a browser `syncing` with its known total (done 0).
 * Called just before the cookie upload for that browser.
 */
export async function reportCookieProfilesSyncing(
  browser: string,
  cookies: ProfiledCookie[],
  accessToken: string,
  runId: string
): Promise<ProgressPostResult[]> {
  return reportProfiles(browser, countCookiesByProfile(cookies), accessToken, runId, 'syncing');
}

/**
 * Mark every profile of a browser `synced` (done = total). Called once the
 * browser's cookie upload has confirmed.
 */
export async function reportCookieProfilesSynced(
  browser: string,
  cookies: ProfiledCookie[],
  accessToken: string,
  runId: string
): Promise<ProgressPostResult[]> {
  return reportProfiles(browser, countCookiesByProfile(cookies), accessToken, runId, 'synced');
}
