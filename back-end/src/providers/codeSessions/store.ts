/**
 * CodeSession persistence: identity, leasing, pause and retirement.
 *
 *   resolveCodeSession(user, root, repo, id?, leaseOwner)
 *     ├─ id given ──► must belong to user (else CodeSessionNotFoundError → 404)
 *     ├─ no id ─────► latest live session for (user, root, repoKey)
 *     │                (expired by TTL → retired, then a new one)
 *     └─ lease ─────► conditional update; a lease held by another spawn means
 *                     a parallel spawn: explicit id → CodeSessionBusyError,
 *                     default → a fresh session for that spawn
 *
 * 10k agents: every query is keyed by (userId, rootAgentId, repoKey) or the
 * session id; no shared row or global counter is touched.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { createLogger } from '../logger';

const log = createLogger('CodeSessionStore');

export type CodeSessionRow = Awaited<ReturnType<typeof prisma.codeSession.findUnique>> & object;

export const CODE_SESSION_STATES = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  RETIRED: 'RETIRED',
} as const;

const LEASE_MS = 60 * 60 * 1000;

export function codeSessionTtlMs(): number {
  const days = Number(process.env.CODE_SESSION_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 14) * 24 * 60 * 60 * 1000;
}

export class CodeSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Code session not found: ${id}`);
    this.name = 'CodeSessionNotFoundError';
  }
}

export class CodeSessionBusyError extends Error {
  constructor(id: string) {
    super(`Code session ${id} is in use by another code agent`);
    this.name = 'CodeSessionBusyError';
  }
}

export function repoKeyFor(repoUrl: string | null | undefined): string {
  return repoUrl !== undefined && repoUrl !== null ? repoUrl.trim() : '';
}

export interface ResolveCodeSessionParams {
  userId: string;
  rootAgentId: string;
  repoUrl: string | null;
  codeProvider: string;
  codeSessionId?: string | null;
  /** Stable for one tool call so Temporal retries keep their lease. */
  leaseOwner: string;
  now?: Date;
}

export interface ResolvedCodeSession {
  session: CodeSessionRow;
  created: boolean;
}

function isExpired(session: { lastActiveAt: Date }, now: Date): boolean {
  return now.getTime() - session.lastActiveAt.getTime() > codeSessionTtlMs();
}

async function tryLease(id: string, leaseOwner: string, now: Date): Promise<boolean> {
  const result = await prisma.codeSession.updateMany({
    where: {
      id,
      state: { not: CODE_SESSION_STATES.RETIRED },
      OR: [{ leaseOwner: null }, { leaseOwner }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      state: CODE_SESSION_STATES.ACTIVE,
      lastActiveAt: now,
    },
  });
  return result.count === 1;
}

async function createSession(params: ResolveCodeSessionParams, now: Date): Promise<CodeSessionRow> {
  return prisma.codeSession.create({
    data: {
      userId: params.userId,
      rootAgentId: params.rootAgentId,
      repoUrl: params.repoUrl,
      repoKey: repoKeyFor(params.repoUrl),
      codeProvider: params.codeProvider,
      state: CODE_SESSION_STATES.ACTIVE,
      leaseOwner: params.leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      lastActiveAt: now,
    },
  });
}

/** Find a session the caller owns; foreign and unknown ids are indistinguishable. */
export async function findOwnedCodeSession(
  userId: string,
  codeSessionId: string
): Promise<CodeSessionRow | null> {
  const session = await prisma.codeSession.findUnique({ where: { id: codeSessionId } });
  if (session === null || session.userId !== userId) return null;
  return session;
}

export async function resolveCodeSession(
  params: ResolveCodeSessionParams
): Promise<ResolvedCodeSession> {
  const now = params.now ?? new Date();
  if (params.codeSessionId !== undefined && params.codeSessionId !== null) {
    const owned = await findOwnedCodeSession(params.userId, params.codeSessionId);
    if (owned === null || owned.state === CODE_SESSION_STATES.RETIRED) {
      throw new CodeSessionNotFoundError(params.codeSessionId);
    }
    if (!(await tryLease(owned.id, params.leaseOwner, now))) {
      throw new CodeSessionBusyError(owned.id);
    }
    const leased = await prisma.codeSession.findUniqueOrThrow({ where: { id: owned.id } });
    return { session: leased, created: false };
  }

  const latest = await prisma.codeSession.findFirst({
    where: {
      userId: params.userId,
      rootAgentId: params.rootAgentId,
      repoKey: repoKeyFor(params.repoUrl),
      state: { not: CODE_SESSION_STATES.RETIRED },
    },
    orderBy: { lastActiveAt: 'desc' },
  });
  if (latest !== null && isExpired(latest, now)) {
    await markRetired(latest.id, now);
  } else if (latest !== null && (await tryLease(latest.id, params.leaseOwner, now))) {
    const leased = await prisma.codeSession.findUniqueOrThrow({ where: { id: latest.id } });
    return { session: leased, created: false };
  } else if (latest !== null) {
    log.info('Latest code session is leased by another spawn; starting a parallel session', {
      codeSessionId: latest.id,
      rootAgentId: params.rootAgentId,
    });
  }
  return { session: await createSession(params, now), created: true };
}

export async function recordSandbox(
  codeSessionId: string,
  data: { sandboxKind: 'e2b' | 'local'; sandboxId: string; homeDir?: string | null }
): Promise<void> {
  await prisma.codeSession.update({
    where: { id: codeSessionId },
    data: {
      sandboxKind: data.sandboxKind,
      sandboxId: data.sandboxId,
      ...(data.homeDir !== undefined ? { homeDir: data.homeDir } : {}),
      lastActiveAt: new Date(),
    },
  });
}

/** Reserve the next checkpoint seq (atomic per session row). */
export async function allocateCheckpointSeq(codeSessionId: string): Promise<number> {
  const updated = await prisma.codeSession.update({
    where: { id: codeSessionId },
    data: { nextCheckpointSeq: { increment: 1 } },
    select: { nextCheckpointSeq: true },
  });
  return updated.nextCheckpointSeq;
}

/** Publish a fully uploaded checkpoint; an older seq never replaces a newer one. */
export async function commitCheckpoint(
  codeSessionId: string,
  seq: number,
  facts: { cliSessionId: string | null; repoFacts: unknown }
): Promise<void> {
  await prisma.codeSession.updateMany({
    where: { id: codeSessionId, latestCheckpointSeq: { lt: seq } },
    data: {
      latestCheckpointSeq: seq,
      ...(facts.cliSessionId !== null ? { cliSessionId: facts.cliSessionId } : {}),
      lastRepoFacts: facts.repoFacts as Prisma.InputJsonValue,
      lastActiveAt: new Date(),
    },
  });
}

/** Release the lease and mark the session paused (sandbox kept, not killed). */
export async function markPaused(codeSessionId: string): Promise<void> {
  await prisma.codeSession.updateMany({
    where: { id: codeSessionId, state: { not: CODE_SESSION_STATES.RETIRED } },
    data: {
      state: CODE_SESSION_STATES.PAUSED,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastActiveAt: new Date(),
    },
  });
}

export async function markRetired(codeSessionId: string, now = new Date()): Promise<void> {
  await prisma.codeSession.updateMany({
    where: { id: codeSessionId },
    data: {
      state: CODE_SESSION_STATES.RETIRED,
      retiredAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
}

/** Bounded per-user sweep of sessions idle past the TTL. */
export async function findExpiredCodeSessions(
  userId: string,
  limit = 5,
  now = new Date()
): Promise<CodeSessionRow[]> {
  return prisma.codeSession.findMany({
    where: {
      userId,
      state: { in: [CODE_SESSION_STATES.PAUSED, CODE_SESSION_STATES.ACTIVE] },
      lastActiveAt: { lt: new Date(now.getTime() - codeSessionTtlMs()) },
    },
    orderBy: { lastActiveAt: 'asc' },
    take: limit,
  });
}

export async function linkClaudeCodeSession(taskId: string, codeSessionId: string): Promise<void> {
  await prisma.claudeCodeSession.update({ where: { id: taskId }, data: { codeSessionId } });
}
