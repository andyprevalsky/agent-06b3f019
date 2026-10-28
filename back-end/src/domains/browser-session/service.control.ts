import { getBrowserSessionHealth } from '../../providers/browser';
import { getTilionLiveViewUrl, isTilionSessionEndedError } from '../../providers/browser/tilion';
import { resumeBrowserSession as resumeBrowserSessionProvider } from '../../providers/browserSessionResume';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import { SessionNotFoundError } from './service.local-storage';
import { isLiveBrowserStatus } from './service.task-info';
import { BrowserControlState as PrismaControlState, BrowserSessionStatus } from './types';

const log = createLogger('BrowserControl');
const { ACTIVE } = BrowserSessionStatus;
const { AGENT, USER_REQUESTED, USER } = PrismaControlState;
const CONTROL_LEASE_MS = 90_000;

export type BrowserControlOwnership = 'agent' | 'requested' | 'user';

export class BrowserControlUnavailableError extends Error {
  constructor(status: string) {
    super(`Browser control is unavailable while the session is ${status}`);
    this.name = 'BrowserControlUnavailableError';
  }
}

function publicControlState(state: PrismaControlState): BrowserControlOwnership {
  if (state === USER_REQUESTED) return 'requested';
  if (state === USER) return 'user';
  return 'agent';
}

function leaseExpiry(): Date {
  return new Date(Date.now() + CONTROL_LEASE_MS);
}

async function requireControlRecord(taskId: string, userId?: string) {
  const session = await repo.findBrowserControlRecord(taskId);
  if (session === null || (userId !== undefined && session.context.userId !== userId)) {
    throw new SessionNotFoundError();
  }
  return session;
}

export async function getBrowserControlState(taskId: string, userId?: string) {
  let session = await requireControlRecord(taskId, userId);
  const expiresAt = session.controlLeaseExpiresAt;
  if (session.controlState !== AGENT && expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    await repo.expireBrowserControlLease(taskId, session.controlState, expiresAt);
    session = await requireControlRecord(taskId, userId);
  }
  const agent = await repo.findAgentStatus(session.agentId);
  return {
    state: publicControlState(session.controlState),
    agentPaused: agent?.status === 'PAUSED',
    debugUrl: session.debugUrl,
  };
}

export interface BrowserLiveView {
  taskId: string;
  sessionId: string | null;
  debugUrl: string | null;
  status: string;
  /** false: closed or provider reports it ended; null: provider health unknown. */
  live: boolean | null;
  /** Server time before the read; orders this against BROWSER_SESSION broadcasts. */
  asOf: number;
}

export interface BrowserLiveViewDeps {
  findRecord?: typeof repo.findBrowserLiveViewRecord;
  health?: typeof getBrowserSessionHealth;
  mintTilionLiveViewUrl?: typeof getTilionLiveViewUrl;
}

async function providerLiveness(
  sessionId: string,
  health: typeof getBrowserSessionHealth
): Promise<boolean | null> {
  try {
    const observed = await health(sessionId);
    if (observed.ttlMs !== null && observed.ttlMs <= 0) return false;
    return isLiveBrowserStatus(observed.status);
  } catch (error) {
    // Tilion answers 404/410 once an ended session's record ages out: it is gone, not unknown.
    if (isTilionSessionEndedError(error)) return false;
    log.warn('Live-view provider health check failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The live view's binding read (mount, focus, transcript change). Same owner
 * check as control, no lease side effects. An ACTIVE row can still name a
 * session the provider already ended (e.g. an idle auth handoff), so ACTIVE
 * rows are confirmed against provider health.
 */
export async function getBrowserLiveView(
  taskId: string,
  userId?: string,
  deps: BrowserLiveViewDeps = {}
): Promise<BrowserLiveView> {
  const asOf = Date.now();
  const session = await (deps.findRecord ?? repo.findBrowserLiveViewRecord)(taskId);
  if (session === null || (userId !== undefined && session.context.userId !== userId)) {
    throw new SessionNotFoundError();
  }
  const live =
    session.status === ACTIVE && session.sessionId !== null
      ? await providerLiveness(session.sessionId, deps.health ?? getBrowserSessionHealth)
      : false;
  return {
    taskId: session.id,
    sessionId: session.sessionId,
    debugUrl:
      session.provider === 'tilion' && live !== false && session.sessionId !== null
        ? await freshTilionLiveViewUrl(
            { sessionId: session.sessionId, debugUrl: session.debugUrl },
            deps.mintTilionLiveViewUrl ?? getTilionLiveViewUrl
          )
        : session.debugUrl,
    status: session.status,
    live,
    asOf,
  };
}

/**
 * Tilion view tokens expire after 1800 s, so the stored debugUrl goes stale
 * mid-run. Every live-view read mints a fresh one (token mints are free); a
 * failed mint keeps the stored URL so the panel degrades instead of erroring.
 */
async function freshTilionLiveViewUrl(
  session: { sessionId: string; debugUrl: string | null },
  mint: typeof getTilionLiveViewUrl
): Promise<string | null> {
  try {
    return await mint(session.sessionId);
  } catch (error) {
    log.warn('Tilion live-view token mint failed', {
      sessionId: session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return session.debugUrl;
  }
}

export async function resumeOwnedBrowserSession(
  taskId: string,
  userId?: string,
  forceFreshProfile = false
) {
  const session = await repo.findSessionByTaskId(taskId);
  if (session === null || (userId !== undefined && session.context.userId !== userId)) {
    throw new SessionNotFoundError();
  }
  return resumeBrowserSessionProvider(taskId, { forceFreshProfile });
}

export async function setBrowserControlState(
  taskId: string,
  mode: 'user' | 'agent' | 'acknowledge',
  userId?: string
) {
  const session = await requireControlRecord(taskId, userId);

  if (mode === 'agent') {
    await repo.transitionBrowserControlState(taskId, [USER_REQUESTED, USER], AGENT, null);
    return getBrowserControlState(taskId, userId);
  }

  if (mode === 'acknowledge') {
    await repo.transitionBrowserControlState(taskId, [USER_REQUESTED], USER, leaseExpiry());
    return getBrowserControlState(taskId, userId);
  }

  if (session.status !== ACTIVE) throw new BrowserControlUnavailableError(session.status);
  if (session.controlState === USER || session.controlState === USER_REQUESTED) {
    // Leftover USER_REQUESTED from the old handshake must also become USER
    // immediately so a mid-action lease cannot expire back to AGENT.
    return grantUserControl(taskId, [session.controlState], userId);
  }

  // Same-session handover is immediate. The activity still yields when it
  // next observes USER; do not block the live view on an action-boundary ack.
  return grantUserControl(taskId, [AGENT], userId);
}

async function grantUserControl(
  taskId: string,
  expectedStates: PrismaControlState[],
  userId?: string
) {
  const transitioned = await repo.transitionBrowserControlState(
    taskId,
    expectedStates,
    USER,
    leaseExpiry()
  );
  if (transitioned) return getBrowserControlState(taskId, userId);

  const current = await requireControlRecord(taskId, userId);
  if (current.status !== ACTIVE) {
    throw new BrowserControlUnavailableError(current.status);
  }
  return getBrowserControlState(taskId, userId);
}
