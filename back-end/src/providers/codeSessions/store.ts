/**
 * CodeSession persistence: identity, leasing, pause and retirement.
 *
 *   resolveCodeSession(user, owner agent, repo, id?, leaseOwner)
 *     ├─ id given ──► must belong to user (else CodeSessionNotFoundError → 404)
 *     ├─ no id ─────► the owner's primary live session for (user, owner, repoKey)
 *     │                (expired by TTL → retired, then a new one on a planned branch)
 *     └─ lease ─────► conditional update; a lease held by another spawn means
 *                     a parallel spawn: explicit id / shared → CodeSessionBusyError,
 *                     default → an idle parallel session, else a new one whose
 *                     branch is cut from the busy one (or CodeSessionBusyError
 *                     once maxLiveSessions are all leased: user tools)
 *
 * 10k agents: every query is keyed by (userId, ownerAgentId, repoKey) or the
 * session id (bounded scan of OWNER_SESSION_SCAN rows); no shared row or
 * global counter is touched.
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

/** Branch a new session works on (see branch.ts). Null fields for repo-less sessions. */
export interface CodeSessionBranchPlan {
  branch: string | null;
  baseBranch: string | null;
  mergeTarget: string | null;
  parentCodeSessionId: string | null;
}

export interface ResolveCodeSessionParams {
  userId: string;
  rootAgentId: string;
  /** Agent whose worktree this is (the spawning agent, or the agent it shares with). */
  ownerAgentId: string;
  repoUrl: string | null;
  codeProvider: string;
  codeSessionId?: string | null;
  /** Stable for one tool call so Temporal retries keep their lease. */
  leaseOwner: string;
  /**
   * Branch for a session this call has to create. `parallelOf` is the owner's
   * session that another spawn holds; the new session branches from it.
   */
  planBranch: (parallelOf: CodeSessionRow | null) => Promise<CodeSessionBranchPlan>;
  /** Shared session ("New agent in this branch"): a busy session is an error, never a fork. */
  shared?: boolean;
  /**
   * Cap on the owner's live sessions: when every one is leased and this many
   * exist, a busy error instead of another parallel session (user tools).
   */
  maxLiveSessions?: number;
  now?: Date;
}

export interface ResolvedCodeSession {
  session: CodeSessionRow;
  created: boolean;
}

/** Owner sessions inspected per resolve: the primary plus a few parallel ones. */
const OWNER_SESSION_SCAN = 10;

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

async function createSession(
  params: ResolveCodeSessionParams,
  plan: CodeSessionBranchPlan,
  now: Date
): Promise<CodeSessionRow> {
  return prisma.codeSession.create({
    data: {
      userId: params.userId,
      rootAgentId: params.rootAgentId,
      ownerAgentId: params.ownerAgentId,
      repoUrl: params.repoUrl,
      repoKey: repoKeyFor(params.repoUrl),
      codeProvider: params.codeProvider,
      state: CODE_SESSION_STATES.ACTIVE,
      leaseOwner: params.leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      lastActiveAt: now,
      branch: plan.branch,
      baseBranch: plan.baseBranch,
      mergeTarget: plan.mergeTarget,
      parentCodeSessionId: plan.parentCodeSessionId,
    },
  });
}

/** Live sessions of one owner for one repo, primary (oldest) first. */
export async function ownerCodeSessions(
  userId: string,
  ownerAgentId: string,
  repoUrl: string | null
): Promise<CodeSessionRow[]> {
  return prisma.codeSession.findMany({
    where: {
      userId,
      ownerAgentId,
      repoKey: repoKeyFor(repoUrl),
      state: { not: CODE_SESSION_STATES.RETIRED },
    },
    orderBy: { createdAt: 'asc' },
    take: OWNER_SESSION_SCAN,
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

  // The owner's primary session first; when another spawn holds it, an idle
  // parallel session of the same owner, else a new parallel one branched from
  // the primary so two CLIs never share one worktree.
  const live: CodeSessionRow[] = [];
  for (const candidate of await ownerCodeSessions(
    params.userId,
    params.ownerAgentId,
    params.repoUrl
  )) {
    if (isExpired(candidate, now)) await markRetired(candidate.id, now);
    else live.push(candidate);
  }
  for (const candidate of live) {
    if (await tryLease(candidate.id, params.leaseOwner, now)) {
      const leased = await prisma.codeSession.findUniqueOrThrow({ where: { id: candidate.id } });
      return { session: leased, created: false };
    }
    if (params.shared === true) throw new CodeSessionBusyError(candidate.id);
  }
  const parallelOf = live[0] ?? null;
  if (
    parallelOf !== null &&
    params.maxLiveSessions !== undefined &&
    live.length >= params.maxLiveSessions
  ) {
    throw new CodeSessionBusyError(parallelOf.id);
  }
  if (parallelOf !== null) {
    log.info('Code session is leased by another spawn; starting a parallel session', {
      codeSessionId: parallelOf.id,
      ownerAgentId: params.ownerAgentId,
    });
  }
  const plan = await params.planBranch(parallelOf);
  return { session: await createSession(params, plan, now), created: true };
}

export async function recordSandbox(
  codeSessionId: string,
  data: {
    sandboxKind: 'e2b' | 'local';
    sandboxId: string;
    homeDir?: string | null;
    /** Size of an E2B sandbox (C16). */
    size?: { cpu: number; memoryGb: number };
  }
): Promise<void> {
  await prisma.codeSession.update({
    where: { id: codeSessionId },
    data: {
      sandboxKind: data.sandboxKind,
      sandboxId: data.sandboxId,
      ...(data.homeDir !== undefined ? { homeDir: data.homeDir } : {}),
      ...(data.size !== undefined
        ? { sandboxCpu: data.size.cpu, sandboxMemoryGb: data.size.memoryGb }
        : {}),
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

/**
 * Keepalive from an attached spawn: push the lease out so a long-running
 * session is never taken by a parallel spawn, and record activity for the TTL.
 */
export async function extendLease(codeSessionId: string, now = new Date()): Promise<void> {
  await prisma.codeSession.updateMany({
    where: {
      id: codeSessionId,
      state: CODE_SESSION_STATES.ACTIVE,
      leaseOwner: { not: null },
    },
    data: { leaseExpiresAt: new Date(now.getTime() + LEASE_MS), lastActiveAt: now },
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
