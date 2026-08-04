import { resumeBrowserSession as resumeBrowserSessionProvider } from '../../providers/browserSessionResume';
import * as repo from './repo';
import { SessionNotFoundError } from './service.local-storage';
import { BrowserControlState as PrismaControlState, BrowserSessionStatus } from './types';

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

  if (session.controlState === USER_REQUESTED || session.controlState === USER) {
    await repo.transitionBrowserControlState(
      taskId,
      [session.controlState],
      session.controlState,
      leaseExpiry()
    );
    return getBrowserControlState(taskId, userId);
  }
  if (session.status !== ACTIVE) throw new BrowserControlUnavailableError(session.status);

  // If the workflow is already paused, no browser activity can race the user,
  // so ownership is immediate. Otherwise the activity must acknowledge the
  // request at an action boundary before the frontend enables interaction.
  const agent = await repo.findAgentStatus(session.agentId);
  const nextState = agent?.status === 'PAUSED' ? USER : USER_REQUESTED;
  const transitioned = await repo.transitionBrowserControlState(
    taskId,
    [AGENT],
    nextState,
    leaseExpiry()
  );
  if (!transitioned) return getBrowserControlState(taskId, userId);
  return getBrowserControlState(taskId, userId);
}
