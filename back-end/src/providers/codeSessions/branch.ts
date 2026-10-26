/**
 * Branch model for persistent code sessions
 * (docs/plans/completed/code-agent-persistent-sessions.md §1b).
 *
 *   new (root) agent ──► rose/<slug>-<id8>            cut from the default branch,
 *                                                     merges into the default branch
 *   sub-agent ─────────► <parent branch>--<slug>-<id6> cut from the parent's branch,
 *                                                     merges into the parent's branch
 *   parallel spawn ────► <busy branch>--<slug>-<id6>   (same owner, its session busy)
 *   "New agent in this branch" ──► shares the parent's session (no new branch)
 *
 * Git refuses `a/b` next to `a/b/c` (a ref cannot be both a file and a
 * directory), so a child joins its parent's name with `--`, never `/`.
 *
 * 10k agents: planning walks at most MAX_PARENT_HOPS agent rows (indexed by
 * id) plus one indexed session lookup per hop; nothing fans in.
 */
import { randomUUID } from 'crypto';
import { prisma } from '../database';
import {
  CODE_SESSION_STATES,
  repoKeyFor,
  type CodeSessionBranchPlan,
  type CodeSessionRow,
} from './store';

const MAX_PARENT_HOPS = 16;
const MAX_SHARE_HOPS = 8;
const MAX_BRANCH_LENGTH = 200;

export const ROOT_BRANCH_PREFIX = 'rose/';

/** Lowercase [a-z0-9-] slug of at most `maxLength` characters (may be empty). */
export function branchSlug(text: string | null | undefined, maxLength = 32): string {
  const slug = (text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '');
}

function idSuffix(agentId: string, length: number): string {
  return (
    agentId
      .replace(/[^0-9a-f]/gi, '')
      .slice(0, length)
      .toLowerCase() || 'x'
  );
}

function agentLabel(agent: { title: string | null; goal: string }): string {
  return branchSlug(agent.title ?? agent.goal) || 'agent';
}

export function rootBranchName(agent: { id: string; title: string | null; goal: string }): string {
  return `${ROOT_BRANCH_PREFIX}${agentLabel(agent)}-${idSuffix(agent.id, 8)}`;
}

export function childBranchName(
  parentBranch: string,
  agent: { id: string; title: string | null; goal: string }
): string {
  const suffix = `--${branchSlug(agent.title ?? agent.goal, 24) || 'agent'}-${idSuffix(agent.id, 6)}`;
  return `${parentBranch.slice(0, MAX_BRANCH_LENGTH - suffix.length)}${suffix}`;
}

/** The agent whose session `agentId` works in ("New agent in this branch" follows shares). */
export async function effectiveOwnerAgentId(userId: string, agentId: string): Promise<string> {
  let current = agentId;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < MAX_SHARE_HOPS; hop += 1) {
    const share = await prisma.codeSessionShare.findUnique({ where: { agentId: current } });
    if (share === null || share.userId !== userId || seen.has(share.sharedWithAgentId)) break;
    current = share.sharedWithAgentId;
    seen.add(current);
  }
  return current;
}

/** Whether agentId's code spawns share another agent's session. */
export async function isSharingAgent(userId: string, agentId: string): Promise<boolean> {
  return (await effectiveOwnerAgentId(userId, agentId)) !== agentId;
}

async function primarySessionOf(
  userId: string,
  ownerAgentId: string,
  repoUrl: string | null
): Promise<CodeSessionRow | null> {
  return prisma.codeSession.findFirst({
    where: {
      userId,
      ownerAgentId,
      repoKey: repoKeyFor(repoUrl),
      state: { not: CODE_SESSION_STATES.RETIRED },
      branch: { not: null },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/** Nearest ancestor (through parentAgentId, following shares) with a session for the repo. */
async function nearestAncestorSession(
  userId: string,
  agentId: string,
  repoUrl: string | null
): Promise<CodeSessionRow | null> {
  let current = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { parentAgentId: true },
  });
  for (let hop = 0; hop < MAX_PARENT_HOPS && current?.parentAgentId; hop += 1) {
    const parentId: string = current.parentAgentId;
    const owner = await effectiveOwnerAgentId(userId, parentId);
    const session = await primarySessionOf(userId, owner, repoUrl);
    if (session !== null) return session;
    current = await prisma.agent.findUnique({
      where: { id: parentId },
      select: { parentAgentId: true },
    });
  }
  return null;
}

export interface PlanBranchParams {
  userId: string;
  ownerAgentId: string;
  repoUrl: string | null;
  /** Project default branch (null = the repo's own default, resolved in the sandbox). */
  defaultBranch: string | null;
  parallelOf: CodeSessionRow | null;
}

export async function planCodeSessionBranch(
  params: PlanBranchParams
): Promise<CodeSessionBranchPlan> {
  if (params.repoUrl === null || params.repoUrl === '') {
    return { branch: null, baseBranch: null, mergeTarget: null, parentCodeSessionId: null };
  }
  const owner = (await prisma.agent.findUnique({
    where: { id: params.ownerAgentId },
    select: { id: true, title: true, goal: true },
  })) ?? { id: params.ownerAgentId, title: null, goal: '' };
  const parent =
    params.parallelOf?.branch !== null && params.parallelOf?.branch !== undefined
      ? params.parallelOf
      : await nearestAncestorSession(params.userId, params.ownerAgentId, params.repoUrl);
  if (parent?.branch !== null && parent?.branch !== undefined) {
    // Parallel spawns of one owner get distinct names even though the owner is the same.
    const labelAgent = params.parallelOf !== null ? { ...owner, id: randomUUID() } : owner;
    return {
      branch: childBranchName(parent.branch, labelAgent),
      baseBranch: parent.branch,
      mergeTarget: parent.branch,
      parentCodeSessionId: parent.id,
    };
  }
  return {
    branch: rootBranchName(owner),
    baseBranch: params.defaultBranch,
    mergeTarget: params.defaultBranch,
    parentCodeSessionId: null,
  };
}

export class CodeSessionShareTargetNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent to share a code session with not found: ${agentId}`);
    this.name = 'CodeSessionShareTargetNotFoundError';
  }
}

/** Record "New agent in this branch": agentId shares sharedWithAgentId's code session. */
export async function shareCodeSession(params: {
  userId: string;
  agentId: string;
  sharedWithAgentId: string;
}): Promise<void> {
  await prisma.codeSessionShare.upsert({
    where: { agentId: params.agentId },
    create: params,
    update: { sharedWithAgentId: params.sharedWithAgentId, userId: params.userId },
  });
}
