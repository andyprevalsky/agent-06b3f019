/**
 * Browser-template fork hook for `/prepare-auth` (plan row A6).
 *
 * Returns the callback injection runs on its own CDP connection once the
 * realm's cookies are in place, so the fork records the exact jar the task
 * starts from, the template account (CookieBundle) it was injected with, and
 * that login's age. Null when the site or session is not tracked. The base
 * revision is informational: keep-best decides on the logins themselves.
 */
import type { BrowserContext } from 'playwright';
import {
  readRootSiteRevision,
  recordSiteFork,
  templateAccountFor,
  worldStateCookiesFrom,
  worldStateForkSite,
  type InjectedCookieBundle,
} from '../../providers/browser/worldState';

const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600n * 1_000_000n;

function injectedLoginAge(bundle: InjectedCookieBundle | null): Date | null {
  const freshest = bundle?.freshestCookieUtc ?? null;
  if (freshest === null) return null;
  const unixMicros = freshest - CHROME_EPOCH_OFFSET_MICROSECONDS;
  return unixMicros > 0n ? new Date(Number(unixMicros / 1_000n)) : null;
}

export function prepareWorldStateFork(
  session: {
    id: string;
    agentId: string;
    provider: string;
    providerProfileSource: string | null;
    wsUrl: string | null;
  },
  userId: string,
  targetUrl: string
): ((context: BrowserContext, injected: InjectedCookieBundle | null) => Promise<void>) | undefined {
  const site = worldStateForkSite(session, targetUrl);
  if (site === null) return undefined;
  return async (context, injected) => {
    const account = templateAccountFor(injected);
    await recordSiteFork({
      browserSessionId: session.id,
      userId,
      agentId: session.agentId,
      site,
      account,
      baseRevision: await readRootSiteRevision(userId, site, account),
      baseObservedAt: injectedLoginAge(injected),
      liveCookies: worldStateCookiesFrom(await context.cookies()),
    });
  };
}
