import * as repo from './repo';
import {
  createCodexCodeSession,
  closeClaudeCodeSession,
  getClaudeCodeSession,
} from '../../providers/e2b';
import type { FilePointer } from '../../providers/storage';
import { checkGithubRepoAccess } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import {
  markGptApiKeyOnCooldown,
  markGptIntegrationRateLimited,
} from '../../providers/gptCredentials';

export type { HealthCheckResult } from './health';
export { checkSandboxHealth } from './health';

export type CodexCredentialFeedback = {
  source: 'initial' | 'oauth' | 'funded_api_key';
  reason: string;
};

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
  fast_mode_cache_enabled?: boolean;
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

  const persistedFastModeCacheEnabled = await repo.findAgentFastModeCache(agent_id);
  const fastModeCacheEnabled = params.fast_mode_cache_enabled ?? persistedFastModeCacheEnabled;
  if (
    params.fast_mode_cache_enabled !== undefined &&
    params.fast_mode_cache_enabled !== persistedFastModeCacheEnabled
  ) {
    log.warn('Codex Code session Fast Mode flag mismatch', {
      agentId: agent_id,
      requestFastModeCacheEnabled: params.fast_mode_cache_enabled,
      persistedFastModeCacheEnabled,
      effectiveFastModeCacheEnabled: fastModeCacheEnabled,
    });
  }
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

export async function persistOutput(
  taskId: string,
  output: string,
  credentialFeedback?: CodexCredentialFeedback[]
) {
  log.info(`Persisting Codex output for session ${taskId} (${output.length} bytes)`);
  await repo.persistSessionOutput(taskId, output);
  await detectAndMarkCodexExhaustion(taskId, output, credentialFeedback);
}

function parseCodexResetTime(output: string): Date | null {
  const match = output.match(
    /try again at\s+([A-Z][a-z]{2}\s+\d{1,2}(?:st|nd|rd|th)?,\s+\d{4}\s+\d{1,2}:\d{2}\s+(?:AM|PM))/i
  );
  if (match === null) return null;
  const withoutOrdinal = match[1].replace(/(\d{1,2})(?:st|nd|rd|th)/i, '$1');
  const parsed = new Date(`${withoutOrdinal} UTC`);
  return Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now() ? null : parsed;
}

async function detectAndMarkCodexExhaustion(
  taskId: string,
  output: string,
  credentialFeedback?: CodexCredentialFeedback[]
): Promise<void> {
  const exhaustionPattern =
    /You've hit your usage limit|usage[ _]limit|usage_limit_reached|purchase more credits|Quota exceeded\.\s*Check your plan and billing details|insufficient[_ ]quota|check your plan and billing/i;
  if (
    credentialFeedback !== undefined
      ? credentialFeedback.length === 0
      : !exhaustionPattern.test(output)
  ) {
    return;
  }

  const session = await repo.findSessionById(taskId);
  if (session === null) {
    log.warn(`Codex credential exhaustion detected for unknown session ${taskId}`);
    return;
  }

  const hasOAuthCredential = (session.claudeTokenIntegrationId ?? '') !== '';
  let oauthReason = '';
  let fundedKeyReason = '';

  if (credentialFeedback !== undefined) {
    for (const feedback of credentialFeedback) {
      if (feedback.source === 'oauth' || (feedback.source === 'initial' && hasOAuthCredential)) {
        oauthReason ||= feedback.reason;
      } else if (
        feedback.source === 'funded_api_key' ||
        (feedback.source === 'initial' && !hasOAuthCredential)
      ) {
        fundedKeyReason ||= feedback.reason;
      }
    }
  } else {
    // Compatibility path for older workers that only POST the terminal
    // snapshot. Current workers send ordered structured credential feedback,
    // which is not vulnerable to the 500-row terminal display bound.
    const fallbackMarker =
      '[Codex] ChatGPT OAuth unavailable — retrying with funded OpenAI API key';
    const fallbackIndex = output.indexOf(fallbackMarker);
    const oauthSegment =
      fallbackIndex >= 0 ? output.slice(0, fallbackIndex) : hasOAuthCredential ? output : '';
    const fundedKeySegment =
      fallbackIndex >= 0
        ? output.slice(fallbackIndex + fallbackMarker.length)
        : hasOAuthCredential
          ? ''
          : output;
    if (exhaustionPattern.test(oauthSegment)) oauthReason = oauthSegment;
    if (exhaustionPattern.test(fundedKeySegment)) fundedKeyReason = fundedKeySegment;
  }

  if (oauthReason !== '') {
    const integrationId = session.claudeTokenIntegrationId ?? '';
    if (integrationId === '') {
      log.warn(`Codex OAuth exhaustion lacks credential identity for session ${taskId}`);
    } else {
      const resetAt = parseCodexResetTime(oauthReason);
      await markGptIntegrationRateLimited(integrationId, { rateLimitedUntil: resetAt });
      log.warn(`Codex OAuth credential backed off for session ${taskId}`, {
        integrationId,
        source: session.claudeTokenSource,
        resetAt: resetAt?.toISOString(),
      });
    }
  }

  if (fundedKeyReason !== '') {
    await markGptApiKeyOnCooldown('codex_code_insufficient_quota');
    log.warn(`Codex funded API key backed off for session ${taskId}`);
  }
}
