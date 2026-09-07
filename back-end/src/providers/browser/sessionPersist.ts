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
  /**
   * Release a remote provider session that is no longer bound to the task row
   * (the previous remote on reclaim, or an orphaned remote after losing a race).
   */
  releaseRemoteSession?: (sessionId: string) => Promise<void>;
};

function isIdUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof PrismaRuntime.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.map(String).includes('id');
  }
  if (typeof target === 'string') {
    // Prisma may report `id` or a primary-key name containing id.
    return target === 'id' || /(^|_)id$/i.test(target) || target.toLowerCase().includes('_pkey');
  }
  // Some drivers omit meta.target for PK collisions; the call site only uses a
  // preallocated `id`, so a bare P2002 after create({ id }) is the id collision.
  return true;
}

async function releaseRemote(
  release: ((sessionId: string) => Promise<void>) | undefined,
  sessionId: string,
  context: string
): Promise<void> {
  if (release === undefined || sessionId === '') return;
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
    status: 'ACTIVE' as const,
    startUrl: input.startUrl,
    provider: input.provider,
    providerProfileId: input.providerProfileId ?? null,
    providerProfileSource: input.providerProfileSource ?? null,
    providerProfilePersist: input.providerProfilePersist ?? true,
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

  const previous =
    existing ?? (await prisma.browserSession.findUnique({ where: { id: taskId } }));
  if (previous === null) {
    return prisma.browserSession.create({ data: { id: taskId, ...shared } });
  }

  if (previous.sessionId === input.sessionId) {
    if (previous.status === 'ACTIVE' && previous.closedAt === null) {
      return previous;
    }
    return prisma.browserSession.update({
      where: { id: taskId },
      data: { ...shared, closedAt: null },
    });
  }

  const previousSessionId = previous.sessionId;
  await releaseRemote(release, previousSessionId, 'idempotent session reclaim');

  log.info('Reclaiming preallocated browser session row', {
    taskId,
    previousSessionId,
    sessionId: input.sessionId,
    previousStatus: previous.status,
  });

  // CAS on (id, previousSessionId) matches resume/recreate — concurrent reclaim
  // cannot silently overwrite a newer binding.
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
    return current;
  }

  return prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
}
