/**
 * Browser world service (plan row A6): the user's Root browser and the
 * per-site world state agents fork from and merge into.
 *
 *   UI ──open──▶ Root browser (persistent provider profile)
 *                 + inject Root's per-site cookies ("rose_root")
 *                 + fork every site of its jar (base = what it already holds)
 *   agent browser task ──prepare-auth(site)──▶ fork that site only
 *   any close ──▶ providers/browser/worldState merge (guarded per-site LWW)
 *   UI ──list──▶ Root sites (head revision, last writer) and per-agent forks
 *   UI ──take over──▶ existing /api/browser-session/task/:taskId/{live-view,control}
 *
 * The merge and conflict rule live in providers/browser/worldState.ts so every
 * provider close path applies them.
 */
import type { Browser } from 'playwright';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  closeSession,
  createSessionWithContext,
  getBrowserSessionHealth,
  getOrCreateContext,
} from '../../providers/browser';
import type { BrowserProviderSession } from '../../providers/browser/types';
import { playwrightCookiesFromRows } from '../../providers/steel/injectionCookies';
import {
  browserWorldStateEnabled,
  recordRootForks,
  rootBrowserAgentId,
  worldStateCookiesFrom,
  type WorldStateMergeReceipt,
} from '../../providers/browser/worldState';
import { controlPath, liveViewPath, LIVE_PROVIDER_STATUSES } from './config';
import * as repo from './repo';
import {
  RootBrowserNotOpenError,
  type AgentBrowserTaskView,
  type ForkState,
  type ForkView,
  type RootBrowserView,
  type RootSiteView,
} from './types';

export { RootBrowserNotOpenError } from './types';

const log = createLogger('BrowserWorld');

export interface RootBrowserDeps {
  createSession: (
    contextId: string,
    agentId: string,
    startUrl: string | undefined
  ) => Promise<BrowserProviderSession>;
  /** true live, false ended, null unknown. */
  isLive: (sessionId: string) => Promise<boolean | null>;
  close: (sessionId: string) => Promise<{ worldState: WorldStateMergeReceipt | null }>;
}

const defaultDeps: RootBrowserDeps = {
  createSession: (contextId, agentId, startUrl) =>
    createSessionWithContext(contextId, agentId, DEFAULT_GEOLOCATION, startUrl, {
      keepValidationConnection: true,
    }),
  isLive: async (sessionId) => {
    try {
      const health = await getBrowserSessionHealth(sessionId);
      if (health.ttlMs !== null && health.ttlMs <= 0) return false;
      if (health.status === null) return null;
      return LIVE_PROVIDER_STATUSES.includes(health.status.toLowerCase());
    } catch {
      return null;
    }
  },
  close: (sessionId) => closeSession(sessionId, false),
};

function rootView(session: {
  id: string;
  sessionId: string;
  status: string;
  provider: string;
  debugUrl: string | null;
  _count: { siteForks: number };
}): RootBrowserView {
  return {
    task_id: session.id,
    session_id: session.sessionId,
    status: session.status,
    provider: session.provider,
    live_view_url: session.debugUrl,
    forked_sites: session._count.siteForks,
    live_view_path: liveViewPath(session.id),
    control_path: controlPath(session.id),
  };
}

export async function listRootSites(userId: string): Promise<RootSiteView[]> {
  const rows = await repo.listRootSites(userId);
  return rows.map((row) => ({
    site: row.site,
    revision: row.revision,
    cookie_count: row.cookieCount,
    updated_at: row.updatedAt.toISOString(),
    last_writer: {
      kind: row.lastWriterKind,
      task_id: row.lastWriterTaskId,
      agent_id: row.lastWriterAgentId,
    },
  }));
}

export async function getRootBrowser(userId: string): Promise<{
  root: RootBrowserView | null;
  sites: RootSiteView[];
}> {
  const [session, sites] = await Promise.all([
    repo.findActiveRootSession(userId, rootBrowserAgentId(userId)),
    listRootSites(userId),
  ]);
  return { root: session === null ? null : rootView(session), sites };
}

/** Root cookies into the fresh Root browser, then fork its whole jar. */
async function seedRootBrowser(
  userId: string,
  session: BrowserProviderSession,
  browser: Browser
): Promise<void> {
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('Root browser has no default context');
  const rootCookies = playwrightCookiesFromRows(await repo.listRootCookies(userId)).filter(
    (cookie) => cookie.name !== ''
  );
  if (rootCookies.length > 0) await context.addCookies(rootCookies);
  const forked = await recordRootForks({
    browserSessionId: session.taskId,
    userId,
    agentId: rootBrowserAgentId(userId),
    liveCookies: worldStateCookiesFrom(await context.cookies()),
  });
  log.info('root_browser.seeded', {
    userId,
    taskId: session.taskId,
    rootCookies: rootCookies.length,
    forkedSites: forked.length,
  });
}

/**
 * Open (or return) the user's Root browser. Idempotent per user: a live Root
 * session is reused; an ended one is closed (merging what it can) and replaced.
 */
export async function openRootBrowser(
  userId: string,
  options: { startUrl?: string } = {},
  deps: RootBrowserDeps = defaultDeps
): Promise<RootBrowserView> {
  if (!browserWorldStateEnabled()) throw new Error('Browser world state is disabled');
  const rootAgentId = rootBrowserAgentId(userId);
  const existing = await repo.findActiveRootSession(userId, rootAgentId);
  if (existing !== null) {
    const live = await deps.isLive(existing.sessionId);
    if (live !== false) return rootView(existing);
    await deps.close(existing.sessionId).catch((error: unknown) => {
      log.warn('root_browser.stale_close_failed', {
        userId,
        sessionId: existing.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const contextId = await getOrCreateContext(userId);
  const session = await deps.createSession(contextId, rootAgentId, options.startUrl);
  try {
    if (session.validationBrowser !== null) {
      await seedRootBrowser(userId, session, session.validationBrowser);
    }
  } catch (error) {
    // A Root browser without its world state is still the user's browser;
    // they can sign in by hand. Log loudly instead of releasing it.
    log.error('root_browser.seed_failed', {
      userId,
      taskId: session.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await session.validationBrowser?.close().catch(() => undefined);
  }
  const created = await repo.findRootSessionByTaskId(session.taskId);
  if (created === null) throw new Error('Root browser session row was not persisted');
  return rootView(created);
}

/** Close the Root browser; its changed sites merge into Root on the way out. */
export async function closeRootBrowser(
  userId: string,
  deps: RootBrowserDeps = defaultDeps
): Promise<{ world_state: WorldStateMergeReceipt | null }> {
  const existing = await repo.findActiveRootSession(userId, rootBrowserAgentId(userId));
  if (existing === null) throw new RootBrowserNotOpenError();
  const { worldState } = await deps.close(existing.sessionId);
  return { world_state: worldState };
}

export async function forgetRootSite(userId: string, site: string): Promise<boolean> {
  return repo.forgetRootSite(userId, site.toLowerCase());
}

function forkState(fork: { mergedRevision: number | null; lastOutcome: string | null }): ForkState {
  if (fork.mergedRevision !== null) return 'merged';
  return (fork.lastOutcome ?? 'forked') as ForkState;
}

/** Which sites each of an agent's browser tasks forked or merged. */
export async function listAgentBrowserWorld(
  userId: string,
  agentId: string
): Promise<AgentBrowserTaskView[]> {
  const tasks = await repo.listAgentBrowserTasks(userId, agentId);
  const sites = [...new Set(tasks.flatMap((task) => task.siteForks.map((fork) => fork.site)))];
  const heads = await repo.findRootRevisions(userId, sites);
  const revisionBySite = new Map(heads.map((head) => [head.site, head.revision]));
  return tasks.map((task) => ({
    task_id: task.id,
    session_id: task.sessionId,
    status: task.status,
    live_view_url: task.debugUrl,
    live_view_path: liveViewPath(task.id),
    control_path: controlPath(task.id),
    sites: task.siteForks.map((fork): ForkView => ({
      site: fork.site,
      state: forkState(fork),
      base_revision: fork.baseRevision,
      merged_revision: fork.mergedRevision,
      root_revision: revisionBySite.get(fork.site) ?? 0,
      forked_at: fork.forkedAt.toISOString(),
      merged_at: fork.mergedAt?.toISOString() ?? null,
    })),
  }));
}
