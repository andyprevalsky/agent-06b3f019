/**
 * One saved login per origin+username for every reader that hands passwords
 * to an agent.
 *
 *   BrowserPassword rows, unique per (origin, username, browserSource, browserProfile)
 *     chrome/Default, chrome/Profile 1, safari/'', agent_signup/'' … same login
 *        │ preferredBrowserPasswords
 *        ▼
 *   ONE row per (origin, username):
 *     1. enabled (disabledAt null) before disabled
 *     2. user-synced before agent-created (agent_signup, agent_passwordless):
 *        a login the user's own browser saved wins, as it did when a browser
 *        sync overwrote the agent's row under the old one-row-per-login key
 *     3. most recently used (dateLastUsed normalized to Unix ms; unknown last)
 *     4. most recently synced (syncedAt)
 *     5. browserSource, browserProfile, id ascending (a total order)
 *
 * Auth options (all rows) and browser-session passwords (enabled rows) apply
 * the same order, so whenever the login has an enabled row both readers pick
 * the same row id. The output keeps the input order of the chosen rows.
 */

import { prisma } from './database';

/** Saved-login rows created at sign-up carry this source, like "chrome" for synced ones. */
export const MINTED_PASSWORD_BROWSER_SOURCE = 'agent_signup';
/** A minted identity that signed in on a site with no password (code or link sign-in). */
export const MINTED_PASSWORDLESS_BROWSER_SOURCE = 'agent_passwordless';

const AGENT_CREATED_SOURCES: ReadonlySet<string> = new Set([
  MINTED_PASSWORD_BROWSER_SOURCE,
  MINTED_PASSWORDLESS_BROWSER_SOURCE,
]);

const CHROMIUM_UNIX_EPOCH_OFFSET_MS = 11644473600000n;
const CHROMIUM_ONE_DAY_MICROSECONDS = 86400000000n;
const UNIX_MS_VS_CHROMIUM_MICROSECONDS_BOUNDARY = 10000000000000n;

/**
 * Chromium stores microseconds since 1601; Apple imports and agent writes store
 * Unix milliseconds. Null, zero and sub-day values mean "never used".
 */
export function passwordLastUsedMs(value: bigint | null): number | null {
  if (value === null || value <= CHROMIUM_ONE_DAY_MICROSECONDS) return null;
  if (value > UNIX_MS_VS_CHROMIUM_MICROSECONDS_BOUNDARY) {
    return Number(value / 1000n - CHROMIUM_UNIX_EPOCH_OFFSET_MS);
  }
  return Number(value);
}

export function isAgentCreatedPasswordSource(browserSource: string): boolean {
  return AGENT_CREATED_SOURCES.has(browserSource);
}

export interface PreferablePassword {
  id: string;
  origin: string;
  username: string;
  browserSource: string;
  browserProfile: string;
  disabledAt: Date | null;
  dateLastUsed: bigint | null;
  syncedAt: Date;
}

const textOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Negative when `a` is the preferred login of the two. */
export function comparePasswordPreference(a: PreferablePassword, b: PreferablePassword): number {
  if ((a.disabledAt === null) !== (b.disabledAt === null)) return a.disabledAt === null ? -1 : 1;
  const aAgent = isAgentCreatedPasswordSource(a.browserSource);
  if (aAgent !== isAgentCreatedPasswordSource(b.browserSource)) return aAgent ? 1 : -1;
  const aUsed = passwordLastUsedMs(a.dateLastUsed) ?? -1;
  const bUsed = passwordLastUsedMs(b.dateLastUsed) ?? -1;
  if (aUsed !== bUsed) return bUsed - aUsed;
  const synced = b.syncedAt.getTime() - a.syncedAt.getTime();
  if (synced !== 0) return synced;
  return (
    textOrder(a.browserSource, b.browserSource) ||
    textOrder(a.browserProfile, b.browserProfile) ||
    textOrder(a.id, b.id)
  );
}

/** One row per origin+username (see the module order), in input order. */
export function preferredBrowserPasswords<T extends PreferablePassword>(rows: T[]): T[] {
  const winners = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.origin}\u0000${row.username}`;
    const current = winners.get(key);
    if (current === undefined || comparePasswordPreference(row, current) < 0) {
      winners.set(key, row);
    }
  }
  const chosen = new Set(winners.values());
  return rows.filter((row) => chosen.has(row));
}

/**
 * Enabled saved logins handed to a browser session, newest use first: one per
 * origin+username, chosen by the shared preference.
 */
export async function findEnabledSessionPasswords(userId: string) {
  const rows = await prisma.browserPassword.findMany({
    where: { userId, disabledAt: null },
    select: {
      id: true,
      origin: true,
      username: true,
      encryptedPassword: true,
      dateLastUsed: true,
      browserSource: true,
      browserProfile: true,
      disabledAt: true,
      syncedAt: true,
    },
    orderBy: { dateLastUsed: 'desc' },
  });
  return preferredBrowserPasswords(rows);
}
