/**
 * Glue between the code-session HTTP surface (claude-code / codex-code
 * domains) and the persistent CodeSession lifecycle.
 */
import { Sandbox } from 'e2b';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { isLocalClaudeCodeSandboxId } from '../claudeCodeLocalSession';
import { effectiveOwnerAgentId, planCodeSessionBranch } from './branch';
import { checkpointCodeSession, retireCodeSession, sweepExpiredCodeSessions } from './lifecycle';
import { e2bSandboxFs, localSandboxFs } from './sandboxFs';
import {
  CodeSessionBusyError,
  CodeSessionNotFoundError,
  extendLease,
  findOwnedCodeSession,
  markPaused,
  resolveCodeSession,
  type CodeSessionRow,
} from './store';
import { CODE_SANDBOX_IDLE_TIMEOUT_MS } from '../e2bCodeSessionSandbox';

const log = createLogger('CodeSessionSpawn');

export { CodeSessionBusyError, CodeSessionNotFoundError } from './store';

/** HTTP status + body for a code-session error, or null when it is not one. */
export function codeSessionHttpError(
  error: unknown
): { status: number; body: { error: string; code: string } } | null {
  if (error instanceof CodeSessionNotFoundError) {
    return {
      status: 404,
      body: { error: 'Code session not found', code: 'CODE_SESSION_NOT_FOUND' },
    };
  }
  if (error instanceof CodeSessionBusyError) {
    return { status: 409, body: { error: error.message, code: 'CODE_SESSION_BUSY' } };
  }
  return null;
}

export interface ResolveSpawnParams {
  agentId: string;
  userId: string | undefined;
  repoUrl: string | null;
  codeProvider: 'claude' | 'codex';
  codeSessionId?: string;
  leaseOwner?: string;
  /** Project default branch; null/undefined = the repo's own default branch. */
  baseBranch?: string | null;
}

/** Resolve (and lease) the code session a spawn attaches to. */
export async function resolveSpawnCodeSession(
  params: ResolveSpawnParams
): Promise<CodeSessionRow | null> {
  if (params.userId === undefined || params.userId === '') return null;
  const userId = params.userId;
  const agent = await prisma.agent.findUnique({
    where: { id: params.agentId },
    select: { busId: true },
  });
  const rootAgentId =
    agent?.busId !== undefined && agent.busId !== null && agent.busId !== ''
      ? agent.busId
      : params.agentId;
  sweepExpiredCodeSessions(userId);
  // "New agent in this branch" works in the shared agent's session; every
  // other agent owns its own worktree and branch (plan §1b).
  const ownerAgentId = await effectiveOwnerAgentId(userId, params.agentId);
  const { session, created } = await resolveCodeSession({
    userId,
    rootAgentId,
    ownerAgentId,
    repoUrl: params.repoUrl,
    codeProvider: params.codeProvider,
    codeSessionId: params.codeSessionId,
    leaseOwner: params.leaseOwner ?? `agent:${params.agentId}`,
    shared: ownerAgentId !== params.agentId,
    planBranch: (parallelOf) =>
      planCodeSessionBranch({
        userId,
        ownerAgentId,
        repoUrl: params.repoUrl,
        defaultBranch: params.baseBranch ?? null,
        parallelOf,
      }),
  });
  log.info(created ? 'Created code session' : 'Resuming code session', {
    codeSessionId: session.id,
    rootAgentId,
    ownerAgentId,
    branch: session.branch ?? undefined,
    mergeTarget: session.mergeTarget ?? undefined,
    state: session.state,
    checkpointSeq: String(session.latestCheckpointSeq),
  });
  return session;
}

/**
 * Resolve the spawn's code session, run the sandbox create, and release the
 * lease when the create fails so a retry (or the next spawn) can resume.
 */
export async function createWithCodeSession<
  T extends { resumedFrom?: string; cliSessionId?: string | null },
>(
  params: ResolveSpawnParams,
  create: (codeSession: CodeSessionRow | null) => Promise<T>
): Promise<{ session: T; fields: CodeSessionSpawnFields }> {
  const codeSession = await resolveSpawnCodeSession(params);
  let session: T;
  try {
    session = await create(codeSession);
  } catch (error) {
    if (codeSession !== null) await markPaused(codeSession.id);
    throw error;
  }
  return {
    session,
    fields: {
      code_session_id: codeSession?.id ?? null,
      resumed_from: session.resumedFrom ?? 'new',
      cli_session_id: session.cliSessionId ?? null,
      branch: codeSession?.branch ?? null,
      base_branch: codeSession?.baseBranch ?? null,
      merge_target: codeSession?.mergeTarget ?? null,
      parent_code_session_id: codeSession?.parentCodeSessionId ?? null,
    },
  };
}

/** Session facts every create response (and so the tool's first trajectory entry) carries. */
export interface CodeSessionSpawnFields {
  code_session_id: string | null;
  resumed_from: string;
  cli_session_id: string | null;
  /** Branch the agent works on (null for repo-less sessions). */
  branch: string | null;
  /** Ref the branch was cut from; null = the repo's default branch. */
  base_branch: string | null;
  /** Where the branch merges; null = the repo's default branch. */
  merge_target: string | null;
  parent_code_session_id: string | null;
}

export interface CodeSessionView {
  code_session_id: string;
  root_agent_id: string;
  owner_agent_id: string;
  repo_url: string | null;
  code_provider: string;
  state: string;
  checkpoint_seq: number;
  cli_session_id: string | null;
  branch: string | null;
  base_branch: string | null;
  merge_target: string | null;
  parent_code_session_id: string | null;
  repo: unknown;
  last_active_at: Date;
}

function view(row: CodeSessionRow): CodeSessionView {
  return {
    code_session_id: row.id,
    root_agent_id: row.rootAgentId,
    owner_agent_id: row.ownerAgentId,
    repo_url: row.repoUrl,
    code_provider: row.codeProvider,
    state: row.state,
    checkpoint_seq: row.latestCheckpointSeq,
    cli_session_id: row.cliSessionId,
    branch: row.branch,
    base_branch: row.baseBranch,
    merge_target: row.mergeTarget,
    parent_code_session_id: row.parentCodeSessionId,
    repo: row.lastRepoFacts,
    last_active_at: row.lastActiveAt,
  };
}

export async function getOwnedCodeSessionView(
  userId: string,
  codeSessionId: string
): Promise<CodeSessionView> {
  const row = await findOwnedCodeSession(userId, codeSessionId);
  if (row === null) throw new CodeSessionNotFoundError(codeSessionId);
  return view(row);
}

/** Explicit close: kill the sandbox, delete checkpoints, retire the session. */
export async function retireOwnedCodeSession(
  userId: string,
  codeSessionId: string
): Promise<CodeSessionView> {
  const row = await findOwnedCodeSession(userId, codeSessionId);
  if (row === null) throw new CodeSessionNotFoundError(codeSessionId);
  if (row.state !== 'RETIRED') await retireCodeSession(row);
  return view((await findOwnedCodeSession(userId, codeSessionId)) ?? row);
}

/**
 * Keepalive from the attached code-agent activity (liveness is heartbeat-only;
 * there is no runtime limit): extend the E2B sandbox's idle window and the
 * session lease. Once keepalives stop, the sandbox pauses after the window.
 */
export async function keepAliveCodeTask(
  taskId: string,
  setTimeoutFn: (sandboxId: string, timeoutMs: number) => Promise<void> = (sandboxId, timeoutMs) =>
    Sandbox.setTimeout(sandboxId, timeoutMs, { apiKey: process.env.E2B_API_KEY })
): Promise<{ alive: boolean; code_session_id: string | null }> {
  const task = await prisma.claudeCodeSession.findUnique({ where: { id: taskId } });
  if (task === null || task.status === 'CLOSED') {
    return { alive: false, code_session_id: task?.codeSessionId ?? null };
  }
  if (!isLocalClaudeCodeSandboxId(task.sandboxId)) {
    await setTimeoutFn(task.sandboxId, CODE_SANDBOX_IDLE_TIMEOUT_MS);
  }
  if (task.codeSessionId !== null) await extendLease(task.codeSessionId);
  return { alive: true, code_session_id: task.codeSessionId };
}

/**
 * Checkpoint a still-running task's session without pausing it (worker drain:
 * the sandbox keeps running for the reattaching attempt).
 */
export async function checkpointRunningTask(
  taskId: string,
  reason: string
): Promise<{ checkpoint_seq: number | null }> {
  const task = await prisma.claudeCodeSession.findUnique({ where: { id: taskId } });
  if (task === null || task.codeSessionId === null) return { checkpoint_seq: null };
  const session = await prisma.codeSession.findUnique({ where: { id: task.codeSessionId } });
  if (session === null || session.state === 'RETIRED') return { checkpoint_seq: null };
  let result = null;
  if (isLocalClaudeCodeSandboxId(task.sandboxId)) {
    if (session.homeDir !== null) {
      result = await checkpointCodeSession({
        session,
        fs: localSandboxFs(session.homeDir),
        reason,
        agentId: task.agentId,
      });
    }
  } else {
    const sandbox = await Sandbox.connect(task.sandboxId, { apiKey: process.env.E2B_API_KEY });
    result = await checkpointCodeSession({
      session,
      fs: e2bSandboxFs(sandbox),
      reason,
      agentId: task.agentId,
    });
  }
  return { checkpoint_seq: result?.seq ?? null };
}
