import { ensureLogicalBrowser } from '../../providers/browser/logicalSession';
import { resumeBrowserSession } from '../../providers/browserSessionResume';
/**
 * Browser world service (plan row A6): the user's one browser template, split
 * by website and account, and the home browser that shows it.
 *
 *   any browser task close ──▶ every credential in its jar percolates into the
 *                              template; keep-best within one account
 *   agent task ──prepare-auth(site)──▶ fork that site on the injected account
 *   Browser app opened ──open──▶ home browser on the persistent profile, opened
 *                              at start_url, else the root agent tree's
 *                              default_url; seeded with one account per site
 *   home browser close ──▶ same percolation as any task
 *   UI ──list──▶ template sites per account and per-agent forks
 *   UI ──take over──▶ existing /api/browser-session/task/:taskId/{live-view,control}
 *
 * The home browser is never opened automatically: reading state, closing tasks
 * and percolating credentials do not start it. The merge and keep-best rule
 * live in providers/browser/worldState*.ts so every provider close applies them.
 */
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  closeSession,
  createSessionWithContext,
  getBrowserSessionHealth,
  getOrCreateContext,
} from '../../providers/browser';
import type { BrowserProviderSession } from '../../providers/browser/types';
import {
  browserWorldStateEnabled,
  rootBrowserAgentId,
  type WorldStateMergeReceipt,
} from '../../providers/browser/worldState';
import { controlPath, liveViewPath, LIVE_PROVIDER_STATUSES } from './config';
import * as repo from './repo';
import { seedRootBrowser } from './service.home';
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
  close: (sessionId) => closeSession(sessionId, true),
};

function rootView(session: {
  id: string;
  sessionId: string | null;
  status: string;
  provider: string;
  debugUrl: string | null;
  startUrl: string | null;
  _count: { siteForks: number };
}): RootBrowserView {
  return {
    task_id: session.id,
    session_id: session.sessionId,
    status: session.status,
    provider: session.provider,
    live_view_url: session.debugUrl,
    start_url: session.startUrl,
    forked_sites: session._count.siteForks,
    live_view_path: liveViewPath(session.id),
    control_path: controlPath(session.id),
  };
}

export async function listRootSites(userId: string): Promise<RootSiteView[]> {
  const rows = await repo.listRootSites(userId);
  return rows.map((row) => ({
    site: row.site,
    account: row.account,
    revision: row.revision,
    cookie_count: row.cookieCount,
    validated_at: row.validatedAt?.toISOString() ?? null,
    auth_expires_at: row.authExpiresAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
    last_writer: {
      kind: row.lastWriterKind,
      task_id: row.lastWriterTaskId,
      agent_id: row.lastWriterAgentId,
    },
  }));
}

/** The URL the root agent's tree is working on: its newest active browser task's. */
export async function defaultRootBrowserUrl(
  userId: string,
  agentId: string | undefined
): Promise<string | null> {
  if (agentId === undefined) return null;
  return repo.findTreeBrowserUrl(userId, agentId);
}

/** Read-only: never opens the home browser. */
export async function getRootBrowser(
  userId: string,
  options: { agentId?: string } = {}
): Promise<{ root: RootBrowserView | null; sites: RootSiteView[]; default_url: string | null }> {
  const [session, sites, defaultUrl] = await Promise.all([
    repo.findActiveRootSession(userId, rootBrowserAgentId(userId)),
    listRootSites(userId),
    defaultRootBrowserUrl(userId, options.agentId),
  ]);
  return { root: session === null ? null : rootView(session), sites, default_url: defaultUrl };
}

/**
 * Open (or return) the user's home browser, on request only. Idempotent per
 * user: a live session is reused as it is (not re-navigated); an ended one is
 * closed (merging what it can) and replaced. A new session opens at
 * `startUrl`, else at the default URL of `agentId`'s tree, else the provider's.
 */
export async function openRootBrowser(
  userId: string,
  options: { startUrl?: string; agentId?: string } = {},
  deps: RootBrowserDeps = defaultDeps
): Promise<RootBrowserView> {
  if (!browserWorldStateEnabled()) throw new Error('Browser world state is disabled');
  if (deps === defaultDeps) {
    const logical = await ensureLogicalBrowser(userId, rootBrowserAgentId(userId));
    if (
      logical.status === 'ACTIVE' &&
      logical.sessionId !== null &&
      (logical.controlState !== 'AGENT' || (await deps.isLive(logical.sessionId)) !== false)
    ) {
      const current = await repo.findRootSessionByTaskId(logical.id);
      if (!current) throw new RootBrowserNotOpenError();
      return rootView(current);
    }
    const startUrl = options.startUrl ?? (await defaultRootBrowserUrl(userId, options.agentId));
    if (startUrl !== null && startUrl !== '' && logical.startUrl === null)
      await repo.updateRootSessionUrl(logical.id, startUrl);
    await resumeBrowserSession(logical.id);
    const current = await repo.findRootSessionByTaskId(logical.id);
    if (!current) throw new RootBrowserNotOpenError();
    return rootView(current);
  }
  const rootAgentId = rootBrowserAgentId(userId);
  const existing = await repo.findActiveRootSession(userId, rootAgentId);
  if (existing !== null && existing.sessionId !== null) {
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

  const startUrl =
    options.startUrl ?? (await defaultRootBrowserUrl(userId, options.agentId)) ?? undefined;
  const contextId = await getOrCreateContext(userId);
  const session = await deps.createSession(contextId, rootAgentId, startUrl);
  try {
    if (session.validationBrowser !== null) {
      await seedRootBrowser(userId, session, session.validationBrowser);
    }
  } catch (error) {
    // A home browser without the template is still the user's browser; they
    // can sign in by hand. Log loudly instead of releasing it.
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

/** Close the home browser; its credentials percolate into the template. */
export async function closeRootBrowser(
  userId: string,
  deps: RootBrowserDeps = defaultDeps
): Promise<{ world_state: WorldStateMergeReceipt | null }> {
  const existing = await repo.findActiveRootSession(userId, rootBrowserAgentId(userId));
  if (existing === null || existing.sessionId === null) throw new RootBrowserNotOpenError();
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
  const revisionOf = new Map(heads.map((head) => [`${head.site}|${head.account}`, head.revision]));
  return tasks.map((task) => ({
    task_id: task.id,
    session_id: task.sessionId,
    status: task.status,
    live_view_url: task.debugUrl,
    live_view_path: liveViewPath(task.id),
    control_path: controlPath(task.id),
    sites: task.siteForks.map((fork): ForkView => ({
      site: fork.site,
      account: fork.account,
      state: forkState(fork),
      base_revision: fork.baseRevision,
      merged_revision: fork.mergedRevision,
      root_revision: revisionOf.get(`${fork.site}|${fork.account}`) ?? 0,
      forked_at: fork.forkedAt.toISOString(),
      merged_at: fork.mergedAt?.toISOString() ?? null,
    })),
  }));
}
