/**
 * Seeding the home browser from the template (plan row A6).
 *
 * A browser jar holds one session per site, so the home browser gets ONE
 * template account per site: the one with the freshest live auth cookie, the
 * same rule injection's bundle selection uses (selectTopCookieBundle). Mixing
 * accounts would build a "Frankenstein" session (see pickCoherentProfile).
 * The open then forks every site of the jar on the account it injected, so
 * only what the user changes afterwards is a new login.
 */
import type { Browser } from 'playwright';
import { isAuthCredentialCookieName } from '../../providers/authCookies';
import { authRealmFromCookieDomain } from '../../providers/authRealm';
import type { BrowserProviderSession } from '../../providers/browser/types';
import {
  recordRootForks,
  rootBrowserAgentId,
  worldStateCookiesFrom,
} from '../../providers/browser/worldState';
import { createLogger } from '../../providers/logger';
import {
  playwrightCookiesFromRows,
  storedCookieIsLive,
} from '../../providers/steel/injectionCookies';
import * as repo from './repo';

const log = createLogger('BrowserWorld');

type Cookie = Awaited<ReturnType<typeof repo.listRootCookies>>[number];

interface AccountGroup {
  account: string;
  rows: Cookie[];
  freshest: bigint;
}

/** One account per site; ties prefer the Rose browser's own account (''), then the name. */
export function pickHomeAccounts(rows: Cookie[]): {
  rows: Cookie[];
  accountBySite: Map<string, string>;
} {
  const groups = new Map<string, Map<string, AccountGroup>>();
  for (const row of rows) {
    const site = authRealmFromCookieDomain(row.domain);
    if (site === '' || row.name === '') continue;
    const accounts = groups.get(site) ?? new Map<string, AccountGroup>();
    const group = accounts.get(row.browserProfile) ?? {
      account: row.browserProfile,
      rows: [],
      freshest: -1n,
    };
    group.rows.push(row);
    const counts = storedCookieIsLive(row) && isAuthCredentialCookieName(row.name);
    if (counts && (row.creationUtc ?? 0n) > group.freshest) group.freshest = row.creationUtc ?? 0n;
    accounts.set(row.browserProfile, group);
    groups.set(site, accounts);
  }
  const picked: Cookie[] = [];
  const accountBySite = new Map<string, string>();
  for (const [site, accounts] of groups) {
    const best = [...accounts.values()]
      .filter((group) => group.freshest >= 0n)
      .sort((a, b) => {
        if (a.freshest !== b.freshest) return a.freshest > b.freshest ? -1 : 1;
        return a.account < b.account ? -1 : a.account > b.account ? 1 : 0;
      })[0];
    if (best === undefined) continue;
    accountBySite.set(site, best.account);
    picked.push(...best.rows);
  }
  return { rows: picked, accountBySite };
}

/** Template cookies into the fresh home browser, then fork its whole jar. */
export async function seedRootBrowser(
  userId: string,
  session: BrowserProviderSession,
  browser: Browser
): Promise<void> {
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('Root browser has no default context');
  const { rows, accountBySite } = pickHomeAccounts(await repo.listRootCookies(userId));
  const cookies = playwrightCookiesFromRows(rows).filter((cookie) => cookie.name !== '');
  if (cookies.length > 0) await context.addCookies(cookies);
  const forked = await recordRootForks({
    browserSessionId: session.taskId,
    userId,
    agentId: rootBrowserAgentId(userId),
    liveCookies: worldStateCookiesFrom(await context.cookies()),
    accountBySite,
  });
  log.info('root_browser.seeded', {
    userId,
    taskId: session.taskId,
    templateCookies: cookies.length,
    accounts: Object.fromEntries(accountBySite),
    forkedSites: forked.length,
  });
}
