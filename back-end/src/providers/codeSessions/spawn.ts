/**
 * Glue between the code-session HTTP surface (claude-code / codex-code
 * domains) and the persistent CodeSession lifecycle.
 */
import { Sandbox } from 'e2b';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { isLocalClaudeCodeSandboxId } from '../claudeCodeLocalSession';
import { checkpointCodeSession, retireCodeSession, sweepExpiredCodeSessions } from './lifecycle';
import { e2bSandboxFs, localSandboxFs } from './sandboxFs';
import {
  CodeSessionNotFoundError,
  findOwnedCodeSession,
  markPaused,
  resolveCodeSession,
  type CodeSessionRow,
} from './store';

const log = createLogger('CodeSessionSpawn');

export { CodeSessionBusyError, CodeSessionNotFoundError } from './store';

export interface ResolveSpawnParams {
  agentId: string;
  userId: string | undefined;
  repoUrl: string | null;
  codeProvider: 'claude' | 'codex';
  codeSessionId?: string;
  leaseOwner?: string;
}

/** Resolve (and lease) the code session a spawn attaches to. */
export async function resolveSpawnCodeSession(
  params: ResolveSpawnParams
): Promise<CodeSessionRow | null> {
  if (params.userId === undefined || params.userId === '') return null;
  const agent = await prisma.agent.findUnique({
    where: { id: params.agentId },
    select: { busId: true },
  });
  const rootAgentId =
    agent?.busId !== undefined && agent.busId !== null && agent.busId !== ''
      ? agent.busId
      : params.agentId;
  sweepExpiredCodeSessions(params.userId);
  const { session, created } = await resolveCodeSession({
    userId: params.userId,
    rootAgentId,
    repoUrl: params.repoUrl,
    codeProvider: params.codeProvider,
    codeSessionId: params.codeSessionId,
    leaseOwner: params.leaseOwner ?? `agent:${params.agentId}`,
  });
  log.info(created ? 'Created code session' : 'Resuming code session', {
    codeSessionId: session.id,
    rootAgentId,
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
): Promise<{
  session: T;
  fields: { code_session_id: string | null; resumed_from: string; cli_session_id: string | null };
}> {
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
    },
  };
}

export interface CodeSessionView {
  code_session_id: string;
  root_agent_id: string;
  repo_url: string | null;
  code_provider: string;
  state: string;
  checkpoint_seq: number;
  cli_session_id: string | null;
  repo: unknown;
  last_active_at: Date;
}

function view(row: CodeSessionRow): CodeSessionView {
  return {
    code_session_id: row.id,
    root_agent_id: row.rootAgentId,
    repo_url: row.repoUrl,
    code_provider: row.codeProvider,
    state: row.state,
    checkpoint_seq: row.latestCheckpointSeq,
    cli_session_id: row.cliSessionId,
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
