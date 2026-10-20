/**
 * Browser world repo: owner-scoped reads of Root's per-site heads, the Root
 * browser session and each agent's per-site forks. Every query is keyed by one
 * user (and one agent), never by a whole user's agent tree.
 */
import { domainVariants } from '../../providers/browserCookies';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { ROOT_BROWSER_PROFILE, ROOT_BROWSER_SOURCE } from '../../providers/browser/worldState';
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
    orderBy: { site: 'asc' },
    take: MAX_ROOT_SITES_LISTED,
  });
}

export async function listRootCookies(userId: string) {
  return prisma.cookie.findMany({
    where: { userId, browserSource: ROOT_BROWSER_SOURCE, browserProfile: ROOT_BROWSER_PROFILE },
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
    select: { site: true, revision: true },
  });
}

/**
 * Forget one site in Root: drop its Root cookies and bundle, and advance its
 * head as an empty write. Keeping the head (instead of deleting it) keeps the
 * revision monotonic, so a task that forked before the forget stays stale.
 */
export async function forgetRootSite(userId: string, site: string): Promise<boolean> {
  return runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-world:${userId}:${site}`}))`;
    const head = await tx.browserSiteState.findUnique({ where: { userId_site: { userId, site } } });
    if (head === null || head.cookieCount === 0) return false;
    await tx.cookie.deleteMany({
      where: {
        userId,
        browserSource: ROOT_BROWSER_SOURCE,
        browserProfile: ROOT_BROWSER_PROFILE,
        OR: domainVariants(site),
      },
    });
    await tx.cookieBundle.deleteMany({
      where: {
        userId,
        authRealm: site,
        browserSource: ROOT_BROWSER_SOURCE,
        browserProfile: ROOT_BROWSER_PROFILE,
      },
    });
    await tx.browserSiteState.update({
      where: { id: head.id },
      data: {
        revision: head.revision + 1,
        authFingerprint: '',
        cookieCount: 0,
        lastWriterKind: 'user_forget',
        lastWriterTaskId: null,
        lastWriterAgentId: null,
      },
    });
    return true;
  });
}
