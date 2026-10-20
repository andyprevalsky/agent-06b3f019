/**
 * Root world-state fork hook for `/prepare-auth` (plan row A6).
 *
 * Reads Root's head revision for the target site BEFORE injection selects the
 * cookies, and returns the callback injection runs on its own CDP connection
 * once the cookies are in place, so the fork records the exact jar the task
 * starts from. Null when the site or session is not tracked.
 */
import type { BrowserContext } from 'playwright';
import {
  readRootSiteRevision,
  recordSiteFork,
  worldStateCookiesFrom,
  worldStateForkSite,
} from '../../providers/browser/worldState';

export async function prepareWorldStateFork(
  session: {
    id: string;
    agentId: string;
    provider: string;
    providerProfileSource: string | null;
    wsUrl: string | null;
  },
  userId: string,
  targetUrl: string
): Promise<((context: BrowserContext) => Promise<void>) | undefined> {
  const site = worldStateForkSite(session, targetUrl);
  if (site === null) return undefined;
  const baseRevision = await readRootSiteRevision(userId, site);
  return async (context) =>
    recordSiteFork({
      browserSessionId: session.id,
      userId,
      agentId: session.agentId,
      site,
      baseRevision,
      liveCookies: worldStateCookiesFrom(await context.cookies()),
    });
}
