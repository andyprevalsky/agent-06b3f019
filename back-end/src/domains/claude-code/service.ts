/**
 * Claude Code domain service -- business logic for session management.
 */

import * as repo from './repo';
import {
  createClaudeCodeSession,
  closeClaudeCodeSession,
  getClaudeCodeSession,
} from '../../providers/e2b';
import type { FilePointer } from '../../providers/storage';
import { checkGithubRepoAccess } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import {
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
} from '../../providers/claudeCredentials';

export type { HealthCheckResult } from './health';
export { checkSandboxHealth } from './health';

const log = createLogger('ClaudeCode');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class MissingUserIdError extends Error {
  constructor() {
    super('user_id is required when using github_repo_url');
    this.name = 'MissingUserIdError';
  }
}

export class GitHubAccessDeniedError extends Error {
  constructor(public detail: string) {
    super(detail);
    this.name = 'GitHubAccessDeniedError';
  }
}

// ---------------------------------------------------------------------------
// Create session
// ---------------------------------------------------------------------------

export interface CreateSessionParams {
  agent_id: string;
  goal: string;
  attachments?: FilePointer[];
  github_repo_url?: string;
  user_id?: string;
}

export interface CreateSessionResult {
  task_id: string;
  sandbox_id: string;
  ws_url: string;
  uploaded_files: string[];
  github_repo_url: string | null;
}

/** Attempt to auto-inject GitHub repo URL from agent or root agent. */
async function resolveGithubRepo(
  agentId: string,
  userId: string | undefined
): Promise<{ repoUrl: string | undefined; userId: string | undefined }> {
  try {
    const agent = await repo.findAgentGithubInfo(agentId);
    if (agent?.githubRepoUrl !== undefined && agent.githubRepoUrl !== null) {
      return {
        repoUrl: agent.githubRepoUrl,
        userId: userId !== undefined && userId !== '' ? userId : agent.userId,
      };
    }
    if (
      agent?.busId !== undefined &&
      agent.busId !== null &&
      agent.busId !== '' &&
      agent.busId !== agentId
    ) {
      const rootAgent = await repo.findRootAgentGithubInfo(agent.busId);
      if (rootAgent?.githubRepoUrl !== undefined && rootAgent.githubRepoUrl !== null) {
        return {
          repoUrl: rootAgent.githubRepoUrl,
          userId: userId !== undefined && userId !== '' ? userId : rootAgent.userId,
        };
      }
    }
  } catch (err) {
    log.error('Failed to look up agent GitHub repo', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { repoUrl: undefined, userId };
}

export async function createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
  const { agent_id, goal, attachments, user_id } = params;
  let effectiveGithubRepoUrl = params.github_repo_url;
  let effectiveUserId = user_id;

  // Auto-inject GitHub repo URL from agent record if not explicitly provided.
  if (effectiveGithubRepoUrl === undefined || effectiveGithubRepoUrl === '') {
    const resolved = await resolveGithubRepo(agent_id, effectiveUserId);
    if (resolved.repoUrl !== undefined) {
      effectiveGithubRepoUrl = resolved.repoUrl;
      effectiveUserId = resolved.userId;
      log.info(`Auto-injecting GitHub repo from agent tree: ${effectiveGithubRepoUrl}`);
    }
  }

  const attachmentCount = attachments !== undefined ? attachments.length : 0;
  log.info(`Creating session for agent ${agent_id}`, {
    attachments: attachmentCount > 0 ? String(attachmentCount) : undefined,
    github_repo: effectiveGithubRepoUrl ?? undefined,
  });

  // Check GitHub repo access if specified
  let normalizedRepoUrl: string | undefined;
  if (effectiveGithubRepoUrl !== undefined && effectiveGithubRepoUrl !== '') {
    if (effectiveUserId === undefined || effectiveUserId === '') {
      throw new MissingUserIdError();
    }

    const accessCheck = await checkGithubRepoAccess(effectiveUserId, effectiveGithubRepoUrl);
    if (!accessCheck.allowed) {
      log.info(`GitHub access denied for user ${effectiveUserId}: ${accessCheck.error ?? ''}`);
      throw new GitHubAccessDeniedError(accessCheck.error!);
    }
    normalizedRepoUrl = accessCheck.normalizedUrl!;
    log.info(`GitHub access granted for ${normalizedRepoUrl}`);
  }

  const session = await createClaudeCodeSession(
    agent_id,
    goal,
    attachments,
    normalizedRepoUrl,
    effectiveUserId
  );

  return {
    task_id: session.taskId,
    sandbox_id: session.sandboxId,
    ws_url: session.wsUrl,
    uploaded_files: session.uploadedFiles,
    github_repo_url: normalizedRepoUrl ?? null,
  };
}

// ---------------------------------------------------------------------------
// Close session
// ---------------------------------------------------------------------------

export interface CloseSessionParams {
  task_id: string;
  user_id?: string;
  agent_id?: string;
  additional_paths?: string[];
}

export async function closeSession(params: CloseSessionParams) {
  const { task_id, user_id, agent_id, additional_paths } = params;

  const pathCount =
    additional_paths !== undefined && additional_paths.length > 0 ? additional_paths.length : 0;
  log.info(`Closing Claude Code session ${task_id}`, {
    additional_paths: pathCount > 0 ? String(pathCount) : undefined,
  });

  const result = await closeClaudeCodeSession(task_id, user_id, agent_id, additional_paths);

  return {
    status: 'CLOSED' as const,
    output_files: result.outputFiles,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Get session
// ---------------------------------------------------------------------------

export async function getSession(taskId: string) {
  const session = await getClaudeCodeSession(taskId);

  if (session === undefined || session === null) {
    return null;
  }

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

// ---------------------------------------------------------------------------
// Get agent sessions
// ---------------------------------------------------------------------------

export async function getAgentSessions(agentId: string) {
  return repo.findSessionsByAgent(agentId);
}

// ---------------------------------------------------------------------------
// Persist output
// ---------------------------------------------------------------------------

export async function persistOutput(taskId: string, output: string) {
  log.info(`Persisting output for session ${taskId} (${output.length} bytes)`);
  await repo.persistSessionOutput(taskId, output);
  await detectAndMarkExhaustion(taskId, output);
}

/**
 * Scan the persisted Claude Code terminal output for the "you've hit your limit"
 * banner and, if found, mark the underlying Integration as rate-limited so
 * subsequent spawns rotate to a different pool token.
 *
 * Banner format (Claude Code v2.x): `You've hit your limit · resets 3:50am (UTC)`
 * — the time component is approximate and varies; we conservatively use the
 * configured POOL_RATE_LIMIT_COOLDOWN_MS (5 min) when we cannot parse it.
 */
async function detectAndMarkExhaustion(taskId: string, output: string): Promise<void> {
  if (!/You've hit your limit/i.test(output)) return;

  const session = await repo.findSessionById(taskId);
  const tokenSource = session?.claudeTokenSource ?? '';
  if (tokenSource === '') {
    log.warn(
      `Claude Code exhaustion detected for ${taskId} but no credential source recorded — cannot rotate`
    );
    return;
  }

  const resetMatch = output.match(
    /You've hit your limit\s*·\s*resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*\(UTC\))/i
  );
  const resetUntil = resetMatch !== null ? parseUtcResetTime(resetMatch[1]) : null;
  const resetLabel = resetMatch?.[1] ?? 'unknown';
  const integrationId = session?.claudeTokenIntegrationId ?? '';

  if (tokenSource === 'pool' && integrationId !== '') {
    log.warn(`Claude Code exhausted on pool integration ${integrationId} (resets ${resetLabel})`);
    await markPoolTokenRateLimited(integrationId, {
      rateLimitedUntil: resetUntil,
    });
  } else if (tokenSource === 'user' && session?.agentId !== undefined) {
    const agent = await repo.findAgentById(session.agentId);
    const ownerId = agent?.userId ?? '';
    if (ownerId !== '') {
      log.warn(`Claude Code exhausted on user ${ownerId} (resets ${resetLabel})`);
      await markUserTokenRateLimited(ownerId, { rateLimitedUntil: resetUntil });
    }
  }
}

/**
 * Parse the reset-time fragment from Claude Code's exhaustion banner into an
 * absolute Date. The banner only includes the next-reset *time-of-day* in UTC,
 * so we anchor it to today/tomorrow depending on whether it has already passed.
 */
function parseUtcResetTime(fragment: string): Date | null {
  const match = fragment.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const now = new Date();
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0)
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}
