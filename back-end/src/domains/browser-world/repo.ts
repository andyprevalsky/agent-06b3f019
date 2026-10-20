/**
 * Browser world repo: owner-scoped reads of the template's per-(site, account)
 * heads, the home browser session and each agent's per-site forks. Every query
 * is keyed by one user (and one agent or one agent tree), never a user's whole
 * agent list.
 */
import { domainVariants } from '../../providers/browserCookies';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { ROOT_BROWSER_SOURCE } from '../../providers/browser/worldState';
import { nextSuperseded } from '../../providers/browser/worldStateKeepBest';
import {
  MAX_AGENT_BROWSER_TASKS,
  MAX_ROOT_COOKIES_PER_OPEN,
  MAX_ROOT_SITES_LISTED,
} from './config';

export async function findActiveRootSession(userId: string, rootAgentId: string) {
  return prisma.browserSession.findFirst({
    where: { agentId: rootAgentId, status: 'ACTIVE', context: { userId } },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { siteForks: true } } },
  });
}

export async function findRootSessionByTaskId(taskId: string) {
  return prisma.browserSession.findUnique({
    where: { id: taskId },
    include: { _count: { select: { siteForks: true } } },
  });
}

export async function listRootSites(userId: string) {
  return prisma.browserSiteState.findMany({
    where: { userId, cookieCount: { gt: 0 } },
    orderBy: [{ site: 'asc' }, { account: 'asc' }],
    take: MAX_ROOT_SITES_LISTED,
  });
}

/** Every template account's cookies (the home browser picks one account per site). */
export async function listRootCookies(userId: string) {
  return prisma.cookie.findMany({
    where: { userId, browserSource: ROOT_BROWSER_SOURCE },
    take: MAX_ROOT_COOKIES_PER_OPEN,
  });
}

export async function listAgentBrowserTasks(userId: string, agentId: string) {
  return prisma.browserSession.findMany({
    where: { agentId, context: { userId } },
    orderBy: { createdAt: 'desc' },
    take: MAX_AGENT_BROWSER_TASKS,
    include: { siteForks: { orderBy: { site: 'asc' } } },
  });
}

export async function findRootRevisions(userId: string, sites: string[]) {
  if (sites.length === 0) return [];
  return prisma.browserSiteState.findMany({
    where: { userId, site: { in: sites } },
    select: { site: true, account: true, revision: true },
  });
}

/**
 * The current URL of the newest ACTIVE browser task in one root agent's tree
 * (the root and every agent on its bus), or null: its last recorded URL, else
 * the URL it opened at. One statement, owner-scoped by the Agent's userId so
 * another user's root id finds nothing. The materialized tree (Agent pkey +
 * Agent(busId)) drives one BrowserSession(agentId) probe per tree agent, so
 * the cost follows the tree's size, never the number of active sessions.
 */
export async function findTreeBrowserUrl(userId: string, rootAgentId: string) {
  const rows = await prisma.$queryRaw<Array<{ url: string }>>`
    WITH tree AS MATERIALIZED (
      SELECT a.id FROM "Agent" a WHERE a.id = ${rootAgentId} AND a."userId" = ${userId}
      UNION
      SELECT a.id FROM "Agent" a WHERE a."busId" = ${rootAgentId} AND a."userId" = ${userId}
    )
    SELECT newest.url
    FROM tree
    CROSS JOIN LATERAL (
      SELECT COALESCE(NULLIF(bs."currentUrl", ''), bs."startUrl") AS url, bs."createdAt"
      FROM "BrowserSession" bs
      WHERE bs."agentId" = tree.id
        AND bs.status = 'ACTIVE'
        AND COALESCE(NULLIF(bs."currentUrl", ''), bs."startUrl") ~* '^https?://'
      ORDER BY bs."createdAt" DESC
      LIMIT 1
    ) newest
    ORDER BY newest."createdAt" DESC
    LIMIT 1`;
  return rows[0]?.url ?? null;
}

/**
 * Forget one site in the template: drop every account's cookies and bundle for
 * it and advance each head as an empty write that supersedes its login.
 * Keeping the heads (instead of deleting them) keeps revisions monotonic, and
 * the superseded login cannot come back from a task that still holds it.
 */
export async function forgetRootSite(userId: string, site: string): Promise<boolean> {
  return runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-world:${userId}:${site}`}))`;
    const heads = await tx.browserSiteState.findMany({
      where: { userId, site, cookieCount: { gt: 0 } },
    });
    if (heads.length === 0) return false;
    await tx.cookie.deleteMany({
      where: { userId, browserSource: ROOT_BROWSER_SOURCE, OR: domainVariants(site) },
    });
    await tx.cookieBundle.deleteMany({
      where: { userId, authRealm: site, browserSource: ROOT_BROWSER_SOURCE },
    });
    for (const head of heads) {
      await tx.browserSiteState.update({
        where: { id: head.id },
        data: {
          revision: head.revision + 1,
          supersededFingerprints: nextSuperseded(
            head.supersededFingerprints,
            [head.authFingerprint],
            ''
          ),
          authFingerprint: '',
          authExpiresAt: null,
          validatedAt: null,
          observedAt: new Date(),
          cookieCount: 0,
          lastWriterKind: 'user_forget',
          lastWriterTaskId: null,
          lastWriterAgentId: null,
        },
      });
    }
    return true;
  });
}
