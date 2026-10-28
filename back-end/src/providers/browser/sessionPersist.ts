/**
 * Idempotent BrowserSession row persistence for preallocated task IDs.
 *
 * Browser activities allocate a stable task_id (BrowserSession.id) before the
 * cancellable activity starts. Temporal retries and transient-proxy re-inits
 * must reclaim that row instead of failing on a unique constraint.
 */

import { Prisma as PrismaRuntime, type BrowserSession } from '@prisma/client';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { announceBrowserSessionBinding } from './sessionBindingAnnounce';
import type { BrowserSessionHealth } from './types';

/** Only an explicit provider terminal observation can reconcile a logical native. */
export function isConfirmedBrowserEnd(status: string | null): boolean {
  return (
    status !== null &&
    ['released', 'deleted', 'stopped', 'closed', 'expired', 'terminated'].includes(
      status.toLowerCase()
    )
  );
}

export async function recordEndedLogicalBrowser(
  taskId: string,
  sessionId: string,
  health: Pick<BrowserSessionHealth, 'sessionId' | 'status'>
): Promise<boolean> {
  if (health.sessionId !== sessionId || !isConfirmedBrowserEnd(health.status)) return false;
  const changed = await prisma.browserSession.updateMany({
    where: {
      id: taskId,
      sessionId,
      logicalOwnerKey: { not: null },
      status: { in: ['ACTIVE', 'ERROR'] },
    },
    data: { status: 'PAUSED', closedAt: null },
  });
  return changed.count === 1;
}

const log = createLogger('BrowserSessionPersist');

export type BrowserSessionPersistInput = {
  taskId?: string;
  contextId: string;
  agentId: string;
  sessionId: string;
  debugUrl?: string | null;
  wsUrl?: string | null;
  startUrl?: string;
  provider: string;
  providerProfileId?: string | null;
  providerProfileSource?: string | null;
  providerProfilePersist?: boolean;
  kernelProxySource?: string | null;
  /**
   * Release a remote provider session that is no longer bound to the task row
   * (the previous remote on reclaim, or an orphaned remote after losing a race).
   */
  releaseRemoteSession?: (sessionId: string) => Promise<void>;
};

/** Thrown when a concurrent reclaim wins the CAS and this caller's remote must not be returned. */
export class BrowserSessionReclaimConflictError extends Error {
  readonly taskId: string;
  readonly attemptedSessionId: string;
  readonly winningSessionId: string | null;

  constructor(taskId: string, attemptedSessionId: string, winningSessionId: string | null) {
    super(
      `Browser session ${taskId} was reclaimed concurrently: ${attemptedSessionId} lost to ${winningSessionId}`
    );
    this.name = 'BrowserSessionReclaimConflictError';
    this.taskId = taskId;
    this.attemptedSessionId = attemptedSessionId;
    this.winningSessionId = winningSessionId;
  }
}

function matchesIdTarget(name: string): boolean {
  return name === 'id' || /(^|_)id$/i.test(name) || name.toLowerCase().includes('_pkey');
}

/** Exported for unit coverage of Prisma P2002 meta.target shape variants. */
export function isIdUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof PrismaRuntime.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    // Prisma may report `['id']` or a PK constraint name like `['BrowserSession_pkey']`.
    return target.map(String).some(matchesIdTarget);
  }
  if (typeof target === 'string') {
    return matchesIdTarget(target);
  }
  // Some drivers omit meta.target for PK collisions; the call site only uses a
  // preallocated `id`, so a bare P2002 after create({ id }) is the id collision.
  return true;
}

async function releaseRemote(
  release: ((sessionId: string) => Promise<void>) | undefined,
  sessionId: string | null,
  context: string
): Promise<void> {
  if (release === undefined || sessionId === null || sessionId === '') return;
  try {
    await release(sessionId);
  } catch (releaseError) {
    log.warn(`Failed to release remote during ${context}`, {
      sessionId,
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
    });
  }
}

/**
 * Persist a BrowserSession row. When `taskId` is preallocated, create-or-reclaim
 * so retries after a prior successful create are idempotent.
 */
export async function persistBrowserSessionRow(
  input: BrowserSessionPersistInput
): Promise<BrowserSession> {
  const shared = {
    contextId: input.contextId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    debugUrl: input.debugUrl ?? undefined,
    wsUrl: input.wsUrl ?? undefined,
    status: 'ACTIVE' as BrowserSession['status'],
    startUrl: input.startUrl,
    provider: input.provider,
    providerProfileId: input.providerProfileId ?? null,
    providerProfileSource: input.providerProfileSource ?? null,
    providerProfilePersist: input.providerProfilePersist ?? true,
    kernelProxySource: input.kernelProxySource ?? null,
  };

  if (input.taskId === undefined || input.taskId === '') {
    return prisma.browserSession.create({ data: shared });
  }

  const taskId = input.taskId;
  const release = input.releaseRemoteSession;

  const existing = await prisma.browserSession.findUnique({ where: { id: taskId } });
  if (existing === null) {
    try {
      return await prisma.browserSession.create({
        data: { id: taskId, ...shared },
      });
    } catch (error) {
      if (!isIdUniqueConstraint(error)) throw error;
      // Concurrent create won the insert race — fall through to reclaim.
    }
  }

  const previous = existing ?? (await prisma.browserSession.findUnique({ where: { id: taskId } }));
  if (previous === null) {
    return prisma.browserSession.create({ data: { id: taskId, ...shared } });
  }

  // A persistent logical binding is not usable until its owner has completed
  // preparation. Initialization and resume publish ACTIVE at their commit.
  if (previous.logicalOwnerKey !== null) shared.status = 'PAUSED';

  if (previous.sessionId === input.sessionId) {
    if (previous.status === 'ACTIVE' && previous.closedAt === null) {
      return previous;
    }
    const reactivated = await prisma.browserSession.update({
      where: { id: taskId },
      data: { ...shared, closedAt: null },
    });
    await announceBrowserSessionBinding({ id: taskId });
    return reactivated;
  }

  const previousSessionId = previous.sessionId;

  log.info('Reclaiming preallocated browser session row', {
    taskId,
    previousSessionId,
    sessionId: input.sessionId,
    previousStatus: previous.status,
  });

  // CAS on (id, previousSessionId) matches resume/recreate — concurrent reclaim
  // cannot silently overwrite a newer binding. Release the previous remote only
  // after the row successfully points at the new sessionId.
  const replaced = await prisma.browserSession.updateMany({
    where: { id: taskId, sessionId: previousSessionId },
    data: {
      ...shared,
      closedAt: null,
    },
  });

  if (replaced.count === 0) {
    const current = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
    if (current.sessionId === input.sessionId) {
      return current;
    }
    // Lost the race to another reclaim — drop the orphaned remote we just created.
    await releaseRemote(release, input.sessionId, 'lost concurrent reclaim race');
    throw new BrowserSessionReclaimConflictError(taskId, input.sessionId, current.sessionId);
  }

  await announceBrowserSessionBinding({ id: taskId });
  await releaseRemote(release, previousSessionId, 'idempotent session reclaim');
  return prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
}
