import * as repo from './repo';
import {
  createCodexCodeSession,
  closeClaudeCodeSession,
  getClaudeCodeSession,
} from '../../providers/e2b';
import { checkGithubRepoAccess, ensureAgentTreeRepo } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import { codexSpeedFor } from '../../providers/codexSpeed';
import {
  markGptApiKeyOnCooldown,
  markGptIntegrationRateLimited,
  markGptUserTokenRateLimited,
} from '../../providers/gptCredentials';

import { classifyComputeGrantFailure } from '../../providers/computeGrantFailure';
import { createWithCodeSession } from '../../providers/codeSessions/spawn';

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

export type { CloseSessionParams, CreateSessionParams } from './types';
import type { CloseSessionParams, CreateSessionParams } from './types';

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
  // No repo yet: the tree gets one on its first code session.
  return { repoUrl: await ensureAgentTreeRepo(agentId), userId };
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

  // Codex never uses the DEMO / Fast Mode cache: the agent's speed only
  // selects Codex's native service tier.
  const codexSpeed = codexSpeedFor(await repo.findAgentSpeed(agent_id));
  const { session, fields } = await createWithCodeSession(
    {
      agentId: agent_id,
      userId: effectiveUserId,
      repoUrl: normalizedRepoUrl ?? null,
      codeProvider: 'codex',
      codeSessionId: params.code_session_id,
      leaseOwner: params.lease_owner,
      baseBranch: params.base_branch ?? null,
    },
    (codeSession, handoff) =>
      createCodexCodeSession(
        agent_id,
        handoff !== null ? `${handoff}\n\n${goal}` : goal,
        attachments,
        normalizedRepoUrl,
        effectiveUserId,
        codexSpeed,
        {
          harnessMode: params.harness_mode,
          roseApiBaseUrl: params.rose_api_base_url,
          memoryEnabled: params.memory_enabled,
          freshConversation: params.fresh_conversation === true,
        },
        codeSession
      )
  );

  return {
    task_id: session.taskId,
    sandbox_id: session.sandboxId,
    ws_url: session.wsUrl,
    uploaded_files: session.uploadedFiles,
    github_repo_url: normalizedRepoUrl ?? null,
    ...fields,
    // Live dev-server preview URL (Rose dev accounts, A1); null otherwise.
    preview_url: session.previewUrl ?? null,
  };
}

export async function closeSession(params: CloseSessionParams) {
  const result = await closeClaudeCodeSession(
    params.task_id,
    params.user_id,
    params.agent_id,
    params.additional_paths,
    { reason: params.reason }
  );

  return {
    status: 'CLOSED' as const,
    output_files: result.outputFiles,
    usage: result.usage,
    code_session: result.codeSession ?? null,
    ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
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
  const parsed = new Date(`${match[1].replace(/(\d{1,2})(?:st|nd|rd|th)/i, '$1')} UTC`);
  return Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now() ? null : parsed;
}

function isRevokedCodexOAuth(reason: string): boolean {
  return (
    reason.trim() === 'oauth_refresh_invalid' ||
    classifyComputeGrantFailure({ status: 401, body: reason }).verdict === 'revoked'
  );
}

function isCodexExhaustion(reason: string): boolean {
  const exhausted =
    /You've hit your usage limit|usage[ _]limit|usage_limit_reached|purchase more credits|Quota exceeded\.\s*Check your plan and billing details|insufficient[_ ]quota|check your plan and billing|no credits remaining|add credits to continue|credit[_ ]balance[_ ]exhausted|credit balance is too low/i;
  return (
    exhausted.test(reason) ||
    classifyComputeGrantFailure({ status: 401, body: reason }).verdict === 'payment_required'
  );
}

/** Read only native diagnostic records, retaining their JSON/indented continuations. */
function legacyCodexDiagnostics(output: string): string[] {
  if (output.trim() === 'oauth_refresh_invalid') return [output.trim()];
  let commandOutput = false;
  let diagnostic = false;
  const lines: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('[Codex command output]')) {
      commandOutput = true;
      diagnostic = false;
    } else if (line.startsWith('[Codex exit_code]')) commandOutput = false;
    else if (!commandOutput) {
      const header =
        /^\[Codex\] (?:Error|Turn failed):/.test(line) ||
        /^\d{4}-\d{2}-\d{2}T\S+\s+ERROR\s+codex_login::auth\S*:\s+Failed to refresh token\b/.test(
          line
        );
      const fallback =
        line === '[Codex] ChatGPT OAuth unavailable — retrying with funded OpenAI API key';
      const continuation =
        /^(?:\s+|[{}"\]]|invalid_grant\b|(?:invalid_)?refresh_token_\w+\b|Your session has ended\b)/i.test(
          line
        );
      if (header || fallback) lines.push(line);
      else if (diagnostic && continuation) lines[lines.length - 1] += `\n${line}`;
      diagnostic = header || (diagnostic && continuation);
    }
  }
  return lines;
}

async function detectAndMarkCodexExhaustion(
  taskId: string,
  output: string,
  credentialFeedback?: CodexCredentialFeedback[]
): Promise<void> {
  // A supplied structured list is authoritative, including no observed failures.
  if (credentialFeedback?.length === 0) return;

  const session = await repo.findSessionById(taskId);
  if (session === null)
    return log.warn(`Codex credential exhaustion detected for unknown session ${taskId}`);

  const hasOAuthCredential = (session.claudeTokenIntegrationId ?? '') !== '';
  let oauthReason = '';
  let oauthRevoked = false;
  let fundedKeyReason = '';

  if (credentialFeedback !== undefined) {
    for (const feedback of credentialFeedback) {
      if (feedback.source === 'oauth' || (feedback.source === 'initial' && hasOAuthCredential)) {
        const revoked = isRevokedCodexOAuth(feedback.reason);
        if (revoked || !oauthReason) {
          oauthReason = feedback.reason;
          oauthRevoked = revoked;
        }
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
    let funded = !hasOAuthCredential;
    for (const diagnostic of legacyCodexDiagnostics(output)) {
      if (diagnostic === fallbackMarker) {
        funded = true;
        continue;
      }
      if (funded) {
        if (isCodexExhaustion(diagnostic)) fundedKeyReason ||= diagnostic;
      } else {
        const revoked = isRevokedCodexOAuth(diagnostic);
        if (revoked || (!oauthReason && isCodexExhaustion(diagnostic))) {
          oauthReason = diagnostic;
          oauthRevoked = revoked;
        }
      }
    }
  }

  if (oauthReason !== '') await markCodexOAuthFailure(taskId, session, oauthReason, oauthRevoked);

  if (isCodexExhaustion(fundedKeyReason)) {
    await markGptApiKeyOnCooldown('codex_code_insufficient_quota');
    log.warn(`Codex funded API key backed off for session ${taskId}`);
  }
}

async function markCodexOAuthFailure(
  taskId: string,
  session: NonNullable<Awaited<ReturnType<typeof repo.findSessionById>>>,
  reason: string,
  revoked: boolean
): Promise<void> {
  const integrationId = session.claudeTokenIntegrationId ?? '';
  if (integrationId === '')
    return log.warn(`Codex OAuth exhaustion lacks credential identity for session ${taskId}`);
  if (revoked) {
    const integration = await repo.findCredentialIntegration(integrationId);
    if (integration) {
      await markGptUserTokenRateLimited(integration.userId, {
        integrationId,
        accountId: integration.accountId,
        failureReason: 'auth_error',
      });
    }
  } else {
    const resetAt = parseCodexResetTime(reason);
    await markGptIntegrationRateLimited(integrationId, { rateLimitedUntil: resetAt });
    log.warn(`Codex OAuth credential backed off for session ${taskId}`, {
      integrationId,
      source: session.claudeTokenSource,
      resetAt: resetAt?.toISOString(),
    });
  }
}
