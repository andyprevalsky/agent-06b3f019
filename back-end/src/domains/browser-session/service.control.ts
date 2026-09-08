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

  if (session.controlState === USER || session.controlState === USER_REQUESTED) {
    // Leftover USER_REQUESTED from the old handshake must also become USER
    // immediately so a mid-action lease cannot expire back to AGENT.
    await repo.transitionBrowserControlState(taskId, [session.controlState], USER, leaseExpiry());
    return getBrowserControlState(taskId, userId);
  }
  if (session.status !== ACTIVE) throw new BrowserControlUnavailableError(session.status);

  // Same-session handover is immediate. The activity still yields when it
  // next observes USER; do not block the live view on an action-boundary ack.
  const transitioned = await repo.transitionBrowserControlState(
    taskId,
    [AGENT],
    USER,
    leaseExpiry()
  );
  if (!transitioned) return getBrowserControlState(taskId, userId);
  return getBrowserControlState(taskId, userId);
}
