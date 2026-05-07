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
 * Long cooldown for credentials the inner Claude Code CLI rejected as
 * unauthenticated ("Please run /login"). This is structurally different from
 * a per-window rate limit — the OAuth refresh token is bad/revoked and won't
 * recover on its own, so we keep it out of rotation for a full day to give
 * operators time to re-sync. Unlike the rate-limit banner there's no inline
 * "resets at HH:MM" hint we can lean on.
 */
const POOL_AUTH_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Authentication-failure banners emitted by Claude Code when the cached
 * credentials envelope is unusable. These are NOT rate-limit signals — they
 * mean the OAuth tokens themselves were rejected, so the same envelope will
 * keep failing on every subsequent spawn until it's re-synced. Rotating the
 * pool token immediately is the only way to make the next agent succeed.
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /Please run \/login/i,
  /Not logged in/i,
  /Invalid authentication credentials/i,
  /Credit balance too low/i,
  /Add funds:\s*https:\/\/platform\.claude\.com\/settings\/billing/i,
];

/**
 * Scan the persisted Claude Code terminal output for either the rate-limit
 * banner ("You've hit your limit · resets X:XX (UTC)") or an authentication-
 * failure banner ("Please run /login" / "Not logged in") and mark the
 * underlying Integration as rate-limited so subsequent spawns rotate to a
 * different pool token. Without this, a single broken OAuth envelope wedges
 * the entire pool (LRU keeps re-selecting it) and every retry burns an E2B
 * sandbox before failing to "/login".
 */
async function detectAndMarkExhaustion(taskId: string, output: string): Promise<void> {
  const rateLimitMatch = output.match(
    /You've hit your limit\s*·\s*resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*\(UTC\))/i
  );
  const isRateLimited = /You've hit your limit/i.test(output);
  const authFailure = AUTH_FAILURE_PATTERNS.some((re) => re.test(output));
  if (!isRateLimited && !authFailure) return;

  const session = await repo.findSessionById(taskId);
  const tokenSource = session?.claudeTokenSource ?? '';
  if (tokenSource === '') {
    log.warn(
      `Claude Code credential failure detected for ${taskId} but no credential source recorded — cannot rotate`
    );
    return;
  }

  const resetUntil = rateLimitMatch !== null ? parseUtcResetTime(rateLimitMatch[1]) : null;
  const resetLabel = rateLimitMatch?.[1] ?? (authFailure ? 'auth-failure' : 'unknown');
  const integrationId = session?.claudeTokenIntegrationId ?? '';

  // Auth-failure cooldown is longer than rate-limit cooldown because the
  // underlying problem (revoked/expired refresh token) won't fix itself.
  const cooldownMs = authFailure ? POOL_AUTH_FAILURE_COOLDOWN_MS : undefined;
  const failureKind = authFailure ? 'auth failure' : 'exhaustion';

  if (tokenSource === 'pool' && integrationId !== '') {
    log.warn(
      `Claude Code ${failureKind} on pool integration ${integrationId} (resets ${resetLabel})`
    );
    await markPoolTokenRateLimited(integrationId, {
      rateLimitedUntil: resetUntil,
      cooldownMs,
    });
  } else if (tokenSource === 'user' && session?.agentId !== undefined) {
    const agent = await repo.findAgentById(session.agentId);
    const ownerId = agent?.userId ?? '';
    if (ownerId !== '') {
      log.warn(`Claude Code ${failureKind} on user ${ownerId} (resets ${resetLabel})`);
      await markUserTokenRateLimited(ownerId, {
        rateLimitedUntil: resetUntil,
        cooldownMs,
      });
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
