import * as repo from './repo';
import {
  createCodexCodeSession,
  closeClaudeCodeSession,
  getClaudeCodeSession,
} from '../../providers/e2b';
import type { FilePointer } from '../../providers/storage';
import { checkGithubRepoAccess } from '../../providers/github';
import { createLogger } from '../../providers/logger';

export type { HealthCheckResult } from './health';
export { checkSandboxHealth } from './health';

const log = createLogger('CodexCode');

export class MissingUserIdError extends Error {
  constructor() {
    super('user_id is required to create a Codex Code session');
    this.name = 'MissingUserIdError';
  }
}

export class GitHubAccessDeniedError extends Error {
  constructor(public detail: string) {
    super(detail);
    this.name = 'GitHubAccessDeniedError';
  }
}

export interface CreateSessionParams {
  agent_id: string;
  goal: string;
  attachments?: FilePointer[];
  github_repo_url?: string;
  user_id: string;
}

export interface CloseSessionParams {
  task_id: string;
  user_id?: string;
  agent_id?: string;
  additional_paths?: string[];
}

async function resolveGithubRepo(
  agentId: string,
  userId: string
): Promise<{ repoUrl: string | undefined; userId: string }> {
  try {
    const agent = await repo.findAgentGithubInfo(agentId);
    if (agent?.githubRepoUrl !== undefined && agent.githubRepoUrl !== null) {
      return { repoUrl: agent.githubRepoUrl, userId };
    }
    if (
      agent?.busId !== undefined &&
      agent.busId !== null &&
      agent.busId !== '' &&
      agent.busId !== agentId
    ) {
      const rootAgent = await repo.findRootAgentGithubInfo(agent.busId);
      if (rootAgent?.githubRepoUrl !== undefined && rootAgent.githubRepoUrl !== null) {
        return { repoUrl: rootAgent.githubRepoUrl, userId };
      }
    }
  } catch (err) {
    log.error('Failed to look up agent GitHub repo', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { repoUrl: undefined, userId };
}

export async function createSession(params: CreateSessionParams) {
  const { agent_id, goal, attachments, user_id } = params;
  if (!user_id) throw new MissingUserIdError();

  let effectiveGithubRepoUrl = params.github_repo_url;
  let effectiveUserId = user_id;

  if (effectiveGithubRepoUrl === undefined || effectiveGithubRepoUrl === '') {
    const resolved = await resolveGithubRepo(agent_id, effectiveUserId);
    if (resolved.repoUrl !== undefined) {
      effectiveGithubRepoUrl = resolved.repoUrl;
      effectiveUserId = resolved.userId;
      log.info(`Auto-injecting GitHub repo from agent tree: ${effectiveGithubRepoUrl}`);
    }
  }

  let normalizedRepoUrl: string | undefined;
  if (effectiveGithubRepoUrl !== undefined && effectiveGithubRepoUrl !== '') {
    const accessCheck = await checkGithubRepoAccess(effectiveUserId, effectiveGithubRepoUrl);
    if (!accessCheck.allowed) {
      log.info(`GitHub access denied for user ${effectiveUserId}: ${accessCheck.error ?? ''}`);
      throw new GitHubAccessDeniedError(accessCheck.error!);
    }
    normalizedRepoUrl = accessCheck.normalizedUrl!;
  }

  const fastModeCacheEnabled = await repo.findAgentFastModeCache(agent_id);
  const session = await createCodexCodeSession(
    agent_id,
    goal,
    attachments,
    normalizedRepoUrl,
    effectiveUserId,
    fastModeCacheEnabled
  );

  return {
    task_id: session.taskId,
    sandbox_id: session.sandboxId,
    ws_url: session.wsUrl,
    uploaded_files: session.uploadedFiles,
    github_repo_url: normalizedRepoUrl ?? null,
  };
}

export async function closeSession(params: CloseSessionParams) {
  const result = await closeClaudeCodeSession(
    params.task_id,
    params.user_id,
    params.agent_id,
    params.additional_paths
  );

  return {
    status: 'CLOSED' as const,
    output_files: result.outputFiles,
    usage: result.usage,
  };
}

export async function getSession(taskId: string) {
  const session = await getClaudeCodeSession(taskId);
  if (!session) return null;
  return {
    task_id: session.id,
    sandbox_id: session.sandboxId,
    stream_url: session.streamUrl,
    goal: session.goal,
    status: session.status,
    output: session.output,
    created_at: session.createdAt,
    closed_at: session.closedAt,
  };
}

export async function getAgentSessions(agentId: string) {
  return repo.findSessionsByAgent(agentId);
}

export async function persistOutput(taskId: string, output: string) {
  log.info(`Persisting Codex output for session ${taskId} (${output.length} bytes)`);
  await repo.persistSessionOutput(taskId, output);
}
